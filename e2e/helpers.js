'use strict';

/**
 * Utilidades para las pruebas en navegador real (Chrome/Chromium con Playwright).
 * El servidor se arranca dentro del proceso, con HTTPS y un certificado temporal.
 */

const fs = require('fs');
const selfsigned = require('selfsigned');
const { chromium } = require('playwright-core');
const { createChatServer } = require('../src/server');

const pems = selfsigned.generate([{ name: 'commonName', value: '127.0.0.1' }], { keySize: 2048, days: 1 });

/** Arranca el chat en HTTPS. Con `port` se reutiliza un puerto (para probar reconexiones). */
async function startServer(port = 0, options = {}) {
  const chat = createChatServer({ tls: { cert: pems.cert, key: pems.private }, heartbeatMs: 60_000, ...options });
  await new Promise((resolve) => chat.server.listen(port, '127.0.0.1', resolve));
  const actual = chat.server.address().port;
  return { chat, port: actual, url: `https://127.0.0.1:${actual}/` };
}

/** Chrome instalado (CHROME_PATH o rutas habituales) o, si no hay, el Chromium de Playwright. */
function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p));
}

function launchBrowser() {
  return chromium.launch({ executablePath: chromePath() });
}

/** Página nueva en su propio contexto (como otra persona), que acumula errores de consola. */
async function openPage(browser, errors, who, options = {}) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1100, height: 800 }, ...options });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${who}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
  return page;
}

/**
 * Espera a que `fn` devuelva true dentro de la página.
 * (No se usa page.waitForFunction porque la CSP del chat prohíbe eval.)
 */
async function waitFor(page, fn, { timeout = 10_000, arg } = {}) {
  const end = Date.now() + timeout;
  let lastError;
  for (;;) {
    try {
      if (await page.evaluate(fn, arg)) return;
    } catch (e) {
      lastError = e;
    }
    if (Date.now() > end) {
      throw new Error(`Tiempo agotado esperando: ${fn.toString().slice(0, 120)}${lastError ? ` (${lastError.message})` : ''}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

const presenceIncludes = (page, text, opts) =>
  waitFor(page, (t) => document.querySelector('#presence-text').textContent.includes(t), { ...opts, arg: text });

const textOf = (page, selector) => page.evaluate((s) => document.querySelector(s)?.textContent || '', selector);

/** Errores de consola que no son esperables en una sesión normal. */
function unexpectedErrors(errors, allowed = []) {
  const ok = [/WebSocket connection .* failed/, /ERR_CONNECTION_REFUSED/, ...allowed];
  return errors.filter((e) => !ok.some((re) => re.test(e)));
}

module.exports = { startServer, launchBrowser, openPage, waitFor, presenceIncludes, textOf, unexpectedErrors };
