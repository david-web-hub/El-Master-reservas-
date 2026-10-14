'use strict';
/*
  Fase 6: comunicación firmada con el Panel Maestro, suscripciones, vencimiento
  y protección de El Máster. Requiere TEST_DATABASE_URL.
*/
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { iniciarServidor, reiniciar, urlBasePruebas, cookieDe, proximoDia } = require('./apoyo/servidor');
const { firmar, cabecerasFirmadas, crearVerificador } = require('../firma-plataforma');
const { estadoEfectivo, resumenSuscripcion } = require('../plataforma');

const URL_PG = urlBasePruebas();
const omitir = URL_PG ? false : 'Define TEST_DATABASE_URL con una base de pruebas';
const CLAVE_PLATAFORMA = 'clave-de-plataforma-solo-para-pruebas-0123456789';
const CLAVE = 'Una-clave-bastante-segura-7';
const unico = () => Math.random().toString(36).slice(2, 10);
const DIA = 24 * 3600 * 1000;

function crearPool() {
  const sinSsl = new URL(URL_PG).searchParams.get('sslmode') === 'disable';
  const pool = new Pool({ connectionString: URL_PG, ssl: sinSsl ? false : { rejectUnauthorized: false }, max: 2 });
  pool.on('error', () => {});
  return pool;
}

/* Petición firmada como la haría el Panel Maestro. */
async function plataforma(s, metodo, ruta, cuerpo, { clave = CLAVE_PLATAFORMA, alterar } = {}) {
  const texto = cuerpo === undefined ? '' : JSON.stringify(cuerpo);
  let cab = cabecerasFirmadas(clave, { metodo, ruta, cuerpo: texto });
  if (alterar) cab = alterar(cab);
  const r = await fetch(s.base + ruta, {
    method: metodo,
    headers: { ...cab, ...(cuerpo === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: cuerpo === undefined ? undefined : texto
  });
  let json = null;
  try { json = await r.json(); } catch { /* sin cuerpo */ }
  return { status: r.status, json };
}

async function enlace(s, correo, tipo, desde) {
  const linea = await s.esperarLog(new RegExp(`\\[DEMO CORREO\\] ${correo.replace(/[.+]/g, '\\$&')} `), 5000, desde);
  return linea.match(new RegExp(`${tipo}=([A-Za-z0-9_-]+)`))[1];
}

/* Registra una barbería nueva con su dueño confirmado y devuelve su id y la cookie del dueño. */
async function registrar(s, extra = {}) {
  const correo = `dueno-${unico()}@prueba.test`;
  const desde = s.logs.length;
  const r = await s.pedir('POST', '/api/auth/registro', { businessName: 'Barbería ' + unico(), name: 'Dueño', email: correo, password: CLAVE, ...extra }, { cookie: null });
  if (r.status !== 201) return { r };
  await s.pedir('POST', '/api/auth/verificar', { token: await enlace(s, correo, 'verificar', desde) }, { cookie: null });
  const login = await s.pedir('POST', '/api/auth/login', { email: correo, password: CLAVE }, { cookie: null });
  return { r, id: r.json.business.id, correo, cookie: cookieDe(login) };
}

const PLANES = [
  { name: 'Individual', price: 9.99, trialDays: 7, active: true },
  { name: 'Pro', price: 19.99, trialDays: 7, active: true },
  { name: 'Business', price: 34.99, trialDays: 7, active: true },
  { name: 'Antiguo', price: 5, trialDays: 30, active: false }
];

test('firma: vector de prueba compartido con el Panel Maestro', () => {
  /* El mismo valor está en las pruebas del Panel Maestro (test/firma.test.js). Comprobado también con openssl. */
  assert.equal(
    firmar('clave-de-prueba-compartida-0123456789abcdef', {
      metodo: 'put', ruta: '/api/plataforma/negocios/el-master/suscripcion?x=1', fecha: 1760000000000,
      nonce: '0123456789abcdef0123456789abcdef', cuerpo: '{"status":"active","version":2}'
    }),
    'ab52f9f043ff13872b3adc4ecd7daf0daf52745957496adf7838c882ce27efc1');
});

test('firma: verificador (fecha, nonce repetido, clave anterior, cuerpo alterado)', () => {
  let ahora = 1760000000000;
  const v = crearVerificador({ claves: ['k'.repeat(40), 'a'.repeat(40)], ahora: () => ahora });
  const pedido = (clave, extra = {}) => {
    const datos = { metodo: 'POST', ruta: '/api/plataforma/x', cuerpo: '{"a":1}', ...extra };
    const cab = cabecerasFirmadas(clave, { ...datos, fecha: ahora });
    return { ...datos, cabeceras: Object.fromEntries(Object.entries(cab).map(([k, x]) => [k.toLowerCase(), x])) };
  };
  const p = pedido('k'.repeat(40));
  assert.deepEqual(v(p), { ok: true });
  assert.equal(v(p).motivo, 'REPETIDA');
  assert.deepEqual(v(pedido('a'.repeat(40))), { ok: true }, 'la clave anterior sigue sirviendo durante el cambio');
  assert.equal(v(pedido('otra-clave-que-no-es-valida-de-ningun-modo')).motivo, 'FIRMA');
  const alterado = pedido('k'.repeat(40));
  alterado.cuerpo = '{"a":2}';
  assert.equal(v(alterado).motivo, 'FIRMA');
  const viejo = pedido('k'.repeat(40));
  ahora += 6 * 60 * 1000;
  assert.equal(v(viejo).motivo, 'FECHA');
  assert.equal(crearVerificador({ claves: [] })(viejo).motivo, 'NO_CONFIGURADA');
});

test('estado efectivo: fechas, protección y reservas', () => {
  const ahora = new Date('2026-10-14T12:00:00Z');
  const ayer = new Date(ahora - DIA);
  const manana = new Date(+ahora + DIA);
  assert.equal(estadoEfectivo({ status: 'trial', trial_ends_at: manana }, ahora), 'trial');
  assert.equal(estadoEfectivo({ status: 'trial', trial_ends_at: ayer }, ahora), 'expired');
  assert.equal(estadoEfectivo({ status: 'active', current_period_end: ayer }, ahora), 'expired');
  assert.equal(estadoEfectivo({ status: 'active', current_period_end: null }, ahora), 'active');
  assert.equal(estadoEfectivo({ status: 'past_due' }, ahora), 'past_due');
  for (const status of ['trial', 'active', 'expired', 'suspended', 'past_due']) {
    assert.equal(estadoEfectivo({ status, protected: true, trial_ends_at: ayer, current_period_end: ayer }, ahora), 'active', status);
  }
  assert.equal(resumenSuscripcion({ status: 'trial', trial_ends_at: ayer }, ahora).canBook, false);
  assert.equal(resumenSuscripcion({ status: 'past_due' }, ahora).canBook, true, 'pago pendiente: avisa pero sigue recibiendo reservas');
  assert.equal(resumenSuscripcion({ status: 'trial', trial_ends_at: new Date(+ahora + 2.5 * DIA) }, ahora).daysLeft, 3);
});

test.describe('Fase 6 · API de plataforma', { skip: omitir }, () => {
  let s;
  let pool;

  test.before(async () => {
    s = await iniciarServidor({ postgres: true, env: { PLATAFORMA_CLAVE: CLAVE_PLATAFORMA } });
    pool = crearPool();
  });
  test.after(async () => {
    if (pool) await pool.end();
    if (s) { await s.detener(); s.borrar(); }
  });

  test('sin firma válida no hay acceso, ni siquiera con la sesión del propietario', async () => {
    const sinFirma = await fetch(s.base + '/api/plataforma/negocios');
    assert.equal(sinFirma.status, 401);
    assert.equal((await s.pedir('GET', '/api/plataforma/negocios')).status, 401, 'la cookie de un propietario no sirve');
    assert.equal((await plataforma(s, 'GET', '/api/plataforma/negocios', undefined, { clave: 'otra-clave-distinta-de-la-configurada-123' })).status, 401);
    const viejo = await plataforma(s, 'GET', '/api/plataforma/negocios', undefined, {
      alterar: () => cabecerasFirmadas(CLAVE_PLATAFORMA, { metodo: 'GET', ruta: '/api/plataforma/negocios', fecha: Date.now() - 10 * 60 * 1000 })
    });
    assert.equal(viejo.status, 401, 'fecha fuera de la ventana de 5 minutos');
    const otraRuta = await plataforma(s, 'GET', '/api/plataforma/negocios', undefined, {
      alterar: () => cabecerasFirmadas(CLAVE_PLATAFORMA, { metodo: 'GET', ruta: '/api/plataforma/eventos' })
    });
    assert.equal(otraRuta.status, 401, 'la firma de una ruta no sirve para otra');

    /* Repetir exactamente la misma petición firmada se rechaza. */
    const cab = cabecerasFirmadas(CLAVE_PLATAFORMA, { metodo: 'GET', ruta: '/api/plataforma/estado' });
    assert.equal((await fetch(s.base + '/api/plataforma/estado', { headers: cab })).status, 200);
    assert.equal((await fetch(s.base + '/api/plataforma/estado', { headers: cab })).status, 401);

    /* El cuerpo firmado no se puede cambiar. */
    const texto = JSON.stringify({ plans: PLANES });
    const firmadas = cabecerasFirmadas(CLAVE_PLATAFORMA, { metodo: 'PUT', ruta: '/api/plataforma/planes', cuerpo: texto });
    const r = await fetch(s.base + '/api/plataforma/planes', {
      method: 'PUT', headers: { ...firmadas, 'Content-Type': 'application/json' },
      body: JSON.stringify({ plans: [{ name: 'Gratis', price: 0, trialDays: 365 }] })
    });
    assert.equal(r.status, 401);
  });

  test('catálogo de planes: el registro usa los planes y los 7 días de prueba del Panel', async () => {
    const r = await plataforma(s, 'PUT', '/api/plataforma/planes', { plans: PLANES });
    assert.equal(r.status, 200);
    assert.equal(r.json.plans.length, 4);
    assert.equal((await plataforma(s, 'PUT', '/api/plataforma/planes', { plans: [{ name: '', price: 1, trialDays: 7 }] })).status, 400);
    assert.equal((await plataforma(s, 'PUT', '/api/plataforma/planes', { plans: [{ name: 'X', price: 1, trialDays: 400 }] })).status, 400);
    const publicos = (await s.pedir('GET', '/api/public/planes', undefined, { cookie: null })).json.plans;
    assert.deepEqual(publicos.map(p => p.name), ['Individual', 'Pro', 'Business'], 'solo los activos');

    const antes = Date.now();
    const pro = await registrar(s, { plan: 'pro' });
    const [fila] = (await pool.query('SELECT plan, status, trial_ends_at FROM businesses WHERE id = $1', [pro.id])).rows;
    assert.equal(fila.plan, 'Pro');
    assert.equal(fila.status, 'trial');
    const dias = (new Date(fila.trial_ends_at) - antes) / DIA;
    assert.ok(dias > 6.99 && dias < 7.01, `7 días de prueba (fueron ${dias})`);

    const sinPlan = await registrar(s);
    assert.equal((await pool.query('SELECT plan FROM businesses WHERE id = $1', [sinPlan.id])).rows[0].plan, 'Individual', 'sin elegir: el primer plan activo');
    for (const plan of ['Inventado', 'Antiguo']) {
      const mal = await registrar(s, { plan });
      assert.equal(mal.r.status, 400, plan);
      assert.equal(mal.r.json.code, 'PLAN_INVALIDO');
    }
  });

  test('barberías: datos administrativos y cifras, sin datos personales de clientes', async () => {
    const cliente = { name: 'Cliente Confidencial', phone: '0991234567' };
    const reserva = await s.pedir('POST', '/api/bookings', {
      ...cliente, barberId: 'master', serviceIds: ['corte'], date: proximoDia(2), time: '10:00'
    }, { cookie: null });
    assert.equal(reserva.status, 201, reserva.texto);

    const r = await plataforma(s, 'GET', '/api/plataforma/negocios');
    assert.equal(r.status, 200);
    const principal = r.json.businesses.find(b => b.id === s.negocio);
    assert.equal(principal.subscription.protected, true, 'El Máster está protegida');
    assert.equal(principal.subscription.status, 'active');
    assert.ok(principal.stats.bookings >= 1 && principal.stats.clients >= 1 && principal.stats.upcomingBookings >= 1);
    assert.equal(principal.owner.email, s.correo, 'contacto administrativo del propietario');
    for (const k of ['barbers', 'users', 'bookings', 'bookingsLast30Days', 'upcomingBookings', 'clients', 'salesLast30Days']) {
      assert.equal(typeof principal.stats[k], 'number', k);
    }
    const todo = JSON.stringify(r.json) + JSON.stringify((await plataforma(s, 'GET', '/api/plataforma/eventos?limite=500')).json);
    assert.ok(!todo.includes(cliente.name) && !todo.includes('1234567'), 'ni el nombre ni el teléfono del cliente salen de la barbería');

    const uno = await plataforma(s, 'GET', `/api/plataforma/negocios/${s.negocio}`);
    assert.equal(uno.json.business.id, s.negocio);
    assert.equal((await plataforma(s, 'GET', '/api/plataforma/negocios/no-existe')).status, 404);
  });

  test('eventos: la barbería nueva se anuncia y se confirma una sola vez', async () => {
    const nueva = await registrar(s, { plan: 'Business' });
    const pendientes = (await plataforma(s, 'GET', '/api/plataforma/eventos?limite=500')).json.events;
    const ev = pendientes.find(e => e.businessId === nueva.id && e.type === 'business.created');
    assert.ok(ev, 'evento business.created');
    assert.equal(ev.payload.plan, 'Business');
    assert.equal((await plataforma(s, 'POST', '/api/plataforma/eventos/confirmar', { ids: ['x'] })).status, 400);
    const c = await plataforma(s, 'POST', '/api/plataforma/eventos/confirmar', { ids: pendientes.map(e => e.id) });
    assert.equal(c.json.confirmed, pendientes.length);
    const despues = (await plataforma(s, 'GET', '/api/plataforma/eventos?limite=500')).json.events;
    assert.ok(!despues.some(e => e.id === ev.id), 'ya no está pendiente');
    assert.equal((await plataforma(s, 'POST', '/api/plataforma/eventos/confirmar', { ids: [ev.id] })).json.confirmed, 0);
  });

  test('suscripción: versiones, vencimiento, pago pendiente y suspensión', async () => {
    const b = await registrar(s, { plan: 'Pro' });
    const ruta = `/api/plataforma/negocios/${b.id}/suscripcion`;
    const sesion = async () => (await s.pedir('GET', '/api/auth/sesion', undefined, { cookie: b.cookie })).json;
    assert.equal((await sesion()).subscription.status, 'trial');

    const activa = { status: 'active', plan: 'Business', trialEndsAt: null, currentPeriodEnd: new Date(Date.now() + 30 * DIA).toISOString(), version: 2 };
    const r1 = await plataforma(s, 'PUT', ruta, activa);
    assert.equal(r1.status, 200);
    assert.equal(r1.json.subscription.status, 'active');
    assert.equal((await plataforma(s, 'PUT', ruta, { ...activa, status: 'expired' })).json.subscription.status, 'active', 'misma versión: se ignora (repetición)');
    const vieja = await plataforma(s, 'PUT', ruta, { ...activa, status: 'expired', version: 1 });
    assert.equal(vieja.status, 409);
    assert.equal(vieja.json.code, 'VERSION_ANTIGUA');
    assert.equal((await plataforma(s, 'PUT', ruta, { ...activa, status: 'gratis', version: 3 })).status, 400);
    assert.equal((await plataforma(s, 'PUT', '/api/plataforma/negocios/no-existe/suscripcion', { ...activa, version: 3 })).status, 404);

    /* Pago pendiente: avisa, pero sigue funcionando. */
    await plataforma(s, 'PUT', ruta, { ...activa, status: 'past_due', version: 3 });
    const pendiente = (await sesion()).subscription;
    assert.deepEqual([pendiente.status, pendiente.canBook], ['past_due', true]);

    /* Vencida por fecha: se conserva todo y se puede entrar, pero no hay reservas nuevas. */
    await plataforma(s, 'PUT', ruta, { ...activa, currentPeriodEnd: new Date(Date.now() - 60000).toISOString(), version: 4 });
    const vencida = await sesion();
    assert.deepEqual([vencida.subscription.status, vencida.subscription.canBook], ['expired', false]);
    for (const ruta2 of ['/api/bookings', '/api/admin/barbers', '/api/admin/services', '/api/admin/settings']) {
      assert.equal((await s.pedir('GET', ruta2, undefined, { cookie: b.cookie })).status, 200, `${ruta2}: los datos siguen disponibles`);
    }
    const [fila] = (await pool.query('SELECT status FROM businesses WHERE id = $1', [b.id])).rows;
    assert.equal(fila.status, 'active', 'el vencimiento por fecha no reescribe nada en la base');

    /* Suspendida: sin acceso, y el resto de barberías no se entera. */
    await plataforma(s, 'PUT', ruta, { ...activa, status: 'suspended', version: 5 });
    assert.equal((await s.pedir('GET', '/api/auth/sesion', undefined, { cookie: b.cookie })).status, 401);
    assert.equal((await s.pedir('GET', '/api/auth/sesion')).status, 200, 'el propietario de El Máster sigue dentro');

    /* Reactivar devuelve el acceso con los datos intactos. */
    await plataforma(s, 'PUT', ruta, { ...activa, version: 6 });
    const login = await s.pedir('POST', '/api/auth/login', { email: b.correo, password: CLAVE }, { cookie: null });
    assert.equal(login.status, 200);
    assert.equal((await s.pedir('GET', '/api/admin/barbers', undefined, { cookie: cookieDe(login) })).status, 200);
  });

  test('El Máster nunca se bloquea: ni desde el Panel, ni por fechas, ni en la base', async () => {
    const ruta = `/api/plataforma/negocios/${s.negocio}/suscripcion`;
    for (const status of ['expired', 'suspended', 'past_due']) {
      const r = await plataforma(s, 'PUT', ruta, { status, plan: 'Pro', version: 10 });
      assert.equal(r.status, 409, status);
      assert.equal(r.json.code, 'NEGOCIO_PROTEGIDO');
    }
    /* Una prueba "vencida" no le afecta. */
    const r = await plataforma(s, 'PUT', ruta, { status: 'trial', plan: 'Pro', trialEndsAt: new Date(Date.now() - DIA).toISOString(), version: 10 });
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.subscription.status, r.json.subscription.canBook], ['active', true]);
    const reserva = await s.pedir('POST', '/api/bookings', {
      name: 'Cliente Protegido', phone: '0990000611', barberId: 'master', serviceIds: ['corte'], date: proximoDia(3), time: '11:00'
    }, { cookie: null });
    assert.equal(reserva.status, 201, 'sigue recibiendo reservas');

    await assert.rejects(
      pool.query(`UPDATE businesses SET status = 'suspended' WHERE id = $1`, [s.negocio]),
      /businesses_protegida_activa/, 'la base rechaza bloquear una barbería protegida');
    await assert.rejects(
      pool.query(`UPDATE businesses SET status = 'gratis' WHERE id = $1`, [s.negocio]),
      /businesses_estado_valido/);
    assert.equal((await s.pedir('GET', '/api/auth/sesion')).json.subscription.status, 'active');
    await plataforma(s, 'PUT', ruta, { status: 'active', plan: 'Pro', version: 11 });
  });
});

test.describe('Fase 6 · reservas con la suscripción vencida', { skip: omitir }, () => {
  test('una barbería vencida no acepta reservas nuevas; al reiniciar, El Máster vuelve a quedar protegida', async () => {
    let s = await iniciarServidor({ postgres: true, env: { PLATAFORMA_CLAVE: CLAVE_PLATAFORMA } });
    const pool = crearPool();
    try {
      const datos = { name: 'Cliente Prueba', phone: '0990000622', barberId: 'master', serviceIds: ['corte'], date: proximoDia(4) };
      assert.equal((await s.pedir('POST', '/api/bookings', { ...datos, time: '09:00' }, { cookie: null })).status, 201);
      const antes = (await s.datos()).bookings.length;

      /* Simula una barbería sin protección (como lo sería una nueva con página pública) y vencida. */
      await pool.query(`UPDATE businesses SET protected = FALSE WHERE id = $1`, [s.negocio]);
      await pool.query(`UPDATE businesses SET status = 'expired' WHERE id = $1`, [s.negocio]);
      const r = await s.pedir('POST', '/api/bookings', { ...datos, time: '10:00' }, { cookie: null });
      assert.equal(r.status, 403);
      assert.equal(r.json.code, 'SUSCRIPCION_VENCIDA');
      const despues = await s.datos();
      assert.equal(despues.bookings.length, antes, 'las reservas existentes se conservan y no entra ninguna nueva');
      assert.equal((await s.pedir('GET', '/api/auth/sesion')).json.subscription.status, 'expired');

      /* Al arrancar, la barbería principal se vuelve a proteger y reactivar. */
      s = await reiniciar(s);
      await s.esperarLog(/BARBERÍA PROTEGIDA/, 5000);
      const [fila] = (await pool.query('SELECT protected, status FROM businesses WHERE id = $1', [s.negocio])).rows;
      assert.deepEqual(fila, { protected: true, status: 'active' });
      assert.equal((await s.pedir('POST', '/api/bookings', { ...datos, time: '10:00' }, { cookie: null })).status, 201);
    } finally {
      await pool.end();
      await s.detener();
      s.borrar();
    }
  });

  test('sin PLATAFORMA_CLAVE la conexión está desactivada; demasiadas firmas malas bloquean la IP', async () => {
    const sin = await iniciarServidor({ postgres: true });
    const con = await iniciarServidor({ postgres: true, env: { PLATAFORMA_CLAVE: CLAVE_PLATAFORMA } });
    try {
      const r = await plataforma(sin, 'GET', '/api/plataforma/negocios');
      assert.equal(r.status, 503);
      assert.equal(r.json.code, 'PLATAFORMA_NO_CONFIGURADA');
      const corta = await iniciarServidor({ postgres: true, env: { PLATAFORMA_CLAVE: 'corta' } });
      try {
        assert.equal((await plataforma(corta, 'GET', '/api/plataforma/negocios', undefined, { clave: 'corta' })).status, 503, 'una clave de menos de 32 caracteres no se acepta');
      } finally {
        await corta.detener();
        corta.borrar();
      }
      for (let i = 0; i < 20; i++) await plataforma(con, 'GET', '/api/plataforma/negocios', undefined, { clave: 'x'.repeat(40) });
      assert.equal((await plataforma(con, 'GET', '/api/plataforma/negocios')).status, 429, 'incluso con la clave correcta, durante 15 minutos');
      assert.ok(!con.logs.join('\n').includes(CLAVE_PLATAFORMA), 'la clave nunca aparece en los registros');
    } finally {
      for (const x of [sin, con]) { await x.detener(); x.borrar(); }
    }
  });
});

