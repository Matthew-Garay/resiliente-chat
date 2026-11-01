/**
 * Resiliente Chat - Servidor WebSocket para chat web global
 * Diseñado para ser difícil de bloquear y funcionar en cualquier red
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

const wss = new WebSocket.Server({
  server,
  path: '/ws',
  perMessageDeflate: false,
  clientTracking: true
});

app.use(require('helmet')());
app.use(require('cors')({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(require('compression')());

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const clients = new Map();
const messageHistory = [];
const MAX_HISTORY = 100;

const USER_COLORS = [
  '#ff6b6b', '#4ecdc4', '#45b7d1', '#f9ca24', '#f0932b',
  '#eb4d4b', '#6ab04c', '#a29bfe', '#fd79a8', '#ffeaa7'
];

function broadcast(data, excludeWs = null) {
  const message = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

function addToHistory(message) {
  messageHistory.push(message);
  if (messageHistory.length > MAX_HISTORY) {
    messageHistory.shift();
  }
}

wss.on('connection', (ws, req) => {
  const clientId = uuidv4();
  const clientColor = USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)];
  
  clients.set(ws, {
    id: clientId,
    username: `Usuario_${clientId.slice(0, 4)}`,
    color: clientColor,
    joinedAt: new Date().toISOString(),
    ip: req.socket.remoteAddress || 'unknown'
  });

  console.log(`[${new Date().toISOString()}] Nuevo cliente: ${clientId} desde ${req.socket.remoteAddress}`);

  if (messageHistory.length > 0) {
    ws.send(JSON.stringify({
      type: 'history',
      messages: messageHistory.slice(-50)
    }));
  }

  const joinMessage = {
    type: 'system',
    message: `👋 ${clients.get(ws).username} se ha unido al chat`,
    username: 'Sistema',
    color: '#95a5a6',
    timestamp: new Date().toISOString(),
    id: uuidv4()
  };
  addToHistory(joinMessage);
  broadcast(joinMessage);

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      const clientInfo = clients.get(ws);

      if (!clientInfo) return;

      switch (data.type) {
        case 'chat_message':
          const chatMessage = {
            type: 'chat_message',
            username: clientInfo.username,
            color: clientInfo.color,
            message: data.message,
            timestamp: new Date().toISOString(),
            id: uuidv4()
          };
          addToHistory(chatMessage);
          broadcast(chatMessage);
          break;

        case 'set_username':
          if (data.username && data.username.trim()) {
            const oldName = clientInfo.username;
            clientInfo.username = data.username.trim();
            
            const usernameChangeMsg = {
              type: 'system',
              message: `📝 ${oldName} cambió su nombre a ${clientInfo.username}`,
              username: 'Sistema',
              color: '#95a5a6',
              timestamp: new Date().toISOString(),
              id: uuidv4()
            };
            addToHistory(usernameChangeMsg);
            broadcast(usernameChangeMsg);
          }
          break;

        case 'typing':
          broadcast({
            type: 'typing',
            username: clientInfo.username,
            color: clientInfo.color,
            isTyping: data.isTyping
          }, ws);
          break;

        default:
          console.log('Tipo desconocido:', data.type);
      }
    } catch (error) {
      console.error('Error procesando mensaje:', error);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Formato inválido',
        timestamp: new Date().toISOString()
      }));
    }
  });

  ws.on('close', () => {
    const clientInfo = clients.get(ws);
    if (clientInfo) {
      const leaveMessage = {
        type: 'system',
        message: `👋 ${clientInfo.username} ha abandonado el chat`,
        username: 'Sistema',
        color: '#95a5a6',
        timestamp: new Date().toISOString(),
        id: uuidv4()
      };
      addToHistory(leaveMessage);
      broadcast(leaveMessage);
      clients.delete(ws);
      console.log(`[${new Date().toISOString()}] Desconectado: ${clientId}`);
    }
  });

  ws.on('error', (error) => {
    console.error(`Error WS ${clientId}:`, error.message);
  });
});

const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log(`
╔═════════════════════════════════════════════════════════════╗
║                    RESILIENTE CHAT                         ║
║                                                            ║
║  Servidor: http://${HOST}:${PORT}                           ║
║  WebSocket: ws://${HOST}:${PORT}/ws                        ║
║                                                            ║
║  Producción: HTTPS puerto 443 + CDN                        ║
╚═════════════════════════════════════════════════════════════╝
  `);
});

module.exports = { app, server, wss };