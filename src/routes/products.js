const express = require('express');
const { db } = require('../config/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// GET /api/products
router.get('/', authenticate, (req, res) => {
  const products = db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY name').all();
  res.json(products);
});

// POST /api/products
router.post('/', authenticate, (req, res) => {
  const { code, name, description, unit, base_price } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'Código y nombre son requeridos' });

  try {
    const result = db.prepare(`
      INSERT INTO products (code, name, description, unit, base_price) VALUES (?, ?, ?, ?, ?)
    `).run(code, name, description || null, unit || 'unidad', base_price || 0);
    res.status(201).json({ id: result.lastInsertRowid, code, name, description, unit, base_price });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'El código de producto ya existe' });
    res.status(500).json({ error: 'Error al crear producto' });
  }
});

// PUT /api/products/:id
router.put('/:id', authenticate, (req, res) => {
  const { code, name, description, unit, base_price, active } = req.body;
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Producto no encontrado' });

  db.prepare(`
    UPDATE products SET code=?, name=?, description=?, unit=?, base_price=?, active=? WHERE id=?
  `).run(
    code ?? product.code,
    name ?? product.name,
    description ?? product.description,
    unit ?? product.unit,
    base_price ?? product.base_price,
    active ?? product.active,
    product.id
  );
  res.json({ success: true });
});

module.exports = router;
