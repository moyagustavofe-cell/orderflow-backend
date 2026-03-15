const express = require('express');
const { db } = require('../config/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// Parsea el string "1,2,3" que devuelve GROUP_CONCAT en un array de números
function parseIds(str) {
  if (!str) return [];
  return str.split(',').map(Number).filter(Boolean);
}

// GET /api/prices — listas con sus clientes asignados
// ?client_id=X  → sólo listas que tengan ese cliente asignado, ordenadas por created_at DESC
//                 (la más reciente primero, que tiene prioridad según la regla de negocio)
router.get('/', authenticate, (req, res) => {
  const { client_id } = req.query;

  let query = `
    SELECT
      pl.id, pl.name, pl.active, pl.created_at,
      GROUP_CONCAT(plc.client_id)          AS client_ids_str,
      GROUP_CONCAT(c.name, ' | ')          AS client_names_str
    FROM price_lists pl
    LEFT JOIN price_list_clients plc ON plc.price_list_id = pl.id
    LEFT JOIN clients c ON c.id = plc.client_id
    WHERE pl.active = 1
  `;
  const params = [];

  if (client_id) {
    // Filtra sólo listas que tengan este cliente, via subquery
    query += ` AND pl.id IN (
      SELECT price_list_id FROM price_list_clients WHERE client_id = ?
    )`;
    params.push(client_id);
  }

  // Agrupa para que GROUP_CONCAT funcione y ordena más reciente primero
  query += ' GROUP BY pl.id ORDER BY pl.created_at DESC';

  const rows = db.prepare(query).all(...params);
  const result = rows.map(r => ({
    ...r,
    client_ids: parseIds(r.client_ids_str),
    client_names: r.client_names_str || '',
    client_ids_str: undefined,
    client_names_str: undefined,
  }));
  res.json(result);
});

// GET /api/prices/:id — lista con sus items y clientes
router.get('/:id', authenticate, (req, res) => {
  const list = db.prepare(`
    SELECT pl.id, pl.name, pl.active, pl.created_at,
           GROUP_CONCAT(plc.client_id)       AS client_ids_str,
           GROUP_CONCAT(c.name, ' | ')       AS client_names_str
    FROM price_lists pl
    LEFT JOIN price_list_clients plc ON plc.price_list_id = pl.id
    LEFT JOIN clients c ON c.id = plc.client_id
    WHERE pl.id = ?
    GROUP BY pl.id
  `).get(req.params.id);

  if (!list) return res.status(404).json({ error: 'Lista de precios no encontrada' });

  const items = db.prepare(`
    SELECT pli.*, p.code, p.name AS product_name, p.unit
    FROM price_list_items pli
    JOIN products p ON p.id = pli.product_id
    WHERE pli.price_list_id = ?
    ORDER BY p.name
  `).all(list.id);

  res.json({
    ...list,
    client_ids: parseIds(list.client_ids_str),
    client_names: list.client_names_str || '',
    client_ids_str: undefined,
    client_names_str: undefined,
    items,
  });
});

// POST /api/prices — crear lista con múltiples clientes
router.post('/', authenticate, (req, res) => {
  const { name, client_ids, items } = req.body;
  if (!name) return res.status(400).json({ error: 'El nombre de la lista es requerido' });
  if (!client_ids || client_ids.length === 0) return res.status(400).json({ error: 'Asignar al menos un cliente' });

  const create = db.transaction(() => {
    const result = db.prepare('INSERT INTO price_lists (name) VALUES (?)').run(name);
    const listId = result.lastInsertRowid;

    const insertClient = db.prepare('INSERT OR IGNORE INTO price_list_clients (price_list_id, client_id) VALUES (?, ?)');
    for (const cid of client_ids) insertClient.run(listId, cid);

    if (items && items.length > 0) {
      const insertItem = db.prepare('INSERT INTO price_list_items (price_list_id, product_id, price) VALUES (?, ?, ?)');
      for (const item of items) insertItem.run(listId, item.product_id, item.price);
    }
    return listId;
  });

  const id = create();
  res.status(201).json({ id, name, client_ids });
});

// PUT /api/prices/:id — actualizar nombre, clientes e items
router.put('/:id', authenticate, (req, res) => {
  const { name, client_ids, items } = req.body;
  const list = db.prepare('SELECT * FROM price_lists WHERE id = ?').get(req.params.id);
  if (!list) return res.status(404).json({ error: 'Lista de precios no encontrada' });

  const update = db.transaction(() => {
    if (name) db.prepare('UPDATE price_lists SET name = ? WHERE id = ?').run(name, list.id);

    if (client_ids !== undefined) {
      if (client_ids.length === 0) throw new Error('Asignar al menos un cliente');
      db.prepare('DELETE FROM price_list_clients WHERE price_list_id = ?').run(list.id);
      const insertClient = db.prepare('INSERT OR IGNORE INTO price_list_clients (price_list_id, client_id) VALUES (?, ?)');
      for (const cid of client_ids) insertClient.run(list.id, cid);
    }

    if (items !== undefined) {
      db.prepare('DELETE FROM price_list_items WHERE price_list_id = ?').run(list.id);
      if (items.length > 0) {
        const insertItem = db.prepare('INSERT INTO price_list_items (price_list_id, product_id, price) VALUES (?, ?, ?)');
        for (const item of items) insertItem.run(list.id, item.product_id, item.price);
      }
    }
  });

  try {
    update();
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/prices/:id (soft delete)
router.delete('/:id', authenticate, (req, res) => {
  const list = db.prepare('SELECT * FROM price_lists WHERE id = ?').get(req.params.id);
  if (!list) return res.status(404).json({ error: 'Lista de precios no encontrada' });
  db.prepare('UPDATE price_lists SET active = 0 WHERE id = ?').run(list.id);
  res.json({ success: true });
});

module.exports = router;
