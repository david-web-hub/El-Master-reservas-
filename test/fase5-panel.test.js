'use strict';
/*
  Fase 5 (navegador real): aceptar o rechazar invitaciones desde el enlace
  del correo y desde «Mi cuenta», y cambiar entre barberías. Escritorio y
  teléfono. Requiere TEST_DATABASE_URL y Chromium (Playwright).
*/
const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciarServidor, urlBasePruebas, crearCuenta } = require('./apoyo/servidor');
const { abrirNavegador } = require('./apoyo/navegador');

const URL_PG = urlBasePruebas();
const CLAVE = 'Clave-de-navegador-segura-1';
const unico = () => Math.random().toString(36).slice(2, 10);
const ESCRITORIO = { viewport: { width: 1366, height: 900 } };
const TELEFONO = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

let navegador = null;
let motivo = URL_PG ? false : 'Define TEST_DATABASE_URL con una base de pruebas';

test.describe('Fase 5 · invitaciones en el navegador', () => {
  let s;
  let cookieA;
  let nombreA;

  test.before(async () => {
    if (motivo) return;
    navegador = await abrirNavegador();
    if (!navegador) {
      motivo = 'Chromium (Playwright) no está disponible';
      return;
    }
    s = await iniciarServidor({ postgres: true, sesion: false });
    const duena = `duena-${unico()}@prueba.test`;
    await crearCuenta(s.negocio, duena, CLAVE, 'owner');
    cookieA = await s.iniciarSesion(duena, CLAVE);
    nombreA = (await s.pedir('GET', '/api/auth/sesion', undefined, { cookie: cookieA })).json.business.name;
  });

  test.after(async () => {
    if (navegador) await navegador.close();
    if (s) { await s.detener(); s.borrar(); }
  });

  /* La barbería A invita y devuelve el enlace del correo (en pruebas se escribe en el registro). */
  async function invitar(correo, rol = 'staff') {
    const desde = s.logs.length;
    const r = await s.pedir('POST', '/api/admin/usuarios', { email: correo, name: 'Invitado', role: rol }, { cookie: cookieA });
    assert.equal(r.status, 201, r.texto);
    const linea = await s.esperarLog(new RegExp(correo.replace(/[.+]/g, '\\$&')), 5000, desde);
    return { enlace: linea.split(' ').pop().replace(/^https?:\/\/[^/]+/, s.base), invitacion: r.json.invitation };
  }

  /* Barbería B nueva, con su dueño ya confirmado. */
  async function barberiaNueva() {
    const correo = `duenob-${unico()}@prueba.test`;
    const desde = s.logs.length;
    await s.pedir('POST', '/api/auth/registro', { businessName: 'Barbería B ' + unico(), name: 'Dueño B', email: correo, password: CLAVE }, { cookie: null });
    const linea = await s.esperarLog(new RegExp(correo.replace(/[.+]/g, '\\$&')), 5000, desde);
    await s.pedir('POST', '/api/auth/verificar', { token: linea.match(/verificar=([A-Za-z0-9_-]+)/)[1] }, { cookie: null });
    const r = await s.pedir('POST', '/api/auth/login', { email: correo, password: CLAVE }, { cookie: null });
    return { correo, id: r.json.business.id, nombre: r.json.business.name };
  }

  async function entrarComo(email, opciones = ESCRITORIO) {
    const ctx = await navegador.newContext(opciones);
    const page = await ctx.newPage();
    await page.goto(s.base + '/acceso.html');
    await page.fill('#login-email', email);
    await page.fill('#login-clave', CLAVE);
    await page.click('#form-login button');
    await page.waitForURL('**/admin.html');
    await page.waitForFunction(() => typeof currentSession !== 'undefined' && currentSession !== null);
    return { ctx, page };
  }

  const sesionDe = page => page.evaluate(() => fetch('/api/auth/sesion').then(r => r.json()));
  const sinDesbordeHorizontal = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

  async function avisoEmergente(page) {
    await page.waitForSelector('#toast.show');
    const texto = await page.textContent('#toast');
    await page.evaluate(() => document.getElementById('toast').classList.remove('show'));
    return texto;
  }

  test('teléfono: una persona sin cuenta acepta con el enlace y entra al panel; el enlace no vuelve a servir', async t => {
    if (motivo) return t.skip(motivo);
    const correo = `nuevo-${unico()}@prueba.test`;
    const { enlace } = await invitar(correo, 'staff');
    const ctx = await navegador.newContext(TELEFONO);
    const page = await ctx.newPage();
    try {
      await page.goto(enlace);
      await page.waitForSelector('#form-invitacion:not(.oculto)');
      assert.equal(await page.textContent('#inv-titulo'), 'Te invitaron a ' + nombreA);
      assert.match(await page.textContent('#inv-texto'), /Recepción y caja/);
      assert.equal(await page.inputValue('#inv-email'), correo);
      assert.equal(await page.isVisible('#inv-existente'), false);
      assert.ok(await sinDesbordeHorizontal(page), 'sin desplazamiento horizontal en el teléfono');

      await page.fill('#inv-nombre', 'Lucía Nueva');
      await page.fill('#inv-clave', CLAVE);
      await page.fill('#inv-clave2', CLAVE + 'x');
      await page.click('#form-invitacion button[type=submit]');
      assert.match(await page.textContent('#aviso-invitacion'), /no coinciden/);

      await page.fill('#inv-clave2', CLAVE);
      await page.click('#form-invitacion button[type=submit]');
      await page.waitForURL('**/admin.html');
      const sesion = await sesionDe(page);
      assert.equal(sesion.business.id, s.negocio);
      assert.equal(sesion.role, 'staff');
      assert.equal(sesion.user.name, 'Lucía Nueva');

      await page.goto(enlace);
      await page.waitForFunction(() => document.getElementById('inv-titulo').textContent === 'Invitación no disponible');
      assert.match(await page.textContent('#inv-texto'), /ya se aceptó/);
      assert.equal(await page.isVisible('#form-invitacion'), false);
    } finally {
      await ctx.close();
    }
  });

  test('cuenta de otra barbería: confirma con su contraseña; luego cambia entre sus barberías en «Mi cuenta»', async t => {
    if (motivo) return t.skip(motivo);
    const b = await barberiaNueva();
    const { enlace } = await invitar(b.correo, 'admin');
    const ctx = await navegador.newContext(ESCRITORIO);
    const page = await ctx.newPage();
    try {
      await page.goto(enlace);
      await page.waitForSelector('#form-invitacion:not(.oculto)');
      assert.match(await page.textContent('#inv-texto'), /Ya tienes una cuenta/);
      assert.equal(await page.isVisible('#inv-nueva'), false);
      assert.equal(await page.isVisible('#inv-dospasos'), false);

      await page.fill('#inv-clave-actual', 'incorrecta-123456');
      await page.click('#form-invitacion button[type=submit]');
      await page.waitForFunction(() => /no es correcta/.test(document.getElementById('aviso-invitacion').textContent));
      assert.ok(page.url().includes('/acceso.html'), 'sin la contraseña no entra');

      await page.fill('#inv-clave-actual', CLAVE);
      await page.click('#form-invitacion button[type=submit]');
      await page.waitForURL('**/admin.html');
      await page.waitForFunction(() => typeof currentSession !== 'undefined' && currentSession !== null);
      assert.equal((await sesionDe(page)).business.id, s.negocio);

      await page.evaluate(() => { goTo('configuracion'); openSetting('cuenta'); });
      const bloque = page.locator('#myBusinesses');
      await bloque.waitFor();
      assert.match(await bloque.textContent(), new RegExp(nombreA));
      assert.match(await bloque.locator('.switch-row', { hasText: nombreA }).textContent(), /Actual/);
      await bloque.locator('.switch-row', { hasText: b.nombre }).locator('text=Entrar').click();
      await page.waitForFunction(id => typeof currentSession !== 'undefined' && currentSession?.business?.id === id, b.id);
      const enB = await sesionDe(page);
      assert.equal(enB.role, 'owner');
      assert.equal(enB.business.id, b.id);
    } finally {
      await ctx.close();
    }
  });

  test('rechazar desde el enlace: no da acceso y la barbería deja de verla pendiente', async t => {
    if (motivo) return t.skip(motivo);
    const correo = `rechaza-${unico()}@prueba.test`;
    const { enlace, invitacion } = await invitar(correo, 'staff');
    const ctx = await navegador.newContext(TELEFONO);
    const page = await ctx.newPage();
    try {
      await page.goto(enlace);
      await page.waitForSelector('#form-invitacion:not(.oculto)');
      await page.click('#inv-rechazar');
      await page.waitForFunction(() => document.getElementById('inv-titulo').textContent === 'Invitación rechazada');
      assert.equal(await page.isVisible('#form-invitacion'), false);
      const pendientes = (await s.pedir('GET', '/api/admin/invitaciones', undefined, { cookie: cookieA })).json.invitations;
      assert.ok(!pendientes.some(i => i.id === invitacion.id));
    } finally {
      await ctx.close();
    }
  });

  test('«Mi cuenta» en el teléfono: aviso al entrar, rechazar y aceptar invitaciones', async t => {
    if (motivo) return t.skip(motivo);
    const b = await barberiaNueva();
    await invitar(b.correo, 'staff');
    const { ctx, page } = await entrarComo(b.correo, TELEFONO);
    try {
      assert.match(await avisoEmergente(page), /invitaciones pendientes/);
      await page.evaluate(() => { goTo('configuracion'); openSetting('cuenta'); });
      const bloque = page.locator('#myInvitations');
      await bloque.waitFor();
      assert.match(await bloque.textContent(), new RegExp(nombreA));
      assert.match(await bloque.textContent(), /Recepción y caja/);
      assert.ok(await sinDesbordeHorizontal(page), 'sin desplazamiento horizontal en el teléfono');

      await bloque.locator('text=Rechazar').click();
      assert.match(await avisoEmergente(page), /rechazada/);
      await page.waitForSelector('#myInvitations', { state: 'detached' });
      assert.equal(await page.locator('#myBusinesses').count(), 0, 'sigue con una sola barbería');

      await invitar(b.correo, 'staff');
      await page.evaluate(() => renderAccountSettings());
      await page.locator('#myInvitations').locator('text=Aceptar').click();
      assert.match(await avisoEmergente(page), new RegExp('Ahora tienes acceso a ' + nombreA));
      await page.waitForSelector('#myBusinesses');
      assert.equal(await page.locator('#myInvitations').count(), 0);
      assert.equal((await sesionDe(page)).business.id, b.id, 'aceptar no cambia la barbería abierta');
      assert.ok(await sinDesbordeHorizontal(page));
    } finally {
      await ctx.close();
    }
  });

  test('el propietario ve la invitación vencida y la reenvía desde «Usuarios y roles»', async t => {
    if (motivo) return t.skip(motivo);
    const correo = `vencida-${unico()}@prueba.test`;
    const { enlace, invitacion } = await invitar(correo, 'staff');
    const { Pool } = require('pg');
    const sinSsl = new URL(URL_PG).searchParams.get('sslmode') === 'disable';
    const pool = new Pool({ connectionString: URL_PG, ssl: sinSsl ? false : { rejectUnauthorized: false }, max: 1 });
    pool.on('error', () => {});
    try {
      await pool.query(`UPDATE invitations SET expires_at = NOW() - interval '1 minute' WHERE id = $1`, [invitacion.id]);
    } finally {
      await pool.end();
    }
    const ctx = await navegador.newContext(ESCRITORIO);
    await ctx.addCookies([{ name: 'mr_sesion', value: cookieA.split('=')[1], url: s.base }]);
    const page = await ctx.newPage();
    try {
      await page.goto(enlace);
      await page.waitForFunction(() => document.getElementById('inv-titulo').textContent === 'Invitación no disponible');
      assert.match(await page.textContent('#inv-texto'), /venció/);

      await page.goto(s.base + '/admin.html');
      await page.waitForFunction(() => typeof currentSession !== 'undefined' && currentSession !== null);
      await page.evaluate(() => { goTo('configuracion'); openSetting('usuarios'); });
      const tarjeta = page.locator('#pendingInvitations .barber-card', { hasText: correo });
      await tarjeta.waitFor();
      assert.match(await tarjeta.textContent(), /Vencida/);
      const desde = s.logs.length;
      await tarjeta.locator('text=Reenviar').click();
      assert.match(await avisoEmergente(page), /reenvi/i);
      await s.esperarLog(new RegExp(correo.replace(/[.+]/g, '\\$&')), 5000, desde);
      await page.waitForFunction(c => [...document.querySelectorAll('#pendingInvitations .barber-card')]
        .some(x => x.textContent.includes(c) && x.textContent.includes('Pendiente')), correo);

      await page.locator('#pendingInvitations .barber-card', { hasText: correo }).locator('text=Cancelar invitación').click();
      await page.waitForFunction(c => ![...document.querySelectorAll('#pendingInvitations .barber-card')]
        .some(x => x.textContent.includes(c)), correo);
    } finally {
      await ctx.close();
    }
  });
});

