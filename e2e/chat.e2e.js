'use strict';

/**
 * Pruebas en navegador real: varias personas (contextos de Chrome separados) usando el chat.
 * Ejecutar con: npm run test:e2e
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  startServer, launchBrowser, openPage, waitFor, presenceIncludes, textOf, unexpectedErrors,
} = require('./helpers');

const ICONS = path.join(__dirname, '..', 'public', 'icons');

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });

describe('sala básica', () => {
  const errors = [];
  let srv;
  let a;
  let b;
  let invite;

  before(async () => { srv = await startServer(); });
  after(async () => { await srv.chat.close(); });

  test('crear una sala no deja la clave en la barra ni usa cookies o localStorage', async () => {
    a = await openPage(browser, errors, 'A');
    await a.goto(srv.url);
    assert.ok(await a.isVisible('#landing'));
    await a.click('#create-room');
    await presenceIncludes(a, 'Solo tú');
    assert.ok(!a.url().includes('#'), 'la clave no queda en la barra de direcciones');
    invite = await a.evaluate(() => sessionStorage.getItem('resiliente.invite'));
    assert.match(invite, /^#r=[\w-]{22}&k=[\w-]{43}$/);
    assert.ok(await a.evaluate(() => localStorage.length === 0 && document.cookie === ''));
  });

  test('otra persona entra con el enlace y ambos ven la presencia', async () => {
    b = await openPage(browser, errors, 'B', { viewport: { width: 390, height: 780 }, colorScheme: 'dark' });
    await b.goto(srv.url + invite);
    await presenceIncludes(b, '2 personas');
    await presenceIncludes(a, '2 personas');
  });

  test('los mensajes llegan descifrados y el HTML no se interpreta', async () => {
    await a.evaluate(() => { const o = new Option('5 s', '5'); document.querySelector('#ttl-select').add(o); o.selected = true; });
    await a.fill('#name-input', 'Ana');
    await a.fill('#message-input', 'Hola <b>B</b>, esto se borra');
    await a.keyboard.press('Enter');
    await b.waitForSelector('.msg-text');
    assert.equal(await textOf(b, '.msg-text'), 'Hola <b>B</b>, esto se borra');
    assert.equal(await textOf(b, '.msg-name'), 'Ana');
    assert.equal(await textOf(a, '.msg-name'), 'Ana (tú)');
    await waitFor(a, () => !document.querySelector('.msg.is-pending'));
  });

  test('los mensajes desaparecen de ambas pantallas al acabar su tiempo', async () => {
    await waitFor(b, () => !document.body.innerHTML.includes('esto se borra'), { timeout: 8000 });
    await waitFor(a, () => !document.body.innerHTML.includes('esto se borra'), { timeout: 2000 });
  });

  test('con la pestaña en segundo plano, el título cuenta los mensajes nuevos (sin su contenido)', async () => {
    await b.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await a.selectOption('#ttl-select', '300');
    for (const t of ['uno', 'dos']) { await a.fill('#message-input', t); await a.keyboard.press('Enter'); }
    await waitFor(b, () => document.title.startsWith('(2) '));
    assert.ok(!(await b.title()).includes('uno'));
    await b.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(b, () => !document.title.startsWith('('));
  });

  test('al recargar se vuelve a la sala sin que reaparezcan mensajes', async () => {
    await b.reload();
    await presenceIncludes(b, '2 personas');
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await b.$$('.msg')).length, 0);
  });

  test('con otra clave no se puede leer la sala', async () => {
    const c = await openPage(browser, errors, 'C');
    await c.goto(srv.url + invite.replace(/k=.*/, `k=${'A'.repeat(43)}`));
    await presenceIncludes(c, '3 personas');
    await a.fill('#message-input', 'Solo para quien tiene la clave');
    await a.keyboard.press('Enter');
    await waitFor(c, () => [...document.querySelectorAll('.notice.is-error')].some((n) => n.textContent.includes('descifrar')));
    assert.ok(!(await c.content()).includes('Solo para quien'));
    await c.context().close();
    await presenceIncludes(a, '2 personas');
  });

  test('un enlace dañado avisa y no lleva en silencio a otra sala', async () => {
    const d = await openPage(browser, errors, 'D');
    await d.goto(`${srv.url}#r=roto&k=x`);
    assert.match(await textOf(d, '#landing-error'), /incompleto/);
    await d.context().close();

    // Misma pestaña, solo cambia el # (sin recarga): aviso y sigue en su sala.
    await b.goto(`${srv.url}#r=roto&k=x`);
    await waitFor(b, () => document.querySelector('#composer-status').textContent.includes('dañado'));
    assert.ok(await b.isVisible('#room'));
    // Carga completa con enlace dañado: error, no vuelve a la sala guardada.
    await b.goto(`${srv.url}?nueva=1#r=roto&k=x`);
    assert.match(await textOf(b, '#landing-error'), /incompleto/);
    await b.goto(srv.url + invite);
    await presenceIncludes(b, '2 personas');
  });

  test('el anti-spam marca como "No enviado" lo que el servidor rechaza', async () => {
    for (let i = 0; i < 16; i++) { await a.fill('#message-input', `spam ${i}`); await a.keyboard.press('Enter'); }
    await waitFor(a, () => document.querySelectorAll('.msg.is-failed').length > 0 && !document.querySelector('.msg.is-pending'));
    const labels = await a.$$eval('.msg.is-failed .msg-timer', (els) => els.map((e) => e.textContent));
    assert.ok(labels.every((t) => t.startsWith('No enviado')));
    assert.match(await textOf(a, '#composer-status'), /muy rápido/);
  });

  test('"Salir y borrar" elimina mensajes y enlace, y los demás lo ven', async () => {
    await b.click('#leave-room');
    assert.ok(await b.isVisible('#landing'));
    assert.ok(await b.evaluate(() => sessionStorage.length === 0 && document.querySelectorAll('.msg').length === 0));
    await presenceIncludes(a, 'Solo tú');
  });

  test('si el servidor se cae, la sala se reconecta sola al volver', async () => {
    const { port } = srv;
    await srv.chat.close();
    await presenceIncludes(a, 'Sin conexión');
    srv = await startServer(port);
    await presenceIncludes(a, 'Solo tú', { timeout: 20_000 });
  });

  test('sin errores inesperados en la consola', () => {
    assert.deepEqual(unexpectedErrors(errors), []);
  });
});

describe('contraseña, código, ver una vez e imágenes', () => {
  const errors = [];
  let srv;
  let a;
  let b;
  let invite;

  before(async () => { srv = await startServer(); });
  after(async () => { await srv.chat.close(); });

  test('el manifiesto y los iconos de la app instalable están disponibles', async () => {
    a = await openPage(browser, errors, 'A');
    await a.goto(srv.url);
    const info = await a.evaluate(async () => {
      const r = await fetch('manifest.webmanifest');
      const icons = await Promise.all(['icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/icon.svg']
        .map(async (u) => (await fetch(u)).status));
      return { type: r.headers.get('content-type'), body: await r.json(), icons };
    });
    assert.match(info.type, /manifest\+json/);
    assert.equal(info.body.display, 'standalone');
    assert.deepEqual(info.icons, [200, 200, 200, 200]);
  });

  test('una sala con contraseña marca el enlace sin incluir la contraseña', async () => {
    await a.click('#password-option summary');
    await a.fill('#create-password', 'luna llena');
    await a.click('#create-room');
    await presenceIncludes(a, 'Solo tú');
    invite = await a.evaluate(() => sessionStorage.getItem('resiliente.invite'));
    assert.match(invite, /&p=1$/);
    assert.ok(!invite.includes('luna'));
    await a.fill('#name-input', 'Ana');
  });

  test('con contraseña incorrecta se avisa sin expulsar a nadie', async () => {
    b = await openPage(browser, errors, 'B', { viewport: { width: 390, height: 800 }, colorScheme: 'dark' });
    await b.goto(srv.url + invite);
    assert.ok(await b.isVisible('#gate'));
    await b.fill('#gate-password', 'sol');
    await b.click('#gate-submit');
    await presenceIncludes(b, '2 personas');
    await waitFor(a, () => [...document.querySelectorAll('.notice')].some((n) => n.textContent.includes('otra contraseña')));
    await a.fill('#message-input', 'solo para la contraseña buena');
    await a.keyboard.press('Enter');
    await waitFor(b, () => document.querySelector('#composer-status').textContent.includes('no coincide'));
    assert.ok(await b.isVisible('#retry-password'));
    assert.ok(!(await b.content()).includes('solo para la contraseña buena'));
    assert.ok(await a.isVisible('#room'));
    await b.click('#retry-password');
    await waitFor(b, () => !document.querySelector('#gate').hidden);
  });

  test('con la contraseña correcta se confirma y el código coincide', async () => {
    await b.fill('#gate-password', 'luna llena');
    await b.click('#gate-submit');
    await waitFor(b, () => document.querySelector('#composer-status').textContent.includes('Contraseña correcta'));
    await a.click('#show-code');
    await b.click('#show-code');
    const codeA = await textOf(a, '#code-words');
    assert.equal(codeA.split(' · ').length, 4);
    assert.equal(await textOf(b, '#code-words'), codeA);
    await a.click('#code-dialog button');
    await b.click('#code-dialog button');
  });

  test('"ver una vez" llega tapado, se ve al tocarlo y desaparece a los 10 s', async () => {
    await a.selectOption('#ttl-select', 'once');
    await a.fill('#message-input', 'secreto de una sola vez');
    await a.keyboard.press('Enter');
    await b.waitForSelector('.reveal');
    assert.ok(!(await b.content()).includes('secreto de una sola vez'));
    await b.click('.reveal');
    assert.ok((await b.content()).includes('secreto de una sola vez'));
    await waitFor(b, () => !document.body.innerHTML.includes('secreto de una sola vez'), { timeout: 12_000 });
    // La copia de quien envía caduca 10 s después del envío; cada pestaña revisa sus
    // temporizadores cada 250 ms, así que se espera un margen en vez de mirar en el mismo instante.
    await waitFor(a, () => !document.body.innerHTML.includes('secreto de una sola vez'), { timeout: 2000 });
  });

  test('las imágenes llegan cifradas, se ven desde memoria y llevan pie de foto', async () => {
    await a.selectOption('#ttl-select', '300');
    await a.fill('#message-input', 'pie de foto');
    await a.setInputFiles('#image-input', path.join(ICONS, 'icon-512.png'));
    await waitFor(b, () => { const i = document.querySelector('.msg-image'); return i && i.complete && i.naturalWidth > 0; });
    assert.ok((await b.content()).includes('pie de foto'));
    assert.ok(await b.evaluate(() => document.querySelector('.msg-image').src.startsWith('blob:')));
    await waitFor(a, () => !document.querySelector('.msg.is-pending'));
  });

  test('una imagen de "ver una vez" llega tapada', async () => {
    await a.selectOption('#ttl-select', 'once');
    await a.setInputFiles('#image-input', path.join(ICONS, 'icon-192.png'));
    await waitFor(b, () => [...document.querySelectorAll('.reveal')].some((r) => r.textContent.includes('imagen')));
    assert.equal((await b.$$('.msg-image')).length, 1);
  });

  test('al salir, las imágenes se liberan de la memoria', async () => {
    const blobUrl = await b.evaluate(() => document.querySelector('.msg-image').src);
    await b.click('#leave-room');
    const stillLoads = await b.evaluate((u) => new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = u;
    }), blobUrl);
    assert.equal(stillLoads, false);
  });

  test('al recargar una sala con contraseña se vuelve a pedir (no se guarda)', async () => {
    await a.reload();
    assert.ok(await a.isVisible('#gate'));
  });

  test('sin errores inesperados en la consola', () => {
    // ERR_FILE_NOT_FOUND: la imagen liberada que se intenta cargar a propósito arriba.
    assert.deepEqual(unexpectedErrors(errors, [/ERR_FILE_NOT_FOUND/]), []);
  });
});
