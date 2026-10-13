'use strict';
/* =========================================================
   ALMACÉN DE DATOS DE LA AGENDA

   Guarda barberos, servicios, reservas, horarios y la
   configuración de la agenda de cada barbería.

   - Modo "postgres": PostgreSQL es la fuente de verdad. Cada
     barbería se identifica con business_id. La memoria solo
     guarda una copia para responder rápido.
   - Modo "archivo": data/db.json (desarrollo local). Escritura
     atómica y nunca reemplaza un archivo ilegible.

   Reglas de seguridad:
   - Nunca se borran barberos, servicios ni reservas: si un
     registro falta en lo que se guarda, se conserva en la base.
   - Cada guardado es una transacción: o se guarda todo o nada.
   - Los choques de horario se comprueban dentro de la base de
     datos (bloqueo por barbería + restricción de exclusión
     cuando PostgreSQL lo permite).
========================================================= */
const fs = require('node:fs');
const path = require('node:path');

const BASE = Symbol('almacen.base');
const COLECCIONES = ['barbers', 'services', 'bookings'];
const ID_NEGOCIO = /^[a-z0-9][a-z0-9-]{0,62}$/;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

class ErrorConflictoHorario extends Error {
  constructor(detalle) {
    super('Ese horario ya está ocupado');
    this.code = 'CONFLICTO_HORARIO';
    this.detalle = detalle;
  }
}

class ErrorAlmacen extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function validarNegocio(id) {
  if (!ID_NEGOCIO.test(String(id || ''))) {
    throw new ErrorAlmacen('NEGOCIO_INVALIDO', `Identificador de barbería no válido: ${id}`);
  }
  return id;
}

function fechaValida(value) {
  if (!FECHA.test(String(value || ''))) return null;
  const d = new Date(value + 'T12:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value ? value : null;
}

function texto(value, max = 200) {
  return value === undefined || value === null ? null : String(value).slice(0, max);
}

/* Intervalos ocupados por una reserva, normalizados y ordenados. */
function normalizarIntervalos(lista) {
  return (Array.isArray(lista) ? lista : [])
    .map(i => ({ start: Math.round(Number(i.start)), end: Math.round(Number(i.end)) }))
    .filter(i => Number.isFinite(i.start) && Number.isFinite(i.end) && i.start < i.end)
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

/* =========================================================
   ESQUEMA (solo aditivo: CREATE ... IF NOT EXISTS)
========================================================= */
const MIGRACIONES = [
  {
    version: '2026-10-fase1-001',
    descripcion: 'Agenda multiempresa: barberías, barberos, servicios, reservas y horarios',
    sql: `
      CREATE TABLE IF NOT EXISTS businesses (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        country TEXT NOT NULL DEFAULT 'EC',
        currency TEXT NOT NULL DEFAULT 'USD',
        locale TEXT NOT NULL DEFAULT 'es-EC',
        timezone TEXT NOT NULL DEFAULT 'America/Guayaquil',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS business_state (
        business_id TEXT NOT NULL REFERENCES businesses(id),
        key TEXT NOT NULL,
        data JSONB NOT NULL,
        origin TEXT NOT NULL DEFAULT 'app',
        version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (business_id, key)
      );

      CREATE TABLE IF NOT EXISTS barbers (
        business_id TEXT NOT NULL REFERENCES businesses(id),
        id TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        name TEXT,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        data JSONB NOT NULL,
        origin TEXT NOT NULL DEFAULT 'app',
        version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (business_id, id)
      );

      CREATE TABLE IF NOT EXISTS services (
        business_id TEXT NOT NULL REFERENCES businesses(id),
        id TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        name TEXT,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        data JSONB NOT NULL,
        origin TEXT NOT NULL DEFAULT 'app',
        version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (business_id, id)
      );

      CREATE TABLE IF NOT EXISTS bookings (
        business_id TEXT NOT NULL REFERENCES businesses(id),
        id TEXT NOT NULL,
        seq BIGSERIAL,
        barber_id TEXT,
        booking_date DATE,
        start_time TEXT,
        end_time TEXT,
        status TEXT,
        source TEXT,
        customer_name TEXT,
        customer_phone TEXT,
        data JSONB NOT NULL,
        origin TEXT NOT NULL DEFAULT 'app',
        version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (business_id, id)
      );
      CREATE INDEX IF NOT EXISTS bookings_agenda_idx
        ON bookings (business_id, booking_date, barber_id);
      CREATE INDEX IF NOT EXISTS bookings_phone_idx
        ON bookings (business_id, customer_phone);

      CREATE TABLE IF NOT EXISTS booking_slots (
        business_id TEXT NOT NULL,
        booking_id TEXT NOT NULL,
        barber_id TEXT NOT NULL,
        booking_date DATE NOT NULL,
        start_min INTEGER NOT NULL,
        end_min INTEGER NOT NULL,
        CHECK (start_min >= 0 AND start_min < end_min AND end_min <= 2880),
        FOREIGN KEY (business_id, booking_id) REFERENCES bookings(business_id, id)
      );
      CREATE INDEX IF NOT EXISTS booking_slots_agenda_idx
        ON booking_slots (business_id, barber_id, booking_date);
      CREATE INDEX IF NOT EXISTS booking_slots_booking_idx
        ON booking_slots (business_id, booking_id);

      CREATE TABLE IF NOT EXISTS data_imports (
        id BIGSERIAL PRIMARY KEY,
        business_id TEXT NOT NULL REFERENCES businesses(id),
        source TEXT NOT NULL,
        summary JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `
  }
];

MIGRACIONES.push({
  version: '2026-10-fase2-001',
  descripcion: 'Registro de barberías para cuentas propias y eventos para el Panel Maestro',
  sql: `
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS plan TEXT;
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS contact_email TEXT;
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS contact_phone TEXT;
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'importacion';

    /* Bandeja de salida: cada evento se entregará al Panel Maestro (fase 6). */
    CREATE TABLE IF NOT EXISTS platform_events (
      id BIGSERIAL PRIMARY KEY,
      business_id TEXT NOT NULL REFERENCES businesses(id),
      type TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      delivered_at TIMESTAMPTZ,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS platform_events_pending_idx
      ON platform_events (created_at) WHERE delivered_at IS NULL;

    /* Las barberías que ya existen también se anunciarán al Panel Maestro. */
    INSERT INTO platform_events (business_id, type, payload)
    SELECT b.id, 'business.created',
           jsonb_build_object('id', b.id, 'slug', b.slug, 'name', b.name, 'country', b.country,
                              'currency', b.currency, 'locale', b.locale, 'timezone', b.timezone,
                              'status', b.status, 'createdAt', b.created_at)
    FROM businesses b
    WHERE NOT EXISTS (
      SELECT 1 FROM platform_events e WHERE e.business_id = b.id AND e.type = 'business.created'
    );
  `
});

MIGRACIONES.push({
  version: '2026-10-fase3-001',
  descripcion: 'Cuentas, sesiones, recuperación de contraseña, roles y registro de seguridad',
  sql: `
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      password_hash TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TIMESTAMPTZ,
      password_changed_at TIMESTAMPTZ,
      last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (lower(email));

    CREATE TABLE IF NOT EXISTS memberships (
      user_id TEXT NOT NULL REFERENCES users(id),
      business_id TEXT NOT NULL REFERENCES businesses(id),
      role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'staff', 'barber')),
      barber_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, business_id)
    );
    CREATE INDEX IF NOT EXISTS memberships_business_idx ON memberships (business_id);

    /* Solo se guarda el resumen (SHA-256) del identificador de sesión, nunca el valor. */
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      business_id TEXT NOT NULL REFERENCES businesses(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      ip TEXT,
      user_agent TEXT
    );
    CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

    CREATE TABLE IF NOT EXISTS password_resets (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ip TEXT
    );
    CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets (user_id);

    CREATE TABLE IF NOT EXISTS auth_events (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT,
      business_id TEXT,
      type TEXT NOT NULL,
      ip TEXT,
      detail JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS auth_events_user_idx ON auth_events (user_id, created_at);
  `
});

const RESTRICCION_SOLAPES = 'booking_slots_sin_solapes';
const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

function payloadNegocio(b) {
  return {
    id: b.id, slug: b.slug, name: b.name, country: b.country, currency: b.currency,
    locale: b.locale, timezone: b.timezone, status: b.status, plan: b.plan || null,
    createdAt: b.created_at
  };
}

/* =========================================================
   CREAR ALMACÉN
========================================================= */
function crearAlmacen(opciones) {
  const {
    modo,
    pool = null,
    archivo,
    negocio = 'el-master',
    datosIniciales,
    normalizar = db => db,
    intervalos,
    registro = console
  } = opciones;

  if (!['postgres', 'archivo'].includes(modo)) throw new Error(`Modo de almacén desconocido: ${modo}`);
  if (modo === 'postgres' && !pool) throw new Error('El modo postgres necesita un pool de PostgreSQL');
  if (typeof intervalos !== 'function') throw new Error('Falta la función de intervalos de reserva');
  validarNegocio(negocio);

  const estado = {
    listo: modo === 'archivo',
    restriccionSolapes: null,
    avisos: []
  };

  /* -------- copia en memoria (solo modo postgres) --------
     Por barbería: { orden: { barbers: [ids], ... },
                     registros: { barbers: Map(id -> json), ... },
                     estado: Map(clave -> json) }
     Los mapas se reemplazan en cada guardado (copia al escribir),
     así cada lectura conserva la versión exacta que leyó. */
  const cache = new Map();
  const colas = new Map();

  function enCola(id, tarea) {
    const anterior = colas.get(id) || Promise.resolve();
    const siguiente = anterior.catch(() => {}).then(tarea);
    colas.set(id, siguiente.catch(() => {}));
    return siguiente;
  }

  /* ======================= ARCHIVO ======================= */
  function leerArchivo() {
    if (!fs.existsSync(archivo)) {
      const inicial = datosIniciales();
      escribirArchivo(inicial);
      return normalizar(inicial);
    }
    const raw = fs.readFileSync(archivo, 'utf8');
    let db;
    try {
      db = JSON.parse(raw);
    } catch (error) {
      throw new ErrorAlmacen('ARCHIVO_ILEGIBLE',
        `${archivo} no es JSON válido; no se reemplaza para no perder información (${error.message})`);
    }
    if (!db || typeof db !== 'object' || Array.isArray(db)) {
      throw new ErrorAlmacen('ARCHIVO_ILEGIBLE', `${archivo} no contiene un objeto de datos`);
    }
    return normalizar(db);
  }

  function escribirArchivo(db) {
    fs.mkdirSync(path.dirname(archivo), { recursive: true });
    const temporal = `${archivo}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporal, JSON.stringify(db, null, 2));
    fs.renameSync(temporal, archivo);
  }

  /* ======================= POSTGRES ====================== */
  async function migrar() {
    const client = await pool.connect();
    try {
      /* Evita que dos instancias migren a la vez. */
      await client.query('SELECT pg_advisory_lock(hashtext($1))', ['master-reservas:migraciones']);
      await client.query(`
        CREATE TABLE IF NOT EXISTS master_reservas_migrations (
          version TEXT PRIMARY KEY,
          description TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
      for (const m of MIGRACIONES) {
        const ya = await client.query('SELECT 1 FROM master_reservas_migrations WHERE version = $1', [m.version]);
        if (ya.rowCount) continue;
        await client.query('BEGIN');
        try {
          await client.query(m.sql);
          await client.query(
            'INSERT INTO master_reservas_migrations (version, description) VALUES ($1, $2)',
            [m.version, m.descripcion]);
          await client.query('COMMIT');
          registro.log(`MIGRACIÓN APLICADA: ${m.version}`);
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['master-reservas:migraciones']).catch(() => {});
      client.release();
    }
  }

  /*
    Restricción de exclusión: impide en la propia base que dos
    reservas activas del mismo barbero se solapen. Requiere la
    extensión btree_gist; si el servidor no la permite o los
    datos antiguos ya tienen solapes, se registra y el control
    sigue funcionando con el bloqueo por barbería.
  */
  async function asegurarRestriccionSolapes() {
    const existe = await pool.query('SELECT 1 FROM pg_constraint WHERE conname = $1', [RESTRICCION_SOLAPES]);
    if (existe.rowCount) {
      estado.restriccionSolapes = 'activa';
      return;
    }
    try {
      await pool.query('CREATE EXTENSION IF NOT EXISTS btree_gist');
      await pool.query(`
        ALTER TABLE booking_slots ADD CONSTRAINT ${RESTRICCION_SOLAPES}
        EXCLUDE USING gist (
          business_id WITH =,
          barber_id WITH =,
          booking_date WITH =,
          int4range(start_min, end_min) WITH &&
        )`);
      estado.restriccionSolapes = 'activa';
      registro.log('RESTRICCIÓN DE SOLAPES ACTIVA EN booking_slots');
    } catch (error) {
      estado.restriccionSolapes = 'no disponible';
      const aviso = `No se pudo activar la restricción de solapes (${error.message}). ` +
        'Los choques se siguen controlando con bloqueo por barbería.';
      estado.avisos.push(aviso);
      registro.error('AVISO ALMACÉN:', aviso);
    }
  }

  function datosNegocio(db, id) {
    const b = db && typeof db.business === 'object' && db.business ? db.business : {};
    return {
      id,
      slug: id,
      name: texto(b.name, 120) || id,
      country: 'EC',
      currency: texto(b.currency, 3) || 'USD',
      locale: 'es-EC',
      timezone: texto(b.timezone, 64) || 'America/Guayaquil'
    };
  }

  /* Inserta una barbería completa (importación). Solo agrega: ON CONFLICT DO NOTHING. */
  async function insertarTodo(client, id, db, origen, { comprobarSolapes = false, fusionar = false } = {}) {
    const resumen = { barbers: 0, services: 0, bookings: 0, state: 0, conservados: 0, actualizados: 0, conflictos: [] };

    const n = datosNegocio(db, id);
    const creada = await client.query(
      `INSERT INTO businesses (id, slug, name, country, currency, locale, timezone)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING RETURNING *`,
      [n.id, n.slug, n.name, n.country, n.currency, n.locale, n.timezone]);
    if (creada.rowCount) {
      await client.query(
        `INSERT INTO platform_events (business_id, type, payload) VALUES ($1, 'business.created', $2::jsonb)`,
        [id, JSON.stringify(payloadNegocio(creada.rows[0]))]);
    }

    for (const [key, data] of Object.entries(db)) {
      if (COLECCIONES.includes(key) || data === undefined) continue;
      const r = await client.query(
        `INSERT INTO business_state (business_id, key, data, origin)
         VALUES ($1, $2, $3::jsonb, $4) ON CONFLICT (business_id, key) DO NOTHING`,
        [id, key, JSON.stringify(data), origen]);
      if (r.rowCount) { resumen.state++; continue; }
      if (fusionar) {
        const u = await client.query(
          `UPDATE business_state SET data = $3::jsonb, origin = $4, version = version + 1, updated_at = NOW()
           WHERE business_id = $1 AND key = $2 AND origin = 'importacion' AND version = 1
             AND data IS DISTINCT FROM $3::jsonb`,
          [id, key, JSON.stringify(data), origen]);
        if (u.rowCount) resumen.actualizados++; else resumen.conservados++;
      } else {
        resumen.conservados++;
      }
    }

    for (const col of ['barbers', 'services']) {
      const lista = Array.isArray(db[col]) ? db[col] : [];
      for (let i = 0; i < lista.length; i++) {
        const rec = lista[i];
        if (!rec || rec.id === undefined || rec.id === null) continue;
        const r = await client.query(
          `INSERT INTO ${col} (business_id, id, position, name, active, data, origin)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) ON CONFLICT (business_id, id) DO NOTHING`,
          [id, String(rec.id), i, texto(rec.name), rec.active !== false, JSON.stringify(rec), origen]);
        if (r.rowCount) { resumen[col]++; continue; }
        if (fusionar) {
          const u = await client.query(
            `UPDATE ${col} SET data = $3::jsonb, name = $4, active = $5, origin = $6,
                    version = version + 1, updated_at = NOW()
             WHERE business_id = $1 AND id = $2 AND origin = 'importacion' AND version = 1
               AND data IS DISTINCT FROM $3::jsonb`,
            [id, String(rec.id), JSON.stringify(rec), texto(rec.name), rec.active !== false, origen]);
          if (u.rowCount) resumen.actualizados++; else resumen.conservados++;
        } else {
          resumen.conservados++;
        }
      }
    }

    const reservas = Array.isArray(db.bookings) ? db.bookings : [];
    for (const b of reservas) {
      if (!b || b.id === undefined || b.id === null) continue;
      await client.query('SAVEPOINT reserva');
      try {
        const r = await client.query(
          `INSERT INTO bookings (business_id, id, barber_id, booking_date, start_time, end_time, status,
                                 source, customer_name, customer_phone, data, origin)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
           ON CONFLICT (business_id, id) DO NOTHING`,
          columnasReserva(id, b, origen));
        if (!r.rowCount) {
          resumen.conservados++;
          await client.query('RELEASE SAVEPOINT reserva');
          continue;
        }
        await escribirIntervalos(client, id, db, b, { comprobar: comprobarSolapes });
        await client.query('RELEASE SAVEPOINT reserva');
        resumen.bookings++;
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT reserva');
        if (error.code !== 'CONFLICTO_HORARIO' && error.code !== '23P01') throw error;
        resumen.conflictos.push({ id: String(b.id), date: b.date, time: b.time, barberId: b.barberId });
      }
    }
    return resumen;
  }

  function columnasReserva(negocioId, b, origen) {
    return [
      negocioId,
      String(b.id),
      texto(b.barberId, 120),
      fechaValida(b.date),
      HORA.test(String(b.time || '')) ? b.time : null,
      HORA.test(String(b.endTime || '')) ? b.endTime : null,
      texto(b.status, 40),
      texto(b.source, 40),
      texto(b.name, 120),
      texto(b.phone, 40),
      JSON.stringify(b),
      origen
    ];
  }

  /*
    Sincroniza booking_slots con los intervalos que el motor de
    reservas considera ocupados. Solo vuelve a comprobar choques
    si los intervalos cambiaron (así cambiar el estado de una
    reserva antigua nunca falla por datos heredados).
  */
  async function escribirIntervalos(client, negocioId, db, b, { comprobar }) {
    const fecha = fechaValida(b.date);
    const activo = b.status !== 'cancelled' && fecha && b.barberId !== undefined && b.barberId !== null;
    const nuevos = activo ? normalizarIntervalos(intervalos(db, b)) : [];
    const barbero = activo ? String(b.barberId) : null;

    const actuales = await client.query(
      `SELECT barber_id, booking_date::text AS fecha, start_min AS start, end_min AS end
       FROM booking_slots WHERE business_id = $1 AND booking_id = $2 ORDER BY start_min, end_min`,
      [negocioId, String(b.id)]);
    const iguales = actuales.rows.length === nuevos.length && actuales.rows.every((r, i) =>
      r.barber_id === barbero && r.fecha === fecha && r.start === nuevos[i].start && r.end === nuevos[i].end);
    if (iguales) return;

    await client.query('DELETE FROM booking_slots WHERE business_id = $1 AND booking_id = $2', [negocioId, String(b.id)]);
    for (const i of nuevos) {
      if (comprobar) {
        const choque = await client.query(
          `SELECT booking_id FROM booking_slots
           WHERE business_id = $1 AND barber_id = $2 AND booking_date = $3
             AND booking_id <> $4 AND start_min < $6 AND end_min > $5
           LIMIT 1`,
          [negocioId, barbero, fecha, String(b.id), i.start, i.end]);
        if (choque.rowCount) {
          throw new ErrorConflictoHorario({ bookingId: String(b.id), conflictoCon: choque.rows[0].booking_id });
        }
      }
      try {
        await client.query(
          `INSERT INTO booking_slots (business_id, booking_id, barber_id, booking_date, start_min, end_min)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [negocioId, String(b.id), barbero, fecha, i.start, i.end]);
      } catch (error) {
        if (error.code === '23P01') throw new ErrorConflictoHorario({ bookingId: String(b.id) });
        throw error;
      }
    }
  }

  async function negocioExiste(client, id) {
    const r = await client.query('SELECT 1 FROM businesses WHERE id = $1', [id]);
    return r.rowCount > 0;
  }

  /*
    Primera vez que una barbería usa PostgreSQL: copia su agenda
    desde data/db.json. Si ya existe en la base, NUNCA se vuelve
    a importar automáticamente (la base manda).
  */
  async function importacionInicial(id) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['master-reservas:negocio:' + id]);
      if (await negocioExiste(client, id)) {
        await client.query('COMMIT');
        return null;
      }
      let origenDatos;
      let db;
      if (archivo && fs.existsSync(archivo)) {
        try {
          db = JSON.parse(fs.readFileSync(archivo, 'utf8'));
        } catch (error) {
          throw new ErrorAlmacen('IMPORTACION',
            `La barbería "${id}" aún no está en PostgreSQL y ${archivo} no es JSON válido. ` +
            'No se arranca para no empezar con datos vacíos; restaura el archivo o importa un respaldo ' +
            'con scripts/migracion/importar.js.');
        }
        origenDatos = 'archivo:' + path.basename(archivo);
      } else {
        db = datosIniciales();
        origenDatos = 'datos-iniciales';
      }
      db = normalizar(db);
      const resumen = await insertarTodo(client, id, db, 'importacion');
      await client.query(
        'INSERT INTO data_imports (business_id, source, summary) VALUES ($1, $2, $3::jsonb)',
        [id, origenDatos, JSON.stringify(resumen)]);
      await client.query('COMMIT');
      registro.log(`IMPORTACIÓN INICIAL DE "${id}" DESDE ${origenDatos}: ` +
        `${resumen.barbers} barberos, ${resumen.services} servicios, ${resumen.bookings} reservas`);
      return resumen;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function cargar(id) {
    const [estadoRows, barbers, services, bookings] = await Promise.all([
      pool.query('SELECT key, data FROM business_state WHERE business_id = $1 ORDER BY key', [id]),
      pool.query('SELECT id, data FROM barbers WHERE business_id = $1 ORDER BY position, created_at, id', [id]),
      pool.query('SELECT id, data FROM services WHERE business_id = $1 ORDER BY position, created_at, id', [id]),
      pool.query('SELECT id, data FROM bookings WHERE business_id = $1 ORDER BY seq', [id])
    ]);
    if (!estadoRows.rowCount && !barbers.rowCount && !services.rowCount && !bookings.rowCount) {
      const existe = await pool.query('SELECT 1 FROM businesses WHERE id = $1', [id]);
      if (!existe.rowCount) throw new ErrorAlmacen('NEGOCIO_DESCONOCIDO', `La barbería "${id}" no existe`);
    }
    const db = {};
    for (const r of estadoRows.rows) db[r.key] = r.data;
    db.barbers = barbers.rows.map(r => r.data);
    db.services = services.rows.map(r => r.data);
    db.bookings = bookings.rows.map(r => r.data);
    const normal = normalizar(db);

    const c = { orden: {}, registros: {}, estado: new Map() };
    for (const col of COLECCIONES) {
      const lista = Array.isArray(normal[col]) ? normal[col] : [];
      c.orden[col] = lista.map(x => String(x.id));
      c.registros[col] = new Map(lista.map(x => [String(x.id), JSON.stringify(x)]));
    }
    for (const [k, v] of Object.entries(normal)) {
      if (!COLECCIONES.includes(k) && v !== undefined) c.estado.set(k, JSON.stringify(v));
    }
    cache.set(id, c);
    return c;
  }

  /*
    Recalcula los horarios ocupados de las reservas desde ayer en
    adelante con el motor real (por ejemplo, después de importar un
    respaldo con un script). Solo corrige datos derivados
    (booking_slots); nunca modifica ni borra reservas.
  */
  async function sincronizarIntervalos(id) {
    const c = cache.get(id);
    const db = vistaDesdeCache(c);
    const desde = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const client = await pool.connect();
    const conflictos = [];
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['master-reservas:negocio:' + id]);
      for (const b of db.bookings) {
        if (!fechaValida(b.date) || b.date < desde) continue;
        await client.query('SAVEPOINT intervalo');
        try {
          await escribirIntervalos(client, id, db, b, { comprobar: false });
          await client.query('RELEASE SAVEPOINT intervalo');
        } catch (error) {
          await client.query('ROLLBACK TO SAVEPOINT intervalo');
          if (error.code !== '23P01') throw error;
          conflictos.push(String(b.id));
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    if (conflictos.length) {
      const aviso = `Reservas que se solapan con otras y no bloquean horario: ${conflictos.join(', ')}`;
      estado.avisos.push(aviso);
      registro.error('AVISO ALMACÉN:', aviso);
    }
  }

  async function iniciar() {
    if (modo === 'archivo') {
      estado.listo = true;
      return estado;
    }
    await migrar();
    await importacionInicial(negocio);
    await asegurarRestriccionSolapes();
    await cargar(negocio);
    await sincronizarIntervalos(negocio);
    estado.listo = true;
    return estado;
  }

  function vistaDesdeCache(c) {
    const db = {};
    for (const [k, v] of c.estado) db[k] = JSON.parse(v);
    for (const col of COLECCIONES) {
      db[col] = c.orden[col].map(id => JSON.parse(c.registros[col].get(id)));
    }
    Object.defineProperty(db, BASE, { value: c, enumerable: false });
    return db;
  }

  /* Devuelve una copia independiente: quien la recibe puede modificarla libremente. */
  function leer(id = negocio) {
    if (modo === 'archivo') return leerArchivo();
    if (!estado.listo) throw new ErrorAlmacen('NO_LISTO', 'El almacén de datos todavía no está listo');
    const c = cache.get(id);
    if (!c) throw new ErrorAlmacen('NEGOCIO_DESCONOCIDO', `La barbería "${id}" no está cargada`);
    return vistaDesdeCache(c);
  }

  function calcularCambios(db, base) {
    const cambios = { estado: [], barbers: [], services: [], bookings: [], omitidos: [] };
    for (const [k, v] of Object.entries(db)) {
      if (COLECCIONES.includes(k) || v === undefined) continue;
      const json = JSON.stringify(v);
      if (base.estado.get(k) !== json) cambios.estado.push({ key: k, json, nuevo: !base.estado.has(k) });
    }
    for (const col of COLECCIONES) {
      const lista = db[col];
      if (!Array.isArray(lista)) {
        throw new ErrorAlmacen('DATOS_INVALIDOS', `"${col}" debe ser una lista; no se guarda nada`);
      }
      const vistos = new Set();
      lista.forEach((rec, posicion) => {
        if (!rec || rec.id === undefined || rec.id === null || rec.id === '') {
          throw new ErrorAlmacen('DATOS_INVALIDOS', `Hay un registro sin id en "${col}"; no se guarda nada`);
        }
        const id = String(rec.id);
        if (vistos.has(id)) {
          throw new ErrorAlmacen('DATOS_INVALIDOS', `Id repetido "${id}" en "${col}"; no se guarda nada`);
        }
        vistos.add(id);
        const json = JSON.stringify(rec);
        const anterior = base.registros[col].get(id);
        const posAnterior = base.orden[col].indexOf(id);
        if (anterior !== json || (col !== 'bookings' && posAnterior !== posicion)) {
          cambios[col].push({ id, rec, json, posicion, nuevo: anterior === undefined });
        }
      });
      for (const id of base.orden[col]) {
        if (!vistos.has(id)) cambios.omitidos.push(`${col}:${id}`);
      }
    }
    return cambios;
  }

  async function aplicarCambios(id, db, cambios) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      /* Un solo escritor por barbería a la vez, también entre varias instancias. */
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['master-reservas:negocio:' + id]);

      for (const e of cambios.estado) {
        await client.query(
          `INSERT INTO business_state (business_id, key, data, origin)
           VALUES ($1, $2, $3::jsonb, 'app')
           ON CONFLICT (business_id, key) DO UPDATE
             SET data = EXCLUDED.data, origin = 'app',
                 version = business_state.version + 1, updated_at = NOW()`,
          [id, e.key, e.json]);
      }

      for (const col of ['barbers', 'services']) {
        for (const c of cambios[col]) {
          if (c.nuevo) {
            const r = await client.query(
              `INSERT INTO ${col} (business_id, id, position, name, active, data, origin)
               VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'app') ON CONFLICT (business_id, id) DO NOTHING`,
              [id, c.id, c.posicion, texto(c.rec.name), c.rec.active !== false, c.json]);
            if (!r.rowCount) {
              throw new ErrorAlmacen('ID_DUPLICADO', `Ya existe un registro con id "${c.id}" en ${col}`);
            }
          } else {
            const r = await client.query(
              `UPDATE ${col} SET position = $3, name = $4, active = $5, data = $6::jsonb, origin = 'app',
                      version = version + 1, updated_at = NOW()
               WHERE business_id = $1 AND id = $2`,
              [id, c.id, c.posicion, texto(c.rec.name), c.rec.active !== false, c.json]);
            if (!r.rowCount) {
              await client.query(
                `INSERT INTO ${col} (business_id, id, position, name, active, data, origin)
                 VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'app')`,
                [id, c.id, c.posicion, texto(c.rec.name), c.rec.active !== false, c.json]);
            }
          }
        }
      }

      for (const c of cambios.bookings) {
        const columnas = columnasReserva(id, c.rec, 'app');
        if (c.nuevo) {
          const r = await client.query(
            `INSERT INTO bookings (business_id, id, barber_id, booking_date, start_time, end_time, status,
                                   source, customer_name, customer_phone, data, origin)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
             ON CONFLICT (business_id, id) DO NOTHING`,
            columnas);
          if (!r.rowCount) {
            throw new ErrorAlmacen('ID_DUPLICADO', `Ya existe una reserva con id "${c.id}"`);
          }
        } else {
          const r = await client.query(
            `UPDATE bookings SET barber_id = $3, booking_date = $4, start_time = $5, end_time = $6,
                    status = $7, source = $8, customer_name = $9, customer_phone = $10,
                    data = $11::jsonb, origin = $12, version = version + 1, updated_at = NOW()
             WHERE business_id = $1 AND id = $2`,
            columnas);
          if (!r.rowCount) {
            await client.query(
              `INSERT INTO bookings (business_id, id, barber_id, booking_date, start_time, end_time, status,
                                     source, customer_name, customer_phone, data, origin)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)`,
              columnas);
          }
        }
        await escribirIntervalos(client, id, db, c.rec, { comprobar: true });
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error.code === '23P01') throw new ErrorConflictoHorario({});
      throw error;
    } finally {
      client.release();
    }
  }

  /* Aplica los cambios ya guardados sobre la copia en memoria actual (no sobre la que se leyó). */
  function actualizarCache(id, db, cambios) {
    const actual = cache.get(id);
    const c = { orden: {}, registros: {}, estado: new Map(actual.estado) };
    for (const e of cambios.estado) c.estado.set(e.key, e.json);
    for (const col of COLECCIONES) {
      const registros = new Map(actual.registros[col]);
      for (const x of cambios[col]) registros.set(x.id, x.json);
      let orden;
      if (col === 'bookings' || !cambios[col].length) {
        orden = actual.orden[col].slice();
        for (const x of cambios[col]) if (!actual.registros[col].has(x.id)) orden.push(x.id);
      } else {
        /* Barberos y servicios: el orden que envió quien guardó, sin perder ninguno. */
        orden = db[col].map(x => String(x.id));
        const incluidos = new Set(orden);
        for (const x of actual.orden[col]) if (!incluidos.has(x)) orden.push(x);
      }
      c.orden[col] = orden;
      c.registros[col] = registros;
    }
    cache.set(id, c);
  }

  /*
    Guarda lo que cambió respecto a la copia que se leyó.
    Devuelve una promesa: quien responde al cliente debe esperarla.
  */
  function guardar(db, id = negocio) {
    if (!db || typeof db !== 'object') {
      return Promise.reject(new ErrorAlmacen('DATOS_INVALIDOS', 'No hay datos para guardar'));
    }
    if (modo === 'archivo') {
      try {
        for (const col of COLECCIONES) {
          if (!Array.isArray(db[col])) throw new ErrorAlmacen('DATOS_INVALIDOS', `"${col}" debe ser una lista`);
        }
        escribirArchivo(db);
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error);
      }
    }
    if (!estado.listo) return Promise.reject(new ErrorAlmacen('NO_LISTO', 'El almacén de datos todavía no está listo'));

    return enCola(id, async () => {
      const base = db[BASE] || cache.get(id);
      if (!base) throw new ErrorAlmacen('NEGOCIO_DESCONOCIDO', `La barbería "${id}" no está cargada`);
      const cambios = calcularCambios(db, base);
      if (cambios.omitidos.length) {
        registro.error('AVISO ALMACÉN: se intentó guardar sin estos registros; se conservan en la base:',
          cambios.omitidos.join(', '));
      }
      const total = cambios.estado.length + cambios.barbers.length + cambios.services.length + cambios.bookings.length;
      if (!total) return;
      await aplicarCambios(id, db, cambios);
      actualizarCache(id, db, cambios);
    });
  }

  /* Vuelve a leer una barbería desde PostgreSQL (después de importar un respaldo, por ejemplo). */
  async function recargar(id = negocio) {
    if (modo !== 'postgres') return;
    await enCola(id, () => cargar(id));
  }

  async function cargarNegocio(id) {
    validarNegocio(id);
    if (modo !== 'postgres') return;
    if (!cache.has(id)) await cargar(id);
  }

  /*
    Crea una barbería nueva con su propia agenda vacía (sin barberos ni
    reservas) y el catálogo de servicios de ejemplo. Lo usará el
    registro de cuentas (fase 3). No se expone todavía por HTTP.
  */
  async function crearNegocio(datos = {}, { client: externo = null } = {}) {
    if (modo !== 'postgres') throw new ErrorAlmacen('SOLO_POSTGRES', 'Crear barberías requiere PostgreSQL');
    const id = validarNegocio(String(datos.id || '').trim().toLowerCase());
    const slug = String(datos.slug || id).trim().toLowerCase();
    if (!SLUG.test(slug)) throw new ErrorAlmacen('SLUG_INVALIDO', `Dirección pública no válida: ${slug}`);
    const nombre = texto(String(datos.name || '').trim(), 120);
    if (!nombre) throw new ErrorAlmacen('NOMBRE_REQUERIDO', 'Escribe el nombre de la barbería');

    const base = normalizar(datosIniciales());
    const db = {
      business: { ...(base.business || {}), id, name: nombre, phone: texto(datos.phone, 30) || '', address: '', description: '' },
      schedule: base.schedule,
      settings: base.settings,
      barbers: [],
      services: base.services || [],
      bookings: []
    };

    /* Con "client" se ejecuta dentro de la transacción de quien llama (registro de cuentas). */
    const client = externo || await pool.connect();
    try {
      if (!externo) await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['master-reservas:negocio:' + id]);
      const existe = await client.query('SELECT 1 FROM businesses WHERE id = $1 OR slug = $2', [id, slug]);
      if (existe.rowCount) throw new ErrorAlmacen('NEGOCIO_EXISTE', `Ya existe una barbería con id o dirección "${slug}"`);
      const r = await client.query(
        `INSERT INTO businesses (id, slug, name, country, currency, locale, timezone, status, plan,
                                 trial_ends_at, contact_email, contact_phone, origin)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'registro') RETURNING *`,
        [id, slug, nombre,
          texto(datos.country, 2) || 'EC', texto(datos.currency, 3) || 'USD',
          texto(datos.locale, 20) || 'es-EC', texto(datos.timezone, 64) || 'America/Guayaquil',
          datos.status === 'active' ? 'active' : 'trial', texto(datos.plan, 60),
          datos.trialEndsAt || null, texto(datos.contactEmail, 160), texto(datos.contactPhone, 40)]);
      await insertarTodo(client, id, db, 'registro');
      await client.query(
        `INSERT INTO platform_events (business_id, type, payload) VALUES ($1, 'business.created', $2::jsonb)`,
        [id, JSON.stringify(payloadNegocio(r.rows[0]))]);
      if (!externo) await client.query('COMMIT');
      return payloadNegocio(r.rows[0]);
    } catch (error) {
      if (!externo) await client.query('ROLLBACK').catch(() => {});
      if (error.code === '23505') throw new ErrorAlmacen('NEGOCIO_EXISTE', 'Ya existe una barbería con ese id o dirección');
      throw error;
    } finally {
      if (!externo) client.release();
    }
  }

  /* Lista de barberías para el Panel Maestro (fase 6). Solo lectura. */
  async function listarNegocios() {
    if (modo !== 'postgres') return [];
    const r = await pool.query(
      `SELECT b.*,
              (SELECT count(*) FROM barbers x WHERE x.business_id = b.id)::int AS barbers,
              (SELECT count(*) FROM bookings x WHERE x.business_id = b.id)::int AS bookings
       FROM businesses b ORDER BY b.created_at, b.id`);
    return r.rows.map(b => ({ ...payloadNegocio(b), barbers: b.barbers, bookings: b.bookings }));
  }

  function info() {
    return {
      modo,
      negocio,
      listo: estado.listo,
      restriccionSolapes: modo === 'postgres' ? estado.restriccionSolapes : null,
      avisos: estado.avisos.slice()
    };
  }

  return {
    iniciar,
    leer,
    guardar,
    recargar,
    cargarNegocio,
    crearNegocio,
    listarNegocios,
    info,
    /* Uso interno de los scripts de migración. */
    _insertarTodo: insertarTodo,
    _migrar: migrar
  };
}

module.exports = {
  crearAlmacen,
  ErrorConflictoHorario,
  ErrorAlmacen,
  MIGRACIONES,
  validarNegocio
};
