'use strict';
/*
  Fase 7 en un navegador real (Chromium), como lo usaría un cliente desde su teléfono:
  - Un cliente sin sesión reserva en la página pública de una barbería nueva (/b/<dirección>/).
  - El dueño ve la reserva, su enlace para compartir y la conexión de WhatsApp en su panel.
  - La página pública de la barbería principal sigue funcionando en "/".
  Requiere TEST_DATABASE_URL y Chromium (Playwright).
*/
const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciarServidor, urlBasePruebas, cookieDe, proximoDia } = require('./apoyo/servidor');
const { abrirNavegador } = require('./apoyo/navegador');

const URL_PG = urlBasePruebas();
const CLAVE = 'Una-clave-bastante-segura-7';
const unico = () => Math.random().toString(36).slice(2, 10);
const TELEFONO = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

test.describe('Fase 7 · página pública por barbería en el navegador', () => {
  let s, navegador, motivo = null, barberia;

  test.before(async () => {
    if (!URL_PG) { motivo = 'Define TEST_DATABASE_URL'; return; }
    navegador = await abrirNavegador();
    if (!navegador) { motivo = 'Chromium no disponible'; return; }
    s = await iniciarServidor({ postgres: true });
    const correo = `dueno-${unico()}@prueba.test`;
    const nombre = 'Barbería Teléfono ' + unico();
    const desde = s.logs.length;
    const r = await s.pedir('POST', '/api/auth/registro', { businessName: nombre, name: 'Mateo', email: correo, password: CLAVE }, { cookie: null });
    assert.equal(r.status, 201);
    const linea = await s.esperarLog(new RegExp(`\\[DEMO CORREO\\] ${correo.replace(/[.+]/g, '\\$&')} `), 5000, desde);
    await s.pedir('POST', '/api/auth/verificar', { token: linea.match(/verificar=([A-Za-z0-9_-]+)/)[1] }, { cookie: null });
    const login = await s.pedir('POST', '/api/auth/login', { email: correo, password: CLAVE }, { cookie: null });
    barberia = { nombre, slug: r.json.business.slug, cookie: cookieDe(login) };
  });
  test.after(async () => {
    if (navegador) await navegador.close();
    if (s) { await s.detener(); s.borrar(); }
  });

  const sinDesborde = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

  test('un cliente sin sesión reserva desde su teléfono en la página de la barbería', async t => {
    if (motivo) return t.skip(motivo);
    const ctx = await navegador.newContext(TELEFONO);
    const page = await ctx.newPage();
    const errores = [];
    page.on('pageerror', e => errores.push(e.message));
    try {
      await page.goto(`${s.base}/b/${barberia.slug}/`);
      await page.locator('#ctaBtn').waitFor();
      assert.equal(await page.title(), barberia.nombre);
      assert.ok(await sinDesborde(page), 'sin desplazamiento horizontal');
      await page.click('#ctaBtn');
      await page.locator('.opt:has-text("Mateo")').click();
      await page.locator('[data-svc="corte"]').click();
      await page.click('#toStep3');
      await page.fill('#dateIn', proximoDia(2));
      await page.locator('[data-time="10:00"]').click();
      await page.click('#toStep4');
      await page.fill('#bName', 'Cliente Teléfono');
      await page.fill('#bPhone', '0997778888');
      await page.click('#confirmBtn');
      await page.locator('text=¡Reserva confirmada!').waitFor();
      assert.match(await page.textContent('#sheet'), new RegExp(`Te esperamos en ${barberia.nombre}`));
      assert.deepEqual(errores, []);
    } finally {
      await ctx.close();
    }
    const deLaBarberia = JSON.stringify((await s.pedir('GET', '/api/bookings', undefined, { cookie: barberia.cookie })).json);
    assert.match(deLaBarberia, /Cliente Teléfono/, 'llegó a la agenda de esa barbería');
    assert.doesNotMatch(JSON.stringify((await s.pedir('GET', '/api/bookings')).json), /Cliente Teléfono/, 'no a la principal');
  });

  test('la página pública de la barbería principal sigue en la raíz', async t => {
    if (motivo) return t.skip(motivo);
    const ctx = await navegador.newContext(TELEFONO);
    const page = await ctx.newPage();
    try {
      await page.goto(s.base + '/');
      await page.locator('#ctaBtn').waitFor();
      assert.notEqual(await page.title(), barberia.nombre);
      assert.ok(await sinDesborde(page));
      await page.goto(`${s.base}/b/no-existe-${unico()}/`);
      assert.match(await page.textContent('body'), /Barbería no encontrada/);
    } finally {
      await ctx.close();
    }
  });

  test('el dueño ve su enlace para compartir y la conexión de WhatsApp en su panel', async t => {
    if (motivo) return t.skip(motivo);
    const ctx = await navegador.newContext(TELEFONO);
    const [nombre, valor] = barberia.cookie.split('=');
    await ctx.addCookies([{ name: nombre, value: valor, url: s.base }]);
    const page = await ctx.newPage();
    try {
      await page.goto(s.base + '/admin.html');
      await page.waitForFunction(() => typeof currentSession !== 'undefined' && currentSession !== null);
      assert.equal(await page.textContent('#brandName'), barberia.nombre.toUpperCase(), 'su propio nombre, no el de El Máster');
      assert.equal(await page.title(), barberia.nombre + ' | Administración');
      await page.evaluate(() => goTo('configuracion'));
      const tarjetas = await page.$$eval('#settingsHome .setting-card h3', h => h.map(x => x.textContent.trim()));
      assert.ok(tarjetas.includes('Tu página de reservas') && tarjetas.includes('WhatsApp y Elia'), tarjetas.join(', '));
      await page.evaluate(() => openSetting('enlace'));
      assert.equal(await page.inputValue('#publicLinkInput'), `${s.base}/b/${barberia.slug}/`);
      assert.ok(await sinDesborde(page));
      await page.evaluate(() => { closeSetting(); openSetting('whatsapp'); });
      await page.locator('#waWebhookUrl').waitFor();
      assert.match(await page.inputValue('#waWebhookUrl'), /\/webhooks\/whatsapp\/n\//);
      assert.ok((await page.inputValue('#waVerifyToken')).length >= 20);
      assert.match(await page.textContent('#waStatus'), /Sin conectar/);
      assert.ok(await sinDesborde(page));
    } finally {
      await ctx.close();
    }
  });
});
