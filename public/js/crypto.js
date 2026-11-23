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

/** El enlace nunca lleva la contraseña: solo una marca (p=1) de que hace falta. */
export function buildInvite(baseUrl, roomId, rawKey, { password = false } = {}) {
  const base = baseUrl.split('#')[0];
  return `${base}#r=${roomId}&k=${rawKey}${password ? '&p=1' : ''}`;
}

/** Lee "#r=<sala>&k=<clave>[&p=1]". Devuelve null si falta algo o no es válido. */
export function parseInvite(hash) {
  const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const room = params.get('r');
  const key = params.get('k');
  if (!isRoomId(room) || !key || !KEY_RE.test(key)) return null;
  return { room, key, password: params.get('p') === '1' };
}

/* ---------------- Contraseña y código de verificación ---------------- */

const PBKDF2_ITERATIONS = 600_000; // recomendación OWASP para PBKDF2-SHA256

/** 64 palabras cortas y fáciles de decir en voz alta (6 bits cada una). */
export const VERIFICATION_WORDS = [
  'agua', 'árbol', 'arena', 'barco', 'bosque', 'búho', 'cactus', 'café',
  'campana', 'canela', 'cielo', 'cobre', 'cometa', 'coral', 'cuervo', 'delfín',
  'duna', 'eco', 'faro', 'flor', 'fresa', 'fuego', 'gato', 'girasol',
  'globo', 'hielo', 'hoja', 'isla', 'jade', 'jaguar', 'lago', 'lápiz',
  'lima', 'lince', 'lluvia', 'lobo', 'luna', 'maíz', 'mango', 'mar',
  'menta', 'miel', 'monte', 'nieve', 'nube', 'nuez', 'ola', 'oro',
  'oso', 'palma', 'perla', 'piedra', 'pino', 'plata', 'puente', 'río',
  'roble', 'rosa', 'sal', 'sol', 'tigre', 'trueno', 'viento', 'volcán',
];

/**
 * Secreto final de la sala.
 * - Sin contraseña: la clave del enlace.
 * - Con contraseña: PBKDF2(contraseña, sal = clave del enlace + sala). Hace falta
 *   tener el enlace Y la contraseña; el servidor no ve ninguno de los dos.
 * Devuelve la clave AES y un código de 4 palabras para comparar en persona.
 */
export async function deriveRoomSecret(rawKey, roomId, password = '') {
  if (!KEY_RE.test(rawKey)) throw new Error('Clave inválida');
  const linkBytes = fromBase64Url(rawKey);
  let bits = linkBytes;

  if (password) {
    const base = await crypto.subtle.importKey('raw', encoder.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
    const salt = new Uint8Array([...linkBytes, ...encoder.encode(roomId)]);
    bits = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
      base,
      256,
    ));
  }

  const key = await crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new Uint8Array([...encoder.encode('resiliente/verificacion/v1'), ...bits]),
  ));
  // 24 bits -> 4 palabras de 6 bits.
  const n = (digest[0] << 16) | (digest[1] << 8) | digest[2];
  const code = [18, 12, 6, 0].map((shift) => VERIFICATION_WORDS[(n >> shift) & 63]);
  return { key, code };
}
