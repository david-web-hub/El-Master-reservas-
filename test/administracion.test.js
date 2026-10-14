'use strict';
/* Barberos, horarios y servicios del panel. Solo usa data/db.json (copia temporal). */
const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciarServidor, proximoDia } = require('./apoyo/servidor');

const LUNES = proximoDia(1);
const SABADO = proximoDia(6);

let s;
test.before(async () => { s = await iniciarServidor(); });
test.after(async () => { await s.detener(); s.borrar(); });

function semana(cambios = {}) {
  const h = {};
  for (let d = 0; d < 7; d++) {
    h[d] = d === 0
      ? { open: false, from: '08:00', to: '19:00', breakFrom: '', breakTo: '' }
      : { open: true, from: '08:00', to: '19:00', breakFrom: '12:00', breakTo: '13:30' };
  }
  return { ...h, ...cambios };
}

test('crear, editar y desactivar un barbero', async () => {
  const c = await s.pedir('POST', '/api/admin/barbers', { name: 'Barbero Prueba', phone: '0990000010', description: 'Fades', serviceIds: ['corte', 'barba'] });
  assert.equal(c.status, 201);
  const id = c.json.barber.id;
  assert.match(id, /^barber_/);
  assert.equal(c.json.barber.active, true);
  assert.equal(c.json.barber.acceptsBookings, true);

  const lista = await s.pedir('GET', '/api/admin/barbers');
  assert.ok(lista.json.barbers.some(b => b.id === id && b.name === 'Barbero Prueba'));

  const e = await s.pedir('PATCH', `/api/admin/barbers/${id}`, { name: 'Barbero Editado', acceptsBookings: false });
  assert.equal(e.status, 200);
  assert.equal(e.json.barber.name, 'Barbero Editado');
  assert.equal(typeof e.json.upcomingBookings, 'number');

  const disp = await s.pedir('GET', `/api/availability?date=${LUNES}&barberId=${id}&serviceIds=corte`);
  assert.deepEqual(disp.json.slots ?? [], [], 'sin reservas si no acepta reservas');

  await s.pedir('PATCH', `/api/admin/barbers/${id}`, { active: false });
  const pub = await s.pedir('GET', '/api/public/site');
  assert.ok(!pub.json.barbers.some(b => b.id === id), 'inactivo no aparece en la web');
  assert.ok((await s.datos()).barbers.some(b => b.id === id), 'nunca se borra');
});

test('barbero valida datos', async () => {
  assert.equal((await s.pedir('POST', '/api/admin/barbers', { name: '' })).status, 400);
  assert.equal((await s.pedir('POST', '/api/admin/barbers', { name: 'X', serviceIds: ['no-existe'] })).status, 400);
  assert.equal((await s.pedir('PATCH', '/api/admin/barbers/no-existe', { name: 'X' })).status, 404);
});

test('el barbero solo ofrece sus servicios', async () => {
  const c = await s.pedir('POST', '/api/admin/barbers', { name: 'Solo Barba', serviceIds: ['barba'] });
  const id = c.json.barber.id;
  const no = await s.pedir('GET', `/api/availability?date=${LUNES}&barberId=${id}&serviceIds=corte`);
  assert.equal(no.status, 400);
  const si = await s.pedir('GET', `/api/availability?date=${LUNES}&barberId=${id}&serviceIds=barba`);
  assert.equal(si.status, 200);
});

test('horarios: guardar, leer y aplicar a la disponibilidad', async () => {
  const antes = await s.pedir('GET', '/api/admin/hours');
  assert.equal(antes.status, 200);
  assert.equal(antes.json.custom, false);

  const nuevo = semana({ 6: { open: true, from: '09:00', to: '14:00', breakFrom: '', breakTo: '' } });
  const g = await s.pedir('PUT', '/api/admin/hours', { hours: nuevo });
  assert.equal(g.status, 200);

  const despues = await s.pedir('GET', '/api/admin/hours');
  assert.equal(despues.json.custom, true);
  assert.deepEqual(despues.json.hours['6'], { open: true, from: '09:00', to: '14:00', breakFrom: '', breakTo: '' });

  const db = (await s.datos());
  assert.deepEqual(db.hours['6'], [['09:00', '14:00']]);
  assert.deepEqual(db.hours['1'], [['08:00', '12:00'], ['13:30', '19:00']]);

  const disp = await s.pedir('GET', `/api/availability?date=${SABADO}&barberId=master&serviceIds=corte`);
  assert.equal(disp.json.slots[0], '09:00');
  assert.equal(disp.json.slots.at(-1), '13:20');

  const cerrar = await s.pedir('PUT', '/api/admin/hours', { hours: semana({ 6: { open: false } }) });
  assert.equal(cerrar.status, 200);
  const sab = await s.pedir('GET', `/api/availability?date=${SABADO}&barberId=master&serviceIds=corte`);
  assert.deepEqual(sab.json.slots, [], 'día libre');
});

test('horarios rechazan valores no válidos', async () => {
  assert.equal((await s.pedir('PUT', '/api/admin/hours', {})).status, 400);
  assert.equal((await s.pedir('PUT', '/api/admin/hours', { hours: semana({ 2: { open: true, from: '19:00', to: '08:00' } }) })).status, 400);
  assert.equal((await s.pedir('PUT', '/api/admin/hours', { hours: semana({ 2: { open: true, from: '08:00', to: '19:00', breakFrom: '20:00', breakTo: '21:00' } }) })).status, 400);
});

test('crear y editar servicios', async () => {
  const c = await s.pedir('POST', '/api/admin/services', { name: 'Cejas', price: 1, duration: 10 });
  assert.equal(c.status, 200);
  const id = c.json.service.id;
  assert.equal(c.json.service.bookingEnabled, true);
  const e = await s.pedir('PATCH', `/api/admin/services/${id}`, { name: 'Cejas premium', price: 2 });
  assert.equal(e.status, 200);
  const lista = await s.pedir('GET', '/api/admin/services');
  const guardado = (lista.json.services || lista.json).find(x => x.id === id);
  assert.equal(guardado.name, 'Cejas premium');
  assert.equal(Number(guardado.price), 2);
  assert.equal((await s.pedir('POST', '/api/admin/services', { name: 'X', price: -1, duration: 10 })).status, 400);
  assert.equal((await s.pedir('POST', '/api/admin/services', { name: 'X', price: 1, duration: 0 })).status, 400);
});
