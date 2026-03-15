const express = require('express');
const { db } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { broadcast } = require('../config/ws-server');
const { processAIResponse } = require('../config/ai-handler');

const router = express.Router();

// ── helpers ────────────────────────────────────────────────────────────────
function getConversation(id) {
  return db.prepare(`
    SELECT c.*, op.name AS operator_name
    FROM ai_conversations c
    LEFT JOIN operators op ON op.id = c.operator_id
    WHERE c.id = ?
  `).get(id);
}

function getMessages(conversationId) {
  return db.prepare(
    'SELECT * FROM ai_messages WHERE conversation_id = ? ORDER BY created_at ASC'
  ).all(conversationId);
}

// ── Conversaciones activas ─────────────────────────────────────────────────

// GET /api/ai/conversations
router.get('/conversations', authenticate, (req, res) => {
  const convs = db.prepare(`
    SELECT c.*, op.name AS operator_name
    FROM ai_conversations c
    LEFT JOIN operators op ON op.id = c.operator_id
    WHERE c.status = 'active'
    ORDER BY c.last_message_at DESC
  `).all();
  res.json(convs);
});

// GET /api/ai/conversations/:id
router.get('/conversations/:id', authenticate, (req, res) => {
  const conv = getConversation(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversación no encontrada' });
  res.json({ ...conv, messages: getMessages(conv.id) });
});

// POST /api/ai/conversations  — crea una conversación nueva (demo/simulación)
router.post('/conversations', authenticate, (req, res) => {
  const { client_name, channel = 'web', initial_message } = req.body;
  if (!client_name) return res.status(400).json({ error: 'Nombre de cliente requerido' });

  const settings = db.prepare('SELECT * FROM ai_settings WHERE id = 1').get();
  const welcome = settings?.welcome_message || '¡Hola! ¿En qué puedo ayudarte?';

  const result = db.prepare(`
    INSERT INTO ai_conversations (client_name, channel, status, ai_active, last_message, last_message_at)
    VALUES (?, ?, 'active', 1, ?, datetime('now'))
  `).run(client_name, channel, initial_message || welcome);

  const convId = result.lastInsertRowid;

  // Mensaje de bienvenida de la IA
  db.prepare("INSERT INTO ai_messages (conversation_id, role, content) VALUES (?, 'assistant', ?)").run(convId, welcome);

  // Si hay mensaje inicial del usuario, agregarlo también
  if (initial_message) {
    db.prepare("INSERT INTO ai_messages (conversation_id, role, content) VALUES (?, 'user', ?)").run(convId, initial_message);
    db.prepare("UPDATE ai_conversations SET last_message = ? WHERE id = ?").run(initial_message, convId);
  }

  const conv = getConversation(convId);
  broadcast({ type: 'new_conversation', conversation: { ...conv, messages: getMessages(convId) } });
  res.status(201).json(conv);
});

// PUT /api/ai/conversations/:id/takeover — operador toma control
router.put('/conversations/:id/takeover', authenticate, (req, res) => {
  const conv = getConversation(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversación no encontrada' });
  if (conv.status !== 'active') return res.status(400).json({ error: 'Conversación no está activa' });

  db.prepare(`
    UPDATE ai_conversations SET ai_active = 0, operator_id = ? WHERE id = ?
  `).run(req.user.id, conv.id);

  const updated = getConversation(conv.id);
  broadcast({ type: 'conversation_updated', conversation: updated });
  res.json(updated);
});

// PUT /api/ai/conversations/:id/return — devolver a la IA
router.put('/conversations/:id/return', authenticate, (req, res) => {
  const conv = getConversation(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversación no encontrada' });

  db.prepare(`
    UPDATE ai_conversations SET ai_active = 1, operator_id = NULL WHERE id = ?
  `).run(conv.id);

  const updated = getConversation(conv.id);
  broadcast({ type: 'conversation_updated', conversation: updated });
  res.json(updated);
});

// POST /api/ai/conversations/:id/messages — enviar mensaje
// role: 'operator' (requiere que el operador haya tomado control) o 'user' (simulación)
router.post('/conversations/:id/messages', authenticate, (req, res) => {
  const { content, role = 'operator' } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'El mensaje no puede estar vacío' });

  const conv = getConversation(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversación no encontrada' });
  if (conv.status !== 'active') return res.status(400).json({ error: 'Conversación cerrada' });
  if (role === 'operator' && conv.ai_active) {
    return res.status(400).json({ error: 'Tomá control de la conversación antes de escribir' });
  }

  const result = db.prepare(`
    INSERT INTO ai_messages (conversation_id, role, content) VALUES (?, ?, ?)
  `).run(conv.id, role, content.trim());

  db.prepare(`
    UPDATE ai_conversations SET last_message = ?, last_message_at = datetime('now') WHERE id = ?
  `).run(content.trim(), conv.id);

  const message = db.prepare('SELECT * FROM ai_messages WHERE id = ?').get(result.lastInsertRowid);
  const updatedConv = getConversation(conv.id);

  broadcast({ type: 'new_message', conversation_id: conv.id, message, conversation: updatedConv });

  // Si es un mensaje de usuario (simulación) y la IA está activa, disparar respuesta IA
  if (role === 'user' && conv.ai_active) {
    processAIResponse(conv.id).catch(err =>
      console.error('[AI] Error procesando respuesta:', err.message)
    );
  }

  // Si es respuesta de operador en conversación de WhatsApp, enviar via API
  if (role === 'operator' && conv.channel === 'whatsapp' && conv.phone_number) {
    const { sendTextMessage, isConfigured } = require('../config/whatsapp');
    if (isConfigured()) {
      sendTextMessage(conv.phone_number, content.trim()).catch(err =>
        console.error('[WhatsApp] Error al enviar respuesta del operador:', err.message)
      );
    }
  }

  res.status(201).json(message);
});

// PUT /api/ai/conversations/:id/close — cerrar conversación
router.put('/conversations/:id/close', authenticate, (req, res) => {
  const conv = getConversation(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversación no encontrada' });

  db.prepare("UPDATE ai_conversations SET status = 'closed' WHERE id = ?").run(conv.id);
  broadcast({ type: 'conversation_closed', conversation_id: conv.id });
  res.json({ success: true });
});

// ── Historial ──────────────────────────────────────────────────────────────

// GET /api/ai/history?client_name=&date_from=&date_to=&has_order=
router.get('/history', authenticate, (req, res) => {
  const { client_name, date_from, date_to, has_order } = req.query;
  let query = `
    SELECT c.*, op.name AS operator_name
    FROM ai_conversations c
    LEFT JOIN operators op ON op.id = c.operator_id
    WHERE c.status = 'closed'
  `;
  const params = [];

  if (client_name) {
    query += ' AND c.client_name LIKE ?';
    params.push(`%${client_name}%`);
  }
  if (date_from) {
    query += ' AND date(c.started_at) >= ?';
    params.push(date_from);
  }
  if (date_to) {
    query += ' AND date(c.started_at) <= ?';
    params.push(date_to);
  }
  if (has_order === 'true') {
    query += ' AND c.generated_order_id IS NOT NULL';
  } else if (has_order === 'false') {
    query += ' AND c.generated_order_id IS NULL';
  }

  query += ' ORDER BY c.last_message_at DESC';

  const rows = db.prepare(query).all(...params);

  // Agregar count de mensajes
  const countStmt = db.prepare('SELECT COUNT(*) as cnt FROM ai_messages WHERE conversation_id = ?');
  const result = rows.map(r => ({ ...r, message_count: countStmt.get(r.id)?.cnt || 0 }));
  res.json(result);
});

// GET /api/ai/history/:id
router.get('/history/:id', authenticate, (req, res) => {
  const conv = db.prepare(`
    SELECT c.*, op.name AS operator_name
    FROM ai_conversations c
    LEFT JOIN operators op ON op.id = c.operator_id
    WHERE c.id = ? AND c.status = 'closed'
  `).get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversación no encontrada' });
  res.json({ ...conv, messages: getMessages(conv.id) });
});

// ── Configuración de IA ────────────────────────────────────────────────────

// GET /api/ai/settings
router.get('/settings', authenticate, (req, res) => {
  const settings = db.prepare('SELECT * FROM ai_settings WHERE id = 1').get();
  if (!settings) return res.status(404).json({ error: 'Configuración no encontrada' });
  res.json({ ...settings, business_hours: JSON.parse(settings.business_hours || '{}') });
});

// PUT /api/ai/settings
router.put('/settings', authenticate, (req, res) => {
  const { assistant_name, welcome_message, business_hours, special_instructions, ai_enabled } = req.body;
  db.prepare(`
    UPDATE ai_settings SET
      assistant_name       = COALESCE(?, assistant_name),
      welcome_message      = COALESCE(?, welcome_message),
      business_hours       = COALESCE(?, business_hours),
      special_instructions = COALESCE(?, special_instructions),
      ai_enabled           = COALESCE(?, ai_enabled),
      updated_at           = datetime('now')
    WHERE id = 1
  `).run(
    assistant_name ?? null,
    welcome_message ?? null,
    business_hours ? JSON.stringify(business_hours) : null,
    special_instructions ?? null,
    ai_enabled !== undefined ? (ai_enabled ? 1 : 0) : null
  );

  const updated = db.prepare('SELECT * FROM ai_settings WHERE id = 1').get();
  broadcast({ type: 'settings_updated', ai_enabled: updated.ai_enabled });
  res.json({ ...updated, business_hours: JSON.parse(updated.business_hours || '{}') });
});

module.exports = router;
