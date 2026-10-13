'use strict';
/* Reservas web, disponibilidad y estados. Solo usa data/db.json (copiado a una carpeta temporal). */
const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciarServidor, proximoDia } = require('./apoyo/servidor');

const LUNES = proximoDia(1);
const DOMINGO = proximoDia(0);

let s;
test.before(async () => { s = await iniciarServidor(); });
test.after(async () => { await s.detener(); s.borrar(); });

test('GET /api/config devuelve negocio, barberos, servicios y horario', async () => {
  const r = await s.pedir('GET', '/api/config');
  assert.equal(r.status, 200);
  assert.equal(r.json.business.name, 'El Máster');
  assert.ok(r.json.barbers.some(b => b.id === 'master'));
  assert.deepEqual(r.json.services.map(x => x.id),
    ['corte', 'barba', 'diseno', 'corte-barba', 'corte-diseno', 'corte-barba-diseno']);
});

test('GET /api/public/site responde aunque PostgreSQL no esté disponible', async () => {
  const r = await s.pedir('GET', '/api/public/site');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.business.name, 'El Máster');
  assert.equal(r.json.hours['0'].open, false, 'domingo cerrado');
  assert.deepEqual(r.json.hours['1'], { open: true, from: '08:00', to: '19:00', breakFrom: '12:00', breakTo: '13:30' });
});

test('disponibilidad respeta horario, descanso y duración del servicio', async () => {
  const r = await s.pedir('GET', `/api/availability?date=${LUNES}&barberId=master&serviceIds=corte`);
  assert.equal(r.status, 200);
  assert.equal(r.json.duration, 40);
  assert.equal(r.json.slots[0], '08:00');
  assert.ok(r.json.slots.includes('11:20'), 'corte de 40 min termina justo a las 12:00');
  assert.ok(!r.json.slots.includes('11:25'), 'no invade el descanso');
  assert.ok(!r.json.slots.includes('12:30'), 'descanso 12:00-13:30');
  assert.ok(r.json.slots.includes('13:30'));
  assert.equal(r.json.slots.at(-1), '18:20');

  const varios = await s.pedir('GET', `/api/availability?date=${LUNES}&barberId=master&serviceIds=corte,barba`);
  assert.equal(varios.json.duration, 60);

  const dom = await s.pedir('GET', `/api/availability?date=${DOMINGO}&barberId=master&serviceIds=corte`);
  assert.deepEqual(dom.json.slots, []);
});

test('disponibilidad valida parámetros', async () => {
  assert.equal((await s.pedir('GET', '/api/availability?date=2026-02-30&barberId=master&serviceIds=corte')).status, 400);
  assert.equal((await s.pedir('GET', `/api/availability?date=${LUNES}&barberId=master`)).status, 400);
  assert.equal((await s.pedir('GET', `/api/availability?date=${LUNES}&barberId=nadie&serviceIds=corte`)).status, 404);
});

test('crear reserva web, bloquear el horario y rechazar solapamientos', async () => {
  const datos = { name: 'Cliente Prueba', phone: '0990000001', barberId: 'master', serviceIds: ['corte'], date: LUNES, time: '09:00' };
  const r = await s.pedir('POST', '/api/bookings', datos);
  assert.equal(r.status, 201);
  const b = r.json.booking;
  assert.match(b.id, /^BK-\d+$/);
  assert.equal(b.name, 'Cliente Prueba');
  assert.equal(b.phone, '0990000001');
  assert.equal(b.barberId, 'master');
  assert.deepEqual(b.serviceIds, ['corte']);
  assert.equal(b.date, LUNES);
  assert.equal(b.time, '09:00');
  assert.equal(b.endTime, '09:40');
  assert.equal(b.status, 'confirmed');
  assert.equal(b.source, 'web');

  const lista = await s.pedir('GET', '/api/bookings');
  assert.ok(lista.json.some(x => x.id === b.id));

  const disp = await s.pedir('GET', `/api/availability?date=${LUNES}&barberId=master&serviceIds=corte`);
  for (const t of ['08:25', '09:00', '09:35']) assert.ok(!disp.json.slots.includes(t), `${t} debe estar ocupado`);
  assert.ok(disp.json.slots.includes('08:20'));
  assert.ok(disp.json.slots.includes('09:40'));

  const mismo = await s.pedir('POST', '/api/bookings', { ...datos, name: 'Otro Cliente' });
  assert.equal(mismo.status, 409);
  const solapa = await s.pedir('POST', '/api/bookings', { ...datos, name: 'Otro Cliente', time: '09:20' });
  assert.equal(solapa.status, 409);

  assert.equal(s.leerDb().bookings.filter(x => x.date === LUNES && x.time === '09:00').length, 1, 'sin duplicados');
});

test('crear reserva valida datos', async () => {
  const base = { name: 'Cliente', phone: '0990000002', barberId: 'master', serviceIds: ['barba'], date: LUNES, time: '15:00' };
  assert.equal((await s.pedir('POST', '/api/bookings', { ...base, name: 'A' })).status, 400);
  assert.equal((await s.pedir('POST', '/api/bookings', { ...base, phone: 'abc' })).status, 400);
  assert.equal((await s.pedir('POST', '/api/bookings', { ...base, time: '25:00' })).status, 400);
  assert.equal((await s.pedir('POST', '/api/bookings', { ...base, date: '2020-01-06' })).status, 400);
  assert.equal((await s.pedir('POST', '/api/bookings', { ...base, serviceIds: ['no-existe'] })).status, 400);
  assert.equal((await s.pedir('POST', '/api/bookings', { ...base, time: '12:30' })).status, 409, 'dentro del descanso');
});

test('cambiar estado de una reserva y cancelarla libera el horario', async () => {
  const r = await s.pedir('POST', '/api/bookings', { name: 'Estado Prueba', phone: '0990000003', barberId: 'master', serviceIds: ['corte'], date: LUNES, time: '16:00' });
  const id = r.json.booking.id;

  for (const status of ['pending', 'in_progress', 'confirmed']) {
    const p = await s.pedir('PATCH', `/api/bookings/${id}`, { status });
    assert.equal(p.status, 200);
    assert.equal(p.json.booking.status, status);
  }
  assert.equal((await s.pedir('PATCH', `/api/bookings/${id}`, { status: 'inventado' })).status, 400);
  assert.equal((await s.pedir('PATCH', '/api/bookings/BK-0', { status: 'cancelled' })).status, 404);

  const c = await s.pedir('PATCH', `/api/bookings/${id}`, { status: 'cancelled' });
  assert.equal(c.json.booking.status, 'cancelled');
  assert.ok(c.json.booking.updatedAt);
  const guardada = s.leerDb().bookings.find(x => x.id === id);
  assert.equal(guardada.status, 'cancelled', 'el cambio queda escrito');

  const disp = await s.pedir('GET', `/api/availability?date=${LUNES}&barberId=master&serviceIds=corte`);
  assert.ok(disp.json.slots.includes('16:00'), 'una reserva cancelada no bloquea');
});
