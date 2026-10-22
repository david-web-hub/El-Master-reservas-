'use strict';
/*
  Ícono MF (en lugar de la coronita) y ojito para mostrar u ocultar contraseñas.
  - Acceso, registro, invitaciones, restablecer, panel de cada negocio y correos: «MF» en el recuadro dorado.
  - El logo de la página comercial (M en el cuadrado amarillo) no cambia.
  - Cada campo de contraseña tiene su ojo: oculto al empezar, alterna al tocarlo (ratón, teclado y pantalla táctil),
    no muestra lo que rellenó el navegador y vuelve a ocultarse al enviar.
  Las pruebas de navegador requieren Chromium; las del panel, además, TEST_DATABASE_URL.
*/
const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciarServidor, urlBasePruebas } = require('./apoyo/servidor');
const { abrirNavegador } = require('./apoyo/navegador');
const { construirCorreo, PLANTILLAS } = require('../correo');
const { crearSitioPublico } = require('../sitio-publico');

test('correos: el recuadro dorado dice MF, sin coronita', () => {
  for (const plantilla of Object.keys(PLANTILLAS)) {
    const c = construirCorreo(plantilla, { nombre: 'Ana', negocio: 'El Máster', enlace: 'https://reservas.example/acceso.html' });
    assert.ok(!c.html.includes('&#9819;') && !c.html.includes('♛'), `${plantilla}: sin coronita`);
    assert.match(c.html, /color:#090909;">MF<\/td>/, `${plantilla}: MF en negro dentro del recuadro`);
  }
});

test('página comercial: el logo de la M no cambia', async () => {
  const sitio = crearSitioPublico({ dominio: 'mfplux.com', appUrl: 'https://reservas.example', catalogo: async () => [], registroAbierto: () => true, registro: { log() {}, error() {} } });
  const html = await sitio.inicio();
  assert.ok(html.includes('<b>M</b>MF Plux'), 'M en el cuadrado amarillo y el texto al lado');
  assert.ok(!html.includes('ojo-boton') && !html.includes('ver-contrasena'), 'la página comercial no tiene contraseñas');
});

test.describe('navegador: MF y ojito', () => {
  let s, navegador, motivo = null;

  test.before(async () => {
    navegador = await abrirNavegador();
    if (!navegador) { motivo = 'Chromium no disponible'; return; }
    s = await iniciarServidor({ postgres: Boolean(urlBasePruebas()) });
  });
  test.after(async () => {
    if (navegador) await navegador.close();
    if (s) { await s.detener(); s.borrar(); }
  });

  const tipo = (page, id) => page.$eval('#' + id, e => e.type);
  const ojoDe = (page, id) => page.locator(`[aria-controls="${id}"]`);

  test('acceso: MF en el recuadro y un ojo en cada contraseña', async t => {
    if (motivo) return t.skip(motivo);
    const page = await navegador.newPage();
    const errores = [];
    page.on('pageerror', e => errores.push(e.message));
    try {
      await page.goto(s.base + '/acceso.html');
      assert.equal((await page.textContent('.marca .logo')).trim(), 'MF');
      assert.ok(!(await page.content()).includes('♛'), 'sin coronita');
      const caja = await page.$eval('.marca .logo', e => { const r = e.getBoundingClientRect(); const c = getComputedStyle(e); return { w: r.width, h: r.height, radio: c.borderRadius, color: c.color }; });
      assert.deepEqual({ w: caja.w, h: caja.h, radio: caja.radio }, { w: 46, h: 46, radio: '14px' }, 'mismo recuadro');
      assert.equal(caja.color, 'rgb(9, 9, 9)', 'letras en negro');
      const ids = await page.$$eval('input[data-ojo]', x => x.map(e => e.id));
      assert.deepEqual(ids.sort(), ['inv-clave', 'inv-clave-actual', 'inv-clave2', 'login-clave', 'reg-clave', 'res-clave', 'res-clave2'].sort(), 'todas las contraseñas');
      for (const id of ids) assert.equal(await ojoDe(page, id).count(), 1, id);
      /* El primer botón del formulario sigue siendo «Entrar» (el ojo no es un <button>). */
      assert.equal(await page.$eval('#form-login', f => f.querySelector('button').textContent.trim()), 'Entrar');

      /* Oculta al empezar; un toque muestra lo escrito; otro la oculta. */
      await page.fill('#login-clave', 'secreto-de-prueba');
      assert.equal(await tipo(page, 'login-clave'), 'password');
      assert.equal(await ojoDe(page, 'login-clave').getAttribute('aria-label'), 'Mostrar contraseña');
      await ojoDe(page, 'login-clave').click();
      assert.equal(await tipo(page, 'login-clave'), 'text');
      assert.equal(await page.inputValue('#login-clave'), 'secreto-de-prueba');
      assert.equal(await ojoDe(page, 'login-clave').getAttribute('aria-label'), 'Ocultar contraseña');
      await ojoDe(page, 'login-clave').click();
      assert.equal(await tipo(page, 'login-clave'), 'password');

      /* Teclado: Enter y espacio. */
      await ojoDe(page, 'login-clave').focus();
      await page.keyboard.press('Enter');
      assert.equal(await tipo(page, 'login-clave'), 'text');
      await page.keyboard.press(' ');
      assert.equal(await tipo(page, 'login-clave'), 'password');

      /* Al enviar, vuelve a quedar oculta. */
      await ojoDe(page, 'login-clave').click();
      await page.fill('#login-email', 'nadie@prueba.test');
      await page.click('#form-login button[type="submit"]');
      assert.equal(await tipo(page, 'login-clave'), 'password');

      /* Una contraseña que rellenó el navegador (sin teclear) no se muestra hasta vaciar el campo. */
      await page.fill('#login-clave', '');
      await page.evaluate(() => { const c = document.getElementById('login-clave'); c.value = 'guardada-en-el-navegador'; c.dispatchEvent(new Event('input', { bubbles: true })); });
      await ojoDe(page, 'login-clave').click({ force: true });
      assert.equal(await tipo(page, 'login-clave'), 'password', 'no se muestra lo autocompletado');
      assert.equal(await ojoDe(page, 'login-clave').getAttribute('aria-disabled'), 'true');
      await page.fill('#login-clave', '');
      await page.fill('#login-clave', 'nueva-clave-escrita');
      await ojoDe(page, 'login-clave').click();
      assert.equal(await tipo(page, 'login-clave'), 'text', 'lo escrito sí');
      assert.deepEqual(errores, []);
    } finally {
      await page.close();
    }
  });

  test('celular: el ojo responde al toque y el formulario no se desborda', async t => {
    if (motivo) return t.skip(motivo);
    const ctx = await navegador.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    try {
      await page.goto(s.base + '/acceso.html#registro');
      await page.click('#tipo-salon');
      await page.fill('#reg-clave', 'clave-del-celular');
      await ojoDe(page, 'reg-clave').tap();
      assert.equal(await tipo(page, 'reg-clave'), 'text');
      await ojoDe(page, 'reg-clave').tap();
      assert.equal(await tipo(page, 'reg-clave'), 'password');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    } finally {
      await ctx.close();
    }
  });

  test('panel del negocio: MF en el menú y ojo en las contraseñas de Configuración', async t => {
    if (motivo) return t.skip(motivo);
    if (!s.cookie) return t.skip('Requiere TEST_DATABASE_URL (panel con sesión)');
    const ctx = await navegador.newContext();
    const [name, value] = s.cookie.split('=');
    await ctx.addCookies([{ name, value, url: s.base }]);
    const page = await ctx.newPage();
    const errores = [];
    page.on('pageerror', e => errores.push(e.message));
    try {
      await page.goto(s.base + '/admin.html', { waitUntil: 'networkidle' });
      assert.equal((await page.textContent('.sidebar .logo')).trim(), 'MF');
      assert.ok(!(await page.content()).includes('♛'), 'sin coronita');
      await page.evaluate(() => { window.goTo('configuracion'); window.openSetting('cuenta'); });
      await page.locator('#accCurrent').waitFor();
      for (const id of ['accCurrent', 'accNew', 'accNew2']) {
        assert.equal(await ojoDe(page, id).count(), 1, id);
        assert.equal(await tipo(page, id), 'password', id);
      }
      await page.fill('#accNew', 'una-clave-nueva-larga');
      await ojoDe(page, 'accNew').click();
      assert.equal(await tipo(page, 'accNew'), 'text');
      assert.equal(await page.inputValue('#accNew'), 'una-clave-nueva-larga');
      await ojoDe(page, 'accNew').click();
      assert.equal(await tipo(page, 'accNew'), 'password');
      assert.deepEqual(errores, []);
    } finally {
      await ctx.close();
    }
  });
});
