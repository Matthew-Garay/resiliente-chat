'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { createChatServer } = require('../src/server');

const ROOM_A = 'AAAAAAAAAAAAAAAAAAAAAA'; // 22 caracteres base64url
const ROOM_B = 'BBBBBBBBBBBBBBBBBBBBBB';
const IV = 'aaaaaaaaaaaaaaaa'; // 12 bytes en base64url
const CT = 'Y2lmcmFkbw';

let chat;
let baseUrl;

before(async () => {
  chat = createChatServer({ joinTimeoutMs: 300, maxRoomSize: 3, maxConnectionsPerIp: 100, heartbeatMs: 60_000, rate: { capacity: 5, refillPerSec: 1 } });
  await new Promise((resolve) => chat.server.listen(0, '127.0.0.1', resolve));
  const { port } = chat.server.address();
  baseUrl = `127.0.0.1:${port}`;
});

after(async () => {
  await chat.close();
});

/** Abre un cliente y acumula los mensajes que recibe. */
function openClient(url = baseUrl, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${url}/ws`, { headers });
    ws.inbox = [];
    ws.waiters = [];
    ws.on('message', (raw) => {
      const data = JSON.parse(raw.toString());
      const idx = ws.waiters.findIndex((w) => w.pred(data));
      if (idx >= 0) ws.waiters.splice(idx, 1)[0].resolve(data);
      else ws.inbox.push(data);
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/** Espera el siguiente mensaje que cumpla el predicado. */
function next(ws, pred = () => true, timeoutMs = 1000) {
  const idx = ws.inbox.findIndex(pred);
  if (idx >= 0) return Promise.resolve(ws.inbox.splice(idx, 1)[0]);
  return new Promise((resolve, reject) => {
    const waiter = { pred, resolve };
    ws.waiters.push(waiter);
    setTimeout(() => {
      const i = ws.waiters.indexOf(waiter);
      if (i >= 0) {
        ws.waiters.splice(i, 1);
        reject(new Error('timeout esperando mensaje'));
      }
    }, timeoutMs);
  });
}

/** Comprueba que NO llega ningún mensaje que cumpla el predicado. */
async function nothing(ws, pred = () => true, ms = 200) {
  await assert.rejects(next(ws, pred, ms), /timeout/);
}

function send(ws, obj) {
  ws.send(JSON.stringify(obj));
}

async function join(room) {
  const ws = await openClient();
  send(ws, { type: 'join', room });
  const joined = await next(ws, (m) => m.type === 'joined');
  return { ws, joined };
}

function closed(ws) {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.on('close', (code) => resolve(code));
  });
}

test('/health responde ok sin datos de usuarios', async () => {
  const res = await fetch(`http://${baseUrl}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('las respuestas HTTP piden no guardar caché', async () => {
  const res = await fetch(`http://${baseUrl}/`);
  assert.match(res.headers.get('cache-control') || '', /no-store/);
});

test('reenvía mensajes cifrados solo a la misma sala y no al emisor', async () => {
  const a1 = await join(ROOM_A);
  const a2 = await join(ROOM_A);
  const b1 = await join(ROOM_B);

  send(a1.ws, { type: 'msg', iv: IV, ct: CT, ref: 'r1' });

  const got = await next(a2.ws, (m) => m.type === 'msg');
  assert.deepEqual(await next(a1.ws, (m) => m.type === 'ack'), { type: 'ack', ref: 'r1' });
  assert.deepEqual(got, { type: 'msg', iv: IV, ct: CT });
  await nothing(a1.ws, (m) => m.type === 'msg');
  await nothing(b1.ws, (m) => m.type === 'msg');

  [a1, a2, b1].forEach(({ ws }) => ws.close());
});

test('quien entra tarde no recibe mensajes anteriores (sin historial)', async () => {
  const a1 = await join(ROOM_A);
  const a2 = await join(ROOM_A);
  send(a1.ws, { type: 'msg', iv: IV, ct: CT });
  await next(a2.ws, (m) => m.type === 'msg');

  const late = await join(ROOM_A);
  await nothing(late.ws, (m) => m.type === 'msg');

  [a1, a2, late].forEach(({ ws }) => ws.close());
});

test('informa cuántas personas hay en la sala', async () => {
  const a1 = await join(ROOM_A);
  assert.equal(a1.joined.peers, 1);

  const a2 = await join(ROOM_A);
  assert.equal(a2.joined.peers, 2);
  assert.equal((await next(a1.ws, (m) => m.type === 'presence')).peers, 2);

  a2.ws.close();
  assert.equal((await next(a1.ws, (m) => m.type === 'presence')).peers, 1);
  a1.ws.close();
});

test('la sala desaparece del servidor cuando sale la última persona', async () => {
  const a1 = await join(ROOM_A);
  assert.equal(chat.roomCount(), 1);
  a1.ws.close();
  await closed(a1.ws);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(chat.roomCount(), 0);
});

test('rechaza identificadores de sala inválidos', async () => {
  const ws = await openClient();
  send(ws, { type: 'join', room: '../etc/passwd' });
  assert.equal((await next(ws, (m) => m.type === 'error')).code, 'bad_room');
  await closed(ws);
});

test('ignora mensajes antes de unirse a una sala', async () => {
  const ws = await openClient();
  send(ws, { type: 'msg', iv: IV, ct: CT });
  assert.equal((await next(ws, (m) => m.type === 'error')).code, 'not_joined');
  ws.close();
});

test('rechaza mensajes con formato inválido', async () => {
  const { ws } = await join(ROOM_A);
  ws.send('esto no es json');
  assert.equal((await next(ws, (m) => m.type === 'error')).code, 'bad_message');
  send(ws, { type: 'msg', iv: 'corto', ct: CT });
  assert.equal((await next(ws, (m) => m.type === 'error')).code, 'bad_message');
  send(ws, { type: 'msg', iv: IV, ct: 'x'.repeat(390_000) });
  assert.equal((await next(ws, (m) => m.type === 'error')).code, 'bad_message');
  ws.close();
});

test('corta la conexión si el mensaje supera el tamaño máximo', async () => {
  const { ws } = await join(ROOM_A);
  send(ws, { type: 'msg', iv: IV, ct: 'x'.repeat(450_000) });
  assert.equal(await closed(ws), 1009);
});

test('no permite unirse dos veces', async () => {
  const { ws } = await join(ROOM_A);
  send(ws, { type: 'join', room: ROOM_B });
  assert.equal((await next(ws, (m) => m.type === 'error')).code, 'already_joined');
  ws.close();
});

test('limita el tamaño de la sala', async () => {
  const members = [await join(ROOM_B), await join(ROOM_B), await join(ROOM_B)];
  const extra = await openClient();
  send(extra, { type: 'join', room: ROOM_B });
  assert.equal((await next(extra, (m) => m.type === 'error')).code, 'room_full');
  await closed(extra);
  members.forEach(({ ws }) => ws.close());
});

test('limita la frecuencia de mensajes (anti-spam)', async () => {
  const a1 = await join(ROOM_A);
  const a2 = await join(ROOM_A);
  for (let i = 0; i < 8; i++) send(a1.ws, { type: 'msg', iv: IV, ct: CT, ref: `m${i}` });
  const err = await next(a1.ws, (m) => m.type === 'error');
  assert.equal(err.code, 'rate_limited');
  assert.equal(err.ref, 'm4', 'el error indica qué mensaje se rechazó');

  let delivered = 0;
  try {
    for (;;) { await next(a2.ws, (m) => m.type === 'msg', 200); delivered++; }
  } catch { /* fin */ }
  // capacidad 5: el 'join' gasta una ficha, así que pasan 4 mensajes.
  assert.equal(delivered, 4);
  [a1, a2].forEach(({ ws }) => ws.close());
});

test('cierra conexiones que no se unen a ninguna sala a tiempo', async () => {
  const ws = await openClient();
  assert.equal(await closed(ws), 1008);
});

test('el límite anti-spam también cubre tramas que no son mensajes', async () => {
  const { ws } = await join(ROOM_A);
  for (let i = 0; i < 10; i++) ws.send('{}');
  const codes = [];
  try { for (;;) codes.push((await next(ws, (m) => m.type === 'error', 200)).code); } catch { /* fin */ }
  assert.ok(codes.includes('rate_limited'));
  ws.close();
});

test('cierra conexiones que abusan del límite una y otra vez', async () => {
  const { ws } = await join(ROOM_A);
  for (let i = 0; i < 60; i++) ws.send('{}');
  assert.equal(await closed(ws), 1008);
});

test('limita las conexiones simultáneas por IP', async () => {
  const small = createChatServer({ maxConnectionsPerIp: 2, heartbeatMs: 60_000 });
  await new Promise((resolve) => small.server.listen(0, '127.0.0.1', resolve));
  const url = `127.0.0.1:${small.server.address().port}`;
  const c1 = await openClient(url);
  const c2 = await openClient(url);
  await assert.rejects(openClient(url), /429/);
  c1.close();
  await closed(c1);
  await new Promise((r) => setTimeout(r, 50));
  const c3 = await openClient(url);
  [c2, c3].forEach((c) => c.close());
  await small.close();
});

test('con trustProxy usa la IP de X-Forwarded-For y acepta X-Forwarded-Host', async () => {
  const proxied = createChatServer({ maxConnectionsPerIp: 1, trustProxy: true, heartbeatMs: 60_000 });
  await new Promise((resolve) => proxied.server.listen(0, '127.0.0.1', resolve));
  const url = `127.0.0.1:${proxied.server.address().port}`;
  const h = (ip) => ({ 'X-Forwarded-For': ip, 'X-Forwarded-Host': 'chat.ejemplo.com', Origin: 'https://chat.ejemplo.com' });
  const u1 = await openClient(url, h('203.0.113.1'));
  const u2 = await openClient(url, h('203.0.113.2'));
  await assert.rejects(openClient(url, h('203.0.113.1')), /429/);
  [u1, u2].forEach((c) => c.close());
  await proxied.close();
});

test('rechaza WebSockets abiertos desde otra web', async () => {
  await assert.rejects(openClient(baseUrl, { Origin: 'https://malicioso.example' }), /401|403/);
});

test('acepta imágenes cifradas grandes (hasta ~380 KB)', async () => {
  const a1 = await join(ROOM_A);
  const a2 = await join(ROOM_A);
  const big = 'x'.repeat(370_000);
  send(a1.ws, { type: 'msg', iv: IV, ct: big, ref: 'img' });
  const got = await next(a2.ws, (m) => m.type === 'msg', 3000);
  assert.equal(got.ct.length, big.length);
  [a1, a2].forEach(({ ws }) => ws.close());
});

test('limita también los bytes por segundo (anti-spam de imágenes)', async () => {
  const small = createChatServer({ heartbeatMs: 60_000, byteRate: { capacity: 1_000_000, refillPerSec: 1 } });
  await new Promise((resolve) => small.server.listen(0, '127.0.0.1', resolve));
  const url = `127.0.0.1:${small.server.address().port}`;
  const ws = await openClient(url);
  send(ws, { type: 'join', room: ROOM_A });
  await next(ws, (m) => m.type === 'joined');
  const big = 'x'.repeat(370_000);
  for (let i = 0; i < 3; i++) send(ws, { type: 'msg', iv: IV, ct: big, ref: `b${i}` });
  const replies = [await next(ws, () => true, 3000), await next(ws, () => true, 3000), await next(ws, () => true, 3000)];
  assert.deepEqual(replies.map((r) => r.type), ['ack', 'ack', 'error']);
  assert.equal(replies[2].code, 'rate_limited');
  assert.equal(replies[2].ref, 'b2');
  ws.close();
  await small.close();
});

test('rechaza una configuración de bytes que bloquearía siempre las imágenes', () => {
  assert.throws(() => createChatServer({ byteRate: { capacity: 100_000, refillPerSec: 1 } }), /byteRate/);
});
