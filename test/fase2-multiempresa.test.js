'use strict';
/*
  Fase 2: cada barbería tiene sus propios datos.
  Dos servidores con barberías distintas comparten la misma base de
  pruebas: ninguno puede ver ni modificar lo del otro. Además se
  comprueba que los datos que El Máster ya tenía (antes de business_id)
  se conservan intactos. Requiere TEST_DATABASE_URL.
*/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { iniciarServidor, urlBasePruebas, negocioNuevo, proximoDia, RAIZ } = require('./apoyo/servidor');
const { crearAlmacen } = require('../almacen');

const URL_PG = urlBasePruebas();
const omitir = URL_PG ? false : 'Define TEST_DATABASE_URL con una base de pruebas';
const PNG_ROJO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const PNG_AZUL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==';

function crearPool(url) {
  const sinSsl = new URL(url).searchParams.get('sslmode') === 'disable';
  const pool = new Pool({ connectionString: url, ssl: sinSsl ? false : { rejectUnauthorized: false } });
  /* Al borrar la base temporal, PostgreSQL cierra las conexiones inactivas: no es un error de la prueba. */
  pool.on('error', () => {});
  return pool;
}

test.describe('Fase 2 · aislamiento entre barberías', { skip: omitir }, () => {
  let a;
  let b;
  test.before(async () => {
    a = await iniciarServidor({ postgres: true, negocio: negocioNuevo() });
    b = await iniciarServidor({ postgres: true, negocio: negocioNuevo() });
  });
  test.after(async () => {
    for (const s of [a, b]) if (s) { await s.detener(); s.borrar(); }
  });

  test('productos: B no ve, no edita y no vende los productos de A', async () => {
    const p = await a.pedir('POST', '/api/admin/products', { name: 'Cera de A', price: 5, cost: 2, stock: 3 });
    assert.equal(p.status, 200);
    const id = p.json.product.id;
    const listaB = await b.pedir('GET', '/api/admin/products');
    assert.ok(!(listaB.json.products || listaB.json).some(x => x.id === id));
    assert.equal((await b.pedir('PATCH', `/api/admin/products/${id}`, { price: 1 })).status, 404);
    const venta = await b.pedir('POST', '/api/sales', { paymentMethod: 'cash', items: [{ type: 'product', id, quantity: 1 }] });
    assert.notEqual(venta.status, 200, 'B no puede vender un producto de A');
    const deA = (await a.pedir('GET', '/api/admin/products')).json;
    const prod = (deA.products || deA).find(x => x.id === id);
    assert.equal(Number(prod.price), 5);
    assert.equal(Number(prod.stock), 3, 'el inventario de A no cambia');
  });

  test('configuración y página pública independientes', async () => {
    await a.pedir('POST', '/api/admin/settings', { section: 'pagina', data: { title: 'Título de A' } });
    await b.pedir('POST', '/api/admin/settings', { section: 'pagina', data: { title: 'Título de B' } });
    assert.equal((await a.pedir('GET', '/api/admin/settings')).json.settings.pagina.title, 'Título de A');
    assert.equal((await b.pedir('GET', '/api/admin/settings')).json.settings.pagina.title, 'Título de B');
    assert.equal((await a.pedir('GET', '/api/public/site')).json.page.title, 'Título de A');
    assert.equal((await b.pedir('GET', '/api/public/site')).json.page.title, 'Título de B');
    await a.pedir('PUT', '/api/admin/business', { name: 'Barbería A', phone: '0990000011' });
    assert.notEqual((await b.pedir('GET', '/api/public/site')).json.business.phone, '0990000011');
  });

  test('Elia usa los mensajes de su propia barbería', async () => {
    const mensajes = { enabled: true, welcome: 'Bienvenida de A', closing: 'Cierre de A', cancel: 'Cancelación de A' };
    await a.pedir('POST', '/api/admin/settings', { section: 'mensajes', data: mensajes });
    assert.equal(await a.enviarWhatsApp('hola', '593990002001'), 'Bienvenida de A');
    assert.match(await b.enviarWhatsApp('hola', '593990002001'), /Bienvenido a El Máster/, 'B conserva sus mensajes');
    await b.pedir('POST', '/api/admin/settings', { section: 'mensajes', data: { ...mensajes, enabled: false } });
    assert.equal(await b.enviarWhatsApp('hola', '593990002002'), null, 'Elia desactivada solo en B');
    assert.equal(await a.enviarWhatsApp('hola', '593990002002'), 'Bienvenida de A');
  });

  test('imágenes con el mismo nombre no se mezclan ni se borran entre barberías', async () => {
    assert.equal((await a.pedir('POST', '/api/admin/media', { kind: 'logo', image: PNG_ROJO })).status, 200);
    assert.equal((await b.pedir('POST', '/api/admin/media', { kind: 'logo', image: PNG_AZUL })).status, 200);
    const bytes = async s => Buffer.from(await (await fetch(s.base + '/api/public/media/logo')).arrayBuffer()).toString('base64');
    assert.equal(await bytes(a), PNG_ROJO.split(',')[1]);
    assert.equal(await bytes(b), PNG_AZUL.split(',')[1]);
    assert.equal((await b.pedir('DELETE', '/api/admin/media/logo')).json.deleted, 1);
    assert.equal((await fetch(b.base + '/api/public/media/logo')).status, 404);
    assert.equal(await bytes(a), PNG_ROJO.split(',')[1], 'el logo de A sigue');
    assert.equal((await a.pedir('GET', '/api/admin/media')).json.media.filter(m => m.id === 'logo').length, 1);
  });

  test('ventas, caja y reportes separados', async () => {
    const reserva = await a.pedir('POST', '/api/bookings', { name: 'Cliente A', phone: '0990002003', barberId: 'master', serviceIds: ['corte'], date: proximoDia(3), time: '10:00' });
    const v = await a.pedir('POST', '/api/sales', { bookingId: reserva.json.booking.id, paymentMethod: 'cash', items: [{ type: 'service', id: 'corte', quantity: 1 }] });
    assert.equal(v.status, 200, v.texto);
    const cajaA = (await a.pedir('GET', '/api/cash/today')).json;
    const cajaB = (await b.pedir('GET', '/api/cash/today')).json;
    assert.equal(cajaA.summary.total_sales, 1, 'A ve su venta');
    assert.equal(cajaA.summary.total_income, 5);
    assert.equal(cajaB.summary.total_sales, 0, 'B no ve las ventas de A');
    assert.equal(cajaB.summary.total_income, 0);

    const cierreB = await b.pedir('POST', '/api/cash/close', {});
    assert.equal(cierreB.status, 200, cierreB.texto);
    const otraVentaA = await a.pedir('POST', '/api/sales', { paymentMethod: 'cash', items: [{ type: 'service', id: 'barba', quantity: 1 }] });
    assert.equal(otraVentaA.status, 200, 'cerrar la caja de B no cierra la de A');
    assert.equal((await b.pedir('POST', '/api/sales', { paymentMethod: 'cash', items: [{ type: 'service', id: 'barba', quantity: 1 }] })).status, 409, 'la caja de B sí quedó cerrada');

    const hoy = new Date().toISOString().slice(0, 10);
    const repA = (await a.pedir('GET', `/api/admin/reports?from=${hoy}&to=${hoy}`)).json;
    const repB = (await b.pedir('GET', `/api/admin/reports?from=${hoy}&to=${hoy}`)).json;
    assert.equal(repA.summary.sales, 2);
    assert.equal(repA.summary.totalIncome, 7);
    assert.equal(repB.summary.sales, 0);
  });

  test('el respaldo de cada barbería solo contiene sus datos', async () => {
    await a.pedir('POST', '/api/admin/barbers', { name: 'Solo de A' });
    const ra = await a.datos();
    const rb = await b.datos();
    assert.ok(ra.barbers.some(x => x.name === 'Solo de A'));
    assert.ok(!rb.barbers.some(x => x.name === 'Solo de A'));
    assert.equal(ra.settings.pagina.title, 'Título de A');
    assert.equal(rb.settings.pagina.title, 'Título de B');
    assert.ok(ra.bookings.every(x => x.name !== 'Cliente B'));
  });
});

test.describe('Fase 2 · datos existentes de El Máster', { skip: omitir }, () => {
  /* Base aparte con las tablas tal como las crea la versión actual en producción (sin business_id). */
  const nombre = new URL(URL_PG).pathname.slice(1) + '_legado';
  const urlLegado = (() => { const u = new URL(URL_PG); u.pathname = '/' + nombre; return u.toString(); })();
  let admin;
  let legado;

  test.before(async () => {
    admin = crearPool(URL_PG);
    await admin.query(`DROP DATABASE IF EXISTS ${nombre}`);
    await admin.query(`CREATE DATABASE ${nombre}`);
    legado = crearPool(urlLegado);
    await legado.query(`
      CREATE TABLE sales (id BIGSERIAL PRIMARY KEY, booking_id TEXT, customer_name TEXT, customer_phone TEXT,
        items JSONB NOT NULL DEFAULT '[]'::jsonb, total NUMERIC(10,2) NOT NULL DEFAULT 0, payment_method TEXT NOT NULL,
        transfer_receipt TEXT, note TEXT, status TEXT NOT NULL DEFAULT 'paid', sale_date DATE NOT NULL DEFAULT CURRENT_DATE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      CREATE TABLE cash_sessions (id BIGSERIAL PRIMARY KEY, session_date DATE NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'open',
        opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), closed_at TIMESTAMPTZ, closing_total NUMERIC(10,2));
      CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT NOT NULL, price NUMERIC(10,2) NOT NULL DEFAULT 0,
        cost NUMERIC(10,2) NOT NULL DEFAULT 0, stock INTEGER NOT NULL DEFAULT 0, min_stock INTEGER NOT NULL DEFAULT 2,
        active BOOLEAN NOT NULL DEFAULT TRUE, image_url TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      CREATE TABLE admin_settings (section TEXT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      CREATE TABLE media_assets (id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
      INSERT INTO products (id, name, price, stock) VALUES ('product_real', 'Cera real', 6.5, 12);
      INSERT INTO admin_settings (section, data) VALUES
        ('pagina', '{"title":"Página real"}'), ('mensajes', '{"enabled":true,"welcome":"Hola real","closing":"Adiós real","cancel":"Cancelado real"}');
      INSERT INTO media_assets (id, kind, data) VALUES ('logo', 'logo', '${PNG_ROJO}');
      INSERT INTO sales (booking_id, items, total, payment_method, sale_date)
        VALUES ('BK-real', '[{"type":"product","id":"product_real","quantity":1}]', 6.5, 'cash', CURRENT_DATE - 1);
      INSERT INTO cash_sessions (session_date, status, closing_total) VALUES (CURRENT_DATE - 1, 'closed', 6.5);
    `);
  });

  test.after(async () => {
    if (legado) await legado.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${nombre} WITH (FORCE)`).catch(() => {});
      await admin.end();
    }
  });

  test('al arrancar se asignan a El Máster, se cambian las claves y no se pierde nada', async () => {
    const antes = {};
    for (const t of ['sales', 'cash_sessions', 'products', 'admin_settings', 'media_assets']) {
      antes[t] = (await legado.query(`SELECT * FROM ${t} ORDER BY 1`)).rows;
    }
    const anterior = process.env.TEST_DATABASE_URL;
    process.env.TEST_DATABASE_URL = urlLegado;
    let s;
    try {
      s = await iniciarServidor({ postgres: true, negocio: 'el-master' });
      for (const t of Object.keys(antes)) {
        const ahora = (await legado.query(`SELECT * FROM ${t} ORDER BY 1`)).rows;
        assert.equal(ahora.length, antes[t].length, `${t}: mismas filas`);
        ahora.forEach((fila, i) => {
          assert.equal(fila.business_id, 'el-master', `${t}: asignada a El Máster`);
          const { business_id, ...resto } = fila;
          assert.deepEqual(resto, antes[t][i], `${t}: contenido intacto`);
        });
      }
      const pk = async t => (await legado.query(
        `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'p'`, [t])).rows[0].d;
      assert.equal(await pk('admin_settings'), 'PRIMARY KEY (business_id, section)');
      assert.equal(await pk('media_assets'), 'PRIMARY KEY (business_id, id)');
      const unicos = (await legado.query(
        `SELECT indexdef FROM pg_indexes WHERE tablename = 'cash_sessions' AND indexdef LIKE '%UNIQUE%'`)).rows.map(r => r.indexdef);
      assert.ok(unicos.some(d => d.includes('(business_id, session_date)')));
      assert.ok(!unicos.some(d => /\(session_date\)/.test(d)), 'ya no hay una sola caja por día para todas');

      /* Las funciones siguen viendo los datos reales. */
      const prods = (await s.pedir('GET', '/api/admin/products')).json;
      assert.equal((prods.products || prods).find(p => p.id === 'product_real').name, 'Cera real');
      assert.equal((await s.pedir('GET', '/api/admin/settings')).json.settings.pagina.title, 'Página real');
      assert.equal(await s.enviarWhatsApp('hola', '593990003001'), 'Hola real');
      assert.equal((await fetch(s.base + '/api/public/media/logo')).status, 200);
      const ayer = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const rep = (await s.pedir('GET', `/api/admin/reports?from=${ayer}&to=${ayer}`)).json;
      assert.ok(JSON.stringify(rep).includes('6.5'), 'el reporte incluye la venta real');

      /* El cambio de claves se puede revertir (para volver a la versión anterior) y repetir. */
      await s.detener();
      await legado.query(fs.readFileSync(path.join(RAIZ, 'scripts/migracion/revertir-claves-fase2.sql'), 'utf8'));
      assert.equal(await pk('admin_settings'), 'PRIMARY KEY (section)');
      assert.equal(await pk('media_assets'), 'PRIMARY KEY (id)');
      s.borrar();
      s = await iniciarServidor({ postgres: true, negocio: 'el-master' });
      assert.equal(await pk('admin_settings'), 'PRIMARY KEY (business_id, section)');
      assert.equal((await s.pedir('GET', '/api/admin/settings')).json.settings.pagina.title, 'Página real');

      /* Un segundo arranque no vuelve a tocar nada. */
      s = await (async () => { await s.detener(); s.borrar(); return iniciarServidor({ postgres: true, negocio: 'el-master' }); })();
      assert.equal((await legado.query('SELECT count(*)::int AS n FROM products')).rows[0].n, 1);
    } finally {
      if (s) { await s.detener(); s.borrar(); }
      process.env.TEST_DATABASE_URL = anterior;
    }
  });
});

test.describe('Fase 2 · registro de barberías y Panel Maestro', { skip: omitir }, () => {
  let pool;
  let almacen;
  test.before(async () => {
    pool = crearPool(URL_PG);
    const archivo = path.join(RAIZ, 'data', 'db.json');
    almacen = crearAlmacen({
      modo: 'postgres', pool, archivo, negocio: negocioNuevo(),
      datosIniciales: () => JSON.parse(fs.readFileSync(archivo, 'utf8')),
      intervalos: () => [], registro: { log() {}, error() {} }
    });
    await almacen.iniciar();
  });
  test.after(() => pool.end());

  test('crear una barbería nueva: agenda propia vacía y evento para el Panel Maestro', async () => {
    const id = negocioNuevo();
    const creada = await almacen.crearNegocio({ id, name: 'Barbería Nueva', country: 'MX', currency: 'MXN', locale: 'es-MX', timezone: 'America/Mexico_City', plan: 'Pro', contactEmail: 'dueno@example.com' });
    assert.equal(creada.status, 'trial');
    assert.equal(creada.currency, 'MXN');
    const ev = (await pool.query(`SELECT type, payload, delivered_at FROM platform_events WHERE business_id = $1`, [id])).rows;
    assert.equal(ev.length, 1);
    assert.equal(ev[0].type, 'business.created');
    assert.equal(ev[0].payload.name, 'Barbería Nueva');
    assert.equal(ev[0].delivered_at, null, 'pendiente de entregar al Panel Maestro');

    await almacen.cargarNegocio(id);
    const db = almacen.leer(id);
    assert.deepEqual(db.barbers, []);
    assert.deepEqual(db.bookings, []);
    assert.ok(db.services.length > 0);
    assert.equal(db.business.name, 'Barbería Nueva');

    const s = await iniciarServidor({ postgres: true, negocio: id });
    try {
      const site = (await s.pedir('GET', '/api/public/site')).json;
      assert.equal(site.business.name, 'Barbería Nueva');
      assert.deepEqual(site.barbers, []);
      assert.equal((await s.pedir('GET', '/api/admin/products')).json.products?.length ?? 0, 0);
    } finally {
      await s.detener();
      s.borrar();
    }
  });

  test('no se pueden repetir id ni dirección pública, y los datos no válidos se rechazan', async () => {
    const id = negocioNuevo();
    await almacen.crearNegocio({ id, name: 'Única' });
    await assert.rejects(almacen.crearNegocio({ id, name: 'Otra' }), /Ya existe/);
    await assert.rejects(almacen.crearNegocio({ id: negocioNuevo(), slug: id, name: 'Otra' }), /Ya existe/);
    await assert.rejects(almacen.crearNegocio({ id: 'Con Espacios', name: 'X' }), /no válido/);
    await assert.rejects(almacen.crearNegocio({ id: negocioNuevo(), name: '' }), /nombre/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM businesses WHERE id = $1', [id])).rows[0].n, 1);
  });

  test('la lista para el Panel Maestro incluye todas las barberías con sus totales', async () => {
    const lista = await almacen.listarNegocios();
    assert.ok(lista.length >= 2);
    for (const n of lista) {
      assert.ok(n.id && n.name && n.timezone && n.currency);
      assert.equal(typeof n.barbers, 'number');
      assert.equal(typeof n.bookings, 'number');
    }
    const pendientes = (await pool.query(
      `SELECT count(*)::int AS n FROM businesses b WHERE NOT EXISTS
       (SELECT 1 FROM platform_events e WHERE e.business_id = b.id AND e.type = 'business.created')`)).rows[0].n;
    assert.equal(pendientes, 0, 'toda barbería tiene su evento de alta');
  });

  test('la memoria de una barbería no se mezcla con la de otra', async () => {
    const [x, y] = [negocioNuevo(), negocioNuevo()];
    await almacen.crearNegocio({ id: x, name: 'X' });
    await almacen.crearNegocio({ id: y, name: 'Y' });
    await almacen.cargarNegocio(x);
    await almacen.cargarNegocio(y);
    const dx = almacen.leer(x);
    dx.barbers.push({ id: 'solo-x', name: 'Solo X', active: true });
    await almacen.guardar(dx, x);
    assert.ok(almacen.leer(x).barbers.some(b => b.id === 'solo-x'));
    assert.ok(!almacen.leer(y).barbers.some(b => b.id === 'solo-x'));
    const filas = (await pool.query(`SELECT business_id FROM barbers WHERE id = 'solo-x' AND business_id = ANY($1)`, [[x, y]])).rows;
    assert.deepEqual(filas.map(f => f.business_id), [x]);
  });
});
