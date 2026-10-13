'use strict';
/*
  Ensayo completo de la migración a producción:
  1. La versión actual (agenda en archivo) tiene datos reales.
  2. Se toma el respaldo por API (scripts/respaldo/respaldo-api.js).
  3. Se despliega la fase 1: importa automáticamente el db.json del
     repositorio, que NO tiene los datos reales.
  4. Llega una reserva nueva antes de importar el respaldo.
  5. importar.js en simulación (no guarda) y luego con --aplicar.
  6. Reinicio: están los datos reales y la reserva nueva; nada se pisa.
  7. verificar.js confirma que no falta nada; exportar.js genera copia.
*/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { iniciarServidor, reiniciar, urlBasePruebas, negocioNuevo, proximoDia, RAIZ } = require('./apoyo/servidor');

const ejecutar = promisify(execFile);
const URL_PG = urlBasePruebas();
const LUNES = proximoDia(1);

function script(nombre, args, negocio) {
  return ejecutar(process.execPath, [path.join(RAIZ, 'scripts', ...nombre.split('/')), ...args], {
    env: { PATH: process.env.PATH, DATABASE_URL: URL_PG, DEFAULT_BUSINESS_ID: negocio }
  }).catch(e => e);
}

test('ensayo de migración: respaldo → despliegue → importación → verificación', { skip: URL_PG ? false : 'Requiere TEST_DATABASE_URL' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migracion-'));
  const negocio = negocioNuevo();

  /* 1-2. Producción actual (archivo) con datos reales y su respaldo. */
  const viejo = await iniciarServidor({ postgres: false });
  let reservaReal;
  try {
    await viejo.pedir('PATCH', '/api/admin/barbers/master', { name: 'Master Real', phone: '0991111111' });
    await viejo.pedir('POST', '/api/admin/barbers', { name: 'Segundo Barbero' });
    const horas = (await viejo.pedir('GET', '/api/admin/hours')).json.hours;
    horas['6'] = { open: true, from: '09:00', to: '15:00', breakFrom: '', breakTo: '' };
    await viejo.pedir('PUT', '/api/admin/hours', { hours: horas });
    reservaReal = (await viejo.pedir('POST', '/api/bookings', { name: 'Cliente Real', phone: '0992222222', barberId: 'master', serviceIds: ['corte'], date: LUNES, time: '09:00' })).json.booking;
    await viejo.pedir('POST', '/api/bookings', { name: 'Cliente Choque', phone: '0993333333', barberId: 'master', serviceIds: ['corte'], date: LUNES, time: '10:00' });
    /* Sin PostgreSQL algunas rutas administrativas fallan; la agenda sí queda respaldada. */
    const r = await ejecutar(process.execPath, [path.join(RAIZ, 'scripts/respaldo/respaldo-api.js'), viejo.base, path.join(dir, 'api')]).catch(e => e);
    assert.match(r.stdout, /OK  200 \/api\/admin\/backup/);
    assert.match(r.stdout, /"reservas":2/);
  } finally {
    await viejo.detener();
    viejo.borrar();
  }
  const respaldo = path.join(dir, 'api', 'respaldo-completo.json');

  /* 3. Despliegue de la fase 1 (importa el db.json del repositorio). */
  let nuevo = await iniciarServidor({ postgres: true, negocio });
  try {
    assert.equal((await nuevo.pedir('GET', '/api/bookings')).json.length, 0);

    /* 4. Llega una reserva antes de importar; ocupa el horario de "Cliente Choque". */
    const ventana = await nuevo.pedir('POST', '/api/bookings', { name: 'Cliente Ventana', phone: '0994444444', barberId: 'master', serviceIds: ['corte'], date: LUNES, time: '10:00' });
    assert.equal(ventana.status, 201);

    /* 5. Simulación: informa sin guardar. */
    const sim = await script('migracion/importar.js', [respaldo], negocio);
    assert.match(sim.stdout, /SIMULACIÓN/);
    assert.match(sim.stdout, /NO importadas por choque de horario: 1/);
    nuevo = await reiniciar(nuevo);
    assert.equal((await nuevo.pedir('GET', '/api/bookings')).json.length, 1, 'la simulación no guarda nada');

    const ap = await script('migracion/importar.js', [respaldo, '--aplicar'], negocio);
    assert.match(ap.stdout, /Importación aplicada/);

    /* 6. Reinicio: datos reales + reserva de la ventana, sin pisar nada. */
    nuevo = await reiniciar(nuevo);
    const reservas = (await nuevo.pedir('GET', '/api/bookings')).json;
    assert.deepEqual(reservas.map(b => b.name).sort(), ['Cliente Real', 'Cliente Ventana']);
    assert.equal(reservas.find(b => b.name === 'Cliente Real').id, reservaReal.id);
    const barberos = (await nuevo.pedir('GET', '/api/admin/barbers')).json.barbers;
    assert.equal(barberos.find(b => b.id === 'master').name, 'Master Real', 'el barbero importado sin cambios toma la versión real');
    assert.ok(barberos.some(b => b.name === 'Segundo Barbero'));
    assert.equal((await nuevo.pedir('GET', '/api/admin/hours')).json.hours['6'].to, '15:00');
    const disp = await nuevo.pedir('GET', `/api/availability?date=${LUNES}&barberId=master&serviceIds=corte`);
    assert.ok(!disp.json.slots.includes('09:00'), 'la reserva importada ocupa su horario');

    /* Repetir la importación no duplica nada. */
    await script('migracion/importar.js', [respaldo, '--aplicar'], negocio);
    nuevo = await reiniciar(nuevo);
    assert.equal((await nuevo.pedir('GET', '/api/bookings')).json.length, 2);

    /* 7. Verificación y exportación. */
    const ver = await script('migracion/verificar.js', [respaldo], negocio);
    assert.match(ver.stdout, /bookings: respaldo 2 · base 2 · iguales 1 · modificados después 0 · FALTAN 1/);
    assert.equal(ver.code, 1, 'avisa de la reserva que no se pudo importar');

    const salida = path.join(dir, 'exportado.json');
    const ex = await script('migracion/exportar.js', [salida], negocio);
    assert.match(ex.stdout, /2 reservas/);
    const exportado = JSON.parse(fs.readFileSync(salida, 'utf8'));
    assert.equal(exportado.bookings.length, 2);
    assert.ok(exportado.hoursConfig);
    const otra = await script('migracion/exportar.js', [salida], negocio);
    assert.match(otra.stderr, /ya existe/, 'no sobrescribe archivos');
  } finally {
    await nuevo.detener();
    nuevo.borrar();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
