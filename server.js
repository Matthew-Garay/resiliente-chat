'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createChatServer } = require('./src/server');

/** Entero positivo de una variable de entorno; si falta o no es válido, el valor por defecto. */
function intEnv(name, fallback) {
  const n = Number.parseInt(process.env[name], 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Certificado HTTPS: TLS_CERT/TLS_KEY si están definidas; si no, certs/ (creado con "npm run cert").
 * Sin certificado se sirve HTTP (válido en localhost o detrás de un proxy HTTPS).
 */
function loadTls() {
  const certPath = process.env.TLS_CERT || path.join(__dirname, 'certs', 'cert.pem');
  const keyPath = process.env.TLS_KEY || path.join(__dirname, 'certs', 'key.pem');
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    if (process.env.TLS_CERT || process.env.TLS_KEY) {
      console.error('No se encontraron TLS_CERT o TLS_KEY. Revisa las rutas.');
      process.exit(1);
    }
    return null;
  }
  return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'))
    .map((i) => i.address);
}

const tls = loadTls();
const PORT = intEnv('PORT', tls ? 8443 : 8080);
const HOST = process.env.HOST || '0.0.0.0';

const chat = createChatServer({
  tls,
  maxRoomSize: intEnv('MAX_ROOM_SIZE', 50),
  maxRooms: intEnv('MAX_ROOMS', 1000),
  maxConnectionsPerIp: intEnv('MAX_CONNECTIONS_PER_IP', 20),
  trustProxy: /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || ''),
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
});

chat.server.listen(PORT, HOST, () => {
  // Solo se informa de cómo entrar. No se registran IPs de visitantes, salas ni mensajes.
  const proto = tls ? 'https' : 'http';
  console.log(`Resiliente Chat escuchando en ${proto}://localhost:${PORT}`);
  if (tls && HOST === '0.0.0.0') {
    for (const ip of lanAddresses()) console.log(`  En tu red: https://${ip}:${PORT}`);
  } else if (!tls) {
    console.log('  Sin HTTPS: otros dispositivos de la red no podrán cifrar. Ejecuta "npm run cert" y vuelve a arrancar.');
  }
});

function shutdown() {
  chat.close().finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
