'use strict';

/**
 * Genera un certificado autofirmado para usar el chat en tu red local por HTTPS.
 * Incluye localhost y todas las IPs de red de este equipo.
 *
 * Uso: npm run cert
 * Después: npm start  (detecta certs/ automáticamente)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const selfsigned = require('selfsigned');

const dir = path.join(__dirname, '..', 'certs');

const ips = Object.values(os.networkInterfaces())
  .flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'))
  .map((i) => i.address);

const altNames = [
  { type: 2, value: 'localhost' },
  { type: 2, value: os.hostname() },
  { type: 7, ip: '127.0.0.1' },
  ...ips.map((ip) => ({ type: 7, ip })),
];

const pems = selfsigned.generate([{ name: 'commonName', value: 'Resiliente Chat (local)' }], {
  keySize: 2048,
  days: 365,
  algorithm: 'sha256',
  extensions: [
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames },
  ],
});

fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'cert.pem'), pems.cert);
fs.writeFileSync(path.join(dir, 'key.pem'), pems.private, { mode: 0o600 });

console.log(`Certificado creado en ${dir} (válido 1 año).`);
console.log(`Sirve para: localhost, ${os.hostname()}${ips.length ? ', ' + ips.join(', ') : ''}`);
console.log('Arranca con "npm start". La primera vez, cada navegador mostrará un aviso: pulsa "Avanzado" y "Continuar".');
