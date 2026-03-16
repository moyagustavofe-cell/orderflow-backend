const { DatabaseSync } = require('node:sqlite');
const path = require('path');
require('dotenv').config();

const DB_PATH = path.resolve(process.env.DB_PATH || './orderflow.db');
const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

function initDatabase() {
  // price_lists ya no tiene client_id (nuevo esquema para instalaciones frescas)
  db.exec(`
    CREATE TABLE IF NOT EXISTS operators (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'operator',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      business_name TEXT,
      tax_id TEXT,
      phone TEXT,
      email TEXT,
      address TEXT,
      notes TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      unit TEXT NOT NULL DEFAULT 'unidad',
      base_price REAL NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS price_lists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS price_list_clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      price_list_id INTEGER NOT NULL,
      client_id INTEGER NOT NULL,
      FOREIGN KEY (price_list_id) REFERENCES price_lists(id) ON DELETE CASCADE,
      FOREIGN KEY (client_id) REFERENCES clients(id),
      UNIQUE(price_list_id, client_id)
    );

    CREATE TABLE IF NOT EXISTS price_list_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      price_list_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      price REAL NOT NULL,
      FOREIGN KEY (price_list_id) REFERENCES price_lists(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id),
      UNIQUE(price_list_id, product_id)
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT UNIQUE NOT NULL,
      client_id INTEGER NOT NULL,
      operator_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      notes TEXT,
      delivery_date TEXT,
      total REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (client_id) REFERENCES clients(id),
      FOREIGN KEY (operator_id) REFERENCES operators(id)
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity REAL NOT NULL,
      unit_price REAL NOT NULL,
      subtotal REAL NOT NULL,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS ai_settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      assistant_name TEXT NOT NULL DEFAULT 'Asistente OrderFlow',
      welcome_message TEXT NOT NULL DEFAULT '¡Hola! ¿En qué puedo ayudarte hoy?',
      business_hours TEXT NOT NULL DEFAULT '{}',
      special_instructions TEXT NOT NULL DEFAULT '',
      ai_enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ai_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER,
      client_name TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'web',
      status TEXT NOT NULL DEFAULT 'active',
      ai_active INTEGER NOT NULL DEFAULT 1,
      operator_id INTEGER,
      generated_order_id INTEGER,
      last_message TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_message_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (client_id) REFERENCES clients(id),
      FOREIGN KEY (operator_id) REFERENCES operators(id)
    );

    CREATE TABLE IF NOT EXISTS ai_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE
    );
  `);

  // ── Migración: price_lists con client_id → price_list_clients ──────────────
  // Se ejecuta una sola vez en instalaciones previas que tenían client_id en price_lists
  const cols = db.prepare("PRAGMA table_info(price_lists)").all();
  const hasLegacyClientId = cols.some(c => c.name === 'client_id');
  if (hasLegacyClientId) {
    // Copiar relaciones existentes a la tabla junction
    db.exec(`INSERT OR IGNORE INTO price_list_clients (price_list_id, client_id)
             SELECT id, client_id FROM price_lists WHERE client_id IS NOT NULL`);
    // Recrear price_lists sin client_id (con foreign_keys OFF para evitar errores)
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`
      ALTER TABLE price_lists RENAME TO _price_lists_old;
      CREATE TABLE price_lists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO price_lists (id, name, active, created_at)
        SELECT id, name, active, created_at FROM _price_lists_old;
      DROP TABLE _price_lists_old;
    `);
    db.exec('PRAGMA foreign_keys = ON');
    console.log('✓ Migración: listas de precios ahora soportan múltiples clientes');
  }

  // Seeds
  const bcrypt = require('bcryptjs');
  const existingAdmin = db.prepare('SELECT id FROM operators WHERE username = ?').get('admin');
  if (!existingAdmin) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO operators (name, username, password, role) VALUES (?, ?, ?, ?)').run('Administrador', 'admin', hash, 'admin');
    console.log('✓ Operador admin creado (usuario: admin, contraseña: admin123)');
  }

  const existingProduct = db.prepare('SELECT id FROM products WHERE code = ?').get('PROD-001');
  if (!existingProduct) {
    db.prepare('INSERT INTO products (code, name, unit, base_price) VALUES (?, ?, ?, ?)').run('PROD-001', 'Producto A', 'kg', 150.00);
    db.prepare('INSERT INTO products (code, name, unit, base_price) VALUES (?, ?, ?, ?)').run('PROD-002', 'Producto B', 'unidad', 80.00);
    db.prepare('INSERT INTO products (code, name, unit, base_price) VALUES (?, ?, ?, ?)').run('PROD-003', 'Producto C', 'litro', 200.00);
    console.log('✓ Productos de ejemplo creados');
  }

  // ── Migración: phone_number en ai_conversations ────────────────────────────
  const convCols = db.prepare('PRAGMA table_info(ai_conversations)').all();
  if (!convCols.some(c => c.name === 'phone_number')) {
    db.exec('ALTER TABLE ai_conversations ADD COLUMN phone_number TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_ai_conv_phone ON ai_conversations(phone_number, status, channel)');
    console.log('✓ Migración: ai_conversations.phone_number agregado');
  }

  // ── Migración: urgent en ai_conversations ─────────────────────────────────
  if (!convCols.some(c => c.name === 'urgent')) {
    db.exec('ALTER TABLE ai_conversations ADD COLUMN urgent INTEGER NOT NULL DEFAULT 0');
    console.log('✓ Migración: ai_conversations.urgent agregado');
  }

  // Seed: configuración de IA por defecto
  const defaultHours = JSON.stringify({
    mon: { e: 1, o: '09:00', c: '18:00' }, tue: { e: 1, o: '09:00', c: '18:00' },
    wed: { e: 1, o: '09:00', c: '18:00' }, thu: { e: 1, o: '09:00', c: '18:00' },
    fri: { e: 1, o: '09:00', c: '17:00' }, sat: { e: 0, o: '', c: '' },
    sun: { e: 0, o: '', c: '' },
  });
  db.prepare(`
    INSERT OR IGNORE INTO ai_settings (id, assistant_name, welcome_message, business_hours, special_instructions, ai_enabled)
    VALUES (1, ?, ?, ?, ?, 1)
  `).run(
    'Asistente OrderFlow',
    '¡Hola! Soy el asistente de OrderFlow. ¿En qué puedo ayudarte hoy?',
    defaultHours,
    'Sos un asistente amable de un centro de producción. Ayudás a los clientes a hacer pedidos, consultar precios y resolver dudas. Respondé siempre en español.'
  );

  // Seed: conversaciones demo
  const hasConvSeed = db.prepare('SELECT id FROM ai_conversations LIMIT 1').get();
  if (!hasConvSeed) {
    function minsAgo(n) {
      return new Date(Date.now() - n * 60 * 1000).toISOString().replace('T', ' ').split('.')[0];
    }
    // Conv 1: IA activa
    db.prepare(`INSERT INTO ai_conversations (id, client_name, channel, status, ai_active, last_message, started_at, last_message_at)
                VALUES (1, 'María García', 'web', 'active', 1, '¿Cuándo puedo recibir el pedido?', ?, ?)`).run(minsAgo(18), minsAgo(3));
    [
      ['user',      '¡Hola! Quiero hacer un pedido de Producto A.',        minsAgo(18)],
      ['assistant', '¡Hola María! Con mucho gusto. ¿Qué cantidad necesitás de Producto A?', minsAgo(17)],
      ['user',      'Necesito 5 kg.',                                       minsAgo(15)],
      ['assistant', 'Perfecto. El precio actual es $150/kg, total $750. ¿Confirmamos el pedido?', minsAgo(14)],
      ['user',      'Sí, confirmado. ¿Cuándo puedo recibir el pedido?',    minsAgo(3)],
    ].forEach(([role, content, ts]) =>
      db.prepare('INSERT INTO ai_messages (conversation_id, role, content, created_at) VALUES (1, ?, ?, ?)').run(role, content, ts)
    );
    // Conv 2: operador tomó control
    db.prepare(`INSERT INTO ai_conversations (id, client_name, channel, status, ai_active, last_message, started_at, last_message_at)
                VALUES (2, 'Carlos Rodríguez', 'web', 'active', 0, 'Necesito el precio especial que acordamos', ?, ?)`).run(minsAgo(40), minsAgo(8));
    [
      ['user',      'Hola, necesito hacer un pedido grande.',                minsAgo(40)],
      ['assistant', '¡Hola Carlos! ¿Qué productos y cantidades necesitás?', minsAgo(39)],
      ['user',      'Quiero 50 kg de Producto A y 30 litros de Producto C.', minsAgo(35)],
      ['assistant', 'El total sería $11.100. ¿Querés proceder?',             minsAgo(34)],
      ['user',      'Necesito el precio especial que acordamos.',             minsAgo(8)],
      ['operator',  'Hola Carlos, soy Juan del equipo. Te aplico el descuento acordado. Dame un momento.', minsAgo(7)],
    ].forEach(([role, content, ts]) =>
      db.prepare('INSERT INTO ai_messages (conversation_id, role, content, created_at) VALUES (2, ?, ?, ?)').run(role, content, ts)
    );
    // Conv 3: cerrada (para historial)
    db.prepare(`INSERT INTO ai_conversations (id, client_name, channel, status, ai_active, last_message, started_at, last_message_at)
                VALUES (3, 'Laura Martínez', 'web', 'closed', 1, 'Gracias, hasta luego.', ?, ?)`).run(minsAgo(120), minsAgo(90));
    [
      ['user',      'Hola, ¿tienen disponible el Producto B?',               minsAgo(120)],
      ['assistant', '¡Hola Laura! Sí, el Producto B está disponible a $80/unidad.', minsAgo(119)],
      ['user',      'Genial. Quiero 10 unidades.',                           minsAgo(115)],
      ['assistant', 'Perfecto, total $800. ¿Confirmo el pedido?',           minsAgo(114)],
      ['user',      'Sí.',                                                   minsAgo(110)],
      ['assistant', '¡Listo! Tu pedido fue registrado. ¿Algo más?',         minsAgo(109)],
      ['user',      'No, gracias, hasta luego.',                             minsAgo(91)],
      ['assistant', '¡Hasta luego! Fue un placer atenderte.',               minsAgo(90)],
    ].forEach(([role, content, ts]) =>
      db.prepare('INSERT INTO ai_messages (conversation_id, role, content, created_at) VALUES (3, ?, ?, ?)').run(role, content, ts)
    );
    console.log('✓ Conversaciones demo de IA creadas');
  }

  console.log('✓ Base de datos inicializada');
}

// Wrapper de transacciones
db.transaction = function(fn) {
  return function(...args) {
    db.exec('BEGIN');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };
};

module.exports = { db, initDatabase };
