const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db } = require('../config/database');
const { authenticate, requireAdmin } = require('../middleware/auth');
require('dotenv').config();

const router = express.Router();

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
  }

  const operator = db.prepare('SELECT * FROM operators WHERE username = ? AND active = 1').get(username);

  if (!operator) {
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  }

  const valid = bcrypt.compareSync(password, operator.password);
  if (!valid) {
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  }

  const token = jwt.sign(
    { id: operator.id, username: operator.username, name: operator.name, role: operator.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );

  res.json({
    token,
    user: { id: operator.id, username: operator.username, name: operator.name, role: operator.role }
  });
});

// GET /api/auth/me
router.get('/me', authenticate, (req, res) => {
  const operator = db.prepare('SELECT id, name, username, role FROM operators WHERE id = ?').get(req.user.id);
  if (!operator) return res.status(404).json({ error: 'Operador no encontrado' });
  res.json(operator);
});

// GET /api/auth/operators
router.get('/operators', authenticate, requireAdmin, (req, res) => {
  const operators = db.prepare('SELECT id, name, username, role, active, created_at FROM operators ORDER BY name').all();
  res.json(operators);
});

// POST /api/auth/operators
router.post('/operators', authenticate, requireAdmin, (req, res) => {
  const { name, username, password, role } = req.body;
  if (!name || !username || !password) {
    return res.status(400).json({ error: 'Nombre, usuario y contraseña son requeridos' });
  }
  const hash = bcrypt.hashSync(password, 10);
  try {
    const result = db.prepare('INSERT INTO operators (name, username, password, role) VALUES (?, ?, ?, ?)').run(name, username, hash, role || 'operator');
    res.status(201).json({ id: result.lastInsertRowid, name, username, role: role || 'operator' });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'El nombre de usuario ya existe' });
    res.status(500).json({ error: 'Error al crear operador' });
  }
});

// PUT /api/auth/operators/:id/toggle
router.put('/operators/:id/toggle', authenticate, requireAdmin, (req, res) => {
  const op = db.prepare('SELECT * FROM operators WHERE id = ?').get(req.params.id);
  if (!op) return res.status(404).json({ error: 'Operador no encontrado' });
  db.prepare('UPDATE operators SET active = ? WHERE id = ?').run(op.active ? 0 : 1, op.id);
  res.json({ success: true });
});

module.exports = router;
