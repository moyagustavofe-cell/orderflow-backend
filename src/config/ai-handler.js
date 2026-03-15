require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { db } = require('./database');
const { broadcast } = require('./ws-server');
const { sendTextMessage, isConfigured } = require('./whatsapp');

function isApiConfigured() {
  return !!process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'TU_API_KEY_AQUI';
}

function buildSystemPrompt(settings, products) {
  const catalog = products.length
    ? products.map(p =>
        `  • [ID:${p.id}] ${p.name} — $${p.base_price}/${p.unit} (código: ${p.code})`
      ).join('\n')
    : '  (Sin productos disponibles)';

  return `Sos ${settings.assistant_name || 'el asistente de OrderFlow'}, un asistente de ventas de un centro de producción.

${settings.special_instructions || 'Ayudás a los clientes a hacer pedidos, consultar precios y resolver dudas. Respondé siempre en español.'}

== CATÁLOGO DE PRODUCTOS ==
${catalog}

== INSTRUCCIONES ==
- Cuando el cliente quiera hacer un pedido, listá los productos y cantidades con sus precios unitarios y el total antes de confirmar.
- Solo creá el pedido cuando el cliente lo confirme explícitamente ("sí", "confirmado", "dale", etc.).
- Al crear el pedido, usá exactamente los IDs del catálogo.
- Respondé siempre de forma amable, breve y en español.`;
}

// Obtiene o crea un cliente en la base de datos para asociar al pedido
function getOrCreateClientId(conv) {
  if (conv.phone_number) {
    const existing = db.prepare('SELECT id FROM clients WHERE phone = ?').get(conv.phone_number);
    if (existing) return existing.id;
    const r = db.prepare('INSERT INTO clients (name, phone, active) VALUES (?, ?, 1)')
      .run(conv.client_name || `+${conv.phone_number}`, conv.phone_number);
    return r.lastInsertRowid;
  }
  // Canal web sin teléfono: crea cliente temporal si no existe
  const r = db.prepare('INSERT INTO clients (name, active) VALUES (?, 1)')
    .run(conv.client_name || 'Cliente IA');
  return r.lastInsertRowid;
}

function createOrderFromAI(conv, { items }, productsMap) {
  const validItems = (items || []).filter(i => productsMap[i.product_id] && i.quantity > 0);
  if (!validItems.length) throw new Error('No hay ítems válidos en el pedido');

  const clientId  = getOrCreateClientId(conv);
  const adminOp   = db.prepare("SELECT id FROM operators WHERE role = 'admin' LIMIT 1").get();
  const operatorId = adminOp?.id || 1;

  // Número de pedido único basado en timestamp
  const orderNumber = `ORD-${Date.now().toString().slice(-7)}`;
  const total = validItems.reduce((sum, i) => sum + productsMap[i.product_id].base_price * i.quantity, 0);

  const orderRes = db.prepare(`
    INSERT INTO orders (order_number, client_id, operator_id, status, notes, total)
    VALUES (?, ?, ?, 'pending', ?, ?)
  `).run(
    orderNumber, clientId, operatorId,
    `Pedido tomado por IA (canal: ${conv.channel})`,
    total
  );

  const orderId = orderRes.lastInsertRowid;

  for (const item of validItems) {
    const p = productsMap[item.product_id];
    db.prepare(`
      INSERT INTO order_items (order_id, product_id, quantity, unit_price, subtotal)
      VALUES (?, ?, ?, ?, ?)
    `).run(orderId, item.product_id, item.quantity, p.base_price, p.base_price * item.quantity);
  }

  return {
    orderId,
    orderNumber,
    total,
    lines: validItems.map(i => ({
      qty: i.quantity,
      unit: productsMap[i.product_id].unit,
      name: productsMap[i.product_id].name,
      subtotal: productsMap[i.product_id].base_price * i.quantity,
    })),
  };
}

async function processAIResponse(convId) {
  console.log(`[AI] processAIResponse iniciado para conv #${convId}`);

  // ── Verificaciones previas ────────────────────────────────────────────────
  const keyPresent = !!process.env.ANTHROPIC_API_KEY;
  const keyValid   = isApiConfigured();
  console.log(`[AI] API key presente: ${keyPresent}, válida: ${keyValid}`);

  if (!keyValid) {
    console.warn('[AI] ANTHROPIC_API_KEY no configurada o con valor placeholder — respuesta IA omitida');
    return;
  }

  const conv = db.prepare('SELECT * FROM ai_conversations WHERE id = ?').get(convId);
  console.log(`[AI] Conv encontrada: ${!!conv}, ai_active: ${conv?.ai_active}, status: ${conv?.status}`);
  if (!conv || !conv.ai_active || conv.status !== 'active') {
    console.warn(`[AI] Conv #${convId} no cumple condiciones para respuesta IA — saltando`);
    return;
  }

  const settings = db.prepare('SELECT * FROM ai_settings WHERE id = 1').get();
  console.log(`[AI] ai_enabled: ${settings?.ai_enabled}`);
  if (!settings?.ai_enabled) {
    console.warn('[AI] IA deshabilitada en configuración — saltando');
    return;
  }

  // ── Datos para el contexto ────────────────────────────────────────────────
  const products    = db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY name ASC').all();
  const productsMap = Object.fromEntries(products.map(p => [p.id, p]));

  // Historial de mensajes: convertir roles al formato user/assistant de Claude
  const rawHistory = db.prepare(
    'SELECT * FROM ai_messages WHERE conversation_id = ? ORDER BY created_at ASC'
  ).all(convId);

  // Omitir mensajes de asistente al inicio (bienvenida) y mapear operator → assistant
  const claudeMsgs = [];
  for (const msg of rawHistory) {
    const role = msg.role === 'user' ? 'user' : 'assistant';
    if (claudeMsgs.length === 0 && role === 'assistant') continue;
    claudeMsgs.push({ role, content: msg.content });
  }

  console.log(`[AI] Historial raw: ${rawHistory.length} mensajes, Claude msgs: ${claudeMsgs.length}`);
  if (claudeMsgs.length) {
    console.log(`[AI] Último mensaje rol: ${claudeMsgs[claudeMsgs.length - 1].role}`);
  }

  // Si el último mensaje no es del usuario, no hay nada que responder
  if (!claudeMsgs.length || claudeMsgs[claudeMsgs.length - 1].role !== 'user') {
    console.warn('[AI] Sin mensaje de usuario al final del historial — saltando');
    return;
  }

  // ── Definición de herramienta ─────────────────────────────────────────────
  const tools = [{
    name: 'create_order',
    description: 'Registra en el sistema un pedido confirmado por el cliente. Llamá esta herramienta SOLO cuando el cliente confirme explícitamente el pedido.',
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'Lista de productos y cantidades del pedido',
          items: {
            type: 'object',
            properties: {
              product_id: { type: 'integer', description: 'ID del producto según el catálogo' },
              quantity:   { type: 'number',  description: 'Cantidad pedida' },
            },
            required: ['product_id', 'quantity'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
  }];

  const client     = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const systemPrompt = buildSystemPrompt(settings, products);
  let messages       = [...claudeMsgs];
  let responseText   = null;
  let orderData      = null;

  console.log(`[AI] Llamando Claude con ${claudeMsgs.length} msgs, ${products.length} productos`);

  try {
    // ── Primera llamada a Claude ──────────────────────────────────────────
    const response = await client.messages.create({
      model:       'claude-opus-4-6',
      max_tokens:  1024,
      system:      systemPrompt,
      messages,
      tools,
      tool_choice: { type: 'auto' },
    });

    console.log(`[AI] Respuesta Claude — stop_reason: ${response.stop_reason}, bloques: ${response.content.length}`);

    if (response.stop_reason === 'tool_use') {
      // ── Ejecutar herramienta y hacer llamada de seguimiento ────────────
      messages = [...messages, { role: 'assistant', content: response.content }];

      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use' || block.name !== 'create_order') continue;
        try {
          orderData = createOrderFromAI(conv, block.input, productsMap);
          toolResults.push({
            type:        'tool_result',
            tool_use_id: block.id,
            content:     `Pedido ${orderData.orderNumber} creado. Total: $${orderData.total.toFixed(2)}. Ítems: ${orderData.lines.map(l => `${l.qty} ${l.unit} de ${l.name} ($${l.subtotal.toFixed(2)})`).join(', ')}.`,
          });
        } catch (err) {
          toolResults.push({
            type:        'tool_result',
            tool_use_id: block.id,
            content:     `Error al crear el pedido: ${err.message}`,
            is_error:    true,
          });
        }
      }

      messages = [...messages, { role: 'user', content: toolResults }];

      const followUp = await client.messages.create({
        model:       'claude-opus-4-6',
        max_tokens:  512,
        system:      systemPrompt,
        messages,
        tools,
        tool_choice: { type: 'none' },  // no volver a llamar herramientas
      });

      for (const block of followUp.content) {
        if (block.type === 'text') { responseText = block.text; break; }
      }
    } else {
      for (const block of response.content) {
        if (block.type === 'text') { responseText = block.text; break; }
      }
    }
  } catch (err) {
    console.error('[AI] Error llamando API de Claude:', err.message);
    console.error('[AI] Stack:', err.stack);
    if (err.status) console.error('[AI] HTTP status:', err.status);
    if (err.error)  console.error('[AI] API error body:', JSON.stringify(err.error));
    return;
  }

  console.log(`[AI] responseText obtenido: ${responseText ? `"${responseText.slice(0, 80)}..."` : 'null'}`);
  if (!responseText) return;

  // ── Persistir respuesta ───────────────────────────────────────────────────
  const msgRes = db.prepare(
    "INSERT INTO ai_messages (conversation_id, role, content) VALUES (?, 'assistant', ?)"
  ).run(convId, responseText);

  db.prepare(
    "UPDATE ai_conversations SET last_message = ?, last_message_at = datetime('now') WHERE id = ?"
  ).run(responseText, convId);

  if (orderData) {
    db.prepare('UPDATE ai_conversations SET generated_order_id = ? WHERE id = ?')
      .run(orderData.orderId, convId);
  }

  const savedMsg    = db.prepare('SELECT * FROM ai_messages WHERE id = ?').get(msgRes.lastInsertRowid);
  const updatedConv = db.prepare('SELECT * FROM ai_conversations WHERE id = ?').get(convId);

  broadcast({ type: 'new_message', conversation_id: convId, message: savedMsg, conversation: updatedConv });

  // ── Enviar por WhatsApp si aplica ─────────────────────────────────────────
  if (conv.channel === 'whatsapp' && conv.phone_number && isConfigured()) {
    await sendTextMessage(conv.phone_number, responseText).catch(err =>
      console.error('[AI→WA] Error enviando respuesta:', err.message)
    );
  }

  console.log(`[AI] Respuesta generada para conv #${convId}${orderData ? ` — Pedido ${orderData.orderNumber} creado` : ''}`);
}

module.exports = { processAIResponse };
