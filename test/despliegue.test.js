'use strict';
/*
  Ensayo general de la INSTALACIÓN LIMPIA en producción, con el código real
  que hoy está desplegado (main) como "producción":

   1. Producción actual (main) con datos de demostración en su base, que además
      comparte con tablas del Panel Maestro y con una tabla ajena.
   2. Inventario de solo lectura: qué es demostración y qué no se toca.
   3. Respaldo (pg_dump) y verificación de su restauración en otra base.
   4. Limpieza: simulación, protecciones y ejecución. Solo se borran las
      tablas de El Máster Reservas; el Panel y la tabla ajena quedan intactos.
   5. Primer arranque de la versión nueva como en Render (RENDER=true):
      base limpia, El Máster protegida, registro cerrado sin correo.
   6. Cuenta del propietario con el script de consola.
   7. Con el correo configurado (Resend simulado): registro de una barbería
      nueva por el proceso normal, con su prueba gratuita.
   8. Reversión: la versión anterior vuelve a arrancar sobre la base nueva.

  Requiere TEST_DATABASE_URL (con permiso para crear bases) y
  MASTER_RESERVAS_PRODUCCION = carpeta con el código de main.
*/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Pool } = require('pg');
const { iniciarServidor, urlBasePruebas, cookieDe, proximoDia, RAIZ } = require('./apoyo/servidor');
const { iniciarResendFalso } = require('./apoyo/resend-falso');
const { cabecerasFirmadas } = require('../firma-plataforma');

const ejecutar = promisify(execFile);
const URL_PG = urlBasePruebas();
const PRODUCCION = process.env.MASTER_RESERVAS_PRODUCCION;
const omitir = !URL_PG ? 'Requiere TEST_DATABASE_URL'
  : !PRODUCCION || !fs.existsSync(path.join(PRODUCCION, 'server.js')) ? 'Requiere MASTER_RESERVAS_PRODUCCION (código de main)'
  : false;
const CLAVE_PLATAFORMA = 'clave-de-plataforma-solo-para-pruebas-0123456789';
const CLAVE = 'Una-clave-bastante-segura-7';
const PNG_1X1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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

/* Versión de producción (main) en una copia: su data/db.json no se toca. */
async function iniciarProduccion(dbUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'produccion-'));
  fs.cpSync(PRODUCCION, dir, { recursive: true, filter: f => !/[\\/](node_modules|\.git)([\\/]|$)/.test(f) });
  const s = await new Promise(resolve => { const x = require('node:net').createServer(); x.listen(0, () => { const p = x.address().port; x.close(() => resolve(p)); }); });
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: dir,
    env: { PATH: process.env.PATH, NODE_PATH: path.join(RAIZ, 'node_modules'), PORT: String(s), DATABASE_URL: dbUrl, TZ: 'UTC', WHATSAPP_TOKEN: '', WHATSAPP_PHONE_NUMBER_ID: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const logs = [];
  proc.stdout.on('data', d => logs.push(String(d)));
  proc.stderr.on('data', d => logs.push(String(d)));
  const fin = Date.now() + 20000;
  while (!(logs.join('').includes('EL MÁSTER RESERVAS INICIADO') && logs.join('').includes('TABLAS ADMINISTRATIVAS Y DE CAJA LISTAS'))) {
    if (proc.exitCode !== null || Date.now() > fin) throw new Error('main no arrancó:\n' + logs.join(''));
    await new Promise(r => setTimeout(r, 50));
  }
  const base = `http://127.0.0.1:${s}`;
  const pedir = async (metodo, ruta, cuerpo) => {
    const r = await fetch(base + ruta, { method: metodo, headers: cuerpo ? { 'Content-Type': 'application/json' } : {}, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
    const texto = await r.text();
    let json = null;
    try { json = JSON.parse(texto); } catch { /* no es JSON */ }
    return { status: r.status, json, texto };
  };
  return {
    base, logs, pedir,
    detener: () => new Promise(r => { if (proc.exitCode !== null || proc.signalCode !== null) return r(); proc.once('exit', r); proc.kill(); }),
    borrar: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

const script = (rel, args, env) => ejecutar(rel.endsWith('.sh') ? 'bash' : process.execPath, [path.join(RAIZ, rel), ...args], {
  env: { PATH: process.env.PATH, ...env }, maxBuffer: 10 * 1024 * 1024
}).then(r => ({ code: 0, ...r }), e => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));

test('ensayo general: instalación limpia en producción', { skip: omitir }, async t => {
  const sufijo = crypto.randomBytes(4).toString('hex');
  const nombre = `despliegue_${sufijo}_test`;
  const nombreRestaurar = `restaurar_${sufijo}_test`;
  const admin = crearPool(URL_PG);
  await admin.query(`CREATE DATABASE ${nombre}`);
  await admin.query(`CREATE DATABASE ${nombreRestaurar}`);
  const URL_DB = urlDe(nombre);
  const db = crearPool(URL_DB);
  const respaldos = fs.mkdtempSync(path.join(os.tmpdir(), 'respaldos-'));
  const servidores = [];
  t.after(async () => {
    for (const s of servidores) { await s.detener().catch(() => {}); s.borrar?.(); }
    await db.end();
    for (const n of [nombre, nombreRestaurar]) await admin.query(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`).catch(() => {});
    await admin.end();
    fs.rmSync(respaldos, { recursive: true, force: true });
  });
  const envDb = { DATABASE_URL: URL_DB };
  const contar = async tabla => (await db.query(`SELECT count(*)::int AS n FROM ${tabla}`)).rows[0].n;

  let respaldoDir;

  await t.test('1. producción actual (main) con datos de demostración y una base compartida', async () => {
    const prod = await iniciarProduccion(URL_DB);
    servidores.push(prod);
    assert.equal((await prod.pedir('POST', '/api/admin/settings', { section: 'pagina', data: { title: 'Demo', slogan: 'Demo' } })).status, 200);
    assert.equal((await prod.pedir('POST', '/api/admin/settings', { section: 'mensajes', data: { welcome: 'Hola demo' } })).status, 200);
    assert.equal((await prod.pedir('POST', '/api/admin/products', { name: 'Cera demo', price: 4.5, cost: 2, stock: 10, minStock: 2 })).status, 200);
    const reserva = await prod.pedir('POST', '/api/bookings', { name: 'Cliente Demo', phone: '0991234567', barberId: 'master', serviceIds: ['corte'], date: proximoDia(2), time: '10:00' });
    assert.equal(reserva.status, 201, reserva.texto);
    assert.equal((await prod.pedir('POST', '/api/sales', { bookingId: reserva.json.booking.id, paymentMethod: 'cash', items: [{ type: 'service', id: 'corte', quantity: 1 }] })).status, 200);
    assert.equal((await prod.pedir('POST', '/api/admin/media', { kind: 'barber', ref: 'master', image: PNG_1X1 })).status, 200);
    await prod.detener();
    /* Tablas del Panel Maestro y una ajena en la misma base (por si la comparten). */
    await db.query(`CREATE TABLE master_fade_plans (id BIGSERIAL PRIMARY KEY, name TEXT UNIQUE, price NUMERIC(10,2), trial_days INT)`);
    await db.query(`INSERT INTO master_fade_plans (name, price, trial_days) VALUES ('Individual', 9.99, 7), ('Pro', 19.99, 7), ('Business', 34.99, 7)`);
    await db.query(`CREATE TABLE tabla_ajena (id INT PRIMARY KEY)`);
    await db.query(`INSERT INTO tabla_ajena VALUES (1)`);
  });

  await t.test('2. inventario: clasifica sin mostrar datos personales', async () => {
    const r = await script('scripts/despliegue/inventario.js', ['--json'], envDb);
    assert.equal(r.code, 0, r.stderr);
    const inv = JSON.parse(r.stdout);
    assert.equal(inv.base, nombre);
    assert.equal(inv.compartidaConPanel, true);
    const clases = Object.fromEntries(inv.tablas.map(x => [x.tabla, x.clase]));
    for (const tbl of ['sales', 'cash_sessions', 'products', 'admin_settings', 'media_assets']) assert.equal(clases[tbl], 'reservas-actual', tbl);
    assert.equal(clases.master_fade_plans, 'panel');
    assert.equal(clases.tabla_ajena, 'otra');
    assert.ok(inv.tablas.find(x => x.tabla === 'sales').filas >= 1);
    assert.ok(!r.stdout.includes('0991234567') && !r.stdout.includes('Cliente Demo') && !r.stdout.includes(new URL(URL_PG).host), 'solo nombres de tablas y cantidades');
  });

  await t.test('3. respaldo completo y restauración verificada en otra base', async () => {
    respaldoDir = path.join(respaldos, 'pg');
    const r = await script('scripts/respaldo/respaldo-postgres.sh', [respaldoDir], envDb);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(fs.statSync(path.join(respaldoDir, 'base.dump')).size > 0);
    const v = await script('scripts/respaldo/verificar-restauracion.sh', [respaldoDir], { RESTAURAR_URL: urlDe(nombreRestaurar) });
    assert.equal(v.code, 0, v.stdout + v.stderr);
    assert.match(v.stdout, /RESTAURACIÓN VERIFICADA: \d+ tablas/);
    const otra = await script('scripts/respaldo/verificar-restauracion.sh', [respaldoDir], { RESTAURAR_URL: urlDe(nombreRestaurar) });
    assert.notEqual(otra.code, 0, 'no restaura sobre una base que ya tiene datos');
    assert.match(otra.stderr, /no está vacía/);
  });

  await t.test('4. limpieza: simulación, protecciones y ejecución', async () => {
    const sim = await script('scripts/despliegue/limpiar-demo.js', [], envDb);
    assert.equal(sim.code, 0, sim.stderr);
    assert.match(sim.stdout, /Se BORRARÍAN 5 tablas/);
    assert.match(sim.stdout, /Simulación: no se cambió nada/);
    assert.match(sim.stdout, /= master_fade_plans\s+3 filas/);
    assert.ok(await contar('sales') >= 1, 'la simulación no borra');

    const malNombre = await script('scripts/despliegue/limpiar-demo.js', ['--ejecutar', '--confirmar', 'otra_base', '--respaldo', path.join(respaldoDir, 'base.dump')], envDb);
    assert.notEqual(malNombre.code, 0);
    assert.match(malNombre.stderr, /--confirmar debe ser exactamente/);
    const sinRespaldo = await script('scripts/despliegue/limpiar-demo.js', ['--ejecutar', '--confirmar', nombre], envDb);
    assert.notEqual(sinRespaldo.code, 0);
    assert.match(sinRespaldo.stderr, /--respaldo/);
    assert.ok(await contar('sales') >= 1, 'sin confirmación ni respaldo no se borra nada');

    const ok = await script('scripts/despliegue/limpiar-demo.js', ['--ejecutar', '--confirmar', nombre, '--respaldo', path.join(respaldoDir, 'base.dump')], envDb);
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /Listo: 5 tablas borradas/);
    const quedan = (await db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`)).rows.map(r => r.table_name);
    assert.deepEqual(quedan, ['master_fade_plans', 'tabla_ajena']);
    assert.equal(await contar('master_fade_plans'), 3);
  });

  let nueva;
  await t.test('5. primer arranque de la versión nueva como en Render', async () => {
    nueva = await iniciarServidor({ postgres: true, negocio: 'el-master', sesion: false, env: { ...envDb, RENDER: 'true', PLATAFORMA_CLAVE: CLAVE_PLATAFORMA } });
    servidores.push(nueva);
    const salud = (await nueva.pedir('GET', '/api/health', undefined, { cookie: null })).json;
    assert.equal(salud.storage || salud.almacen || salud.agenda?.modo, 'postgres', JSON.stringify(salud));
    assert.equal((await nueva.pedir('GET', '/api/auth/config', undefined, { cookie: null })).json.registrationOpen, false, 'sin correo, registro cerrado');
    const [b] = (await db.query('SELECT id, protected, status FROM businesses')).rows;
    assert.deepEqual(b, { id: 'el-master', protected: true, status: 'active' });
    for (const [tabla, n] of [['users', 0], ['bookings', 0], ['sales', 0], ['products', 0], ['media_assets', 0], ['memberships', 0]]) {
      assert.equal(await contar(tabla), n, tabla);
    }
    assert.equal(await contar('master_fade_plans'), 3, 'el Panel no se tocó');
    const admin1 = await nueva.pedir('GET', '/admin.html', undefined, { cookie: null });
    assert.equal(admin1.status, 302, 'el panel exige iniciar sesión');
  });

  await t.test('6. cuenta del propietario con el script de consola', async () => {
    const r = await script('scripts/cuentas/crear-propietario.js', ['--negocio', 'el-master', '--email', 'dueno@prueba.test', '--nombre', 'Dueño'], { ...envDb, PUBLIC_BASE_URL: 'https://reservas.ejemplo.com' });
    assert.equal(r.code, 0, r.stderr);
    const token = r.stdout.match(/restablecer=([A-Za-z0-9_-]+)/)[1];
    assert.equal((await nueva.pedir('POST', '/api/auth/restablecer', { token, password: CLAVE }, { cookie: null })).status, 200);
    const login = await nueva.pedir('POST', '/api/auth/login', { email: 'dueno@prueba.test', password: CLAVE }, { cookie: null });
    assert.equal(login.status, 200);
    const productos = await nueva.pedir('GET', '/api/admin/products', undefined, { cookie: cookieDe(login) });
    assert.equal(productos.status, 200);
    assert.deepEqual(productos.json.products ?? productos.json, [], 'sin datos de la demostración');
  });

  await t.test('7. con el correo configurado, una barbería se registra por el proceso normal', async () => {
    await nueva.detener();
    const resend = await iniciarResendFalso();
    try {
      nueva = await iniciarServidor({
        postgres: true, negocio: 'el-master', sesion: false,
        env: {
          ...envDb, RENDER: 'true', PLATAFORMA_CLAVE: CLAVE_PLATAFORMA, REGISTRO_ABIERTO: '1',
          RESEND_API_KEY: 're_prueba_no_real', RESEND_API_URL: resend.url, CORREO_REMITENTE: 'Master Fade <no-responder@ejemplo.com>',
          PUBLIC_BASE_URL: 'https://reservas.ejemplo.com'
        }
      });
      servidores.push(nueva);
      assert.equal((await nueva.pedir('GET', '/api/auth/config', undefined, { cookie: null })).json.registrationOpen, true);
      const reg = await nueva.pedir('POST', '/api/auth/registro', { businessName: 'Mi Barbería', name: 'David', email: 'david@prueba.test', password: CLAVE }, { cookie: null });
      assert.equal(reg.status, 201, reg.texto);
      assert.equal(reg.json.emailSent, true);
      const correo = resend.recibidos.map(x => typeof x.cuerpo === 'string' ? JSON.parse(x.cuerpo) : x.cuerpo).find(x => [].concat(x.to).includes('david@prueba.test'));
      const token = correo.html.match(/verificar=([A-Za-z0-9_-]+)/)[1];
      assert.equal((await nueva.pedir('POST', '/api/auth/verificar', { token }, { cookie: null })).status, 200);
      const login = await nueva.pedir('POST', '/api/auth/login', { email: 'david@prueba.test', password: CLAVE }, { cookie: null });
      assert.equal(login.status, 200);
      const sesion = (await nueva.pedir('GET', '/api/auth/sesion', undefined, { cookie: cookieDe(login) })).json;
      assert.equal(sesion.role, 'owner');
      assert.equal(sesion.subscription.status, 'trial');
      assert.equal(sesion.subscription.protected, false);
      assert.ok(sesion.subscription.daysLeft === 7, `7 días de prueba (${sesion.subscription.daysLeft})`);
      const ruta = '/api/plataforma/negocios';
      const lista = await (await fetch(nueva.base + ruta, { headers: cabecerasFirmadas(CLAVE_PLATAFORMA, { metodo: 'GET', ruta }) })).json();
      assert.deepEqual(lista.businesses.map(b => b.id).sort(), ['el-master', reg.json.business.id].sort(), 'el Panel Maestro las verá a las dos');
    } finally {
      await resend.cerrar();
    }
  });

  await t.test('8. reversión: la versión anterior vuelve a arrancar sobre la base nueva', async () => {
    await nueva.detener();
    const prod = await iniciarProduccion(URL_DB);
    servidores.push(prod);
    assert.equal((await prod.pedir('GET', '/api/config')).status, 200);
    assert.equal((await prod.pedir('GET', '/api/public/site')).status, 200);
    const antes = await prod.pedir('POST', '/api/admin/settings', { section: 'pagina', data: { title: 'Vuelta atrás' } });
    if (antes.status !== 200) {
      /* Las claves de la fase 2 se restauran con el script previsto (no borra filas). */
      const r = await ejecutar('psql', [URL_DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', path.join(RAIZ, 'scripts/migracion/revertir-claves-fase2.sql')]).then(() => 0, e => e.stderr);
      assert.equal(r, 0, String(r));
    }
    assert.equal((await prod.pedir('POST', '/api/admin/settings', { section: 'pagina', data: { title: 'Vuelta atrás' } })).status, 200);
    assert.equal(await contar('users'), 2, 'las cuentas de la versión nueva quedan guardadas para volver a ella');
    await prod.detener();
  });
});

/*
  Variante SIN terminal (recomendada para Render sin Shell): la versión nueva
  guarda la demostración en el esquema respaldo_demo en su primer arranque
  (ARCHIVAR_DEMO) y crea la cuenta del propietario desde variables de entorno.
*/
test('ensayo general: instalación limpia sin terminal (ARCHIVAR_DEMO y propietario inicial)', { skip: omitir }, async t => {
  const { lanzarServidor } = require('./apoyo/servidor');
  const sufijo = crypto.randomBytes(4).toString('hex');
  const nombre = `archivar_${sufijo}_test`;
  const admin = crearPool(URL_PG);
  await admin.query(`CREATE DATABASE ${nombre}`);
  const URL_DB = urlDe(nombre);
  const db = crearPool(URL_DB);
  const servidores = [];
  t.after(async () => {
    for (const s of servidores) { await s.detener().catch(() => {}); s.borrar?.(); }
    await db.end();
    await admin.query(`DROP DATABASE IF EXISTS ${nombre} WITH (FORCE)`).catch(() => {});
    await admin.end();
  });
  const contar = async tabla => (await db.query(`SELECT count(*)::int AS n FROM ${tabla}`)).rows[0].n;
  const envNueva = {
    DATABASE_URL: URL_DB, RENDER: 'true', PLATAFORMA_CLAVE: CLAVE_PLATAFORMA, ARCHIVAR_DEMO: nombre,
    PROPIETARIO_INICIAL_EMAIL: 'dueno@prueba.test', PROPIETARIO_INICIAL_CLAVE: CLAVE, PROPIETARIO_INICIAL_NOMBRE: 'Dueño'
  };
  let demo;

  await t.test('producción actual con datos de demostración y el catálogo del Panel en la misma base', async () => {
    const prod = await iniciarProduccion(URL_DB);
    servidores.push(prod);
    assert.equal((await prod.pedir('POST', '/api/admin/settings', { section: 'pagina', data: { title: 'Demo' } })).status, 200);
    assert.equal((await prod.pedir('POST', '/api/admin/products', { name: 'Cera demo', price: 4.5, cost: 2, stock: 10, minStock: 2 })).status, 200);
    const reserva = await prod.pedir('POST', '/api/bookings', { name: 'Cliente Demo', phone: '0991234567', barberId: 'master', serviceIds: ['corte'], date: proximoDia(2), time: '10:00' });
    assert.equal((await prod.pedir('POST', '/api/sales', { bookingId: reserva.json.booking.id, paymentMethod: 'cash', items: [{ type: 'service', id: 'corte', quantity: 1 }] })).status, 200);
    assert.equal((await prod.pedir('POST', '/api/admin/media', { kind: 'barber', ref: 'master', image: PNG_1X1 })).status, 200);
    await prod.detener();
    await db.query(`CREATE TABLE master_fade_plans (id BIGSERIAL PRIMARY KEY, name TEXT UNIQUE, price NUMERIC(10,2), trial_days INT)`);
    await db.query(`INSERT INTO master_fade_plans (name, price, trial_days) VALUES ('Individual', 9.99, 7), ('Pro', 19.99, 7), ('Business', 34.99, 7)`);
    demo = {};
    for (const tbl of ['sales', 'cash_sessions', 'products', 'admin_settings', 'media_assets']) demo[tbl] = await contar(tbl);
    assert.ok(demo.sales >= 1 && demo.products >= 1 && demo.media_assets >= 1 && demo.admin_settings >= 1);
  });

  await t.test('con un nombre de base equivocado, la versión nueva no arranca y no toca nada', async () => {
    const s = await lanzarServidor({ postgres: true, negocio: 'el-master', env: { ...envNueva, ARCHIVAR_DEMO: 'otra_base' } });
    servidores.push(s);
    const codigo = await new Promise(r => (s.proc.exitCode !== null ? r(s.proc.exitCode) : s.proc.once('exit', r)));
    assert.equal(codigo, 1, 'Render la marcaría como fallida y mantendría la anterior');
    assert.match(s.logs.join('\n'), /no coincide con la base conectada/);
    assert.equal(await contar('sales'), demo.sales);
    assert.equal((await db.query(`SELECT to_regnamespace('respaldo_demo') AS e`)).rows[0].e, null);
    assert.equal((await db.query(`SELECT to_regclass('public.businesses') AS t`)).rows[0].t, null, 'no se creó ninguna tabla nueva');
  });

  let nueva;
  await t.test('primer arranque: guarda la demostración, empieza vacía y crea al propietario', async () => {
    nueva = await iniciarServidor({ postgres: true, negocio: 'el-master', sesion: false, env: envNueva });
    servidores.push(nueva);
    const logs = nueva.logs.join('\n');
    assert.match(logs, /ARCHIVAR_DEMO: datos de la demostración guardados en el esquema respaldo_demo/);
    assert.match(logs, /PROPIETARIO INICIAL CREADO para "el-master": d\*\*\*@prueba\.test/);
    assert.ok(!logs.includes(CLAVE), 'la contraseña nunca aparece en los registros');
    for (const [tbl, n] of Object.entries(demo)) {
      assert.equal(await contar(`respaldo_demo.${tbl}`), n, `respaldo_demo.${tbl} conserva sus filas`);
    }
    for (const tbl of ['sales', 'products', 'media_assets', 'cash_sessions', 'bookings']) assert.equal(await contar(tbl), 0, tbl);
    assert.equal(await contar('master_fade_plans'), 3, 'el catálogo del Panel no se tocó');
    const [b] = (await db.query('SELECT id, protected, status FROM businesses')).rows;
    assert.deepEqual(b, { id: 'el-master', protected: true, status: 'active' });
    const login = await nueva.pedir('POST', '/api/auth/login', { email: 'dueno@prueba.test', password: CLAVE }, { cookie: null });
    assert.equal(login.status, 200);
    const sesion = (await nueva.pedir('GET', '/api/auth/sesion', undefined, { cookie: cookieDe(login) })).json;
    assert.deepEqual([sesion.role, sesion.business.id, sesion.subscription.protected], ['owner', 'el-master', true]);
    assert.equal((await nueva.pedir('GET', '/admin.html', undefined, { cookie: null })).status, 302);
  });

  await t.test('los siguientes arranques no repiten nada aunque las variables sigan', async () => {
    await nueva.detener();
    nueva = await iniciarServidor({ postgres: true, negocio: 'el-master', sesion: false, env: { ...envNueva, PROPIETARIO_INICIAL_CLAVE: 'Otra-clave-distinta-9' } });
    servidores.push(nueva);
    const logs = nueva.logs.join('\n');
    assert.match(logs, /la versión nueva ya está instalada en esta base; no se archiva nada/);
    assert.match(logs, /ya tiene propietario; no se hace nada/);
    assert.equal((await nueva.pedir('POST', '/api/auth/login', { email: 'dueno@prueba.test', password: CLAVE }, { cookie: null })).status, 200, 'la contraseña no cambió');
    assert.equal(await contar('respaldo_demo.sales'), demo.sales);
  });

  await t.test('volver atrás: restaurar-demo.sql devuelve la demostración y la versión anterior arranca con ella', async () => {
    await nueva.detener();
    const r = await ejecutar('psql', [URL_DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', path.join(RAIZ, 'scripts/despliegue/restaurar-demo.sql')]).then(() => 0, e => e.stderr);
    assert.equal(r, 0, String(r));
    for (const [tbl, n] of Object.entries(demo)) assert.equal(await contar(`public.${tbl}`), n, tbl);
    assert.equal((await db.query(`SELECT to_regclass('respaldo_nueva.sales') AS t`)).rows[0].t, 'respaldo_nueva.sales', 'lo nuevo se aparta, no se borra');
    const prod = await iniciarProduccion(URL_DB);
    servidores.push(prod);
    const productos = await prod.pedir('GET', '/api/admin/products');
    assert.equal(productos.status, 200);
    assert.ok(JSON.stringify(productos.json).includes('Cera demo'), 'la versión anterior ve su demostración');
  });
});
