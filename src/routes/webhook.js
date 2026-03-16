require('dotenv').config();
const express = require('express');
const { db } = require('../config/database');
const { broadcast } = require('../config/ws-server');
const { sendTextMessage, markAsRead, isConfigured } = require('../config/whatsapp');
const { processAIResponse } = require('../config/ai-handler');

const router = express.Router();

// ── GET /api/whatsapp/webhook — verificación del webhook (Meta lo llama una vez) ──
router.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('[WhatsApp Webhook] ✓ Verificación exitosa');
    return res.status(200).send(challenge);
  }

  console.warn('[WhatsApp Webhook] ✗ Verificación fallida — token incorrecto');
  res.status(403).json({ error: 'Verificación fallida' });
});

// ── POST /api/whatsapp/webhook — mensajes y eventos entrantes ────────────────
// WhatsApp requiere HTTP 200 en menos de 20s; procesamos de forma asíncrona.
router.post('/webhook', (req, res) => {
  console.log('[WhatsApp Webhook] POST recibido');
  console.log('[WhatsApp Webhook] Body:', JSON.stringify(req.body, null, 2));
  res.status(200).send('EVENT_RECEIVED');
  processPayload(req.body).catch(err =>
    console.error('[WhatsApp Webhook] Error al procesar payload:', err.message, err.stack)
  );
});

// ── Procesamiento del payload ─────────────────────────────────────────────────

async function processPayload(payload) {
  console.log('[WhatsApp] processPayload — object:', payload.object);
  if (payload.object !== 'whatsapp_business_account') {
    console.warn('[WhatsApp] Ignorado: object no es whatsapp_business_account');
    return;
  }

  for (const entry of payload.entry || []) {
    console.log('[WhatsApp] Entry id:', entry.id);
    for (const change of entry.changes || []) {
      console.log('[WhatsApp] Change field:', change.field);
      if (change.field !== 'messages') continue;
      const value = change.value;

      console.log('[WhatsApp] Messages en payload:', (value.messages || []).length);
      console.log('[WhatsApp] Statuses en payload:', (value.statuses || []).length);

      // Mensajes de texto entrantes
      for (const message of value.messages || []) {
        console.log('[WhatsApp] Procesando mensaje id:', message.id, 'tipo:', message.type);
        await handleIncomingMessage(message, value.contacts?.[0]).catch(err =>
          console.error('[WhatsApp] Error al manejar mensaje:', err.message, err.stack)
        );
      }

      // Actualizaciones de estado (delivered, read, failed) — sólo log
      for (const status of value.statuses || []) {
        console.log(`[WhatsApp] Status "${status.status}" para wamid ${status.id}`);
      }
    }
  }
}

async function handleIncomingMessage(message, contact) {
  // Por ahora sólo procesamos texto; otros tipos se acusan pero no se procesan
  if (message.type !== 'text') {
    console.log(`[WhatsApp] Tipo no soportado: ${message.type} — respondiendo aviso`);
    if (isConfigured()) {
      await sendTextMessage(message.from, 'Por el momento sólo puedo procesar mensajes de texto. ¿En qué puedo ayudarte?').catch(() => {});
    }
    return;
  }

  const phoneNumber = message.from;                              // "5491112345678"
  const text        = message.text.body.trim();
  const wamid       = message.id;
  const clientName  = contact?.profile?.name || `+${phoneNumber}`;

  console.log(`[WhatsApp] Mensaje de ${clientName} (${phoneNumber}): "${text}"`);

  // Marcar como leído en WhatsApp
  if (isConfigured()) markAsRead(wamid);

  // ── Buscar conversación activa con este número ─────────────────
  let conv = db.prepare(`
    SELECT * FROM ai_conversations
    WHERE phone_number = ? AND status = 'active' AND channel = 'whatsapp'
    ORDER BY started_at DESC LIMIT 1
  `).get(phoneNumber);

  const settings = db.prepare('SELECT * FROM ai_settings WHERE id = 1').get();

  if (!conv) {
    // ── Crear nueva conversación ───────────────────────────────────
    const welcome = settings?.welcome_message || '¡Hola! ¿En qué puedo ayudarte?';

    // Auto-vincular si el teléfono ya corresponde a un cliente registrado
    const existingClient = db.prepare(
      'SELECT id, name FROM clients WHERE phone = ? AND active = 1 LIMIT 1'
    ).get(phoneNumber);

    const result = db.prepare(`
      INSERT INTO ai_conversations
        (client_id, client_name, channel, status, ai_active, phone_number, last_message, last_message_at)
      VALUES (?, ?, 'whatsapp', 'active', 1, ?, ?, datetime('now'))
    `).run(
      existingClient?.id   || null,
      existingClient?.name || clientName,
      phoneNumber,
      text
    );

    conv = db.prepare('SELECT * FROM ai_conversations WHERE id = ?').get(result.lastInsertRowid);
    if (existingClient) {
      console.log(`[WhatsApp] Cliente reconocido: "${existingClient.name}" (ID: ${existingClient.id})`);
    }

    // Guardar mensaje de bienvenida de la IA
    db.prepare(
      "INSERT INTO ai_messages (conversation_id, role, content) VALUES (?, 'assistant', ?)"
    ).run(conv.id, welcome);

    // Enviar bienvenida al número de WhatsApp
    if (settings?.ai_enabled && isConfigured()) {
      await sendTextMessage(phoneNumber, welcome).catch(err =>
        console.error('[WhatsApp] Error enviando bienvenida:', err.message)
      );
    }

    broadcast({ type: 'new_conversation', conversation: { ...conv, last_message: text } });
  }

  // ── Guardar el mensaje del usuario ────────────────────────────────
  const msgResult = db.prepare(`
    INSERT INTO ai_messages (conversation_id, role, content) VALUES (?, 'user', ?)
  `).run(conv.id, text);

  db.prepare(`
    UPDATE ai_conversations SET last_message = ?, last_message_at = datetime('now') WHERE id = ?
  `).run(text, conv.id);

  const savedMsg   = db.prepare('SELECT * FROM ai_messages WHERE id = ?').get(msgResult.lastInsertRowid);
  const updatedConv = db.prepare('SELECT * FROM ai_conversations WHERE id = ?').get(conv.id);

  broadcast({ type: 'new_message', conversation_id: conv.id, message: savedMsg, conversation: updatedConv });

  // Disparar respuesta de IA de forma asíncrona (no bloquea el webhook)
  console.log(`[WhatsApp] Disparando processAIResponse para conv #${conv.id} (ai_active=${conv.ai_active})`);
  processAIResponse(conv.id).catch(err =>
    console.error('[AI] Error procesando respuesta:', err.message, err.stack)
  );
}

module.exports = router;
