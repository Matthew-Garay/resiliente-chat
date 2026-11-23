'use strict';

/**
 * Publica el chat en internet desde este equipo con un túnel gratuito de Cloudflare
 * (sin cuenta, sin abrir puertos del router, con HTTPS válido).
 *
 * Uso: npm run publicar
 *
 * - Arranca el servidor solo en 127.0.0.1 (no accesible desde fuera salvo por el túnel).
 * - Activa TRUST_PROXY: el túnel es el único que puede conectarse, así que sus
 *   cabeceras X-Forwarded-* son de fiar.
 * - Muestra la dirección pública https://<algo>.trycloudflare.com
 * - La dirección cambia cada vez y deja de funcionar al cerrar este proceso (Ctrl+C).
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PUBLIC_PORT || '8787';

function findCloudflared() {
  const candidates = [
    process.env.CLOUDFLARED,
    'cloudflared',
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe'),
  ].filter(Boolean);
  for (const bin of candidates) {
    if (bin.includes(path.sep) && !fs.existsSync(bin)) continue;
    const probe = spawnSync(bin, ['--version'], { stdio: 'ignore' });
    if (probe.status === 0) return bin;
  }
  return null;
}

const cloudflared = findCloudflared();
if (!cloudflared) {
  console.error(`No se encontró cloudflared. Instálalo y vuelve a ejecutar "npm run publicar":

  Windows:  winget install --id Cloudflare.cloudflared
  macOS:    brew install cloudflared
  Linux:    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
`);
  process.exit(1);
}

const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT, HOST: '127.0.0.1', TRUST_PROXY: 'true', TLS: 'off' },
  stdio: ['ignore', 'ignore', 'inherit'],
});

const tunnel = spawn(cloudflared, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

let announced = false;
function watch(chunk) {
  // Solo la dirección del túnel; los errores de cloudflared mencionan api.trycloudflare.com.
  const match = String(chunk).match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/);
  if (match && !announced) {
    announced = true;
    console.log(`
Chat publicado en internet:

  ${match[0]}

Comparte esa dirección. Crea una sala y pasa su enlace como siempre.
La dirección deja de funcionar al cerrar esta ventana (Ctrl+C).
`);
  }
}
tunnel.stdout.on('data', watch);
tunnel.stderr.on('data', watch);

function stop(code = 0) {
  tunnel.kill();
  server.kill();
  process.exit(code);
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
server.on('exit', (code) => { if (code) { console.error('El servidor se detuvo.'); stop(1); } });
tunnel.on('exit', (code) => {
  if (!announced) console.error('No se pudo abrir el túnel. Revisa tu conexión a internet.');
  stop(code || 1);
});
