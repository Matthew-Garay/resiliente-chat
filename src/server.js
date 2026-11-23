'use strict';

/**
 * Servidor de Resiliente Chat.
 *
 * El servidor es un simple "cartero ciego":
 * - Solo ve texto cifrado (iv + ct); nunca la clave, los nombres ni los mensajes.
 * - No guarda historial ni escribe nada en disco ni en los logs.
 * - Las salas viven en memoria y desaparecen cuando sale la última persona.
 */

const http = require('http');
const https = require('https');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const WebSocket = require('ws');
const { createRateLimiter } = require('./rate-limiter');

const ROOM_RE = /^[A-Za-z0-9_-]{22}$/;
const IV_RE = /^[A-Za-z0-9_-]{16}$/;
const CT_RE = /^[A-Za-z0-9_-]+$/;
const REF_RE = /^[A-Za-z0-9_-]{1,36}$/;
// Peor caso: 2000 caracteres de control escapados en JSON (6 bytes cada uno) + nombre,
// más la etiqueta GCM, en base64url. Unos 16 300 caracteres.
const MAX_CT_LENGTH = 16_500;
// Tras tantos excesos seguidos del límite anti-spam se corta la conexión.
const MAX_STRIKES = 30;

const DEFAULTS = {
  maxRoomSize: 50,
  maxRooms: 1000,
  maxPayload: 20 * 1024,
  maxConnectionsPerIp: 20,
  trustProxy: false,
  heartbeatMs: 30_000,
  joinTimeoutMs: 10_000,
  allowedOrigins: [],
  rate: { capacity: 10, refillPerSec: 2 },
};

function createChatServer(options = {}) {
  const opts = { ...DEFAULTS, ...options, rate: { ...DEFAULTS.rate, ...options.rate } };

  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'"],
          'img-src': ["'self'", 'data:'],
          'connect-src': ["'self'"],
          'font-src': ["'self'"],
          'object-src': ["'none'"],
          'base-uri': ["'none'"],
          'form-action': ["'none'"],
          'frame-ancestors': ["'none'"],
          // Si se forzara HTTPS aquí, el chat dejaría de funcionar por HTTP en la red local.
          'upgrade-insecure-requests': null,
        },
      },
      referrerPolicy: { policy: 'no-referrer' },
      // Con HTTPS propio (red local, certificado autofirmado) HSTS impediría aceptar el aviso del certificado.
      // En producción el proxy HTTPS es quien debe enviar HSTS.
      strictTransportSecurity: !opts.tls,
      crossOriginEmbedderPolicy: false,
    }),
  );

  // Nada se guarda en caché: ni del navegador ni de proxies intermedios.
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { etag: false, lastModified: false }));

  const server = opts.tls ? https.createServer(opts.tls, app) : http.createServer(app);
  const wss = new WebSocket.Server({
    server,
    path: '/ws',
    maxPayload: opts.maxPayload,
    perMessageDeflate: false,
    verifyClient: ({ origin, req }, done) => {
      if (!isOriginAllowed(origin, requestHost(req, opts.trustProxy), opts.allowedOrigins)) return done(false, 403);
      const ip = clientIp(req, opts.trustProxy);
      if ((connectionsPerIp.get(ip) || 0) >= opts.maxConnectionsPerIp) return done(false, 429);
      return done(true);
    },
  });

  // Solo un contador por IP mientras hay conexiones abiertas; nunca se registra ni se guarda.
  /** @type {Map<string, number>} */
  const connectionsPerIp = new Map();

  /** @type {Map<string, Set<WebSocket>>} */
  const rooms = new Map();

  function sendTo(ws, data) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  }

  function broadcastPresence(roomId) {
    const members = rooms.get(roomId);
    if (!members) return;
    for (const member of members) sendTo(member, { type: 'presence', peers: members.size });
  }

  function leave(ws) {
    const roomId = ws.roomId;
    if (!roomId) return;
    ws.roomId = null;
    const members = rooms.get(roomId);
    if (!members) return;
    members.delete(ws);
    if (members.size === 0) rooms.delete(roomId);
    else broadcastPresence(roomId);
  }

  function fail(ws, code, { close = false, ref } = {}) {
    sendTo(ws, ref ? { type: 'error', code, ref } : { type: 'error', code });
    if (close) ws.close(1008, code);
  }

  function handleJoin(ws, data) {
    if (ws.roomId) return fail(ws, 'already_joined');
    if (typeof data.room !== 'string' || !ROOM_RE.test(data.room)) return fail(ws, 'bad_room', { close: true });

    let members = rooms.get(data.room);
    if ((members ? members.size : 0) >= opts.maxRoomSize) return fail(ws, 'room_full', { close: true });
    if (!members) {
      if (rooms.size >= opts.maxRooms) return fail(ws, 'server_full', { close: true });
      members = new Set();
      rooms.set(data.room, members);
    }

    members.add(ws);
    ws.roomId = data.room;
    clearTimeout(ws.joinTimer);
    sendTo(ws, { type: 'joined', peers: members.size });
    for (const member of members) {
      if (member !== ws) sendTo(member, { type: 'presence', peers: members.size });
    }
  }

  function handleMsg(ws, data) {
    const ref = typeof data.ref === 'string' && REF_RE.test(data.ref) ? data.ref : undefined;
    if (!ws.roomId) return fail(ws, 'not_joined', { ref });
    const validIv = typeof data.iv === 'string' && IV_RE.test(data.iv);
    const validCt = typeof data.ct === 'string' && data.ct.length <= MAX_CT_LENGTH && CT_RE.test(data.ct);
    if (!validIv || !validCt) return fail(ws, 'bad_message', { ref });

    const out = JSON.stringify({ type: 'msg', iv: data.iv, ct: data.ct });
    for (const member of rooms.get(ws.roomId) || []) {
      if (member !== ws && member.readyState === WebSocket.OPEN) member.send(out);
    }
    if (ref) sendTo(ws, { type: 'ack', ref });
  }

  /** Cada trama gasta una ficha. Devuelve false si hay que descartarla. */
  function withinRate(ws, data) {
    if (ws.limiter.take()) {
      ws.strikes = 0;
      return true;
    }
    ws.strikes += 1;
    if (ws.strikes >= MAX_STRIKES) {
      ws.close(1008, 'rate_limited');
      return false;
    }
    const ref = data && typeof data.ref === 'string' && REF_RE.test(data.ref) ? data.ref : undefined;
    fail(ws, 'rate_limited', { ref });
    return false;
  }

  wss.on('connection', (ws, req) => {
    const ip = clientIp(req, opts.trustProxy);
    connectionsPerIp.set(ip, (connectionsPerIp.get(ip) || 0) + 1);
    ws.isAlive = true;
    ws.roomId = null;
    ws.strikes = 0;
    ws.limiter = createRateLimiter(opts.rate);
    // Una conexión que no entra en ninguna sala no tiene nada que hacer aquí.
    ws.joinTimer = setTimeout(() => {
      if (!ws.roomId) ws.close(1008, 'join_timeout');
    }, opts.joinTimeoutMs);

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw, isBinary) => {
      let data;
      try {
        data = isBinary ? null : JSON.parse(raw.toString());
      } catch {
        data = null;
      }
      if (!withinRate(ws, data)) return;
      if (!data || typeof data !== 'object') return fail(ws, 'bad_message');

      if (data.type === 'join') handleJoin(ws, data);
      else if (data.type === 'msg') handleMsg(ws, data);
      else fail(ws, 'bad_message');
    });

    ws.on('close', () => {
      clearTimeout(ws.joinTimer);
      const left = (connectionsPerIp.get(ip) || 1) - 1;
      if (left <= 0) connectionsPerIp.delete(ip);
      else connectionsPerIp.set(ip, left);
      leave(ws);
    });
    ws.on('error', () => leave(ws));
  });

  // Cierra conexiones muertas (móvil que perdió señal, pestaña congelada...).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, opts.heartbeatMs);
  heartbeat.unref();

  async function close() {
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.terminate();
    rooms.clear();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }

  return { app, server, wss, close, roomCount: () => rooms.size };
}

/**
 * IP del cliente. Detrás de un proxy de confianza se usa la última entrada de
 * X-Forwarded-For (la que añadió nuestro propio proxy, que no se puede falsificar).
 */
function clientIp(req, trustProxy) {
  if (trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (forwarded.length) return forwarded[forwarded.length - 1];
  }
  return req.socket.remoteAddress || 'unknown';
}

function requestHost(req, trustProxy) {
  if (trustProxy && req.headers['x-forwarded-host']) return String(req.headers['x-forwarded-host']).split(',')[0].trim();
  return req.headers.host;
}

/**
 * Evita que otra web abra conexiones en nombre del visitante.
 * Sin ALLOWED_ORIGINS solo se acepta el mismo host (o clientes sin Origin, p. ej. tests/CLI).
 */
function isOriginAllowed(origin, host, allowedOrigins) {
  if (!origin) return true;
  if (allowedOrigins.length > 0) return allowedOrigins.includes(origin);
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

module.exports = { createChatServer, isOriginAllowed, clientIp };
