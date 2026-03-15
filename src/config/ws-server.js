const { WebSocketServer, OPEN } = require('ws');
const jwt = require('jsonwebtoken');
require('dotenv').config();

let wss = null;
const clients = new Map(); // ws → { id, name, role }

function setupWebSocket(httpServer) {
  wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      clients.set(ws, { id: decoded.id, name: decoded.name, role: decoded.role });
      ws.send(JSON.stringify({ type: 'connected', user: decoded.name }));
      ws.on('close', () => clients.delete(ws));
      ws.on('error', () => clients.delete(ws));
    } catch {
      ws.close(1008, 'Unauthorized');
    }
  });

  console.log('✓ WebSocket server listo en /ws');
}

function broadcast(data, excludeWs = null) {
  if (!wss) return;
  const msg = JSON.stringify(data);
  clients.forEach((_, ws) => {
    if (ws !== excludeWs && ws.readyState === OPEN) ws.send(msg);
  });
}

function connectedCount() {
  return clients.size;
}

module.exports = { setupWebSocket, broadcast, connectedCount };
