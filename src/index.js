require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { initDatabase } = require('./config/database');
const { setupWebSocket } = require('./config/ws-server');

const app = express();
const PORT = process.env.PORT || 3002;

app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5173', credentials: true }));
app.use(express.json());

// Rutas REST
app.use('/api/auth',    require('./routes/auth'));
app.use('/api/clients', require('./routes/clients'));
app.use('/api/products',require('./routes/products'));
app.use('/api/prices',  require('./routes/prices'));
app.use('/api/orders',  require('./routes/orders'));
app.use('/api/ai',      require('./routes/ai'));
app.use('/api/whatsapp', require('./routes/webhook'));

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// 404
app.use((req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Error interno del servidor' });
});

initDatabase();

const server = app.listen(PORT, () => {
  console.log(`\n🚀 OrderFlow API corriendo en http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/api/health\n`);
});

setupWebSocket(server);
