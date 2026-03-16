require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { db } = require('./database');
const { broadcast } = require('./ws-server');
const { sendTextMessage, isConfigured } = require('./whatsapp');

function isApiConfigured() {
  return !!process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'TU_API_KEY_AQUI';
}

// ── Contexto del cliente ───────────────────────────────────────────────────────
// Devuelve { identified, client } y auto-vincula si el teléfono ya está en la DB.
// Un cliente se considera "identificado" SOLO si tiene CUIT (tax_id) registrado.
function getClientContext(conv) {
  if (conv.client_id) {
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(conv.client_id);
    if (client && client.tax_id) return { identified: true, client };
    // Tiene cliente vinculado pero sin CUIT — no es identificación válida
  }
  if (conv.phone_number) {
    const client = db.prepare(
      "SELECT * FROM clients WHERE phone = ? AND active = 1 AND tax_id IS NOT NULL AND tax_id != '' LIMIT 1"
    ).get(conv.phone_number);
    if (client) {
      db.prepare('UPDATE ai_conversations SET client_id = ?, client_name = ? WHERE id = ?')
        .run(client.id, client.name, conv.id);
      return { identified: true, client };
    }
  }
  return { identified: false, client: null };
}

// ── Buscar cliente por CUIT o nombre ─────────────────────────────────────────
function buscarCliente(query) {
  const q = (query || '').trim();
  const cleanCuit = q.replace(/[-.\s]/g, '');

  // 1. Por CUIT exacto (ignorando guiones y espacios)
  if (cleanCuit.length >= 10) {
    const byCuit = db.prepare(
      "SELECT * FROM clients WHERE active = 1 AND replace(replace(replace(COALESCE(tax_id,''),'-',''),' ',''),'.','') = ? LIMIT 1"
    ).get(cleanCuit);
    if (byCuit) return { found: true, exact: true, clients: [byCuit] };
  }

  // 2. Por nombre exacto (sin distinción de mayúsculas)
  const byExact = db.prepare(
    "SELECT * FROM clients WHERE active = 1 AND lower(name) = lower(?) LIMIT 1"
  ).get(q);
  if (byExact) return { found: true, exact: true, clients: [byExact] };

  // 3. Por nombre parcial (hasta 5 resultados)
  const byPartial = db.prepare(
    `SELECT * FROM clients WHERE active = 1
     AND (lower(name) LIKE lower(?) OR lower(COALESCE(business_name,'')) LIKE lower(?))
     ORDER BY name ASC LIMIT 5`
  ).all(`%${q}%`, `%${q}%`);
  if (byPartial.length > 0) return { found: true, exact: false, clients: byPartial };

  return { found: false, clients: [] };
}

// ── Confirmar cliente existente y vincularlo a la conversación ────────────────
function confirmarCliente(conv, clientId) {
  const client = db.prepare('SELECT * FROM clients WHERE id = ? AND active = 1').get(clientId);
  if (!client) throw new Error(`No se encontró el cliente con ID ${clientId}`);
  db.prepare('UPDATE ai_conversations SET client_id = ?, client_name = ? WHERE id = ?')
    .run(client.id, client.name, conv.id);
  // Vincular teléfono si no lo tenía
  if (conv.phone_number && !client.phone) {
    db.prepare('UPDATE clients SET phone = ? WHERE id = ?').run(conv.phone_number, client.id);
  }
  console.log(`[AI] Cliente confirmado: "${client.name}" (ID: ${client.id})`);
  return client;
}

// ── Crear cliente nuevo y vincularlo a la conversación ───────────────────────
function crearCliente(conv, { name, tax_id, phone, email, address }) {
  if (!name?.trim()) throw new Error('La razón social es requerida');
  if (!tax_id?.trim()) throw new Error('El CUIT es requerido');

  const cleanCuit = tax_id.replace(/[-.\s]/g, '');
  const dup = db.prepare(
    "SELECT id, name FROM clients WHERE active = 1 AND replace(replace(replace(COALESCE(tax_id,''),'-',''),' ',''),'.','') = ?"
  ).get(cleanCuit);
  if (dup) throw new Error(`Ya existe un cliente con ese CUIT: ${dup.name} (ID: ${dup.id})`);

  const res = db.prepare(
    'INSERT INTO clients (name, business_name, tax_id, phone, email, address, active) VALUES (?, ?, ?, ?, ?, ?, 1)'
  ).run(
    name.trim(), name.trim(), tax_id.trim(),
    phone?.trim() || conv.phone_number || null,
    email?.trim() || null,
    address?.trim() || null
  );

  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(res.lastInsertRowid);
  db.prepare('UPDATE ai_conversations SET client_id = ?, client_name = ? WHERE id = ?')
    .run(client.id, client.name, conv.id);
  console.log(`[AI] Cliente creado: "${client.name}" CUIT: ${client.tax_id} (ID: ${client.id})`);
  return client;
}

// ── Calcular fecha mínima de entrega (48 horas desde ahora) ─────────────────
function getDeliveryInfo() {
  const DAYS_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const now     = new Date();
  const minDate = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  return {
    today:      DAYS_ES[now.getDay()],
    minDay:     DAYS_ES[minDate.getDay()],
    minDateStr: minDate.toISOString().split('T')[0], // YYYY-MM-DD
  };
}

// ── System prompt ─────────────────────────────────────────────────────────────
function buildSystemPrompt(settings, products, clientContext) {
  const catalog = products.length
    ? products.map(p =>
        `  • [ID:${p.id}] ${p.name} — $${p.base_price}/${p.unit} (código: ${p.code})`
      ).join('\n')
    : '  (Sin productos disponibles)';

  const baseInstructions = settings.special_instructions ||
    'Sos un asistente amable de un centro de producción. Ayudás a los clientes a hacer pedidos, consultar precios y resolver dudas. Respondé siempre en español.';

  let clientSection;
  if (clientContext.identified && clientContext.client) {
    const c = clientContext.client;
    clientSection = `== CLIENTE IDENTIFICADO ✅ ==
Razón social : ${c.name}
CUIT         : ${c.tax_id || '(no registrado)'}
Teléfono     : ${c.phone  || '(no registrado)'}
Email        : ${c.email  || '(no registrado)'}
ID interno   : ${c.id}
→ Podés mostrar el catálogo y tomar pedidos directamente.`;
  } else {
    clientSection = `== CLIENTE NO IDENTIFICADO ⚠️ ==
INSTRUCCIÓN CRÍTICA: El cliente NO está identificado en el sistema.
ANTES de mostrar el catálogo o tomar cualquier pedido, DEBÉS pedirle su CUIT o razón social.
Ejemplo: "Para registrar tu pedido necesito identificarte. ¿Me podés dar tu CUIT o razón social?"
Usá la herramienta buscar_cliente cuando te lo dé.`;
  }

  const { today, minDay, minDateStr } = getDeliveryInfo();

  return `Sos ${settings.assistant_name || 'el asistente de OrderFlow'}, asistente de ventas de un centro de producción.

${baseInstructions}

${clientSection}

== CATÁLOGO DE PRODUCTOS ==
${catalog}

== FLUJO DE ATENCIÓN ==

▶ PASO 1 — IDENTIFICAR AL CLIENTE (obligatorio si no está identificado):
  a) Pedí CUIT o razón social.
  b) Llamá buscar_cliente con lo que te dieron.
  c) Si encontró coincidencia exacta → mostrá los datos al cliente y pedí confirmación.
     Cuando el cliente confirme → llamá confirmar_cliente con su ID.
  d) Si encontró varias coincidencias → mostrá la lista y preguntá cuál es.
     Cuando el cliente elija → llamá confirmar_cliente con ese ID.
  e) Si no encontró nada → informalo y pedí los datos completos:
     razón social, CUIT, teléfono y email (dirección es opcional).
     Con esos datos → llamá crear_cliente.
  f) Una vez confirmado/creado → continuá al Paso 2.

▶ PASO 2 — TOMAR EL PEDIDO (solo si cliente identificado):
  a) Mostrá el catálogo con precios.
  b) Recibí los productos y cantidades.
  c) Mostrá el resumen: ítems, subtotales y total general.
  d) ANTES de confirmar, pedí la fecha de entrega (es OBLIGATORIA).
     Indicá que el tiempo mínimo de entrega es 48 horas.
     Ejemplo actual: "Si lo pedís hoy (${today}), te lo entregamos el ${minDay} como mínimo (en 48 hs)."
     La fecha mínima aceptable es: ${minDateStr}.
  e) Validá la fecha pedida:
     - Si la fecha es >= ${minDateStr}: perfecto, pedí confirmación explícita y llamá create_order.
     - Si la fecha es < ${minDateStr} (menos de 48 hs):
       1. Informale: "El tiempo mínimo de entrega es 48 hs."
       2. Preguntale si igual necesita la entrega para esa fecha urgente.
       3. Si confirma que sí la necesita urgente → llamá escalar_a_humano y decile:
          "Entendido. Un miembro de nuestro equipo se va a comunicar a la brevedad para coordinar tu entrega urgente."
  f) Solo después de validar la fecha, llamá create_order (solo si fecha >= ${minDateStr}).

▶ REGLAS:
  - Respondé siempre en español, de forma amable y breve.
  - Usá exactamente los IDs del catálogo al crear el pedido.
  - El pedido queda registrado automáticamente a nombre del cliente identificado.
  - Nunca registres un pedido con fecha de entrega menor a 48 hs; usá escalar_a_humano en ese caso.`;
}

// ── Herramientas disponibles para Claude ─────────────────────────────────────
const TOOLS = [
  {
    name: 'buscar_cliente',
    description: 'Busca un cliente en el sistema por CUIT o nombre/razón social. Llamá esta herramienta cuando el cliente te dé su CUIT o nombre para identificarse.',
    input_schema: {
      type: 'object',
      properties: {
        cuit_o_nombre: {
          type: 'string',
          description: 'CUIT (ej: 20-12345678-9 o 20123456789) o nombre/razón social a buscar',
        },
      },
      required: ['cuit_o_nombre'],
      additionalProperties: false,
    },
  },
  {
    name: 'confirmar_cliente',
    description: 'Vincula un cliente existente a esta conversación. Llamá esta herramienta SOLO después de que el cliente confirmó que los datos mostrados son correctos.',
    input_schema: {
      type: 'object',
      properties: {
        client_id: {
          type: 'integer',
          description: 'ID del cliente a confirmar (obtenido del resultado de buscar_cliente)',
        },
      },
      required: ['client_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'crear_cliente',
    description: 'Crea un nuevo cliente en el sistema. Usá esta herramienta cuando el cliente no existe y ya tenés todos sus datos (razón social y CUIT son obligatorios).',
    input_schema: {
      type: 'object',
      properties: {
        name:    { type: 'string', description: 'Razón social o nombre completo' },
        tax_id:  { type: 'string', description: 'CUIT (ej: 20-12345678-9)' },
        phone:   { type: 'string', description: 'Teléfono de contacto (opcional)' },
        email:   { type: 'string', description: 'Email de contacto (opcional)' },
        address: { type: 'string', description: 'Dirección (opcional)' },
      },
      required: ['name', 'tax_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'escalar_a_humano',
    description: 'Escala la conversación a un operador humano urgente. Usá esta herramienta SOLO cuando el cliente necesita entrega en menos de 48 horas y confirma que necesita esa fecha.',
    input_schema: {
      type: 'object',
      properties: {
        motivo: {
          type: 'string',
          description: 'Motivo de la escalada (ej: "Cliente solicita entrega urgente para 2026-03-17, menos de 48h")',
        },
      },
      required: ['motivo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_order',
    description: 'Registra un pedido confirmado por el cliente. SOLO llamar cuando: (1) el cliente está identificado, y (2) el cliente confirmó el pedido explícitamente.',
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'Lista de productos y cantidades',
          items: {
            type: 'object',
            properties: {
              product_id: { type: 'integer', description: 'ID del producto según catálogo' },
              quantity:   { type: 'number',  description: 'Cantidad pedida' },
            },
            required: ['product_id', 'quantity'],
            additionalProperties: false,
          },
        },
        delivery_date: { type: 'string', description: 'Fecha de entrega YYYY-MM-DD (opcional)' },
        notes:         { type: 'string', description: 'Observaciones del pedido (opcional)' },
      },
      required: ['items'],
      additionalProperties: false,
    },
  },
];

// ── Crear pedido ──────────────────────────────────────────────────────────────
function createOrderFromAI(conv, { items, delivery_date, notes }, productsMap) {
  const validItems = (items || []).filter(i => productsMap[i.product_id] && i.quantity > 0);
  if (!validItems.length) throw new Error('No hay ítems válidos en el pedido');
  if (!conv.client_id) throw new Error('El cliente no está identificado. Identificalo antes de crear el pedido.');

  const adminOp    = db.prepare("SELECT id FROM operators WHERE role = 'admin' LIMIT 1").get();
  const operatorId = adminOp?.id || 1;
  const orderNumber = `ORD-${Date.now().toString().slice(-7)}`;
  const total = validItems.reduce(
    (sum, i) => sum + productsMap[i.product_id].base_price * i.quantity, 0
  );
  const orderNotes = [notes || null, `Pedido tomado por IA (canal: ${conv.channel})`]
    .filter(Boolean).join(' — ');

  const orderRes = db.prepare(`
    INSERT INTO orders (order_number, client_id, operator_id, status, notes, delivery_date, total)
    VALUES (?, ?, ?, 'pending', ?, ?, ?)
  `).run(orderNumber, conv.client_id, operatorId, orderNotes, delivery_date || null, total);

  const orderId = orderRes.lastInsertRowid;
  for (const item of validItems) {
    const p = productsMap[item.product_id];
    db.prepare(`
      INSERT INTO order_items (order_id, product_id, quantity, unit_price, subtotal)
      VALUES (?, ?, ?, ?, ?)
    `).run(orderId, item.product_id, item.quantity, p.base_price, p.base_price * item.quantity);
  }

  const client = db.prepare('SELECT name FROM clients WHERE id = ?').get(conv.client_id);
  return {
    orderId, orderNumber, total,
    clientName: client?.name || 'Cliente',
    lines: validItems.map(i => ({
      qty:      i.quantity,
      unit:     productsMap[i.product_id].unit,
      name:     productsMap[i.product_id].name,
      subtotal: productsMap[i.product_id].base_price * i.quantity,
    })),
  };
}

// ── Escalar conversación a humano urgente ─────────────────────────────────────
function escalarAHumano(conv, motivo) {
  db.prepare(
    'UPDATE ai_conversations SET ai_active = 0, urgent = 1 WHERE id = ?'
  ).run(conv.id);
  console.log(`[AI] Conv #${conv.id} escalada a humano — motivo: ${motivo}`);
  const updated = db.prepare('SELECT * FROM ai_conversations WHERE id = ?').get(conv.id);
  broadcast({ type: 'conversation_updated', conversation: updated });
  return updated;
}

// ── Procesamiento principal ───────────────────────────────────────────────────
async function processAIResponse(convId) {
  console.log(`[AI] processAIResponse conv #${convId}`);

  if (!isApiConfigured()) {
    console.warn('[AI] ANTHROPIC_API_KEY no configurada — saltando');
    return;
  }

  let conv = db.prepare('SELECT * FROM ai_conversations WHERE id = ?').get(convId);
  if (!conv || !conv.ai_active || conv.status !== 'active') return;

  const settings = db.prepare('SELECT * FROM ai_settings WHERE id = 1').get();
  if (!settings?.ai_enabled) return;

  const products    = db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY name ASC').all();
  const productsMap = Object.fromEntries(products.map(p => [p.id, p]));

  const rawHistory = db.prepare(
    'SELECT * FROM ai_messages WHERE conversation_id = ? ORDER BY created_at ASC'
  ).all(convId);

  const claudeMsgs = [];
  for (const msg of rawHistory) {
    const role = msg.role === 'user' ? 'user' : 'assistant';
    if (claudeMsgs.length === 0 && role === 'assistant') continue;
    claudeMsgs.push({ role, content: msg.content });
  }

  if (!claudeMsgs.length || claudeMsgs[claudeMsgs.length - 1].role !== 'user') return;

  const anthropic  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  let messages     = [...claudeMsgs];
  let responseText = null;
  let orderData    = null;

  for (let iter = 0; iter < 6; iter++) {
    conv = db.prepare('SELECT * FROM ai_conversations WHERE id = ?').get(convId);
    const clientContext = getClientContext(conv);
    const systemPrompt  = buildSystemPrompt(settings, products, clientContext);

    console.log(`[AI] Iter ${iter + 1} — cliente: ${clientContext.identified ? clientContext.client?.name : 'no identificado'}`);

    const response = await anthropic.messages.create({
      model:       'claude-opus-4-6',
      max_tokens:  1024,
      system:      systemPrompt,
      messages,
      tools:       TOOLS,
      tool_choice: { type: 'auto' },
    });

    console.log(`[AI] stop_reason: ${response.stop_reason}`);

    if (response.stop_reason !== 'tool_use') {
      for (const block of response.content) {
        if (block.type === 'text') { responseText = block.text; break; }
      }
      break;
    }

    messages = [...messages, { role: 'assistant', content: response.content }];
    const toolResults = [];

    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;

      if (block.name === 'buscar_cliente') {
        const result = buscarCliente(block.input.cuit_o_nombre);
        let content;
        if (!result.found) {
          content = `No se encontró ningún cliente con "${block.input.cuit_o_nombre}" en el sistema.`;
        } else if (result.exact) {
          const c = result.clients[0];
          content = `Cliente encontrado:\n• Razón social: ${c.name}\n• CUIT: ${c.tax_id || '(no registrado)'}\n• Teléfono: ${c.phone || '(no registrado)'}\n• Email: ${c.email || '(no registrado)'}\n• ID: ${c.id}`;
        } else {
          content = `Se encontraron ${result.clients.length} coincidencias:\n` +
            result.clients.map((c, i) =>
              `${i + 1}. ${c.name} | CUIT: ${c.tax_id || 'N/A'} | ID: ${c.id}`
            ).join('\n') +
            '\nPedile al cliente que confirme cuál es el correcto.';
        }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content });
        console.log(`[AI] buscar_cliente "${block.input.cuit_o_nombre}" → found: ${result.found}`);
      }

      else if (block.name === 'confirmar_cliente') {
        try {
          const client = confirmarCliente(conv, block.input.client_id);
          conv = db.prepare('SELECT * FROM ai_conversations WHERE id = ?').get(convId);
          toolResults.push({
            type: 'tool_result', tool_use_id: block.id,
            content: `✅ Cliente confirmado y vinculado: ${client.name} (CUIT: ${client.tax_id || 'N/A'}, ID: ${client.id}). Podés continuar con el pedido.`,
          });
        } catch (err) {
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Error: ${err.message}`, is_error: true });
        }
      }

      else if (block.name === 'crear_cliente') {
        try {
          const client = crearCliente(conv, block.input);
          conv = db.prepare('SELECT * FROM ai_conversations WHERE id = ?').get(convId);
          toolResults.push({
            type: 'tool_result', tool_use_id: block.id,
            content: `✅ Cliente creado: ${client.name} (CUIT: ${client.tax_id}, ID: ${client.id}). Podés continuar con el pedido.`,
          });
        } catch (err) {
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Error: ${err.message}`, is_error: true });
        }
      }

      else if (block.name === 'escalar_a_humano') {
        try {
          escalarAHumano(conv, block.input.motivo);
          conv = db.prepare('SELECT * FROM ai_conversations WHERE id = ?').get(convId);
          toolResults.push({
            type: 'tool_result', tool_use_id: block.id,
            content: `✅ Conversación marcada como urgente. Motivo: ${block.input.motivo}. Un operador humano recibirá la alerta y se comunicará a la brevedad.`,
          });
        } catch (err) {
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Error: ${err.message}`, is_error: true });
        }
      }

      else if (block.name === 'create_order') {
        conv = db.prepare('SELECT * FROM ai_conversations WHERE id = ?').get(convId);
        try {
          orderData = createOrderFromAI(conv, block.input, productsMap);
          toolResults.push({
            type: 'tool_result', tool_use_id: block.id,
            content: `✅ Pedido ${orderData.orderNumber} creado para ${orderData.clientName}. Total: $${orderData.total.toFixed(2)}. Ítems: ${orderData.lines.map(l => `${l.qty} ${l.unit} de ${l.name} ($${l.subtotal.toFixed(2)})`).join(', ')}.`,
          });
        } catch (err) {
          console.error('[AI] Error creando pedido:', err.message);
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Error: ${err.message}`, is_error: true });
        }
      }
    }

    messages = [...messages, { role: 'user', content: toolResults }];
  }

  if (!responseText) return;

  conv = db.prepare('SELECT * FROM ai_conversations WHERE id = ?').get(convId);
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

  if (conv.channel === 'whatsapp' && conv.phone_number && isConfigured()) {
    await sendTextMessage(conv.phone_number, responseText).catch(err =>
      console.error('[AI→WA] Error:', err.message)
    );
  }

  console.log(`[AI] Respuesta conv #${convId}${orderData ? ` — Pedido ${orderData.orderNumber} para ${orderData.clientName}` : ''}`);
}

module.exports = { processAIResponse };
