'use strict';
/*
  Fase 6 (navegador real): aviso de renovación según la suscripción y registro
  desde el enlace del Panel Maestro. Requiere TEST_DATABASE_URL y Chromium.
*/
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { iniciarServidor, urlBasePruebas, crearCuenta } = require('./apoyo/servidor');
const { abrirNavegador } = require('./apoyo/navegador');
const { cabecerasFirmadas } = require('../firma-plataforma');

const URL_PG = urlBasePruebas();
const CLAVE = 'Clave-de-navegador-segura-1';
const CLAVE_PLATAFORMA = 'clave-de-plataforma-solo-para-pruebas-0123456789';
const DIA = 24 * 3600 * 1000;
const unico = () => Math.random().toString(36).slice(2, 10);

let navegador = null;
let motivo = URL_PG ? false : 'Define TEST_DATABASE_URL con una base de pruebas';

test.describe('Fase 6 · aviso de suscripción en el panel', () => {
  let s;
  let pool;

  test.before(async () => {
    if (motivo) return;
    navegador = await abrirNavegador();
    if (!navegador) { motivo = 'Chromium (Playwright) no está disponible'; return; }
    s = await iniciarServidor({ postgres: true, sesion: false, env: { PLATAFORMA_CLAVE: CLAVE_PLATAFORMA } });
    const sinSsl = new URL(URL_PG).searchParams.get('sslmode') === 'disable';
    pool = new Pool({ connectionString: URL_PG, ssl: sinSsl ? false : { rejectUnauthorized: false }, max: 2 });
    pool.on('error', () => {});
    const texto = JSON.stringify({ plans: [{ name: 'Individual', price: 9.99, trialDays: 7 }, { name: 'Pro', price: 19.99, trialDays: 7 }] });
    const r = await fetch(s.base + '/api/plataforma/planes', {
      method: 'PUT', body: texto,
      headers: { 'Content-Type': 'application/json', ...cabecerasFirmadas(CLAVE_PLATAFORMA, { metodo: 'PUT', ruta: '/api/plataforma/planes', cuerpo: texto }) }
    });
    assert.equal(r.status, 200);
  });

  test.after(async () => {
    if (navegador) await navegador.close();
    if (s) { await s.detener(); s.borrar(); }
    if (pool) await pool.end();
  });

  /* Barbería nueva (no protegida) con su propietario. */
  async function barberia(estado) {
    const id = 'f6-' + unico();
    await pool.query(
      `INSERT INTO businesses (id, slug, name, status, plan, trial_ends_at, current_period_end, origin)
       VALUES ($1, $1, $2, $3, 'Pro', $4, $5, 'registro')`,
      [id, 'Barbería ' + id, estado.status, estado.trialEndsAt || null, estado.currentPeriodEnd || null]);
    /* Como crearNegocio: toda barbería tiene su aviso de alta para el Panel Maestro. */
    await pool.query(`INSERT INTO platform_events (business_id, type, payload) VALUES ($1, 'business.created', '{}'::jsonb)`, [id]);
    const correo = `${id}@prueba.test`;
    await crearCuenta(id, correo, CLAVE, 'owner');
    return correo;
  }

  async function panelDe(correo, viewport = { width: 1366, height: 900 }) {
    const ctx = await navegador.newContext({ viewport });
    const page = await ctx.newPage();
    await page.goto(s.base + '/acceso.html');
    await page.fill('#login-email', correo);
    await page.fill('#login-clave', CLAVE);
    await page.click('#form-login button');
    await page.waitForURL('**/admin.html');
    await page.waitForFunction(() => typeof currentSession !== 'undefined' && currentSession !== null);
    return { ctx, page };
  }

  const aviso = async page => (await page.isVisible('#subscriptionNotice')) ? (await page.textContent('#subscriptionNotice')).trim() : null;

  test('vencida, pago pendiente, prueba por terminar y al día', async t => {
    if (motivo) return t.skip(motivo);
    const casos = [
      [{ status: 'active', currentPeriodEnd: new Date(Date.now() - DIA) }, /Tu suscripción venció.*se conservan/s, true],
      [{ status: 'past_due' }, /Pago pendiente/, false],
      [{ status: 'trial', trialEndsAt: new Date(Date.now() + 2 * DIA - 60000) }, /prueba gratuita termina en 2 días/, false],
      [{ status: 'trial', trialEndsAt: new Date(Date.now() + 6 * DIA) }, null, false],
      [{ status: 'active', currentPeriodEnd: new Date(Date.now() + 20 * DIA) }, null, false]
    ];
    for (const [estado, esperado, rojo] of casos) {
      const { ctx, page } = await panelDe(await barberia(estado));
      try {
        const texto = await aviso(page);
        if (esperado) {
          assert.match(texto || '', esperado, JSON.stringify(estado));
          assert.equal(await page.$eval('#subscriptionNotice', e => e.classList.contains('danger')), rojo);
        } else {
          assert.equal(texto, null, JSON.stringify(estado));
        }
      } finally {
        await ctx.close();
      }
    }
  });

  test('el aviso de vencimiento en el teléfono no rompe la pantalla; El Máster no muestra aviso', async t => {
    if (motivo) return t.skip(motivo);
    const { ctx, page } = await panelDe(await barberia({ status: 'expired' }), { width: 390, height: 844 });
    try {
      assert.match(await aviso(page), /venció/);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'sin desplazamiento horizontal');
    } finally {
      await ctx.close();
    }
    const duena = `master-${unico()}@prueba.test`;
    await crearCuenta(s.negocio, duena, CLAVE, 'owner');
    const principal = await panelDe(duena);
    try {
      assert.equal(await aviso(principal.page), null);
      assert.equal((await principal.page.evaluate(() => currentSession.subscription)).protected, true);
    } finally {
      await principal.ctx.close();
    }
  });

  test('registro desde el enlace del Panel Maestro: datos rellenados y plan con 7 días de prueba', async t => {
    if (motivo) return t.skip(motivo);
    const ctx = await navegador.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    const correo = `panel-${unico()}@prueba.test`;
    try {
      const nombreNegocio = 'Barbería Desde Panel ' + unico();
      const q = new URLSearchParams({ plan: 'Pro', negocio: nombreNegocio, nombre: 'Rosa', correo, telefono: '+593 99 000 0000', pais: 'Colombia' });
      await page.goto(`${s.base}/acceso.html?${q}#registro`);
      await page.waitForSelector('#reg-plan:not(.oculto)');
      assert.equal(await page.textContent('#reg-plan'), 'Plan Pro · $19.99 al mes · 7 días de prueba gratis');
      assert.equal(await page.inputValue('#reg-negocio'), nombreNegocio);
      assert.equal(await page.inputValue('#reg-email'), correo);
      assert.equal(await page.inputValue('#reg-clave'), '', 'la contraseña nunca viaja en el enlace');
      assert.match(await page.inputValue('#reg-pais'), /^CO\|/);
      await page.fill('#reg-clave', CLAVE);
      await page.click('#form-registro button');
      await page.waitForSelector('#vista-pendiente:not(.oculto)');
      const [fila] = (await pool.query(
        `SELECT b.plan, b.country, b.trial_ends_at FROM businesses b JOIN memberships m ON m.business_id = b.id
         JOIN users u ON u.id = m.user_id WHERE u.email = $1`, [correo])).rows;
      assert.equal(fila.plan, 'Pro');
      assert.equal(fila.country, 'CO');
      assert.ok(Math.abs(new Date(fila.trial_ends_at) - Date.now() - 7 * DIA) < 60000);
    } finally {
      await ctx.close();
    }
  });
});
