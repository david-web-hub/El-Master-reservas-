'use strict';
/*
  Persistencia de la información.

  "Reiniciar" = el mismo proceso vuelve a arrancar sobre la misma carpeta.
  "Despliegue limpio" = el servidor arranca desde una copia nueva del
  repositorio, que es lo que ocurre en un hosting con disco efímero
  (por ejemplo, un servicio web de Render sin disco persistente).

  Las pruebas marcadas como "todo" describen el comportamiento que debe tener
  la aplicación después de la fase 1. Hoy fallan y documentan la causa de la
  pérdida de datos; no hacen fallar la ejecución.
*/
const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciarServidor, reiniciar, proximoDia } = require('./apoyo/servidor');

const LUNES = proximoDia(1);

async function crearDatos(s) {
  const barbero = await s.pedir('POST', '/api/admin/barbers', { name: 'Barbero Persistente' });
  const horas = await s.pedir('GET', '/api/admin/hours');
  const semana = horas.json.hours;
  semana['6'] = { open: true, from: '09:00', to: '13:00', breakFrom: '', breakTo: '' };
  await s.pedir('PUT', '/api/admin/hours', { hours: semana });
  const reserva = await s.pedir('POST', '/api/bookings', { name: 'Cliente Persistente', phone: '0990000201', barberId: 'master', serviceIds: ['corte'], date: LUNES, time: '08:00' });
  assert.equal(reserva.status, 201);
  return { barberId: barbero.json.barber.id, bookingId: reserva.json.booking.id };
}

async function comprobarDatos(s, { barberId, bookingId }) {
  const barberos = await s.pedir('GET', '/api/admin/barbers');
  assert.ok(barberos.json.barbers.some(b => b.id === barberId), 'el barbero sigue registrado');
  const horas = await s.pedir('GET', '/api/admin/hours');
  assert.equal(horas.json.hours['6'].to, '13:00', 'el horario sigue guardado');
  const reservas = await s.pedir('GET', '/api/bookings');
  assert.ok(reservas.json.some(b => b.id === bookingId), 'la reserva sigue en el panel');
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

test('los datos sobreviven a un despliegue limpio (disco efímero)', { todo: 'Fase 1: hoy se guardan en data/db.json y se pierden' }, async () => {
  const s1 = await iniciarServidor();
  let ids;
  try {
    ids = await crearDatos(s1);
  } finally {
    await s1.detener();
    s1.borrar();
  }
  const s2 = await iniciarServidor();
  try {
    await comprobarDatos(s2, ids);
  } finally {
    await s2.detener();
    s2.borrar();
  }
});

test('un db.json dañado no debe reemplazarse por los datos de ejemplo', { todo: 'Fase 1: readDb() devuelve defaultDb() y la siguiente escritura sobrescribe todo' }, async () => {
  const s = await iniciarServidor({ db: null });
  try {
    require('node:fs').writeFileSync(s.archivoDb, '{"bookings": [ {"id": "BK-1"');
    await s.pedir('POST', '/api/admin/barbers', { name: 'Escritura tras daño' });
    const contenido = require('node:fs').readFileSync(s.archivoDb, 'utf8');
    assert.ok(contenido.includes('BK-1'), 'la información original no debe perderse');
  } finally {
    await s.detener();
    s.borrar();
  }
});
