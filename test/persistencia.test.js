'use strict';
/*
  Persistencia de la información.

  "Reiniciar" = el mismo proceso vuelve a arrancar sobre la misma carpeta.
  "Despliegue limpio" = el servidor arranca desde una copia nueva del
  repositorio, que es lo que ocurre en un hosting con disco efímero
  (por ejemplo, un servicio web de Render sin disco persistente).
  Solo PostgreSQL conserva los datos en ese caso.
*/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { iniciarServidor, reiniciar, urlBasePruebas, negocioNuevo, proximoDia } = require('./apoyo/servidor');

const LUNES = proximoDia(1);
const sinPostgres = urlBasePruebas() ? false : 'Requiere TEST_DATABASE_URL (PostgreSQL de pruebas)';

async function crearDatos(s) {
  const barbero = await s.pedir('POST', '/api/admin/barbers', { name: 'Barbero Persistente' });
  assert.equal(barbero.status, 201);
  const horas = await s.pedir('GET', '/api/admin/hours');
  const semana = horas.json.hours;
  semana['6'] = { open: true, from: '09:00', to: '13:00', breakFrom: '', breakTo: '' };
  assert.equal((await s.pedir('PUT', '/api/admin/hours', { hours: semana })).status, 200);
  const servicio = await s.pedir('POST', '/api/admin/services', { name: 'Servicio Persistente', price: 3, duration: 30 });
  assert.equal(servicio.status, 200);
  const reserva = await s.pedir('POST', '/api/bookings', { name: 'Cliente Persistente', phone: '0990000201', barberId: 'master', serviceIds: ['corte'], date: LUNES, time: '08:00' });
  assert.equal(reserva.status, 201);
  const cancelada = await s.pedir('POST', '/api/bookings', { name: 'Cliente Cancela', phone: '0990000202', barberId: 'master', serviceIds: ['barba'], date: LUNES, time: '10:00' });
  assert.equal((await s.pedir('PATCH', `/api/bookings/${cancelada.json.booking.id}`, { status: 'cancelled' })).status, 200);
  return {
    barberId: barbero.json.barber.id,
    serviceId: servicio.json.service.id,
    bookingId: reserva.json.booking.id,
    canceladaId: cancelada.json.booking.id
  };
}

async function comprobarDatos(s, ids) {
  const barberos = await s.pedir('GET', '/api/admin/barbers');
  assert.ok(barberos.json.barbers.some(b => b.id === ids.barberId), 'el barbero sigue registrado');
  const horas = await s.pedir('GET', '/api/admin/hours');
  assert.equal(horas.json.hours['6'].to, '13:00', 'el horario sigue guardado');
  const servicios = await s.pedir('GET', '/api/admin/services');
  assert.ok((servicios.json.services || servicios.json).some(x => x.id === ids.serviceId), 'el servicio sigue registrado');
  const reservas = await s.pedir('GET', '/api/bookings');
  const r = reservas.json.find(b => b.id === ids.bookingId);
  assert.ok(r, 'la reserva sigue en el panel');
  assert.equal(r.name, 'Cliente Persistente');
  assert.equal(r.phone, '0990000201');
  assert.equal(r.barberId, 'master');
  assert.deepEqual(r.serviceIds, ['corte']);
  assert.equal(r.date, LUNES);
  assert.equal(r.time, '08:00');
  assert.equal(r.status, 'confirmed');
  assert.equal(reservas.json.find(b => b.id === ids.canceladaId).status, 'cancelled', 'el cambio de estado se conserva');
  const disp = await s.pedir('GET', `/api/availability?date=${LUNES}&barberId=master&serviceIds=corte`);
  assert.ok(!disp.json.slots.includes('08:00'), 'el horario reservado sigue ocupado');
  assert.ok(disp.json.slots.includes('10:00'), 'el horario cancelado sigue libre');
}

test('los datos sobreviven a un reinicio del proceso sobre el mismo disco', async () => {
  let s = await iniciarServidor();
  try {
    const ids = await crearDatos(s);
    s = await reiniciar(s);
    await comprobarDatos(s, ids);
  } finally {
    await s.detener();
    s.borrar();
  }
});

test('los datos sobreviven a despliegues limpios (disco efímero) con PostgreSQL', { skip: sinPostgres }, async () => {
  const negocio = negocioNuevo();
  const s1 = await iniciarServidor({ postgres: true, negocio });
  let ids;
  try {
    ids = await crearDatos(s1);
  } finally {
    await s1.detener();
    s1.borrar();
  }
  /* Dos despliegues seguidos desde copias nuevas del repositorio. */
  for (let i = 0; i < 2; i++) {
    const s = await iniciarServidor({ postgres: true, negocio });
    try {
      await comprobarDatos(s, ids);
      const reservas = await s.pedir('GET', '/api/bookings');
      assert.equal(reservas.json.filter(b => b.id === ids.bookingId).length, 1, 'sin duplicados tras desplegar');
    } finally {
      await s.detener();
      s.borrar();
    }
  }
});

test('modo archivo: un db.json dañado no se reemplaza por los datos de ejemplo', { skip: process.env.TEST_ALMACEN === 'postgres' ? 'Solo aplica al modo archivo' : false }, async () => {
  const s = await iniciarServidor({ postgres: false });
  try {
    const danado = '{"bookings": [ {"id": "BK-1"';
    fs.writeFileSync(s.archivoDb, danado);
    const r = await s.pedir('POST', '/api/admin/barbers', { name: 'Escritura tras daño' });
    assert.equal(r.status, 500, 'la escritura se rechaza');
    assert.equal(fs.readFileSync(s.archivoDb, 'utf8'), danado, 'el archivo original no se toca');
  } finally {
    await s.detener();
    s.borrar();
  }
});
