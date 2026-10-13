'use strict';
/*
  Funciones que usan PostgreSQL: configuración (incluida Elia), productos,
  ventas, caja, reportes, imágenes y salud. Se omiten si no hay
  TEST_DATABASE_URL. Nunca usar la base de producción (ver test/apoyo/servidor.js).
*/
const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciarServidor, urlBasePruebas, proximoDia } = require('./apoyo/servidor');

const omitir = urlBasePruebas() ? false : 'Define TEST_DATABASE_URL con una base de pruebas';
const PNG_1X1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test.describe('PostgreSQL', { skip: omitir }, () => {
  let s;
  test.before(async () => { s = await iniciarServidor({ postgres: true }); });
  test.after(async () => { if (s) { await s.detener(); s.borrar(); } });

  test('salud informa la base conectada', async () => {
    const r = await s.pedir('GET', '/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.json.database, 'connected');
  });

  test('configuración por secciones se guarda y se lee', async () => {
    const g = await s.pedir('POST', '/api/admin/settings', { section: 'pagina', data: { title: 'Título prueba', slogan: 'Eslogan prueba' } });
    assert.equal(g.status, 200);
    const l = await s.pedir('GET', '/api/admin/settings');
    assert.equal(l.json.settings.pagina.title, 'Título prueba');
    const pub = await s.pedir('GET', '/api/public/site');
    assert.equal(pub.json.page.title, 'Título prueba');
    assert.equal((await s.pedir('POST', '/api/admin/settings', { data: {} })).status, 400);
  });

  test('datos del negocio se guardan en PostgreSQL y en la agenda', async () => {
    const r = await s.pedir('PUT', '/api/admin/business', { name: 'El Máster', phone: '0990000300', address: 'Dirección prueba' });
    assert.equal(r.status, 200);
    const l = await s.pedir('GET', '/api/admin/settings');
    assert.equal(l.json.settings.negocio.phone, '0990000300');
    assert.equal(s.leerDb().business.phone, '0990000300');
    assert.equal((await s.pedir('PUT', '/api/admin/business', { name: '' })).status, 400);
  });

  test('mensajes personalizados de Elia se aplican y se pueden desactivar', async () => {
    const mensajes = { enabled: true, welcome: 'Bienvenida de prueba', closing: 'Cierre de prueba', cancel: 'Cancelación de prueba' };
    assert.equal((await s.pedir('POST', '/api/admin/settings', { section: 'mensajes', data: mensajes })).status, 200);
    assert.equal(await s.enviarWhatsApp('hola', '593990000301'), 'Bienvenida de prueba');
    assert.equal(await s.enviarWhatsApp('gracias', '593990000301'), 'Cierre de prueba');

    await s.pedir('POST', '/api/admin/settings', { section: 'mensajes', data: { ...mensajes, enabled: false } });
    assert.equal(await s.enviarWhatsApp('hola', '593990000302'), null, 'Elia desactivada no responde');

    await s.pedir('POST', '/api/admin/settings', { section: 'mensajes', data: { ...mensajes, enabled: true } });
  });

  test('productos: crear, editar y listar', async () => {
    const c = await s.pedir('POST', '/api/admin/products', { name: 'Cera prueba', price: 4.5, cost: 2, stock: 10, minStock: 2 });
    assert.equal(c.status, 200);
    const id = c.json.product.id;
    const e = await s.pedir('PATCH', `/api/admin/products/${id}`, { price: 5 });
    assert.equal(e.status, 200);
    const l = await s.pedir('GET', '/api/admin/products');
    const p = (l.json.products || l.json).find(x => x.id === id);
    assert.equal(Number(p.price), 5);
    assert.equal((await s.pedir('POST', '/api/admin/products', { name: '', price: 1 })).status, 400);
  });

  test('venta de una reserva: total recalculado, reserva pagada y sin cobro doble', async () => {
    const reserva = await s.pedir('POST', '/api/bookings', { name: 'Cliente Venta', phone: '0990000302', barberId: 'master', serviceIds: ['corte'], date: proximoDia(2), time: '10:00' });
    const bookingId = reserva.json.booking.id;
    const antes = (await s.pedir('GET', '/api/cash/today')).json;

    const venta = await s.pedir('POST', '/api/sales', { bookingId, paymentMethod: 'cash', items: [{ type: 'service', id: 'corte', quantity: 1, price: 999 }] });
    assert.equal(venta.status, 200, venta.texto);
    assert.equal(Number(venta.json.sale.total), 5, 'el servidor usa el precio del catálogo');

    const b = s.leerDb().bookings.find(x => x.id === bookingId);
    assert.equal(b.status, 'completed');
    assert.equal(b.paymentStatus, 'paid');

    const doble = await s.pedir('POST', '/api/sales', { bookingId, paymentMethod: 'cash', items: [{ type: 'service', id: 'corte', quantity: 1 }] });
    assert.equal(doble.status, 409);

    const despues = (await s.pedir('GET', '/api/cash/today')).json;
    assert.ok(JSON.stringify(despues) !== JSON.stringify(antes), 'la caja del día refleja la venta');

    assert.equal((await s.pedir('POST', '/api/sales', { paymentMethod: 'bitcoin', items: [{ type: 'service', id: 'corte' }] })).status, 400);
    assert.equal((await s.pedir('POST', '/api/sales', { paymentMethod: 'transfer', items: [{ type: 'service', id: 'corte' }] })).status, 400, 'transferencia exige comprobante');
  });

  test('reportes por rango de fechas', async () => {
    const hoy = new Date().toISOString().slice(0, 10);
    const r = await s.pedir('GET', `/api/admin/reports?from=${hoy}&to=${hoy}`);
    assert.equal(r.status, 200);
    assert.equal((await s.pedir('GET', '/api/admin/reports?from=x&to=y')).status, 400);
  });

  test('imágenes: subir, servir y eliminar sin tocar barberos', async () => {
    const sub = await s.pedir('POST', '/api/admin/media', { kind: 'barber', ref: 'master', image: PNG_1X1 });
    assert.equal(sub.status, 200);
    assert.equal(sub.json.id, 'barber_master');
    const img = await fetch(s.base + '/api/public/media/barber_master');
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    const pub = await s.pedir('GET', '/api/public/site');
    assert.match(pub.json.barbers.find(b => b.id === 'master').photo, /barber_master/);
    const del = await s.pedir('DELETE', '/api/admin/media/barber_master');
    assert.equal(del.json.deleted, 1);
    assert.ok(s.leerDb().barbers.some(b => b.id === 'master'));
  });

  test('respaldo administrativo incluye agenda y configuración', async () => {
    const r = await s.pedir('GET', '/api/admin/backup');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /el-master-respaldo-/);
    for (const k of ['business', 'barbers', 'services', 'schedule', 'hoursConfig', 'bookings', 'settings']) {
      assert.ok(k in r.json, `falta ${k}`);
    }
  });
});
