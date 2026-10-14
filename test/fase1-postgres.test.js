'use strict';
/*
  Fase 1: agenda en PostgreSQL con business_id.
  Comprueba importación inicial, persistencia, choques de horario
  controlados por la base, aislamiento entre barberías y que un
  error nunca borra información. Requiere TEST_DATABASE_URL.
*/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { iniciarServidor, lanzarServidor, urlBasePruebas, negocioNuevo, proximoDia, RAIZ } = require('./apoyo/servidor');
const { crearAlmacen } = require('../almacen');

const URL_PG = urlBasePruebas();
const omitir = URL_PG ? false : 'Define TEST_DATABASE_URL con una base de pruebas';
const LUNES = proximoDia(1);
const MARTES = proximoDia(2);

function repoDb() {
  return JSON.parse(fs.readFileSync(path.join(RAIZ, 'data', 'db.json'), 'utf8'));
}

test.describe('Fase 1 · PostgreSQL', { skip: omitir }, () => {
  let pool;
  test.before(() => {
    const sslDesactivado = new URL(URL_PG).searchParams.get('sslmode') === 'disable';
    pool = new Pool({ connectionString: URL_PG, ssl: sslDesactivado ? false : { rejectUnauthorized: false } });
  });
  test.after(() => pool.end());

  const q = (sql, params) => pool.query(sql, params).then(r => r.rows);

  async function conServidor(opciones, fn) {
    const s = await iniciarServidor({ postgres: true, ...opciones });
    try { return await fn(s); } finally { await s.detener(); s.borrar(); }
  }

  test('importación inicial desde db.json y tablas preparadas con business_id', async () => {
    const negocio = negocioNuevo();
    await conServidor({ negocio }, async s => {
      const [b] = await q('SELECT * FROM businesses WHERE id = $1', [negocio]);
      assert.equal(b.name, 'El Máster');
      assert.equal(b.timezone, 'America/Guayaquil');
      assert.equal(b.currency, 'USD');
      assert.deepEqual((await q('SELECT id FROM barbers WHERE business_id = $1', [negocio])).map(r => r.id), ['master']);
      assert.equal((await q('SELECT id FROM services WHERE business_id = $1', [negocio])).length, 6);
      assert.equal((await q('SELECT id FROM bookings WHERE business_id = $1', [negocio])).length, 0);
      const imp = await q('SELECT source FROM data_imports WHERE business_id = $1', [negocio]);
      assert.deepEqual(imp.map(r => r.source), ['archivo:db.json']);

      for (const tabla of ['sales', 'cash_sessions', 'products', 'admin_settings', 'media_assets']) {
        const col = await q(`SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = 'business_id'`, [tabla]);
        assert.equal(col.length, 1, `${tabla}.business_id`);
      }
      const salud = await s.pedir('GET', '/api/health');
      assert.equal(salud.json.storage, 'postgres');
      assert.equal(salud.json.businessId, negocio);
      assert.equal(salud.json.overlapConstraint, 'activa');
    });
  });

  test('la importación copia reservas, barberos y horarios existentes y no se repite', async () => {
    const negocio = negocioNuevo();
    const db = repoDb();
    db.barbers.push({ id: 'barber_viejo', name: 'Barbero Antiguo', active: true });
    db.hoursConfig = { 1: { open: true, from: '09:00', to: '17:00', breakFrom: '', breakTo: '' } };
    db.hours = { 1: [['09:00', '17:00']] };
    db.bookings = [
      { id: 'BK-100', name: 'Antigua Uno', phone: '0990000401', serviceId: 'corte', barberId: 'master', date: LUNES, time: '09:00', status: 'confirmed', source: 'web' },
      { id: 'BK-101', name: 'Antigua Dos', phone: '0990000402', serviceId: 'barba', barberId: 'master', date: LUNES, time: '11:00', endTime: '11:20', status: 'cancelled', source: 'whatsapp',
        people: [{ index: 1, serviceId: 'barba', duration: 20, time: '11:00', endTime: '11:20' }] }
    ];
    await conServidor({ negocio, db }, async s => {
      const reservas = (await s.pedir('GET', '/api/bookings')).json;
      assert.deepEqual(reservas.map(r => r.id), ['BK-100', 'BK-101']);
      assert.equal(reservas[1].people[0].endTime, '11:20', 'se conservan todos los campos');
      const slots = await q('SELECT booking_id, start_min, end_min FROM booking_slots WHERE business_id = $1', [negocio]);
      assert.deepEqual(slots, [{ booking_id: 'BK-100', start_min: 540, end_min: 580 }], 'la cancelada no ocupa horario');
      const disp = await s.pedir('GET', `/api/availability?date=${LUNES}&barberId=master&serviceIds=corte`);
      assert.equal(disp.json.slots[0], '09:40');
      assert.ok((await s.pedir('GET', '/api/admin/barbers')).json.barbers.some(b => b.id === 'barber_viejo'));
    });
    /* Nuevo despliegue con el db.json del repositorio: la base manda, no se reimporta ni se pisa nada. */
    await conServidor({ negocio }, async s => {
      const reservas = (await s.pedir('GET', '/api/bookings')).json;
      assert.deepEqual(reservas.map(r => r.id), ['BK-100', 'BK-101']);
      assert.equal((await s.pedir('GET', '/api/admin/hours')).json.hours['1'].to, '17:00');
      assert.equal((await q('SELECT 1 FROM data_imports WHERE business_id = $1', [negocio])).length, 1);
    });
  });

  test('una barbería nueva con db.json dañado no arranca vacía y el archivo no se toca', async () => {
    const negocio = negocioNuevo();
    const s = await lanzarServidor({ postgres: true, negocio, db: '{"bookings": [' });
    try {
      await s.esperarLog(/NO SE PUDO INICIAR LA AGENDA: .*no es JSON válido/, 15000);
      assert.equal(fs.readFileSync(s.archivoDb, 'utf8'), '{"bookings": [');
      assert.equal((await q('SELECT 1 FROM businesses WHERE id = $1', [negocio])).length, 0, 'no se crea nada a medias');
    } finally {
      await s.detener();
      s.borrar();
    }
  });

  test('una barbería ya guardada arranca con sus datos aunque db.json esté dañado', async () => {
    const negocio = negocioNuevo();
    let id;
    await conServidor({ negocio }, async s => {
      id = (await s.pedir('POST', '/api/bookings', { name: 'Cliente Base', phone: '0990000410', barberId: 'master', serviceIds: ['corte'], date: LUNES, time: '15:00' })).json.booking.id;
    });
    const s = await lanzarServidor({ postgres: true, negocio, db: 'basura' });
    try {
      await s.esperarLog(/EL MÁSTER RESERVAS INICIADO/, 15000);
      await s.prepararPropietario();
      assert.ok((await s.pedir('GET', '/api/bookings')).json.some(b => b.id === id));
    } finally {
      await s.detener();
      s.borrar();
    }
  });

  test('reservas simultáneas al mismo horario: solo una se guarda', async () => {
    const negocio = negocioNuevo();
    await conServidor({ negocio }, async s => {
      const pedidos = Array.from({ length: 15 }, (_, i) => s.pedir('POST', '/api/bookings', {
        name: `Cliente ${i}`, phone: `09900005${String(i).padStart(2, '0')}`, barberId: 'master', serviceIds: ['corte'], date: LUNES, time: '10:00'
      }));
      const estados = (await Promise.all(pedidos)).map(r => r.status).sort();
      assert.equal(estados.filter(x => x === 201).length, 1);
      assert.equal(estados.filter(x => x === 409).length, 14);
      assert.equal((await q('SELECT 1 FROM bookings WHERE business_id = $1', [negocio])).length, 1);
      assert.equal((await q('SELECT 1 FROM booking_slots WHERE business_id = $1', [negocio])).length, 1);
      const ids = (await s.pedir('GET', '/api/bookings')).json.map(b => b.id);
      assert.equal(new Set(ids).size, ids.length, 'ids únicos');
    });
  });

  test('dos instancias del servidor no pueden reservar el mismo horario', async () => {
    const negocio = negocioNuevo();
    const a = await iniciarServidor({ postgres: true, negocio });
    const b = await iniciarServidor({ postgres: true, negocio });
    try {
      const datos = { phone: '0990000601', barberId: 'master', serviceIds: ['corte'], date: MARTES, time: '11:00' };
      assert.equal((await a.pedir('POST', '/api/bookings', { ...datos, name: 'Instancia A' })).status, 201);
      /* B todavía no ve la reserva de A en memoria, pero la base la rechaza. */
      assert.equal((await b.pedir('POST', '/api/bookings', { ...datos, name: 'Instancia B', time: '11:20' })).status, 409);
      assert.equal((await q('SELECT 1 FROM bookings WHERE business_id = $1', [negocio])).length, 1);
    } finally {
      await a.detener(); a.borrar();
      await b.detener(); b.borrar();
    }
  });

  test('cambios simultáneos no se pisan entre sí', async () => {
    const negocio = negocioNuevo();
    await conServidor({ negocio }, async s => {
      const r = await s.pedir('POST', '/api/bookings', { name: 'Cliente Estado', phone: '0990000701', barberId: 'master', serviceIds: ['corte'], date: LUNES, time: '14:00' });
      const id = r.json.booking.id;
      const horas = (await s.pedir('GET', '/api/admin/hours')).json.hours;
      horas['6'] = { open: true, from: '10:00', to: '14:00', breakFrom: '', breakTo: '' };
      const res = await Promise.all([
        s.pedir('PATCH', `/api/bookings/${id}`, { status: 'in_progress' }),
        s.pedir('POST', '/api/admin/barbers', { name: 'Barbero Simultáneo' }),
        s.pedir('PUT', '/api/admin/hours', { hours: horas }),
        s.pedir('POST', '/api/admin/services', { name: 'Servicio Simultáneo', price: 2, duration: 15 }),
        s.pedir('POST', '/api/bookings', { name: 'Otra Cliente', phone: '0990000702', barberId: 'master', serviceIds: ['barba'], date: LUNES, time: '16:00' })
      ]);
      assert.deepEqual(res.map(x => x.status), [200, 201, 200, 200, 201]);
      const [b] = await q('SELECT status FROM bookings WHERE business_id = $1 AND id = $2', [negocio, id]);
      assert.equal(b.status, 'in_progress');
      assert.ok((await q(`SELECT 1 FROM barbers WHERE business_id = $1 AND name = 'Barbero Simultáneo'`, [negocio])).length);
      assert.ok((await q(`SELECT 1 FROM services WHERE business_id = $1 AND name = 'Servicio Simultáneo'`, [negocio])).length);
      const [h] = await q(`SELECT data FROM business_state WHERE business_id = $1 AND key = 'hoursConfig'`, [negocio]);
      assert.equal(h.data['6'].from, '10:00');
      assert.equal((await q('SELECT 1 FROM bookings WHERE business_id = $1', [negocio])).length, 2);
    });
  });

  test('cada barbería tiene datos independientes', async () => {
    const [na, nb] = [negocioNuevo(), negocioNuevo()];
    const a = await iniciarServidor({ postgres: true, negocio: na });
    const b = await iniciarServidor({ postgres: true, negocio: nb });
    try {
      const datos = { phone: '0990000801', barberId: 'master', serviceIds: ['corte'], date: LUNES, time: '12:00' };
      /* 12:00 está en el descanso; usar 13:30. */
      datos.time = '13:30';
      assert.equal((await a.pedir('POST', '/api/bookings', { ...datos, name: 'Cliente A' })).status, 201);
      assert.equal((await b.pedir('POST', '/api/bookings', { ...datos, name: 'Cliente B' })).status, 201, 'el mismo horario en otra barbería es independiente');
      await a.pedir('POST', '/api/admin/barbers', { name: 'Solo en A' });
      assert.ok(!(await b.pedir('GET', '/api/admin/barbers')).json.barbers.some(x => x.name === 'Solo en A'));
      assert.deepEqual((await b.pedir('GET', '/api/bookings')).json.map(x => x.name), ['Cliente B']);
      assert.deepEqual((await a.pedir('GET', '/api/bookings')).json.map(x => x.name), ['Cliente A']);
    } finally {
      await a.detener(); a.borrar();
      await b.detener(); b.borrar();
    }
  });

  test('reactivar una reserva cancelada cuyo horario ya se ocupó devuelve 409', async () => {
    await conServidor({ negocio: negocioNuevo() }, async s => {
      const datos = { phone: '0990000901', barberId: 'master', serviceIds: ['corte'], date: LUNES, time: '17:00' };
      const uno = (await s.pedir('POST', '/api/bookings', { ...datos, name: 'Primera' })).json.booking.id;
      await s.pedir('PATCH', `/api/bookings/${uno}`, { status: 'cancelled' });
      assert.equal((await s.pedir('POST', '/api/bookings', { ...datos, name: 'Segunda' })).status, 201);
      const r = await s.pedir('PATCH', `/api/bookings/${uno}`, { status: 'confirmed' });
      assert.equal(r.status, 409);
      const lista = (await s.pedir('GET', '/api/bookings')).json;
      assert.equal(lista.find(b => b.id === uno).status, 'cancelled', 'la reserva queda como estaba');
    });
  });

  test('reserva de Elia y cobro quedan en PostgreSQL y sobreviven a un despliegue', async () => {
    const negocio = negocioNuevo();
    const [y, m, d] = LUNES.split('-');
    let codigo;
    await conServidor({ negocio }, async s => {
      const from = '593990001001';
      await s.enviarWhatsApp('quiero reservar', from);
      await s.enviarWhatsApp('1', from);
      await s.enviarWhatsApp('corte', from);
      await s.enviarWhatsApp(`${d}/${m}/${y}`, from);
      await s.enviarWhatsApp('16:00', from);
      await s.enviarWhatsApp('Cliente WhatsApp', from);
      const ok = await s.enviarWhatsApp('confirmar', from);
      assert.match(ok, /Reserva confirmada/);
      codigo = ok.match(/BK-\d+/)[0];
      const venta = await s.pedir('POST', '/api/sales', { bookingId: codigo, paymentMethod: 'cash', items: [{ type: 'service', id: 'corte', quantity: 1 }] });
      assert.equal(venta.status, 200, venta.texto);
    });
    const [fila] = await q('SELECT source, status, customer_phone, data FROM bookings WHERE business_id = $1 AND id = $2', [negocio, codigo]);
    assert.equal(fila.source, 'whatsapp');
    assert.equal(fila.status, 'completed');
    assert.equal(fila.data.paymentStatus, 'paid');
    assert.equal(fila.customer_phone, '593990001001');
    await conServidor({ negocio }, async s => {
      const b = (await s.pedir('GET', '/api/bookings')).json.find(x => x.id === codigo);
      assert.equal(b.paymentStatus, 'paid');
    });
  });

  test.describe('almacén: un error nunca borra información', () => {
    const negocio = negocioNuevo();
    let almacen;
    let fallarEn = null;
    const registro = { log() {}, error() {} };

    test.before(async () => {
      /* Pool que puede fallar a propósito en una consulta concreta. */
      const proxy = {
        connect: async () => {
          const client = await pool.connect();
          return {
            query: (sql, params) => {
              if (fallarEn && fallarEn.test(String(sql))) return Promise.reject(new Error('fallo simulado'));
              return client.query(sql, params);
            },
            release: () => client.release()
          };
        },
        query: (sql, params) => pool.query(sql, params)
      };
      const db = repoDb();
      db.bookings = [{ id: 'BK-1', name: 'Fija', phone: '1', serviceId: 'corte', barberId: 'master', date: LUNES, time: '08:00', status: 'confirmed' }];
      const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'almacen-'));
      fs.writeFileSync(path.join(tmp, 'db.json'), JSON.stringify(db));
      almacen = crearAlmacen({
        modo: 'postgres', pool: proxy, archivo: path.join(tmp, 'db.json'), negocio,
        datosIniciales: repoDb, intervalos: (_db, b) => {
          const [h, m] = String(b.time).split(':').map(Number);
          return [{ start: h * 60 + m, end: h * 60 + m + 40 }];
        },
        registro
      });
      await almacen.iniciar();
    });

    test('guardar sin un registro no lo borra', async () => {
      const db = almacen.leer();
      db.bookings = [];
      db.barbers = [];
      await almacen.guardar(db);
      assert.equal((await q('SELECT 1 FROM bookings WHERE business_id = $1', [negocio])).length, 1);
      assert.equal((await q('SELECT 1 FROM barbers WHERE business_id = $1', [negocio])).length, 1);
      assert.equal(almacen.leer().bookings.length, 1);
    });

    test('datos con formato inválido se rechazan sin tocar nada', async () => {
      const db = almacen.leer();
      db.bookings = 'no es una lista';
      await assert.rejects(almacen.guardar(db), /debe ser una lista/);
      const db2 = almacen.leer();
      db2.bookings.push({ name: 'sin id' });
      await assert.rejects(almacen.guardar(db2), /sin id/);
      assert.equal((await q('SELECT 1 FROM bookings WHERE business_id = $1', [negocio])).length, 1);
    });

    test('si falla una escritura a mitad de camino no se guarda nada', async () => {
      const db = almacen.leer();
      db.barbers[0].name = 'Nombre que no debe quedar';
      db.services.push({ id: 'svc-x', name: 'No debe quedar', price: 1, duration: 10 });
      db.bookings.push({ id: 'BK-2', name: 'No debe quedar', phone: '2', serviceId: 'barba', barberId: 'master', date: LUNES, time: '09:00', status: 'confirmed' });
      fallarEn = /INSERT INTO bookings/;
      await assert.rejects(almacen.guardar(db), /fallo simulado/);
      fallarEn = null;
      const [b] = await q('SELECT name FROM barbers WHERE business_id = $1', [negocio]);
      assert.equal(b.name, 'Master');
      assert.equal((await q(`SELECT 1 FROM services WHERE business_id = $1 AND id = 'svc-x'`, [negocio])).length, 0);
      assert.equal((await q('SELECT 1 FROM bookings WHERE business_id = $1', [negocio])).length, 1);
      assert.equal(almacen.leer().barbers[0].name, 'Master', 'la copia en memoria tampoco cambia');
      /* El mismo cambio se puede guardar después sin problema. */
      await almacen.guardar(db);
      assert.equal((await q('SELECT 1 FROM bookings WHERE business_id = $1', [negocio])).length, 2);
    });

    test('si PostgreSQL no responde, lo ya guardado sigue disponible', async () => {
      fallarEn = /BEGIN/;
      const db = almacen.leer();
      db.barbers[0].name = 'Tampoco';
      await assert.rejects(almacen.guardar(db));
      fallarEn = null;
      assert.equal(almacen.leer().bookings.length, 2);
      assert.notEqual(almacen.leer().barbers[0].name, 'Tampoco');
    });
  });
});
