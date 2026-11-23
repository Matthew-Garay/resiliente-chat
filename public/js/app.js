/**
 * Resiliente Chat — cliente.
 *
 * Todo lo sensible ocurre aquí, en el navegador:
 * - La clave se genera aquí y viaja solo en el fragmento (#) del enlace.
 * - Los mensajes se cifran antes de salir y se descifran al llegar.
 * - Cada mensaje se elimina de la pantalla y de la memoria al expirar.
 * - No se usa localStorage ni cookies. El enlace se guarda en sessionStorage
 *   (se borra al cerrar la pestaña) solo para sobrevivir a una recarga.
 */

import {
  randomRoomId, generateKey, exportKey, importKey,
  encryptMessage, decryptMessage, buildInvite, parseInvite,
} from './crypto.js';

const MIN_TTL = 5;
const MAX_TTL = 3600;
const MAX_TEXT = 2000;
const MAX_NAME = 30;
const SESSION_KEY = 'resiliente.invite';
const MAX_CT_LENGTH = 16_500; // igual que en el servidor

const $ = (id) => document.getElementById(id);
const els = {
  landing: $('landing'),
  landingError: $('landing-error'),
  createRoom: $('create-room'),
  room: $('room'),
  presenceDot: $('presence-dot'),
  presenceText: $('presence-text'),
  copyLink: $('copy-link'),
  leaveRoom: $('leave-room'),
  messages: $('messages'),
  emptyState: $('empty-state'),
  emptyHint: $('empty-hint'),
  list: $('message-list'),
  composer: $('composer'),
  nameInput: $('name-input'),
  ttlSelect: $('ttl-select'),
  messageInput: $('message-input'),
  sendBtn: $('send-btn'),
  status: $('composer-status'),
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
  ws: null,
  joined: false,
  peers: 0,
  retry: 0,
  retryTimer: null,
  leaving: false,
  messages: new Map(), // id -> { el, timer, expiresAt, ttl }
  pending: new Map(), // ref -> id de mensajes propios aún sin confirmar
  tick: null,
  undecryptableShown: false,
};

/* ------------------------------------------------------------------ */
/* Arranque                                                            */
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

function storeInvite(room, rawKey) {
  try { sessionStorage.setItem(SESSION_KEY, `#r=${room}&k=${rawKey}`); } catch { /* sin almacenamiento: no pasa nada */ }
}

function clearStoredInvite() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignorar */ }
}

/** Quita la clave de la barra de direcciones para que no quede a la vista. */
function scrubAddressBar() {
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
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

  if (invite) {
    await enterRoom(invite.room, invite.key);
  } else {
    showLanding(hadHash ? 'Ese enlace está incompleto o dañado. Pide que te lo vuelvan a enviar o crea una sala nueva.' : '');
  }
}

function showLanding(error = '') {
  els.room.hidden = true;
  els.landing.hidden = false;
  els.landingError.textContent = error;
  els.landingError.hidden = !error;
  document.title = 'Resiliente Chat';
  els.createRoom.focus();
}

/* ------------------------------------------------------------------ */
/* Salas                                                               */
/* ------------------------------------------------------------------ */

async function createRoom() {
  els.createRoom.disabled = true;
  try {
    const key = await generateKey();
    await enterRoom(randomRoomId(), await exportKey(key));
  } catch {
    showLanding('Tu navegador no permite cifrar en esta página. Ábrela por HTTPS o desde localhost.');
  } finally {
    els.createRoom.disabled = false;
  }
}

async function enterRoom(room, rawKey) {
  let key;
  try {
    key = await importKey(rawKey);
  } catch {
    showLanding('No se pudo leer la clave del enlace. Pide que te lo vuelvan a enviar.');
    return;
  }

  Object.assign(state, { room, rawKey, key, leaving: false, retry: 0, undecryptableShown: false });
  storeInvite(room, rawKey);

  els.landing.hidden = true;
  els.room.hidden = false;
  document.title = 'Sala privada · Resiliente';
  updateEmptyState();
  startTicker();
  connect();
  els.messageInput.focus();
}

function leaveRoom() {
  state.leaving = true;
  clearTimeout(state.retryTimer);
  if (state.ws) state.ws.close(1000, 'bye');
  wipeEverything();
  showLanding();
}

/** Borra todo rastro de la sesión: mensajes, clave y enlace. */
function wipeEverything() {
  for (const { el } of state.messages.values()) el.remove();
  state.messages.clear();
  state.pending.clear();
  els.list.replaceChildren();
  els.messageInput.value = '';
  setStatus('');
  stopTicker();
  clearStoredInvite();
  Object.assign(state, { room: null, rawKey: null, key: null, ws: null, joined: false, peers: 0 });
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
      setStatus('');
      updateSendButton();
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
  if (code === 'bad_room' || code === 'room_full' || code === 'server_full') {
    state.leaving = true;
    wipeEverything();
    showLanding(text);
    return;
  }
  setStatus(text, true);
}

/* ------------------------------------------------------------------ */
/* Mensajes                                                            */
/* ------------------------------------------------------------------ */

function clampTtl(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 60;
  return Math.min(MAX_TTL, Math.max(MIN_TTL, n));
}

async function send(event) {
  event.preventDefault();
  const text = els.messageInput.value.trim().slice(0, MAX_TEXT);
  const name = (els.nameInput.value.trim() || randomAlias()).slice(0, MAX_NAME);
  if (!text || !state.joined) return;

  const ttl = clampTtl(els.ttlSelect.value);
  const payload = { v: 1, n: name, t: text, ttl };
  const { ws, key, room } = state;

  let sealed;
  try {
    sealed = await encryptMessage(key, room, payload);
  } catch {
    setStatus('No se pudo cifrar el mensaje.', true);
    return;
  }
  if (sealed.ct.length > MAX_CT_LENGTH) {
    setStatus('El mensaje es demasiado largo una vez cifrado. Acórtalo un poco.', true);
    return;
  }
  // Si mientras se cifraba se salió de la sala o se reconectó, no se envía.
  if (ws !== state.ws || room !== state.room || !state.joined || ws.readyState !== WebSocket.OPEN) {
    setStatus('No enviado: la conexión cambió. Vuelve a enviarlo.', true);
    return;
  }

  const ref = crypto.randomUUID();
  ws.send(JSON.stringify({ type: 'msg', ...sealed, ref }));

  els.messageInput.value = '';
  autoGrow();
  updateSendButton();
  const id = render({ name, text, ttl, own: true, pending: true });
  state.pending.set(ref, id);
  setStatus('');
  if (state.peers <= 1) {
    setStatus('Nadie más está en la sala: este mensaje no lo ha recibido nadie.');
  }
}

async function receive(sealed) {
  const { key, room } = state;
  if (!key) return;
  let payload;
  try {
    payload = await decryptMessage(key, room, sealed);
  } catch {
    if (room !== state.room) return;
    if (!state.undecryptableShown) {
      state.undecryptableShown = true;
      notice('Llegó un mensaje que no se pudo descifrar. Quien lo envió puede tener un enlace distinto.', true);
    }
    return;
  }
  // Si mientras se descifraba se salió de la sala, el mensaje se descarta.
  if (room !== state.room || key !== state.key) return;
  if (!payload || typeof payload.t !== 'string' || typeof payload.n !== 'string') return;

  render({
    name: payload.n.slice(0, MAX_NAME) || 'Anónimo',
    text: payload.t.slice(0, MAX_TEXT),
    ttl: clampTtl(payload.ttl),
    own: false,
  });
}

function nameColor(name) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  const hue = NAME_HUES[hash % NAME_HUES.length];
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  return dark ? `hsl(${hue} 70% 72%)` : `hsl(${hue} 65% 32%)`;
}

/** Pinta un mensaje. Solo se usa textContent: nunca se interpreta HTML. */
function render({ name, text, ttl, own, pending = false }) {
  const id = crypto.randomUUID();
  const expiresAt = Date.now() + ttl * 1000;

  const li = document.createElement('li');
  li.className = own ? 'msg is-own' : 'msg';
  if (pending) li.classList.add('is-pending');

  const head = document.createElement('div');
  head.className = 'msg-head';
  const who = document.createElement('span');
  who.className = 'msg-name';
  who.textContent = own ? `${name} (tú)` : name;
  who.style.color = nameColor(name);
  const timer = document.createElement('span');
  timer.className = 'msg-timer';
  head.append(who, timer);

  const body = document.createElement('p');
  body.className = 'msg-text';
  body.textContent = text;

  const fuse = document.createElement('span');
  fuse.className = 'msg-fuse';
  fuse.setAttribute('aria-hidden', 'true');

  li.append(head, body, fuse);

  const stick = isNearBottom();
  els.list.append(li);
  state.messages.set(id, { el: li, timer, expiresAt, ttl });
  updateMessage(id, Date.now());
  updateEmptyState();
  if (stick || own) scrollToBottom();
  return id;
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
    m.el.remove();
    state.messages.delete(id);
    updateEmptyState();
    return;
  }
  m.el.style.setProperty('--life', String(Math.max(0, remaining / (m.ttl * 1000))));
  m.timer.textContent = m.failed
    ? `${m.failed} · se borra en ${formatRemaining(remaining)}`
    : `se borra en ${formatRemaining(remaining)}`;
}

function formatRemaining(ms) {
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s} s`;
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
  const hasMessages = state.messages.size > 0;
  els.emptyState.hidden = hasMessages;
  els.emptyHint.textContent = state.peers > 1
    ? 'Escribe algo. Cada mensaje desaparece cuando se acaba su tiempo.'
    : 'Comparte el enlace con quien quieras invitar. Solo quien lo tenga puede entrar y leer.';
}

function updateSendButton() {
  els.sendBtn.disabled = !state.joined || !els.messageInput.value.trim();
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
  const url = buildInvite(location.href, state.room, state.rawKey);
  try {
    await navigator.clipboard.writeText(url);
    setStatus('Enlace copiado. Quien lo tenga puede leer la sala: compártelo solo por un canal de confianza.');
  } catch {
    window.prompt('Copia este enlace:', url);
  }
}

/* ------------------------------------------------------------------ */
/* Eventos                                                             */
/* ------------------------------------------------------------------ */

els.createRoom.addEventListener('click', createRoom);
els.copyLink.addEventListener('click', copyLink);
els.leaveRoom.addEventListener('click', leaveRoom);
els.composer.addEventListener('submit', send);
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
  leaveRoom();
  await enterRoom(invite.room, invite.key);
});

// Al cerrar la pestaña se cierra la conexión; el resto vive solo en memoria.
window.addEventListener('pagehide', () => {
  if (state.ws) state.ws.close(1000, 'bye');
});

boot();
