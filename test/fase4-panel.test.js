'use strict';
/*
  Fase 4 (navegador real): cierre de sesión, Mi cuenta, Usuarios y roles,
  verificación en dos pasos, sesión vencida, menús por rol y registro con
  confirmación de correo. Requiere TEST_DATABASE_URL y Chromium (Playwright).
*/
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { iniciarServidor, urlBasePruebas, crearCuenta } = require('./apoyo/servidor');
const { abrirNavegador } = require('./apoyo/navegador');
const { codigoTotp, desdeBase32 } = require('../autenticacion');

const URL_PG = urlBasePruebas();
const CLAVE = 'Clave-de-navegador-segura-1';
const unico = () => Math.random().toString(36).slice(2, 10);

let navegador = null;
let motivo = URL_PG ? false : 'Define TEST_DATABASE_URL con una base de pruebas';

test.describe('Fase 4 · panel en el navegador', () => {
  let s;
  let pool;

  test.before(async () => {
    if (motivo) return;
    navegador = await abrirNavegador();
    if (!navegador) {
      motivo = 'Chromium (Playwright) no está disponible';
      return;
    }
    s = await iniciarServidor({ postgres: true, sesion: false });
    const sinSsl = new URL(URL_PG).searchParams.get('sslmode') === 'disable';
    pool = new Pool({ connectionString: URL_PG, ssl: sinSsl ? false : { rejectUnauthorized: false }, max: 2 });
    pool.on('error', () => {});
  });

  test.after(async () => {
    if (navegador) await navegador.close();
    if (s) { await s.detener(); s.borrar(); }
    if (pool) await pool.end();
  });

  async function entrarComo(email, clave = CLAVE) {
    const ctx = await navegador.newContext({ viewport: { width: 1366, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(s.base + '/acceso.html');
    await page.fill('#login-email', email);
    await page.fill('#login-clave', clave);
    await page.click('#form-login button');
    await page.waitForURL('**/admin.html');
    await page.waitForFunction(() => typeof currentSession !== 'undefined' && currentSession !== null);
    return { ctx, page };
  }

  async function abrirAjuste(page, id) {
    await page.evaluate(id => { goTo('configuracion'); openSetting(id); }, id);
  }

  async function avisoEmergente(page) {
    await page.waitForSelector('#toast.show');
    const texto = await page.textContent('#toast');
    await page.evaluate(() => document.getElementById('toast').classList.remove('show'));
    return texto;
  }

  const nav = page => page.$$eval('#desktopNav [data-page]', b => b.map(x => x.dataset.page));
  const tarjetas = page => page.$$eval('#settingsHome .setting-card h3', h => h.map(x => x.textContent.trim()));

  test('propietario: barra lateral con su nombre y botón que cierra la sesión', async t => {
    if (motivo) return t.skip(motivo);
    const correo = `duena-${unico()}@prueba.test`;
    await crearCuenta(s.negocio, correo, CLAVE, 'owner');
    const { ctx, page } = await entrarComo(correo);
    try {
      assert.match(await page.textContent('#sidebarAccount'), /Propietario/);
      assert.ok(await page.isVisible('#logoutBtn'));
      assert.deepEqual(await nav(page), ['inicio', 'reservas', 'caja', 'productos', 'clientes', 'informes', 'configuracion']);
      await page.evaluate(() => goTo('configuracion'));
      const t1 = await tarjetas(page);
      assert.ok(t1.includes('Mi cuenta') && t1.includes('Usuarios y roles'));

      await page.click('#logoutBtn');
      await page.waitForURL('**/acceso.html');
      await page.goto(s.base + '/admin.html');
      assert.match(page.url(), /acceso\.html$/, 'después de salir el panel ya no abre');
    } finally {
      await ctx.close();
    }
  });

  test('usuarios y roles: agregar, cambiar rol, desactivar; el administrador solo ve', async t => {
    if (motivo) return t.skip(motivo);
    const duena = `duena2-${unico()}@prueba.test`;
    await crearCuenta(s.negocio, duena, CLAVE, 'owner');
    const { ctx, page } = await entrarComo(duena);
    try {
      await abrirAjuste(page, 'usuarios');
      await page.waitForSelector('text=+ Agregar usuario');
      const nuevo = `equipo-${unico()}@prueba.test`;
      const desde = s.logs.length;
      await page.click('text=+ Agregar usuario');
      await page.fill('#usEmail', nuevo);
      await page.fill('#usName', 'Pedro Equipo');
      await page.selectOption('#usRole', 'staff');
      assert.equal(await page.isVisible('#usBarberField'), false, 'el barbero solo se pide para el rol Barbero');
      await page.click('#saveUserBtn');
      assert.match(await avisoEmergente(page), /Invitación enviada/);
      await s.esperarLog(new RegExp(nuevo.replace('.', '\\.')), 5000, desde);
      const tarjeta = page.locator('.barber-card', { hasText: 'Pedro Equipo' });
      await tarjeta.waitFor();
      assert.match(await tarjeta.textContent(), /Recepción y caja/);

      await tarjeta.locator('text=Cambiar rol').click();
      await page.selectOption('#usRole', 'barber');
      assert.equal(await page.isVisible('#usBarberField'), true);
      await page.selectOption('#usBarber', 'master');
      await page.click('#saveUserBtn');
      assert.match(await avisoEmergente(page), /Rol actualizado/);
      await page.waitForFunction(() => document.querySelector('#settingContent').textContent.includes('Barbero: Master'));

      await page.locator('.barber-card', { hasText: 'Pedro Equipo' }).locator('text=Desactivar').click();
      assert.match(await avisoEmergente(page), /desactivado/);
      await page.waitForFunction(() => [...document.querySelectorAll('.barber-card')]
        .some(c => c.textContent.includes('Pedro Equipo') && c.textContent.includes('Desactivado')));
      const [m] = (await pool.query(
        `SELECT m.role, m.barber_id, m.status FROM memberships m JOIN users u ON u.id = m.user_id WHERE lower(u.email) = $1`, [nuevo])).rows;
      assert.deepEqual(m, { role: 'barber', barber_id: 'master', status: 'disabled' });

      /* Un administrador ve la lista pero no puede cambiarla. */
      const admin = `admin-${unico()}@prueba.test`;
      await crearCuenta(s.negocio, admin, CLAVE, 'admin');
      const otra = await entrarComo(admin);
      try {
        await abrirAjuste(otra.page, 'usuarios');
        await otra.page.waitForSelector('text=Solo un propietario puede agregar o cambiar usuarios');
        assert.equal(await otra.page.locator('text=+ Agregar usuario').count(), 0);
        assert.equal(await otra.page.locator('text=Cambiar rol').count(), 0);
      } finally {
        await otra.ctx.close();
      }
    } finally {
      await ctx.close();
    }
  });

  test('mi cuenta: cambiar contraseña y activar la verificación en dos pasos', async t => {
    if (motivo) return t.skip(motivo);
    const correo = `cuenta-${unico()}@prueba.test`;
    await crearCuenta(s.negocio, correo, CLAVE, 'staff');
    const { ctx, page } = await entrarComo(correo);
    try {
      await abrirAjuste(page, 'cuenta');
      await page.waitForSelector('#accCurrent');
      assert.equal(await page.inputValue('#settingContent .field:nth-child(2) input'), correo);

      await page.fill('#accCurrent', 'no-es-la-actual-1');
      await page.fill('#accNew', 'Nueva-clave-del-panel-2');
      await page.fill('#accNew2', 'Nueva-clave-del-panel-2');
      await page.click('#accPasswordBtn');
      assert.match(await avisoEmergente(page), /no es correcta/);
      assert.match(page.url(), /admin\.html$/, 'una contraseña actual incorrecta no cierra la sesión');
      await page.fill('#accCurrent', CLAVE);
      await page.click('#accPasswordBtn');
      assert.match(await avisoEmergente(page), /Contraseña actualizada/);

      await page.click('text=Activar verificación en dos pasos');
      await page.waitForSelector('#tfSecret');
      const clave = (await page.textContent('#tfSecret')).replace(/\s/g, '');
      await page.fill('#tfCode', codigoTotp(desdeBase32(clave), Math.floor(Date.now() / 30000)));
      await page.click('text=Confirmar y activar');
      await page.waitForSelector('#tfRecovery');
      assert.equal(await page.locator('#tfRecovery .chip').count(), 10);

      /* El siguiente inicio de sesión pide el código. */
      const ctx2 = await navegador.newContext();
      const p2 = await ctx2.newPage();
      try {
        await p2.goto(s.base + '/acceso.html');
        await p2.fill('#login-email', correo);
        await p2.fill('#login-clave', 'Nueva-clave-del-panel-2');
        await p2.click('#form-login button');
        await p2.waitForSelector('#vista-dospasos:not(.oculto)');
        await p2.fill('#dp-codigo', codigoTotp(desdeBase32(clave), Math.floor(Date.now() / 30000) + 1));
        await p2.click('#form-dospasos button');
        await p2.waitForURL('**/admin.html');
      } finally {
        await ctx2.close();
      }
    } finally {
      await ctx.close();
    }
  });

  test('si la sesión vence con el panel abierto, vuelve al acceso con un aviso', async t => {
    if (motivo) return t.skip(motivo);
    const correo = `vence-${unico()}@prueba.test`;
    await crearCuenta(s.negocio, correo, CLAVE, 'owner');
    const { ctx, page } = await entrarComo(correo);
    try {
      await pool.query(`UPDATE sessions SET revoked_at = NOW() WHERE user_id = (SELECT id FROM users WHERE lower(email) = $1)`, [correo]);
      await page.evaluate(() => loadBookings());
      await page.waitForURL('**/acceso.html**');
      await page.waitForSelector('#aviso-login.error');
      assert.match(await page.textContent('#aviso-login'), /Tu sesión terminó/);
    } finally {
      await ctx.close();
    }
  });

  test('recepción y barbero solo ven las secciones que pueden usar', async t => {
    if (motivo) return t.skip(motivo);
    const staff = `rec-${unico()}@prueba.test`;
    const barber = `bar-${unico()}@prueba.test`;
    await crearCuenta(s.negocio, staff, CLAVE, 'staff');
    await crearCuenta(s.negocio, barber, CLAVE, 'barber', 'master');
    const a = await entrarComo(staff);
    try {
      assert.deepEqual(await nav(a.page), ['inicio', 'reservas', 'caja', 'productos', 'clientes', 'configuracion']);
      await a.page.evaluate(() => goTo('configuracion'));
      assert.deepEqual(await tarjetas(a.page), ['Mi cuenta']);
    } finally {
      await a.ctx.close();
    }
    const b = await entrarComo(barber);
    try {
      assert.deepEqual(await nav(b.page), ['inicio', 'reservas', 'configuracion']);
      assert.match(await b.page.textContent('#sidebarAccount'), /Barbero/);
    } finally {
      await b.ctx.close();
    }
  });

  test('registro en el navegador: confirmar el correo y entrar', async t => {
    if (motivo) return t.skip(motivo);
    const ctx = await navegador.newContext();
    const page = await ctx.newPage();
    const correo = `nueva-${unico()}@prueba.test`;
    try {
      await page.goto(s.base + '/acceso.html');
      assert.equal(await page.isVisible('#enlace-registro'), true, 'en pruebas el registro está abierto');
      await page.click('#enlace-registro');
      await page.fill('#reg-negocio', 'Barbería ' + unico());
      await page.fill('#reg-nombre', 'Rosa');
      await page.fill('#reg-email', correo);
      await page.fill('#reg-clave', CLAVE);
      const desde = s.logs.length;
      await page.click('#form-registro button');
      await page.waitForSelector('#vista-pendiente:not(.oculto)');
      assert.match(await page.textContent('#pendiente-texto'), new RegExp(correo.replace('.', '\\.')));

      const linea = await s.esperarLog(new RegExp(correo.replace('.', '\\.')), 5000, desde);
      const enlace = linea.split(' ').pop();
      await page.goto(enlace.replace(/^https?:\/\/[^/]+/, s.base));
      await page.waitForSelector('#aviso-login.ok');
      assert.match(await page.textContent('#aviso-login'), /Correo confirmado/);
      await page.fill('#login-email', correo);
      await page.fill('#login-clave', CLAVE);
      await page.click('#form-login button');
      await page.waitForURL('**/admin.html');
    } finally {
      await ctx.close();
    }
  });
});
