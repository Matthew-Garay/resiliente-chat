'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');
const WebSocket = require('ws');
const selfsigned = require('selfsigned');
const { createChatServer } = require('../src/server');

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: false }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, hsts: res.headers['strict-transport-security'], body: JSON.parse(body) }));
    }).on('error', reject);
  });
}

test('con certificado sirve HTTPS y WSS', async () => {
  const pems = selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { keySize: 2048, days: 1 });
  const chat = createChatServer({ tls: { cert: pems.cert, key: pems.private }, heartbeatMs: 60_000 });
  await new Promise((resolve) => chat.server.listen(0, '127.0.0.1', resolve));
  const { port } = chat.server.address();

  try {
    const res = await getJson(`https://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: 'ok' });
    assert.equal(res.hsts, undefined, 'sin HSTS para poder aceptar un certificado autofirmado');

    const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, { rejectUnauthorized: false });
    const joined = await new Promise((resolve, reject) => {
      ws.on('open', () => ws.send(JSON.stringify({ type: 'join', room: 'CCCCCCCCCCCCCCCCCCCCCC' })));
      ws.on('message', (m) => resolve(JSON.parse(m.toString())));
      ws.on('error', reject);
    });
    assert.equal(joined.type, 'joined');
    ws.close();
  } finally {
    await chat.close();
  }
});
