const express = require('express');
const { db } = require('../config/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// GET /api/clients
router.get('/', authenticate, (req, res) => {
  const { search, active } = req.query;
  let query = 'SELECT * FROM clients WHERE 1=1';
  const params = [];

  if (active !== undefined) {
    query += ' AND active = ?';
    params.push(active === 'true' ? 1 : 0);
  } else {
    query += ' AND active = 1';
  }

  if (search) {
    query += ' AND (name LIKE ? OR business_name LIKE ? OR tax_id LIKE ?)';
    const s = `%${search}%`;
    params.push(s, s, s);
  }

  query += ' ORDER BY name';
  res.json(db.prepare(query).all(...params));
});

// GET /api/clients/:id
router.get('/:id', authenticate, (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  res.json(client);
});

// POST /api/clients
router.post('/', authenticate, (req, res) => {
  const { name, business_name, tax_id, phone, email, address, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'El nombre del cliente es requerido' });

  const result = db.prepare(`
    INSERT INTO clients (name, business_name, tax_id, phone, email, address, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(name, business_name || null, tax_id || null, phone || null, email || null, address || null, notes || null);

  res.status(201).json({ id: result.lastInsertRowid, name, business_name, tax_id, phone, email, address, notes, active: 1 });
});

// PUT /api/clients/:id
router.put('/:id', authenticate, (req, res) => {
  const { name, business_name, tax_id, phone, email, address, notes, active } = req.body;
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });

  db.prepare(`
    UPDATE clients SET name=?, business_name=?, tax_id=?, phone=?, email=?, address=?, notes=?, active=?
    WHERE id=?
  `).run(
    name ?? client.name,
    business_name ?? client.business_name,
    tax_id ?? client.tax_id,
    phone ?? client.phone,
    email ?? client.email,
    address ?? client.address,
    notes ?? client.notes,
    active ?? client.active,
    client.id
  );

  res.json({ ...client, name, business_name, tax_id, phone, email, address, notes, active });
});

// DELETE /api/clients/:id (soft delete)
router.delete('/:id', authenticate, (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  db.prepare('UPDATE clients SET active = 0 WHERE id = ?').run(client.id);
  res.json({ success: true });
});

module.exports = router;
