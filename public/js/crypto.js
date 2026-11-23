/**
 * Cifrado de extremo a extremo para Resiliente Chat.
 *
 * - AES-GCM de 256 bits mediante Web Crypto (navegador y Node >= 20).
 * - La clave y el id de sala viajan en el fragmento de la URL (#...), que el
 *   navegador nunca envía al servidor.
 * - El id de sala se usa como dato autenticado (AAD): un mensaje cifrado para
 *   una sala no se acepta en otra.
 */

const ROOM_RE = /^[A-Za-z0-9_-]{22}$/;
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toBase64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function isRoomId(value) {
  return typeof value === 'string' && ROOM_RE.test(value);
}

/** Identificador de sala: 128 bits aleatorios. */
export function randomRoomId() {
  return toBase64Url(randomBytes(16));
}

export function generateKey() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

export async function exportKey(key) {
  return toBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', key)));
}

export function importKey(raw) {
  if (!KEY_RE.test(raw)) throw new Error('Clave inválida');
  return crypto.subtle.importKey('raw', fromBase64Url(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Cifra un objeto JSON. Devuelve { iv, ct } en base64url. */
export async function encryptMessage(key, roomId, payload) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(roomId) },
    key,
    encoder.encode(JSON.stringify(payload)),
  );
  return { iv: toBase64Url(iv), ct: toBase64Url(new Uint8Array(ct)) };
}

/** Descifra { iv, ct }. Lanza un error si la clave, la sala o el contenido no cuadran. */
export async function decryptMessage(key, roomId, { iv, ct }) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(iv), additionalData: encoder.encode(roomId) },
    key,
    fromBase64Url(ct),
  );
  return JSON.parse(decoder.decode(plain));
}

export function buildInvite(baseUrl, roomId, rawKey) {
  const base = baseUrl.split('#')[0];
  return `${base}#r=${roomId}&k=${rawKey}`;
}

/** Lee "#r=<sala>&k=<clave>". Devuelve null si falta algo o no es válido. */
export function parseInvite(hash) {
  const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const room = params.get('r');
  const key = params.get('k');
  if (!isRoomId(room) || !key || !KEY_RE.test(key)) return null;
  return { room, key };
}
