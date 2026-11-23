import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  randomRoomId, generateKey, exportKey, importKey,
  encryptMessage, decryptMessage, parseInvite, buildInvite,
} from '../public/js/crypto.js';

const ROOM = 'AAAAAAAAAAAAAAAAAAAAAA';

test('randomRoomId produce 22 caracteres base64url distintos cada vez', () => {
  const a = randomRoomId();
  const b = randomRoomId();
  assert.match(a, /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(a, b);
});

test('la clave se exporta e importa sin perder nada', async () => {
  const key = await generateKey();
  const raw = await exportKey(key);
  assert.match(raw, /^[A-Za-z0-9_-]{43}$/);
  const again = await importKey(raw);
  const sealed = await encryptMessage(key, ROOM, { t: 'hola' });
  assert.deepEqual(await decryptMessage(again, ROOM, sealed), { t: 'hola' });
});

test('cifra y descifra; el texto cifrado no contiene el mensaje', async () => {
  const key = await generateKey();
  const sealed = await encryptMessage(key, ROOM, { n: 'Ana', t: 'secreto' });
  assert.match(sealed.iv, /^[A-Za-z0-9_-]{16}$/);
  assert.ok(!sealed.ct.includes('secreto'));
  assert.deepEqual(await decryptMessage(key, ROOM, sealed), { n: 'Ana', t: 'secreto' });
});

test('cada mensaje usa un IV distinto', async () => {
  const key = await generateKey();
  const a = await encryptMessage(key, ROOM, { t: 'x' });
  const b = await encryptMessage(key, ROOM, { t: 'x' });
  assert.notEqual(a.iv, b.iv);
});

test('con otra clave no se puede descifrar', async () => {
  const sealed = await encryptMessage(await generateKey(), ROOM, { t: 'x' });
  await assert.rejects(decryptMessage(await generateKey(), ROOM, sealed));
});

test('un mensaje de otra sala no se acepta aunque la clave coincida', async () => {
  const key = await generateKey();
  const sealed = await encryptMessage(key, ROOM, { t: 'x' });
  await assert.rejects(decryptMessage(key, 'BBBBBBBBBBBBBBBBBBBBBB', sealed));
});

test('un mensaje alterado se rechaza', async () => {
  const key = await generateKey();
  const sealed = await encryptMessage(key, ROOM, { t: 'hola mundo' });
  const flipped = sealed.ct[0] === 'A' ? 'B' : 'A';
  await assert.rejects(decryptMessage(key, ROOM, { ...sealed, ct: flipped + sealed.ct.slice(1) }));
});

test('el enlace de invitación lleva sala y clave en el fragmento (#)', () => {
  const key = 'k'.repeat(43);
  const url = buildInvite('https://chat.ejemplo.com/', ROOM, key);
  assert.equal(url, `https://chat.ejemplo.com/#r=${ROOM}&k=${key}`);
  assert.deepEqual(parseInvite(`#r=${ROOM}&k=${key}`), { room: ROOM, key });
});

test('parseInvite rechaza fragmentos incompletos o inválidos', () => {
  assert.equal(parseInvite(''), null);
  assert.equal(parseInvite('#r=corto&k=abc'), null);
  assert.equal(parseInvite(`#r=${ROOM}`), null);
});
