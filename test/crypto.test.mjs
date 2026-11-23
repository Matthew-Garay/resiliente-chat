import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  randomRoomId, generateKey, exportKey, importKey,
  encryptMessage, decryptMessage, parseInvite, buildInvite,
  deriveRoomSecret, VERIFICATION_WORDS,
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
  assert.deepEqual(parseInvite(`#r=${ROOM}&k=${key}`), { room: ROOM, key, password: false });
});

test('parseInvite rechaza fragmentos incompletos o inválidos', () => {
  assert.equal(parseInvite(''), null);
  assert.equal(parseInvite('#r=corto&k=abc'), null);
  assert.equal(parseInvite(`#r=${ROOM}`), null);
});

test('el enlace indica si la sala tiene contraseña (sin incluirla)', () => {
  const key = 'k'.repeat(43);
  const url = buildInvite('https://x.com/', ROOM, key, { password: true });
  assert.equal(url, `https://x.com/#r=${ROOM}&k=${key}&p=1`);
  assert.deepEqual(parseInvite(`#r=${ROOM}&k=${key}&p=1`), { room: ROOM, key, password: true });
});

test('sin contraseña, deriveRoomSecret descifra lo cifrado con la clave del enlace', async () => {
  const raw = await exportKey(await generateKey());
  const a = await deriveRoomSecret(raw, ROOM);
  const b = await deriveRoomSecret(raw, ROOM, '');
  const sealed = await encryptMessage(a.key, ROOM, { t: 'hola' });
  assert.deepEqual(await decryptMessage(b.key, ROOM, sealed), { t: 'hola' });
  assert.deepEqual(a.code, b.code);
});

test('con contraseña, solo la misma contraseña descifra', async () => {
  const raw = await exportKey(await generateKey());
  const good = await deriveRoomSecret(raw, ROOM, 'luna llena');
  const same = await deriveRoomSecret(raw, ROOM, 'luna llena');
  const wrong = await deriveRoomSecret(raw, ROOM, 'luna nueva');
  const none = await deriveRoomSecret(raw, ROOM);
  const sealed = await encryptMessage(good.key, ROOM, { t: 'secreto' });
  assert.deepEqual(await decryptMessage(same.key, ROOM, sealed), { t: 'secreto' });
  await assert.rejects(decryptMessage(wrong.key, ROOM, sealed));
  await assert.rejects(decryptMessage(none.key, ROOM, sealed));
});

test('el código de verificación son 4 palabras que cambian con la clave o la contraseña', async () => {
  const raw = await exportKey(await generateKey());
  const a = await deriveRoomSecret(raw, ROOM, 'x');
  const b = await deriveRoomSecret(raw, ROOM, 'x');
  const c = await deriveRoomSecret(raw, ROOM, 'y');
  const d = await deriveRoomSecret(await exportKey(await generateKey()), ROOM, 'x');
  assert.equal(a.code.length, 4);
  assert.ok(a.code.every((w) => VERIFICATION_WORDS.includes(w)));
  assert.deepEqual(a.code, b.code);
  assert.notDeepEqual(a.code, c.code);
  assert.notDeepEqual(a.code, d.code);
});

test('la lista de palabras tiene 64 palabras distintas', () => {
  assert.equal(new Set(VERIFICATION_WORDS).size, 64);
});
