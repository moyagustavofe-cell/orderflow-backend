const express = require('express');
const { db } = require('../config/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

function generateOrderNumber() {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.floor(Math.random() * 9000) + 1000;
  return `ORD-${date}-${rand}`;
}

// GET /api/orders - con filtros
router.get('/', authenticate, (req, res) => {
  const { status, date, client_id, today } = req.query;
  let query = `
    SELECT o.*, c.name as client_name, op.name as operator_name
    FROM orders o
    JOIN clients c ON c.id = o.client_id
    JOIN operators op ON op.id = o.operator_id
    WHERE 1=1
  `;
  const params = [];

  if (today === 'true') {
    query += " AND date(o.created_at) = date('now')";
  } else if (date) {
    query += ' AND date(o.created_at) = ?';
    params.push(date);
  }

  if (status) {
    query += ' AND o.status = ?';
    params.push(status);
  }

  if (client_id) {
    query += ' AND o.client_id = ?';
    params.push(client_id);
  }

  query += ' ORDER BY o.created_at DESC';
  res.json(db.prepare(query).all(...params));
});

// GET /api/orders/stats - estadísticas del día
router.get('/stats', authenticate, (req, res) => {
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) as confirmed,
      SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) as delivered,
      COALESCE(SUM(CASE WHEN status != 'cancelled' THEN total ELSE 0 END), 0) as revenue
    FROM orders
    WHERE date(created_at) = date('now')
  `).get();
  res.json(stats);
});

// GET /api/orders/:id
router.get('/:id', authenticate, (req, res) => {
  const order = db.prepare(`
    SELECT o.*, c.name as client_name, c.phone as client_phone, op.name as operator_name
    FROM orders o
    JOIN clients c ON c.id = o.client_id
    JOIN operators op ON op.id = o.operator_id
    WHERE o.id = ?
  `).get(req.params.id);

  if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });

  const items = db.prepare(`
    SELECT oi.*, p.code, p.name as product_name, p.unit
    FROM order_items oi
    JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id = ?
  `).all(order.id);

  res.json({ ...order, items });
});

// POST /api/orders
router.post('/', authenticate, (req, res) => {
  const { client_id, delivery_date, notes, items } = req.body;
  if (!client_id || !items || items.length === 0) {
    return res.status(400).json({ error: 'Cliente e items son requeridos' });
  }

  const total = items.reduce((sum, item) => sum + (item.quantity * item.unit_price), 0);
  const order_number = generateOrderNumber();

  const insertOrder = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO orders (order_number, client_id, operator_id, status, notes, delivery_date, total)
      VALUES (?, ?, ?, 'pending', ?, ?, ?)
    `).run(order_number, client_id, req.user.id, notes || null, delivery_date || null, total);

    const orderId = result.lastInsertRowid;
    const insertItem = db.prepare(`
      INSERT INTO order_items (order_id, product_id, quantity, unit_price, subtotal) VALUES (?, ?, ?, ?, ?)
    `);
    for (const item of items) {
      insertItem.run(orderId, item.product_id, item.quantity, item.unit_price, item.quantity * item.unit_price);
    }
    return orderId;
  });

  const orderId = insertOrder();
  res.status(201).json({ id: orderId, order_number, total, status: 'pending' });
});

// PUT /api/orders/:id/status
router.put('/:id/status', authenticate, (req, res) => {
  const { status } = req.body;
  const validStatuses = ['pending', 'confirmed', 'delivered', 'cancelled'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Estado inválido' });
  }

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });

  db.prepare("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, order.id);
  res.json({ success: true, status });
});

// PUT /api/orders/:id - actualizar pedido (solo si está pendiente)
router.put('/:id', authenticate, (req, res) => {
  const { client_id, notes, delivery_date, items } = req.body;
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
  if (order.status !== 'pending') {
    return res.status(400).json({ error: 'Solo se pueden editar pedidos en estado pendiente' });
  }

  const updateOrder = db.transaction(() => {
    let total = order.total;
    if (items && items.length > 0) {
      total = items.reduce((sum, item) => sum + (item.quantity * item.unit_price), 0);
      db.prepare('DELETE FROM order_items WHERE order_id = ?').run(order.id);
      const insertItem = db.prepare(
        'INSERT INTO order_items (order_id, product_id, quantity, unit_price, subtotal) VALUES (?, ?, ?, ?, ?)'
      );
      for (const item of items) {
        insertItem.run(order.id, item.product_id, item.quantity, item.unit_price, item.quantity * item.unit_price);
      }
    }
    db.prepare(`
      UPDATE orders SET client_id=?, notes=?, delivery_date=?, total=?, updated_at=datetime('now') WHERE id=?
    `).run(
      client_id ?? order.client_id,
      notes ?? order.notes,
      delivery_date ?? order.delivery_date,
      total,
      order.id
    );
  });

  updateOrder();
  res.json({ success: true });
});

// DELETE /api/orders/:id (cancelar)
router.delete('/:id', authenticate, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
  if (order.status === 'delivered') return res.status(400).json({ error: 'No se puede cancelar un pedido entregado' });
  db.prepare("UPDATE orders SET status='cancelled', updated_at=datetime('now') WHERE id=?").run(order.id);
  res.json({ success: true });
});

module.exports = router;
