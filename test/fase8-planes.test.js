'use strict';
/*
  Fase 8: límites de barberos por plan, aplicados en el servidor.
  - Individual 1, Pro 4, Business 10 barberos activos (catálogo del Panel Maestro).
  - Crear o activar un barbero por encima del límite se rechaza aunque se llame a la API directamente.
  - Subir de plan amplía el límite sin tocar datos; bajar se rechaza mientras sobren barberos activos.
  - El Máster (protegida) no tiene límite. Cada barbería solo toca lo suyo.
  Requiere TEST_DATABASE_URL.
*/
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { iniciarServidor, reiniciar, urlBasePruebas, cookieDe } = require('./apoyo/servidor');
const { cabecerasFirmadas } = require('../firma-plataforma');
const { abrirNavegador } = require('./apoyo/navegador');

const URL_PG = urlBasePruebas();
const omitir = URL_PG ? false : 'Define TEST_DATABASE_URL con una base de pruebas';
const CLAVE_PLATAFORMA = 'clave-de-plataforma-solo-para-pruebas-0123456789';
const CLAVE = 'Una-clave-bastante-segura-7';
const unico = () => Math.random().toString(36).slice(2, 10);
const CATALOGO = [
  { name: 'Individual', price: 10.99, trialDays: 7, active: true, maxBarbers: 1 },
  { name: 'Pro', price: 19.99, trialDays: 7, active: true, maxBarbers: 4 },
  { name: 'Business', price: 34.99, trialDays: 7, active: true, maxBarbers: 10 }
];

function crearPool() {
  const sinSsl = new URL(URL_PG).searchParams.get('sslmode') === 'disable';
  const pool = new Pool({ connectionString: URL_PG, ssl: sinSsl ? false : { rejectUnauthorized: false }, max: 2 });
  pool.on('error', () => {});
  return pool;
}

async function plataforma(s, metodo, ruta, cuerpo) {
  const texto = cuerpo === undefined ? '' : JSON.stringify(cuerpo);
  const r = await fetch(s.base + ruta, {
    method: metodo,
    headers: { ...cabecerasFirmadas(CLAVE_PLATAFORMA, { metodo, ruta, cuerpo: texto }), ...(cuerpo === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: cuerpo === undefined ? undefined : texto
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function registrar(s, plan) {
  const correo = `plan-${unico()}@prueba.test`;
  const desde = s.logs.length;
  const r = await s.pedir('POST', '/api/auth/registro',
    { businessName: `Barbería ${plan} ${unico()}`, name: 'Dueño', email: correo, password: CLAVE, plan }, { cookie: null });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const linea = await s.esperarLog(new RegExp(`\\[DEMO CORREO\\] ${correo.replace(/[.+]/g, '\\$&')} `), 5000, desde);
  await s.pedir('POST', '/api/auth/verificar', { token: linea.match(/verificar=([A-Za-z0-9_-]+)/)[1] }, { cookie: null });
  const login = await s.pedir('POST', '/api/auth/login', { email: correo, password: CLAVE }, { cookie: null });
  assert.equal(login.status, 200);
  return { id: r.json.business.id, correo, cookie: cookieDe(login) };
}

const nuevoBarbero = (s, b, extra = {}) => s.pedir('POST', '/api/admin/barbers', { name: 'Barbero ' + unico(), ...extra }, { cookie: b.cookie });
const activos = async (s, b) => ((await s.pedir('GET', '/api/admin/barbers', undefined, { cookie: b.cookie })).json.barbers || [])
  .filter(x => x.active !== false).length;

async function cambiarPlan(s, b, plan, extra = {}) {
  const actual = (await plataforma(s, 'GET', `/api/plataforma/negocios/${b.id}`)).json.business.subscription;
  return plataforma(s, 'PUT', `/api/plataforma/negocios/${b.id}/suscripcion`, {
    status: actual.storedStatus, plan, trialEndsAt: actual.trialEndsAt, currentPeriodEnd: actual.currentPeriodEnd,
    version: actual.version + 1, ...extra
  });
}

test.describe('Fase 8 · límites de barberos por plan', { skip: omitir }, () => {
  let s, pool;

  test.before(async () => {
    pool = crearPool();
    s = await iniciarServidor({ postgres: true, env: { PLATAFORMA_CLAVE: CLAVE_PLATAFORMA } });
    const r = await plataforma(s, 'PUT', '/api/plataforma/planes', { plans: CATALOGO });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  });
  test.after(async () => {
    await s.detener();
    s.borrar();
    await pool.end();
  });

  test('el catálogo guarda precio, días de prueba y límite; el registro los muestra', async () => {
    const publicos = (await s.pedir('GET', '/api/public/planes', undefined, { cookie: null })).json.plans;
    assert.deepEqual(publicos, CATALOGO.map(p => ({ name: p.name, price: p.price, trialDays: p.trialDays, maxBarbers: p.maxBarbers })));
    const malo = await plataforma(s, 'PUT', '/api/plataforma/planes', { plans: [{ ...CATALOGO[0], maxBarbers: 0 }] });
    assert.equal(malo.status, 400, 'un límite no válido se rechaza');
    assert.equal((await s.pedir('GET', '/api/public/planes', undefined, { cookie: null })).json.plans.length, 3, 'y el catálogo no cambia');
  });

  test('Individual: 1 barbero activo; el segundo se rechaza en el servidor', async () => {
    const b = await registrar(s, 'Individual');
    const sesion = (await s.pedir('GET', '/api/auth/sesion', undefined, { cookie: b.cookie })).json;
    assert.deepEqual(sesion.limits, { plan: 'Individual', maxBarbers: 1, activeBarbers: 1 });
    const r = await nuevoBarbero(s, b);
    assert.equal(r.status, 403);
    assert.equal(r.json.code, 'LIMITE_BARBEROS');
    assert.match(r.json.error, /plan Individual permite 1 barbero activo.*plan superior/);
    assert.equal(await activos(s, b), 1);
    /* Uno desactivado sí se puede crear (no cuenta), pero no activarlo. */
    const inactivo = await nuevoBarbero(s, b, { active: false });
    assert.equal(inactivo.status, 201);
    const activar = await s.pedir('PATCH', `/api/admin/barbers/${inactivo.json.barber.id}`, { active: true }, { cookie: b.cookie });
    assert.equal(activar.status, 403);
    assert.equal(await activos(s, b), 1);
    /* Editar el barbero activo sigue funcionando. */
    assert.equal((await s.pedir('PATCH', '/api/admin/barbers/barbero-1', { name: 'Carlos' }, { cookie: b.cookie })).status, 200);
    /* Solicitudes simultáneas tampoco superan el límite. */
    const varios = await Promise.all([1, 2, 3].map(() => nuevoBarbero(s, b)));
    assert.ok(varios.every(x => x.status === 403));
    assert.equal(await activos(s, b), 1);
  });

  test('Pro: hasta 4; Business: hasta 10', async () => {
    for (const [plan, maximo] of [['Pro', 4], ['Business', 10]]) {
      const b = await registrar(s, plan);
      for (let i = 1; i < maximo; i++) assert.equal((await nuevoBarbero(s, b)).status, 201, `${plan} barbero ${i + 1}`);
      assert.equal(await activos(s, b), maximo);
      const extra = await nuevoBarbero(s, b);
      assert.equal(extra.status, 403, `${plan}: el ${maximo + 1}.º se rechaza`);
      assert.deepEqual(extra.json.limits, { plan, maxBarbers: maximo, activeBarbers: maximo });
      const stats = (await plataforma(s, 'GET', `/api/plataforma/negocios/${b.id}`)).json.business.stats;
      assert.equal(stats.activeBarbers, maximo);
      assert.equal(stats.maxBarbers, maximo, 'el Panel Maestro recibe activos y límite');
    }
  });

  test('subir de plan amplía el límite sin perder nada; bajar exige reducir barberos activos', async () => {
    const b = await registrar(s, 'Individual');
    assert.equal((await nuevoBarbero(s, b)).status, 403);
    const subir = await cambiarPlan(s, b, 'Pro');
    assert.equal(subir.status, 200, JSON.stringify(subir.json));
    assert.equal(subir.json.subscription.plan, 'Pro');
    const nuevos = [];
    for (let i = 0; i < 2; i++) {
      const r = await nuevoBarbero(s, b);
      assert.equal(r.status, 201);
      nuevos.push(r.json.barber.id);
    }
    assert.equal(await activos(s, b), 3);

    /* Bajar a Individual con 3 activos: se rechaza y no cambia nada. */
    const bajar = await cambiarPlan(s, b, 'Individual');
    assert.equal(bajar.status, 409);
    assert.equal(bajar.json.code, 'LIMITE_BARBEROS');
    assert.equal(bajar.json.activeBarbers, 3);
    assert.equal(bajar.json.maxBarbers, 1);
    const sus = (await plataforma(s, 'GET', `/api/plataforma/negocios/${b.id}`)).json.business.subscription;
    assert.equal(sus.plan, 'Pro', 'el plan no cambió');
    assert.equal(await activos(s, b), 3, 'ningún barbero se desactivó ni se borró');

    /* El propietario desactiva dos (se conservan) y entonces sí se puede bajar. */
    for (const id of nuevos) assert.equal((await s.pedir('PATCH', `/api/admin/barbers/${id}`, { active: false }, { cookie: b.cookie })).status, 200);
    const ahora = await cambiarPlan(s, b, 'Individual');
    assert.equal(ahora.status, 200, JSON.stringify(ahora.json));
    const lista = (await s.pedir('GET', '/api/admin/barbers', undefined, { cookie: b.cookie })).json.barbers;
    assert.equal(lista.length, 3, 'los tres barberos siguen guardados');
    assert.equal((await s.pedir('PATCH', `/api/admin/barbers/${nuevos[0]}`, { active: true }, { cookie: b.cookie })).status, 403);

    /* Cambios de estado con el mismo plan no se bloquean. */
    assert.equal((await cambiarPlan(s, b, 'Individual', { status: 'past_due' })).status, 200);
  });

  test('el límite se aplica aunque se salte la interfaz, y nadie toca otra barbería', async () => {
    const a = await registrar(s, 'Individual');
    const otra = await registrar(s, 'Pro');
    /* Sin sesión. */
    assert.equal((await s.pedir('POST', '/api/admin/barbers', { name: 'Intruso' }, { cookie: null })).status, 401);
    /* Con su sesión, enviando el id de otra barbería: el cambio va a la suya y se rechaza por su plan. */
    const r = await s.pedir('POST', '/api/admin/barbers', { name: 'Intruso', businessId: otra.id }, { cookie: a.cookie, headers: { 'X-Business-Id': otra.id } });
    assert.equal(r.status, 403);
    assert.equal(await activos(s, otra), 1, 'la otra barbería no cambió');
    /* Mismo id de barbero en las dos: editar desde A no toca el de la otra. */
    assert.equal((await s.pedir('PATCH', '/api/admin/barbers/barbero-1', { name: 'Solo de A' }, { cookie: a.cookie })).status, 200);
    const deOtra = (await s.pedir('GET', '/api/admin/barbers', undefined, { cookie: otra.cookie })).json.barbers;
    assert.notEqual(deOtra.find(x => x.id === 'barbero-1').name, 'Solo de A');
    /* El propietario no puede cambiarse de plan: la API de plataforma exige la firma del Panel Maestro. */
    const sinFirma = await s.pedir('PUT', `/api/plataforma/negocios/${a.id}/suscripcion`, { status: 'active', plan: 'Business', version: 99 }, { cookie: a.cookie });
    assert.equal(sinFirma.status, 401);
    assert.equal((await s.pedir('PUT', '/api/plataforma/planes', { plans: [{ ...CATALOGO[0], maxBarbers: 1000 }] }, { cookie: a.cookie })).status, 401);
    assert.equal((await nuevoBarbero(s, a)).status, 403, 'sigue en Individual');
  });

  test('El Máster (protegida) no tiene límite y conserva su protección', async () => {
    const sesion = (await s.pedir('GET', '/api/auth/sesion')).json;
    assert.equal(sesion.limits.maxBarbers, null);
    for (let i = 0; i < 11; i++) assert.equal((await s.pedir('POST', '/api/admin/barbers', { name: 'Equipo ' + i })).status, 201);
    const vencer = await cambiarPlan(s, { id: s.negocio }, null, { status: 'expired' });
    assert.equal(vencer.status, 409);
    assert.equal(vencer.json.code, 'NEGOCIO_PROTEGIDO');
  });

  test('el propietario ve cuántos barberos tiene y cuántos permite su plan (teléfono)', async t => {
    const navegador = await abrirNavegador();
    if (!navegador) return t.skip('Chromium no disponible');
    try {
      const b = await registrar(s, 'Individual');
      const ctx = await navegador.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
      const [nombre, valor] = b.cookie.split('=');
      await ctx.addCookies([{ name: nombre, value: valor, url: s.base }]);
      const page = await ctx.newPage();
      await page.goto(s.base + '/admin.html');
      await page.waitForFunction(() => typeof currentSession !== 'undefined' && currentSession !== null);
      await page.evaluate(() => { goTo('configuracion'); openSetting('barberos'); });
      await page.locator('#barberLimit').waitFor();
      assert.match(await page.textContent('#barberLimit'), /Barberos activos: 1 de 1[\s\S]*Llegaste al máximo de tu plan Individual/);
      assert.ok(await page.locator('#addBarberBtn').isDisabled());
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
      await ctx.close();
    } finally {
      await navegador.close();
    }
  });

  test('los límites siguen después de reiniciar; un Panel antiguo sin límites no los borra', async () => {
    const b = await registrar(s, 'Individual');
    /* Panel Maestro anterior: envía el catálogo sin maxBarbers. */
    const antiguo = await plataforma(s, 'PUT', '/api/plataforma/planes', { plans: CATALOGO.map(({ maxBarbers, ...p }) => p) });
    assert.equal(antiguo.status, 200);
    assert.deepEqual(antiguo.json.plans.map(p => p.maxBarbers), [1, 4, 10], 'se conservan');
    s = await reiniciar(s);
    const login = await s.pedir('POST', '/api/auth/login', { email: b.correo, password: CLAVE }, { cookie: null });
    b.cookie = cookieDe(login);
    assert.equal((await nuevoBarbero(s, b)).status, 403);
    assert.equal((await s.pedir('GET', '/api/auth/sesion', undefined, { cookie: b.cookie })).json.limits.maxBarbers, 1);
  });

  test('la migración pone los límites de los planes actuales donde faltan', async () => {
    await pool.query(`UPDATE platform_plans SET max_barbers = NULL`);
    await pool.query(`DELETE FROM master_reservas_migrations WHERE version = '2026-10-fase8-001'`);
    s = await reiniciar(s);
    assert.ok(s.logs.some(l => l.includes('MIGRACIÓN APLICADA: 2026-10-fase8-001')));
    const filas = (await pool.query('SELECT name, max_barbers FROM platform_plans ORDER BY position')).rows;
    assert.deepEqual(filas.map(f => [f.name, f.max_barbers]), [['Individual', 1], ['Pro', 4], ['Business', 10]]);
  });
});
