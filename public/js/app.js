/**
 * Resiliente Chat — cliente.
 *
 * Todo lo sensible ocurre aquí, en el navegador:
 * - La clave se genera aquí y viaja solo en el fragmento (#) del enlace.
 * - Con contraseña, la clave final se deriva del enlace + la contraseña (PBKDF2).
 * - Los mensajes e imágenes se cifran antes de salir y se descifran al llegar.
 * - Cada mensaje se elimina de la pantalla y de la memoria al expirar o al verse una vez.
 * - No se usa localStorage ni cookies. El enlace (nunca la contraseña) se guarda en
 *   sessionStorage, que se borra al cerrar la pestaña, solo para sobrevivir a una recarga.
 */

import {
  randomRoomId, generateKey, exportKey, deriveRoomSecret,
  encryptMessage, decryptMessage, buildInvite, parseInvite,
  toBase64Url, fromBase64Url,
} from './crypto.js';
import { compressImage, isJpeg } from './images.js';

const MIN_TTL = 5;
const MAX_TTL = 3600;
const ONCE_VIEW_SECONDS = 10; // lo que dura un mensaje de "ver una vez" tras abrirlo
const MAX_TEXT = 2000;
const MAX_NAME = 30;
const SESSION_KEY = 'resiliente.invite';
const MAX_CT_LENGTH = 380_000; // igual que en el servidor

const $ = (id) => document.getElementById(id);
const els = {
  landing: $('landing'),
  landingError: $('landing-error'),
  createForm: $('create-form'),
  createRoom: $('create-room'),
  createPassword: $('create-password'),
  passwordOption: $('password-option'),
  gate: $('gate'),
  gateForm: $('gate-form'),
  gatePassword: $('gate-password'),
  gateError: $('gate-error'),
  gateSubmit: $('gate-submit'),
  gateCancel: $('gate-cancel'),
  room: $('room'),
  presenceDot: $('presence-dot'),
  presenceText: $('presence-text'),
  showCode: $('show-code'),
  copyLink: $('copy-link'),
  leaveRoom: $('leave-room'),
  messages: $('messages'),
  emptyState: $('empty-state'),
  emptyHint: $('empty-hint'),
  list: $('message-list'),
  composer: $('composer'),
  nameInput: $('name-input'),
  ttlSelect: $('ttl-select'),
  imageInput: $('image-input'),
  messageInput: $('message-input'),
  sendBtn: $('send-btn'),
  status: $('composer-status'),
  retryPassword: $('retry-password'),
  codeDialog: $('code-dialog'),
  codeWords: $('code-words'),
  codePasswordNote: $('code-password-note'),
};

const ERROR_TEXT = {
  bad_room: 'El enlace de la sala no es válido.',
  room_full: 'La sala está llena. Prueba más tarde o crea una nueva.',
  server_full: 'El servidor está al límite de salas. Prueba en unos minutos.',
  rate_limited: 'Vas muy rápido. Espera un momento antes de enviar otro mensaje.',
  bad_message: 'El mensaje no se pudo enviar.',
  not_joined: 'El mensaje no se envió porque la conexión se estaba recuperando. Vuelve a enviarlo.',
};

const ADJECTIVES = ['Azul', 'Callado', 'Veloz', 'Nocturno', 'Sereno', 'Lejano', 'Bravo', 'Tenue', 'Gris', 'Valiente'];
const ANIMALS = ['Zorro', 'Búho', 'Lince', 'Colibrí', 'Lobo', 'Ajolote', 'Halcón', 'Jaguar', 'Nutria', 'Cuervo'];
const NAME_HUES = [220, 160, 15, 280, 340, 40, 190, 100];

/** Estado de la sesión: vive solo en memoria. */
const state = {
  room: null,
  rawKey: null,
  key: null,
  code: null,
  hasPassword: false,
  verified: false, // true cuando sabemos que nuestra clave coincide con la de la sala
  helloSent: false,
  ws: null,
  joined: false,
  peers: 0,
  retry: 0,
  retryTimer: null,
  leaving: false,
  messages: new Map(), // id -> { el, timer, expiresAt, ttl, url, failed }
  pending: new Map(), // ref -> id de mensajes propios aún sin confirmar
  tick: null,
  lastUndecryptableNotice: 0,
  gateInvite: null,
  ackTimers: new Map(), // id de "hola" -> temporizador de respuesta
  unread: 0, // mensajes recibidos con la pestaña en segundo plano
};

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

function randomPick(list) {
  return list[crypto.getRandomValues(new Uint32Array(1))[0] % list.length];
}

function randomAlias() {
  return `${randomPick(ANIMALS)} ${randomPick(ADJECTIVES)}`;
}

function readStoredInvite() {
  try { return parseInvite(sessionStorage.getItem(SESSION_KEY) || ''); } catch { return null; }
}

function storeInvite({ room, key, password }) {
  try { sessionStorage.setItem(SESSION_KEY, buildInvite('', room, key, { password })); } catch { /* sin almacenamiento */ }
}

function clearStoredInvite() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignorar */ }
}

/** Quita la clave de la barra de direcciones para que no quede a la vista. */
function scrubAddressBar() {
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}

function currentName() {
  return (els.nameInput.value.trim() || randomAlias()).slice(0, MAX_NAME);
}

/* ------------------------------------------------------------------ */
/* Pantallas                                                           */
/* ------------------------------------------------------------------ */

function showOnly(view) {
  for (const v of [els.landing, els.gate, els.room]) v.hidden = v !== view;
}

function showLanding(error = '') {
  showOnly(els.landing);
  els.landingError.textContent = error;
  els.landingError.hidden = !error;
  document.title = 'Resiliente Chat';
  if (!els.createRoom.disabled) els.createRoom.focus();
}

function showGate(invite, error = '') {
  state.gateInvite = invite;
  showOnly(els.gate);
  els.gatePassword.value = '';
  els.gateError.textContent = error;
  els.gateError.hidden = !error;
  document.title = 'Sala con contraseña · Resiliente';
  els.gatePassword.focus();
}

async function boot() {
  els.nameInput.value = randomAlias();

  // Fuera de HTTPS (o localhost) el navegador desactiva el cifrado: mejor avisar desde el principio.
  if (!window.isSecureContext || !crypto.subtle) {
    scrubAddressBar();
    els.createRoom.disabled = true;
    showLanding(`Esta página se abrió sin HTTPS (${location.origin}), así que tu navegador no permite cifrar los mensajes. `
      + 'Ábrela con una dirección https://. Si eres quien aloja el chat, ejecuta "npm run cert" y vuelve a arrancar el servidor.');
    return;
  }

  const hadHash = Boolean(location.hash);
  // El enlace guardado solo se usa al recargar sin enlace; uno dañado nunca te lleva a otra sala.
  const invite = hadHash ? parseInvite(location.hash) : readStoredInvite();
  scrubAddressBar();
  await openInvite(invite, hadHash);
}

async function openInvite(invite, fromLink = true) {
  if (!invite) {
    showLanding(fromLink ? 'Ese enlace está incompleto o dañado. Pide que te lo vuelvan a enviar o crea una sala nueva.' : '');
    return;
  }
  if (invite.password) showGate(invite);
  else await enterRoom(invite, '');
}

/* ------------------------------------------------------------------ */
/* Salas                                                               */
/* ------------------------------------------------------------------ */

async function createRoom(event) {
  event.preventDefault();
  const password = els.passwordOption.open ? els.createPassword.value : '';
  if (password && password.length < 4) {
    showLanding('La contraseña debe tener al menos 4 caracteres.');
    els.createPassword.focus();
    return;
  }
  els.createRoom.disabled = true;
  els.createRoom.textContent = password ? 'Protegiendo la sala…' : 'Creando…';
  try {
    const invite = { room: randomRoomId(), key: await exportKey(await generateKey()), password: Boolean(password) };
    // Quien crea la sala define la clave: está verificado por definición.
    await enterRoom(invite, password, { creator: true });
    els.createPassword.value = '';
    els.passwordOption.open = false;
  } catch {
    showLanding('Tu navegador no permite cifrar en esta página. Ábrela por HTTPS o desde localhost.');
  } finally {
    els.createRoom.disabled = false;
    els.createRoom.textContent = 'Crear sala privada';
  }
}

async function submitGate(event) {
  event.preventDefault();
  const password = els.gatePassword.value;
  if (!password || !state.gateInvite) return;
  els.gateSubmit.disabled = true;
  els.gateSubmit.textContent = 'Comprobando…';
  try {
    await enterRoom(state.gateInvite, password);
  } finally {
    els.gateSubmit.disabled = false;
    els.gateSubmit.textContent = 'Entrar';
  }
}

function retryPassword() {
  const invite = { room: state.room, key: state.rawKey, password: true };
  leaveRoom();
  storeInvite(invite);
  showGate(invite);
}

function cancelGate() {
  state.gateInvite = null;
  clearStoredInvite();
  showLanding();
}

async function enterRoom(invite, password, { creator = false } = {}) {
  let secret;
  try {
    secret = await deriveRoomSecret(invite.key, invite.room, password);
  } catch {
    showLanding('No se pudo leer la clave del enlace. Pide que te lo vuelvan a enviar.');
    return;
  }

  Object.assign(state, {
    room: invite.room,
    rawKey: invite.key,
    key: secret.key,
    code: secret.code,
    hasPassword: invite.password,
    verified: creator,
    helloSent: false,
    leaving: false,
    retry: 0,
    lastUndecryptableNotice: 0,
    gateInvite: null,
  });
  storeInvite(invite);

  showOnly(els.room);
  state.unread = 0;
  updateTitle();
  els.codePasswordNote.hidden = !invite.password;
  updateEmptyState();
  startTicker();
  connect();
  els.messageInput.focus();
  if (creator && invite.password) {
    setStatus('Sala con contraseña creada. Copia el enlace y di la contraseña a los demás por otro medio.');
  }
}

function leaveRoom() {
  state.leaving = true;
  clearTimeout(state.retryTimer);
  if (state.ws) state.ws.close(1000, 'bye');
  wipeEverything();
  showLanding();
}

/** Borra todo rastro de la sesión: mensajes, imágenes, clave y enlace. */
function wipeEverything() {
  for (const id of [...state.messages.keys()]) removeMessage(id);
  state.pending.clear();
  els.list.replaceChildren();
  els.messageInput.value = '';
  els.imageInput.value = '';
  setStatus('');
  stopTicker();
  clearStoredInvite();
  if (els.codeDialog.open) els.codeDialog.close();
  for (const t of state.ackTimers.values()) clearTimeout(t);
  state.ackTimers.clear();
  els.retryPassword.hidden = true;
  Object.assign(state, {
    room: null, rawKey: null, key: null, code: null, hasPassword: false, verified: false,
    ws: null, joined: false, peers: 0, unread: 0,
  });
}

/* ------------------------------------------------------------------ */
/* Conexión                                                            */
/* ------------------------------------------------------------------ */

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

function connect() {
  if (!state.room || state.leaving) return;
  setPresence('connecting');

  const ws = new WebSocket(wsUrl());
  state.ws = ws;
  state.joined = false;

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'join', room: state.room }));
  });

  ws.addEventListener('message', (event) => {
    if (ws !== state.ws) return;
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    handleServerMessage(data);
  });

  ws.addEventListener('close', () => {
    if (ws !== state.ws) return;
    state.joined = false;
    updateSendButton();
    failPending('No enviado: se perdió la conexión.');
    if (state.leaving || !state.room) return;
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  const delay = Math.min(15_000, 1000 * 2 ** state.retry);
  state.retry += 1;
  setPresence('offline', delay);
  clearTimeout(state.retryTimer);
  state.retryTimer = setTimeout(connect, delay);
}

function handleServerMessage(data) {
  switch (data.type) {
    case 'joined':
      state.joined = true;
      state.retry = 0;
      setPeers(data.peers);
      if (!state.hasPassword || state.verified) setStatus('');
      updateSendButton();
      if (!state.helloSent) {
        state.helloSent = true;
        sendControl('hello', { h: crypto.randomUUID() });
        // Los demás responden al "hola" si pueden descifrarlo. Si nadie responde, avisamos.
        if (state.hasPassword && !state.verified && data.peers > 1) {
          const room = state.room;
          setStatus('Comprobando la contraseña con los demás…');
          setTimeout(() => {
            if (state.room === room && !state.verified) {
              setStatus('Nadie ha confirmado tu contraseña. Si los demás no ven tus mensajes, no coincide: sal y vuelve a entrar.', true);
            }
          }, 5000);
        }
      }
      break;
    case 'presence':
      setPeers(data.peers);
      break;
    case 'msg':
      receive(data);
      break;
    case 'ack':
      confirmSent(data.ref);
      break;
    case 'error':
      handleServerError(data.code, data.ref);
      break;
    default:
      break;
  }
}

function handleServerError(code, ref) {
  const text = ERROR_TEXT[code] || 'Algo falló en el servidor.';
  if (ref) markFailed(ref, 'No enviado');
  // Las tramas de control (hola/respuesta) no llevan ref: si el anti-spam las frena, no es culpa de quien escribe.
  if (code === 'rate_limited' && !ref) return;
  if (code === 'bad_room' || code === 'room_full' || code === 'server_full') {
    state.leaving = true;
    wipeEverything();
    showLanding(text);
    return;
  }
  setStatus(text, true);
}

/* ------------------------------------------------------------------ */
/* Envío                                                               */
/* ------------------------------------------------------------------ */

function clampTtl(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 60;
  return Math.min(MAX_TTL, Math.max(MIN_TTL, n));
}

/** Cifra y envía. Devuelve el ref del mensaje, o null si no se envió. */
async function sealAndSend(payload, { ref = null } = {}) {
  const { ws, key, room } = state;
  if (!ws || !state.joined) {
    setStatus('Sin conexión: no se pudo enviar. Espera a que se recupere y vuelve a intentarlo.', true);
    return null;
  }

  let sealed;
  try {
    sealed = await encryptMessage(key, room, payload);
  } catch {
    setStatus('No se pudo cifrar el mensaje.', true);
    return null;
  }
  if (sealed.ct.length > MAX_CT_LENGTH) {
    setStatus('El mensaje es demasiado grande una vez cifrado.', true);
    return null;
  }
  // Si mientras se cifraba se salió de la sala o se reconectó, no se envía.
  if (ws !== state.ws || room !== state.room || !state.joined || ws.readyState !== WebSocket.OPEN) {
    setStatus('No enviado: la conexión cambió. Vuelve a enviarlo.', true);
    return null;
  }
  ws.send(JSON.stringify(ref ? { type: 'msg', ...sealed, ref } : { type: 'msg', ...sealed }));
  return ref || true;
}

/** Mensajes de control cifrados (no se muestran): sirven para comprobar la contraseña. */
function sendControl(kind, extra = {}) {
  return sealAndSend({ v: 1, kind, n: currentName(), ...extra });
}

function readTtlChoice() {
  const value = els.ttlSelect.value;
  return value === 'once' ? { once: true, ttl: MAX_TTL } : { once: false, ttl: clampTtl(value) };
}

async function sendText(event) {
  event.preventDefault();
  const text = els.messageInput.value.trim().slice(0, MAX_TEXT);
  if (!text || !state.joined) return;

  const name = currentName();
  const { once, ttl } = readTtlChoice();
  const ref = crypto.randomUUID();
  const sent = await sealAndSend({ v: 1, kind: 'text', n: name, t: text, ttl, once }, { ref });
  if (!sent) return;

  els.messageInput.value = '';
  autoGrow();
  updateSendButton();
  const id = render({ name, text, ttl: once ? ONCE_VIEW_SECONDS : ttl, own: true, pending: true, once });
  state.pending.set(ref, id);
  afterSend();
}

async function sendImage() {
  const file = els.imageInput.files && els.imageInput.files[0];
  els.imageInput.value = '';
  if (!file) return;
  if (!state.joined) {
    setStatus('Sin conexión: no se pudo enviar la imagen.', true);
    return;
  }
  if (!file.type.startsWith('image/')) {
    setStatus('Ese archivo no es una imagen.', true);
    return;
  }

  setStatus('Preparando la imagen…');
  let bytes;
  try {
    bytes = await compressImage(file);
  } catch {
    setStatus('No se pudo preparar la imagen. Prueba con otra o hazle una captura más pequeña.', true);
    return;
  }

  const name = currentName();
  const caption = els.messageInput.value.trim().slice(0, MAX_TEXT);
  const { once, ttl } = readTtlChoice();
  const ref = crypto.randomUUID();
  const payload = { v: 1, kind: 'image', n: name, img: toBase64Url(bytes), t: caption, ttl, once };
  const sent = await sealAndSend(payload, { ref });
  if (!sent) return;

  els.messageInput.value = '';
  autoGrow();
  updateSendButton();
  const id = render({ name, text: caption, image: bytes, ttl: once ? ONCE_VIEW_SECONDS : ttl, own: true, pending: true, once });
  state.pending.set(ref, id);
  afterSend();
}

function afterSend() {
  // Mientras no se confirme la contraseña, se mantiene el aviso.
  if (state.hasPassword && !state.verified) return;
  setStatus(state.peers <= 1 ? 'Nadie más está en la sala: este mensaje no lo ha recibido nadie.' : '');
}

/* ------------------------------------------------------------------ */
/* Recepción                                                           */
/* ------------------------------------------------------------------ */

async function receive(sealed) {
  const { key, room } = state;
  if (!key) return;
  let payload;
  try {
    payload = await decryptMessage(key, room, sealed);
  } catch {
    if (room === state.room && key === state.key) onUndecryptable();
    return;
  }
  // Si mientras se descifraba se salió de la sala, el mensaje se descarta.
  if (room !== state.room || key !== state.key) return;
  if (!payload || typeof payload !== 'object' || typeof payload.n !== 'string') return;

  // Cualquier cosa que se descifra demuestra que nuestra clave es la de la sala.
  if (!state.verified) {
    state.verified = true;
    els.retryPassword.hidden = true;
    if (state.hasPassword) setStatus('Contraseña correcta: estás en la misma sala que los demás.');
  }

  const name = payload.n.slice(0, MAX_NAME) || 'Anónimo';
  const kind = payload.kind || 'text';

  // Al "hola" de quien entra responde UNA persona: cada cual espera un poco al azar
  // y se calla si otra ya respondió. Así una sala grande no se llena de respuestas.
  const helloId = typeof payload.h === 'string' ? payload.h.slice(0, 64) : '';
  if (kind === 'hello') {
    if (!helloId || state.ackTimers.has(helloId)) return;
    const timer = setTimeout(() => {
      state.ackTimers.delete(helloId);
      if (room === state.room) sendControl('hello-ack', { h: helloId });
    }, 150 + Math.random() * 1350);
    state.ackTimers.set(helloId, timer);
    return;
  }
  if (kind === 'hello-ack') {
    clearTimeout(state.ackTimers.get(helloId));
    state.ackTimers.delete(helloId);
    return;
  }

  const text = typeof payload.t === 'string' ? payload.t.slice(0, MAX_TEXT) : '';
  const once = payload.once === true;
  const ttl = clampTtl(payload.ttl);

  if (kind === 'image') {
    let image;
    try { image = fromBase64Url(String(payload.img || '')); } catch { return; }
    if (!isJpeg(image)) return;
    render({ name, text, image, ttl, own: false, once });
  } else if (kind === 'text' && text) {
    render({ name, text, ttl, own: false, once });
  }
}

function onUndecryptable() {
  // Con contraseña y sin haber leído nada aún, lo más probable es que tu contraseña no coincida.
  // No se expulsa a nadie: con dos personas en desacuerdo no hay forma de saber cuál tiene la buena.
  if (state.hasPassword && !state.verified) {
    setStatus('No puedes leer lo que escriben aquí: tu contraseña no coincide con la de quien escribe. Comparad el código de la sala.', true);
    els.retryPassword.hidden = false;
    return;
  }
  const now = Date.now();
  if (now - state.lastUndecryptableNotice > 30_000) {
    state.lastUndecryptableNotice = now;
    notice(state.hasPassword
      ? 'Alguien ha entrado con otra contraseña: no puede leeros ni vosotros a esa persona.'
      : 'Llegó un mensaje que no se pudo descifrar. Quien lo envió tiene un enlace distinto.', true);
  }
}

/* ------------------------------------------------------------------ */
/* Pintar mensajes                                                     */
/* ------------------------------------------------------------------ */

function nameColor(name) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  const hue = NAME_HUES[hash % NAME_HUES.length];
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  return dark ? `hsl(${hue} 70% 72%)` : `hsl(${hue} 65% 27%)`;
}

/** Crea el contenido visible (texto y/o imagen). Solo textContent: nunca se interpreta HTML. */
function buildContent({ name, text, image }) {
  const parts = [];
  let url = null;
  if (image) {
    url = URL.createObjectURL(new Blob([image], { type: 'image/jpeg' }));
    const img = document.createElement('img');
    img.className = 'msg-image';
    img.src = url;
    img.alt = `Imagen enviada por ${name}`;
    img.decoding = 'async';
    parts.push(img);
  }
  if (text) {
    const p = document.createElement('p');
    p.className = 'msg-text';
    p.textContent = text;
    parts.push(p);
  }
  return { parts, url };
}

/**
 * Pinta un mensaje.
 * Los de "ver una vez" que llegan de otros se muestran tapados hasta que se tocan.
 */
function render({ name, text, image = null, ttl, own, pending = false, once = false }) {
  const id = crypto.randomUUID();

  const li = document.createElement('li');
  li.className = own ? 'msg is-own' : 'msg';
  if (pending) li.classList.add('is-pending');
  if (once) li.classList.add('is-once');

  const head = document.createElement('div');
  head.className = 'msg-head';
  const who = document.createElement('span');
  who.className = 'msg-name';
  who.textContent = own ? `${name} (tú)` : name;
  who.style.color = nameColor(name);
  // La cuenta atrás cambia 4 veces por segundo: se oculta a los lectores de pantalla
  // y se anuncia una sola vez, en texto fijo, cuándo se borra.
  const timer = document.createElement('span');
  timer.className = 'msg-timer';
  timer.setAttribute('aria-hidden', 'true');
  const spoken = document.createElement('span');
  spoken.className = 'visually-hidden';
  spoken.textContent = once && !own ? 'Mensaje de ver una vez.' : `Se borra en ${formatRemaining(ttl * 1000)}.`;
  head.append(who, timer, spoken);

  const body = document.createElement('div');
  body.className = 'msg-body';

  const fuse = document.createElement('span');
  fuse.className = 'msg-fuse';
  fuse.setAttribute('aria-hidden', 'true');

  li.append(head, body, fuse);
  const entry = { el: li, timer, expiresAt: Date.now() + ttl * 1000, ttl, url: null, failed: null, sealed: false };

  if (once && !own) {
    // Tapado: el contenido no entra en la página hasta que se pide verlo.
    entry.sealed = true;
    const reveal = document.createElement('button');
    reveal.type = 'button';
    reveal.className = 'btn btn-quiet reveal';
    reveal.textContent = image ? 'Ver imagen (una vez)' : 'Ver mensaje (una vez)';
    reveal.addEventListener('click', () => {
      const { parts, url } = buildContent({ name, text, image });
      body.replaceChildren(...parts);
      entry.url = url;
      entry.sealed = false;
      entry.ttl = ONCE_VIEW_SECONDS;
      entry.expiresAt = Date.now() + ONCE_VIEW_SECONDS * 1000;
      // Se suelta la referencia al contenido original: solo queda lo que está en pantalla.
      text = null;
      image = null;
      updateMessage(id, Date.now());
    }, { once: true });
    body.append(reveal);
  } else {
    const { parts, url } = buildContent({ name, text, image });
    body.append(...parts);
    entry.url = url;
  }

  if (!own && document.hidden) {
    // Solo un número en el título: nada del contenido sale de la página.
    state.unread += 1;
    updateTitle();
  }

  const stick = isNearBottom();
  els.list.append(li);
  state.messages.set(id, entry);
  updateMessage(id, Date.now());
  updateEmptyState();
  if (stick || own) scrollToBottom();
  return id;
}

function removeMessage(id) {
  const m = state.messages.get(id);
  if (!m) return;
  m.el.remove();
  if (m.url) URL.revokeObjectURL(m.url);
  state.messages.delete(id);
}

function confirmSent(ref) {
  const id = state.pending.get(ref);
  state.pending.delete(ref);
  const m = id && state.messages.get(id);
  if (m) m.el.classList.remove('is-pending');
}

function markFailed(ref, label) {
  const id = state.pending.get(ref);
  state.pending.delete(ref);
  const m = id && state.messages.get(id);
  if (!m) return;
  m.el.classList.remove('is-pending');
  m.el.classList.add('is-failed');
  m.failed = label;
  updateMessage(id, Date.now());
}

function failPending(label) {
  for (const ref of [...state.pending.keys()]) markFailed(ref, label);
}

function updateMessage(id, now) {
  const m = state.messages.get(id);
  if (!m) return;
  const remaining = m.expiresAt - now;
  if (remaining <= 0) {
    // Se elimina del DOM y de la memoria: no queda copia en la página.
    removeMessage(id);
    updateEmptyState();
    return;
  }
  m.el.style.setProperty('--life', String(Math.max(0, remaining / (m.ttl * 1000))));
  const when = m.sealed
    ? `ver una vez · caduca en ${formatRemaining(remaining)}`
    : `se borra en ${formatRemaining(remaining)}`;
  m.timer.textContent = m.failed ? `${m.failed} · ${when}` : when;
}

function formatRemaining(ms) {
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s} s`;
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const min = Math.floor((s % 3600) / 60);
    return min ? `${h} h ${min} min` : `${h} h`;
  }
  const m = Math.floor(s / 60);
  const rest = String(s % 60).padStart(2, '0');
  return `${m}:${rest}`;
}

function startTicker() {
  stopTicker();
  state.tick = setInterval(() => {
    const now = Date.now();
    for (const id of [...state.messages.keys()]) updateMessage(id, now);
  }, 250);
}

function stopTicker() {
  clearInterval(state.tick);
  state.tick = null;
}

function notice(text, isError = false) {
  const li = document.createElement('li');
  li.className = isError ? 'notice is-error' : 'notice';
  li.textContent = text;
  els.list.append(li);
  // Los avisos también se van solos.
  setTimeout(() => li.remove(), 15_000);
  scrollToBottom();
}

/* ------------------------------------------------------------------ */
/* Interfaz                                                            */
/* ------------------------------------------------------------------ */

function setPresence(mode, delay = 0) {
  els.presenceDot.classList.toggle('is-online', mode === 'online');
  els.presenceDot.classList.toggle('is-offline', mode === 'offline');
  if (mode === 'connecting') els.presenceText.textContent = 'Conectando…';
  if (mode === 'offline') els.presenceText.textContent = `Sin conexión. Reintentando en ${Math.round(delay / 1000)} s`;
}

function setPeers(peers) {
  state.peers = Number(peers) || 0;
  setPresence('online');
  els.presenceText.textContent = state.peers <= 1
    ? 'Solo tú en la sala'
    : `${state.peers} personas en la sala`;
  updateEmptyState();
}

function updateEmptyState() {
  els.emptyState.hidden = state.messages.size > 0;
  els.emptyHint.textContent = state.peers > 1
    ? 'Escribe algo. Cada mensaje desaparece cuando se acaba su tiempo.'
    : 'Comparte el enlace con quien quieras invitar. Solo quien lo tenga puede entrar y leer.';
}

function updateSendButton() {
  els.sendBtn.disabled = !state.joined || !els.messageInput.value.trim();
  els.imageInput.disabled = !state.joined;
  els.imageInput.parentElement.classList.toggle('is-disabled', !state.joined);
}

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle('is-error', isError);
}

function isNearBottom() {
  const el = els.messages;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

function scrollToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

function autoGrow() {
  const ta = els.messageInput;
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
}

async function copyLink() {
  if (!state.room) return;
  const url = buildInvite(location.href, state.room, state.rawKey, { password: state.hasPassword });
  const extra = state.hasPassword ? ' La contraseña no va en el enlace: dísela aparte.' : '';
  try {
    await navigator.clipboard.writeText(url);
    setStatus(`Enlace copiado. Quien lo tenga puede entrar: compártelo solo por un canal de confianza.${extra}`);
  } catch {
    window.prompt('Copia este enlace:', url);
  }
}

function updateTitle() {
  if (!state.room) return;
  const base = 'Sala privada · Resiliente';
  document.title = state.unread ? `(${state.unread}) ${base}` : base;
}

function showCode() {
  if (!state.code) return;
  els.codeWords.textContent = state.code.join(' · ');
  els.codeDialog.showModal();
}

/* ------------------------------------------------------------------ */
/* Eventos                                                             */
/* ------------------------------------------------------------------ */

els.createForm.addEventListener('submit', createRoom);
els.gateForm.addEventListener('submit', submitGate);
els.gateCancel.addEventListener('click', cancelGate);
els.retryPassword.addEventListener('click', retryPassword);
els.showCode.addEventListener('click', showCode);
els.copyLink.addEventListener('click', copyLink);
els.leaveRoom.addEventListener('click', leaveRoom);
els.composer.addEventListener('submit', sendText);
els.imageInput.addEventListener('change', sendImage);
els.messageInput.addEventListener('input', () => { autoGrow(); updateSendButton(); });
els.messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    els.composer.requestSubmit();
  }
});

// Si alguien abre otro enlace en la misma pestaña, cambia de sala.
window.addEventListener('hashchange', async () => {
  const invite = parseInvite(location.hash);
  scrubAddressBar();
  if (!invite) {
    const text = 'Ese enlace está incompleto o dañado. Pide que te lo vuelvan a enviar.';
    if (state.room) setStatus(`${text} Sigues en esta sala.`, true);
    else showLanding(text);
    return;
  }
  if (invite.room === state.room) return;
  // Otra página podría cambiar el enlace de esta pestaña: nunca se cambia de sala sin preguntar.
  if (state.room && !window.confirm('¿Salir de esta sala (se borrarán sus mensajes) y entrar en la del enlace nuevo?')) {
    setStatus('Seguís en esta sala. Se ignoró el enlace nuevo.');
    return;
  }
  if (state.room) leaveRoom();
  await openInvite(invite);
});

// Al volver a la pestaña, el contador de mensajes nuevos se pone a cero.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.unread) {
    state.unread = 0;
    updateTitle();
  }
});

// Al cerrar la pestaña se cierra la conexión; el resto vive solo en memoria.
window.addEventListener('pagehide', () => {
  if (state.ws) state.ws.close(1000, 'bye');
});

boot();
