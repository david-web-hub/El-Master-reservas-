'use strict';
/*
  Ensayo de la ACTUALIZACIÓN de producción a esta versión (fase 7):

   1. Producción actual (main) en una base nueva, con datos reales: la barbería
      principal con su propietario y una reserva, y otra barbería registrada con
      su dueño, un barbero y su configuración.
   2. Arranca esta versión sobre la misma base: aplica sus migraciones y no
      pierde ni cambia ningún dato (mismas filas en todas las tablas).
      Todo sigue funcionando y la otra barbería ya tiene su página pública.
   3. Vuelta atrás: la versión de main vuelve a arrancar sobre la base
      actualizada, con todos los datos.

  Requiere TEST_DATABASE_URL (con permiso para crear bases) y
  MASTER_RESERVAS_PRODUCCION = carpeta con el código de main.
*/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Pool } = require('pg');
const { iniciarServidor, urlBasePruebas, cookieDe, proximoDia, RAIZ } = require('./apoyo/servidor');

const URL_PG = urlBasePruebas();
const PRODUCCION = process.env.MASTER_RESERVAS_PRODUCCION;
const omitir = !URL_PG ? 'Requiere TEST_DATABASE_URL'
  : !PRODUCCION || !fs.existsSync(path.join(PRODUCCION, 'server.js')) ? 'Requiere MASTER_RESERVAS_PRODUCCION (código de main)'
  : false;
const CLAVE = 'Una-clave-bastante-segura-7';
const CORREO_DUENO = 'propietario@elmaster.prueba';
const TABLAS = ['businesses', 'users', 'memberships', 'barbers', 'services', 'bookings', 'booking_slots', 'business_state',
  'admin_settings', 'sales', 'products', 'platform_events', 'platform_plans'];

function urlDe(nombre) {
  const u = new URL(URL_PG);
  u.pathname = '/' + nombre;
  return u.toString();
}
function crearPool(url) {
  const sinSsl = new URL(url).searchParams.get('sslmode') === 'disable';
  const pool = new Pool({ connectionString: url, ssl: sinSsl ? false : { rejectUnauthorized: false }, max: 2 });
  pool.on('error', () => {});
  return pool;
}

/* La versión de main (producción actual), en una copia. */
async function iniciarMain(dbUrl, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-'));
  fs.cpSync(PRODUCCION, dir, { recursive: true, filter: f => !/[\\/](node_modules|\.git)([\\/]|$)/.test(f) });
  const puerto = await new Promise(resolve => { const x = require('node:net').createServer(); x.listen(0, () => { const p = x.address().port; x.close(() => resolve(p)); }); });
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: dir,
    env: { PATH: process.env.PATH, NODE_PATH: path.join(RAIZ, 'node_modules'), PORT: String(puerto), DATABASE_URL: dbUrl, TZ: 'UTC',
      WHATSAPP_TOKEN: '', WHATSAPP_PHONE_NUMBER_ID: '', AUTH_LIMITE_IP: '100000', ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const logs = [];
  proc.stdout.on('data', d => logs.push(...String(d).split('\n')));
  proc.stderr.on('data', d => logs.push(...String(d).split('\n')));
  const fin = Date.now() + 30000;
  while (!logs.some(l => l.includes('EL MÁSTER RESERVAS INICIADO'))) {
    if (proc.exitCode !== null || Date.now() > fin) throw new Error('main no arrancó:\n' + logs.join('\n'));
    await new Promise(r => setTimeout(r, 50));
  }
  const base = `http://127.0.0.1:${puerto}`;
  const pedir = async (metodo, ruta, cuerpo, cookie) => {
    const r = await fetch(base + ruta, {
      method: metodo,
      headers: { ...(cuerpo ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined
    });
    const texto = await r.text();
    let json = null;
    try { json = JSON.parse(texto); } catch { /* no es JSON */ }
    return { status: r.status, json, texto, headers: r.headers };
  };
  return {
    base, logs, pedir,
    detener: () => new Promise(r => { if (proc.exitCode !== null || proc.signalCode !== null) return r(); proc.once('exit', r); proc.kill(); }),
    borrar: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

async function conteos(pool) {
  const r = {};
  for (const t of TABLAS) {
    const existe = (await pool.query('SELECT to_regclass($1) AS t', ['public.' + t])).rows[0].t;
    r[t] = existe ? (await pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n : null;
  }
  return r;
}

/* Contenido completo de las tablas de la agenda: debe quedar idéntico. */
async function huella(pool) {
  const partes = [];
  for (const t of ['businesses', 'users', 'memberships', 'barbers', 'services', 'bookings']) {
    const filas = (await pool.query(`SELECT to_jsonb(x) AS f FROM ${t} x`)).rows.map(r => {
      const f = { ...r.f };
      /* Marcas de uso que cambian solas (sesiones, última visita). */
      delete f.last_login_at; delete f.updated_at; delete f.last_seen_at;
      /* Columna nueva de MF Plux (tipo de negocio): debe quedar vacía en los negocios existentes. Si tuviera un valor, la huella cambia. */
      if (f.business_type === null) delete f.business_type;
      return JSON.stringify(f, Object.keys(f).sort());
    }).sort();
    partes.push(t + ':' + crypto.createHash('sha256').update(filas.join('\n')).digest('hex'));
  }
  return partes.join(' ');
}

test('ensayo de actualización: producción actual → fase 7 → vuelta atrás, sin perder datos', { skip: omitir }, async t => {
  const nombre = `actualizacion_${crypto.randomBytes(4).toString('hex')}`;
  const raiz = crearPool(URL_PG);
  await raiz.query(`CREATE DATABASE ${nombre}`);
  const url = urlDe(nombre);
  const pool = crearPool(url);
  t.after(async () => {
    await pool.end();
    await raiz.query(`DROP DATABASE IF EXISTS ${nombre} WITH (FORCE)`).catch(() => {});
    await raiz.end();
  });

  let antes, huellaAntes, otra;
  const fecha = proximoDia(2);

  await t.test('1. producción actual (main) con datos reales', async () => {
    const main = await iniciarMain(url, { PROPIETARIO_INICIAL_EMAIL: CORREO_DUENO, PROPIETARIO_INICIAL_CLAVE: CLAVE, PROPIETARIO_INICIAL_NOMBRE: 'David' });
    try {
      const login = await main.pedir('POST', '/api/auth/login', { email: CORREO_DUENO, password: CLAVE });
      assert.equal(login.status, 200, login.texto);
      const reserva = await main.pedir('POST', '/api/bookings', { name: 'Cliente Real', phone: '0991112233', barberId: 'master', serviceIds: ['corte'], date: fecha, time: '10:00' });
      assert.equal(reserva.status, 201, reserva.texto);
      /* Otra barbería registrada por el proceso normal, con su barbero. */
      const correo = 'otra@barberia.prueba';
      const desde = main.logs.length;
      const reg = await main.pedir('POST', '/api/auth/registro', { businessName: 'Barbería Existente', name: 'Rosa', email: correo, password: CLAVE });
      assert.equal(reg.status, 201, reg.texto);
      let linea;
      for (let i = 0; i < 100 && !linea; i++) { linea = main.logs.slice(desde).find(l => l.includes('[DEMO CORREO] ' + correo)); if (!linea) await new Promise(r => setTimeout(r, 50)); }
      assert.equal((await main.pedir('POST', '/api/auth/verificar', { token: linea.match(/verificar=([A-Za-z0-9_-]+)/)[1] })).status, 200);
      const cookie = cookieDe(await fetch(main.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: correo, password: CLAVE }) }));
      assert.equal((await main.pedir('POST', '/api/admin/barbers', { name: 'Rosa', active: true }, cookie)).status < 300, true);
      otra = { id: reg.json.business.id, slug: reg.json.business.slug, correo };
    } finally {
      await main.detener();
      main.borrar();
    }
    otra.barberos = (await pool.query(
      `SELECT data->>'name' AS n FROM barbers WHERE business_id = $1 ORDER BY position, created_at, id`, [otra.id])).rows.map(r => r.n);
    antes = await conteos(pool);
    huellaAntes = await huella(pool);
    assert.equal(antes.bookings, 1);
    assert.equal(antes.businesses, 2);
    assert.equal(antes.barbers >= 2, true);
  });

  await t.test('2. esta versión arranca sobre la misma base: migra sin perder ni cambiar datos', async () => {
    const nueva = await iniciarServidor({ postgres: true, sesion: false, env: { DATABASE_URL: url, DEFAULT_BUSINESS_ID: 'el-master' } });
    try {
      /* La migración de la fase 7 queda aplicada (por esta versión o, si main ya es la fase 7, desde antes). */
      assert.ok((await pool.query('SELECT to_regclass($1) AS t', ['public.business_whatsapp'])).rows[0].t, 'migración de la fase 7 aplicada');
      assert.deepEqual(await conteos(pool), antes, 'mismas filas en todas las tablas');
      assert.equal(await huella(pool), huellaAntes, 'mismo contenido');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM business_whatsapp')).rows[0].n, 0, 'tabla nueva, vacía');

      const dueno = await nueva.pedir('POST', '/api/auth/login', { email: CORREO_DUENO, password: CLAVE }, { cookie: null });
      assert.equal(dueno.status, 200, 'el propietario de El Máster entra con su contraseña');
      const reservas = await nueva.pedir('GET', '/api/bookings', undefined, { cookie: cookieDe(dueno) });
      assert.match(JSON.stringify(reservas.json), /Cliente Real/, 'su reserva sigue ahí');
      const sesion = (await nueva.pedir('GET', '/api/auth/sesion', undefined, { cookie: cookieDe(dueno) })).json;
      assert.equal(sesion.principal, true);
      assert.equal(sesion.subscription.protected, true, 'El Máster sigue protegida');
      assert.equal((await nueva.pedir('GET', '/', undefined, { cookie: null })).status, 200, 'su página pública sigue en la raíz');

      const otraLogin = await nueva.pedir('POST', '/api/auth/login', { email: otra.correo, password: CLAVE }, { cookie: null });
      assert.equal(otraLogin.status, 200);
      const site = (await nueva.pedir('GET', `/b/${otra.slug}/api/public/site`, undefined, { cookie: null })).json;
      assert.equal(site.business.name, 'Barbería Existente', 'la barbería existente ya tiene su página pública');
      assert.ok(otra.barberos.includes('Rosa'));
      assert.deepEqual(site.barbers.map(b => b.name), otra.barberos, 'sus barberos de siempre');
    } finally {
      await nueva.detener();
      nueva.borrar();
    }
    assert.equal(await huella(pool), huellaAntes, 'nada cambió al detenerse');
  });

  await t.test('3. vuelta atrás: main arranca sobre la base actualizada con todos los datos', async () => {
    const main = await iniciarMain(url);
    try {
      const login = await main.pedir('POST', '/api/auth/login', { email: CORREO_DUENO, password: CLAVE });
      assert.equal(login.status, 200);
      const reservas = await main.pedir('GET', '/api/bookings', undefined, cookieDe(login));
      assert.match(JSON.stringify(reservas.json), /Cliente Real/);
    } finally {
      await main.detener();
      main.borrar();
    }
    assert.deepEqual(await conteos(pool), antes);
  });
});
