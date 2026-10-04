require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const DB = path.join(__dirname, 'data', 'db.json');
const TZ = 'America/Guayaquil';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});

pool.query('SELECT NOW()')
  .then(() => {
    console.log('POSTGRESQL CONECTADO CORRECTAMENTE');
  })
  .catch((error) => {
    console.error('ERROR CONECTANDO POSTGRESQL:', error.message);
  });

async function initPostgres() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sales (
      id BIGSERIAL PRIMARY KEY,
      booking_id TEXT,
      customer_name TEXT,
      customer_phone TEXT,
      items JSONB NOT NULL DEFAULT '[]'::jsonb,
      total NUMERIC(10,2) NOT NULL DEFAULT 0,
      payment_method TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'paid',
      sale_date DATE NOT NULL DEFAULT CURRENT_DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS cash_sessions (
      id BIGSERIAL PRIMARY KEY,
      session_date DATE NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'open',
      opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at TIMESTAMPTZ,
      closing_total NUMERIC(10,2)
    );
  `);

  console.log('TABLAS DE CAJA LISTAS');
}

initPostgres().catch((error) => {
  console.error('ERROR INICIANDO TABLAS DE CAJA:', error.message);
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

/* =========================================================
   BASE DE DATOS
========================================================= */

function readDB() {
  return JSON.parse(fs.readFileSync(DB, 'utf8'));
}

function writeDB(data) {
  fs.writeFileSync(DB, JSON.stringify(data, null, 2), 'utf8');
}

/* =========================================================
   UTILIDADES GENERALES
========================================================= */

function normalizar(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function parseDateLocal(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function toHHMM(total) {
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(
    total % 60
  ).padStart(2, '0')}`;
}

function formatHora(hhmm) {
  if (!hhmm) return '';

  const [hh, mm] = hhmm.split(':').map(Number);
  const ap = hh >= 12 ? 'PM' : 'AM';

  let h = hh % 12;
  if (h === 0) h = 12;

  return `${h}:${String(mm).padStart(2, '0')} ${ap}`;
}

/* =========================================================
   FECHAS
========================================================= */

function localDateParts(offsetDays = 0) {
  const now = new Date();

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);

  const y = Number(parts.find(x => x.type === 'year').value);
  const m = Number(parts.find(x => x.type === 'month').value);
  const d = Number(parts.find(x => x.type === 'day').value);

  const utc = new Date(
    Date.UTC(y, m - 1, d + offsetDays, 12, 0, 0)
  );

  return utc.toISOString().slice(0, 10);
}

function dateFromSpanish(text) {
  const t = normalizar(text);

  if (/\bpasado manana\b/.test(t)) {
    return localDateParts(2);
  }

  if (/\bmanana\b/.test(t)) {
    return localDateParts(1);
  }

  if (/\bhoy\b/.test(t)) {
    return localDateParts(0);
  }

  const iso = t.match(
    /\b(20\d{2})-(\d{2})-(\d{2})\b/
  );

  if (iso) {
    return iso[0];
  }

  const dm = t.match(
    /\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](20\d{2}))?\b/
  );

  if (dm) {
    const year =
      dm[3] || localDateParts().slice(0, 4);

    return `${year}-${String(dm[2]).padStart(
      2,
      '0'
    )}-${String(dm[1]).padStart(2, '0')}`;
  }

  const weekdays = {
    domingo: 0,
    lunes: 1,
    martes: 2,
    miercoles: 3,
    jueves: 4,
    viernes: 5,
    sabado: 6
  };

  for (const [name, target] of Object.entries(weekdays)) {
    if (new RegExp(`\\b${name}\\b`).test(t)) {
      const base = new Date(
        localDateParts() + 'T12:00:00-05:00'
      );

      const current = base.getDay();

      let add = (target - current + 7) % 7;

      if (add === 0) {
        add = 7;
      }

      return localDateParts(add);
    }
  }

  return null;
}

/* =========================================================
   NÚMEROS Y CANTIDAD DE TURNOS
========================================================= */

const NUMEROS = {
  un: 1,
  uno: 1,
  una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10
};

function numeroNatural(value) {
  const t = normalizar(value).trim();

  if (/^\d+$/.test(t)) {
    return Number(t);
  }

  return NUMEROS[t] || null;
}

function extraerCantidadPersonas(
  text,
  allowBareNumber = false
) {
  const t = normalizar(text).trim();

  const numero =
    '(\\d+|un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)';

  const patterns = [
    new RegExp(
      `\\b${numero}\\s+(?:personas?|turnos?|citas?)\\b`
    ),
    new RegExp(
      `\\b(?:somos|seremos|para|necesito|quiero|deseo)\\s+${numero}\\s*(?:personas?|turnos?|citas?)?\\b`
    )
  ];

  for (const re of patterns) {
    const match = t.match(re);

    if (match) {
      const n = numeroNatural(match[1]);

      if (n) {
        return Math.min(
          10,
          Math.max(1, n)
        );
      }
    }
  }

  if (allowBareNumber) {
    const n = numeroNatural(t);

    if (n) {
      return Math.min(
        10,
        Math.max(1, n)
      );
    }
  }

  return null;
}

/* =========================================================
   SERVICIOS
========================================================= */

function findServiceFromText(text, db) {
  const t = normalizar(text);

  if (
    /corte.*barba.*disen|corte.*disen.*barba|barba.*corte.*disen/.test(
      t
    )
  ) {
    return db.services.find(
      s => s.id === 'corte-barba-diseno'
    );
  }

  if (/corte.*barba|barba.*corte/.test(t)) {
    return db.services.find(
      s => s.id === 'corte-barba'
    );
  }

  if (/corte.*disen|disen.*corte/.test(t)) {
    return db.services.find(
      s => s.id === 'corte-diseno'
    );
  }

  if (/\bbarba\b/.test(t)) {
    return db.services.find(
      s => s.id === 'barba'
    );
  }

  if (/\bdisen/.test(t)) {
    return db.services.find(
      s => s.id === 'diseno'
    );
  }

  if (/\bcorte\b/.test(t)) {
    return db.services.find(
      s => s.id === 'corte'
    );
  }

  return null;
}

function findBarberFromText(text, db) {
  const t = normalizar(text);

  return db.barbers.find(
    barber =>
      t.includes(normalizar(barber.name))
  );
}

function serviceDuration(db, serviceId) {
  return (
    db.services.find(
      service => service.id === serviceId
    )?.duration || 40
  );
}

/* =========================================================
   NUEVO MODELO: SERVICIO POR PERSONA
========================================================= */

function crearPersonas(cantidad) {
  const personas = [];

  for (let i = 0; i < cantidad; i++) {
    personas.push({
      index: i + 1,
      serviceId: null,
      duration: null,
      time: null,
      endTime: null
    });
  }

  return personas;
}

function actualizarDuracionPersona(db, persona) {
  if (!persona || !persona.serviceId) {
    return persona;
  }

  persona.duration = serviceDuration(
    db,
    persona.serviceId
  );

  return persona;
}

function todasPersonasConServicio(personas = []) {
  return (
    personas.length > 0 &&
    personas.every(
      persona =>
        persona.serviceId &&
        Number(persona.duration) > 0
    )
  );
}

function duracionTotalPersonas(personas = []) {
  return personas.reduce(
    (total, persona) =>
      total + (Number(persona.duration) || 0),
    0
  );
}

/* =========================================================
   HORAS Y DETECCIÓN DE HORARIO
========================================================= */

function extractRequestedTime(text) {
  const t = normalizar(text).trim();

  const match = t.match(
    /\b(?:a\s+las?\s+|para\s+las?\s+|desde\s+las?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.?\s*m\.?|p\.?\s*m\.?|de la manana|de la tarde|de la noche)?\b/i
  );

  if (!match) {
    return null;
  }

  let hour = Number(match[1]);
  const minutes = Number(match[2] || 0);
  const period = normalizar(match[3] || '');

  if (
    (
      period.includes('pm') ||
      period.includes('p.') ||
      period.includes('tarde') ||
      period.includes('noche')
    ) &&
    hour < 12
  ) {
    hour += 12;
  }

  if (
    (
      period.includes('am') ||
      period.includes('a.') ||
      period.includes('manana')
    ) &&
    hour === 12
  ) {
    hour = 0;
  }

  /*
   * En el contexto de la barbería:
   * "a las 4" normalmente significa 4 PM.
   */
  if (!period && hour >= 1 && hour <= 7) {
    hour += 12;
  }

  if (
    hour > 23 ||
    minutes > 59
  ) {
    return null;
  }

  return `${String(hour).padStart(
    2,
    '0'
  )}:${String(minutes).padStart(2, '0')}`;
}

/* =========================================================
   COMPATIBILIDAD CON RESERVAS ANTERIORES
========================================================= */

function reservationDuration(
  db,
  serviceId,
  cantidadPersonas = 1
) {
  return (
    serviceDuration(db, serviceId) *
    Math.max(
      1,
      Number(cantidadPersonas) || 1
    )
  );
}

function bookingDuration(db, booking) {
  if (
    booking.endTime &&
    booking.time
  ) {
    const duration =
      toMinutes(booking.endTime) -
      toMinutes(booking.time);

    if (duration > 0) {
      return duration;
    }
  }

  /*
   * Reservas nuevas de grupo.
   */
  if (
    Array.isArray(booking.people) &&
    booking.people.length
  ) {
    return duracionTotalPersonas(
      booking.people
    );
  }

  /*
   * Reservas antiguas.
   */
  return reservationDuration(
    db,
    booking.serviceId,
    booking.cantidadPersonas || 1
  );
}

/* =========================================================
   OCUPACIÓN DE AGENDA
========================================================= */

function getBookingsForDay(
  db,
  date,
  barberId
) {
  return db.bookings.filter(
    booking =>
      booking.date === date &&
      booking.barberId === barberId &&
      booking.status !== 'cancelled'
  );
}

function bookingIntervals(
  db,
  booking
) {
  /*
   * Las reservas nuevas pueden guardar
   * un horario individual para cada persona.
   */
  if (
    Array.isArray(booking.people) &&
    booking.people.length
  ) {
    const intervals = booking.people
      .filter(
        person =>
          person.time &&
          person.endTime
      )
      .map(person => ({
        start: toMinutes(person.time),
        end: toMinutes(person.endTime)
      }));

    if (intervals.length) {
      return intervals;
    }
  }

  /*
   * Compatibilidad con las reservas
   * creadas antes de esta actualización.
   */
  if (booking.time) {
    const start = toMinutes(
      booking.time
    );

    const duration =
      bookingDuration(db, booking);

    return [
      {
        start,
        end: start + duration
      }
    ];
  }

  return [];
}

function occupiedIntervals(
  db,
  date,
  barberId
) {
  const bookings =
    getBookingsForDay(
      db,
      date,
      barberId
    );

  const intervals = [];

  for (const booking of bookings) {
    intervals.push(
      ...bookingIntervals(
        db,
        booking
      )
    );
  }

  return intervals;
}

function overlapsAny(
  start,
  end,
  intervals = []
) {
  return intervals.some(
    interval =>
      start < interval.end &&
      end > interval.start
  );
}

/* =========================================================
   HORARIO DEL BARBERO
========================================================= */

function getSchedulePeriods(
  db,
  date,
  barberId
) {
  const barber = db.barbers.find(
    b =>
      b.id === barberId &&
      b.active !== false
  );

  if (!barber) {
    return [];
  }

  const jsDay =
    parseDateLocal(date).getUTCDay();

  return (
    barber.schedule?.[
      String(jsDay)
    ] || []
  );
}

function intervalInsideSchedule(
  periods,
  start,
  end
) {
  return periods.some(
    ([from, to]) => {
      const periodStart =
        toMinutes(from);

      const periodEnd =
        toMinutes(to);

      return (
        start >= periodStart &&
        end <= periodEnd
      );
    }
  );
}

/* =========================================================
   DISPONIBILIDAD INDIVIDUAL
========================================================= */

function isIntervalAvailable(
  db,
  date,
  barberId,
  start,
  duration,
  extraIntervals = []
) {
  const periods =
    getSchedulePeriods(
      db,
      date,
      barberId
    );

  const end =
    start + duration;

  if (
    !intervalInsideSchedule(
      periods,
      start,
      end
    )
  ) {
    return false;
  }

  const occupied = [
    ...occupiedIntervals(
      db,
      date,
      barberId
    ),
    ...extraIntervals
  ];

  return !overlapsAny(
    start,
    end,
    occupied
  );
}

function availableStartsForDuration(
  db,
  date,
  barberId,
  duration
) {
  const periods =
    getSchedulePeriods(
      db,
      date,
      barberId
    );

  const occupied =
    occupiedIntervals(
      db,
      date,
      barberId
    );

  const results = [];
  const step = 5;

  for (const [from, to] of periods) {
    const start =
      toMinutes(from);

    const finish =
      toMinutes(to);

    for (
      let minute = start;
      minute + duration <= finish;
      minute += step
    ) {
      if (
        !overlapsAny(
          minute,
          minute + duration,
          occupied
        )
      ) {
        results.push(
          toHHMM(minute)
        );
      }
    }
  }

  return results;
}

/* =========================================================
   TURNOS CONSECUTIVOS
========================================================= */

function buildConsecutivePlan(
  db,
  date,
  barberId,
  people,
  requestedStart
) {
  if (
    !Array.isArray(people) ||
    !people.length ||
    !requestedStart
  ) {
    return null;
  }

  let cursor =
    toMinutes(requestedStart);

  const plan = [];
  const tentativeIntervals = [];

  for (const originalPerson of people) {
    const person = {
      ...originalPerson
    };

    const duration =
      Number(person.duration) ||
      serviceDuration(
        db,
        person.serviceId
      );

    const start = cursor;
    const end =
      start + duration;

    if (
      !isIntervalAvailable(
        db,
        date,
        barberId,
        start,
        duration,
        tentativeIntervals
      )
    ) {
      return null;
    }

    person.duration = duration;
    person.time =
      toHHMM(start);
    person.endTime =
      toHHMM(end);

    plan.push(person);

    tentativeIntervals.push({
      start,
      end
    });

    cursor = end;
  }

  return plan;
}

function findConsecutiveStarts(
  db,
  date,
  barberId,
  people
) {
  if (
    !Array.isArray(people) ||
    !people.length
  ) {
    return [];
  }

  const periods =
    getSchedulePeriods(
      db,
      date,
      barberId
    );

  const totalDuration =
    duracionTotalPersonas(
      people
    );

  const results = [];
  const step = 5;

  for (const [from, to] of periods) {
    const periodStart =
      toMinutes(from);

    const periodEnd =
      toMinutes(to);

    for (
      let minute = periodStart;
      minute + totalDuration <=
        periodEnd;
      minute += step
    ) {
      const start =
        toHHMM(minute);

      const plan =
        buildConsecutivePlan(
          db,
          date,
          barberId,
          people,
          start
        );

      if (plan) {
        results.push(start);
      }
    }
  }

  return results;
}

/* =========================================================
   TURNOS SEPARADOS
========================================================= */

function buildSeparatedPlan(
  db,
  date,
  barberId,
  people,
  preferredStart = null
) {
  if (
    !Array.isArray(people) ||
    !people.length
  ) {
    return null;
  }

  const plan = [];
  const tentativeIntervals = [];

  let preferredMinutes =
    preferredStart
      ? toMinutes(preferredStart)
      : null;

  for (const originalPerson of people) {
    const person = {
      ...originalPerson
    };

    const duration =
      Number(person.duration) ||
      serviceDuration(
        db,
        person.serviceId
      );

    const periods =
      getSchedulePeriods(
        db,
        date,
        barberId
      );

    const candidates = [];
    const step = 5;

    for (const [from, to] of periods) {
      const periodStart =
        toMinutes(from);

      const periodEnd =
        toMinutes(to);

      for (
        let minute = periodStart;
        minute + duration <=
          periodEnd;
        minute += step
      ) {
        if (
          isIntervalAvailable(
            db,
            date,
            barberId,
            minute,
            duration,
            tentativeIntervals
          )
        ) {
          candidates.push(minute);
        }
      }
    }

    if (!candidates.length) {
      return null;
    }

    if (
      preferredMinutes !== null
    ) {
      candidates.sort(
        (a, b) =>
          Math.abs(
            a - preferredMinutes
          ) -
          Math.abs(
            b - preferredMinutes
          )
      );
    }

    const selected =
      candidates[0];

    const end =
      selected + duration;

    person.duration = duration;
    person.time =
      toHHMM(selected);
    person.endTime =
      toHHMM(end);

    plan.push(person);

    tentativeIntervals.push({
      start: selected,
      end
    });

    /*
     * La siguiente persona se intenta
     * colocar después de la anterior,
     * pero puede saltar a otro hueco.
     */
    preferredMinutes = end;
  }

  return plan;
}

/* =========================================================
   OPCIONES CERCANAS
========================================================= */

function nearestSlots(
  slots,
  requested,
  limit = 4
) {
  if (!Array.isArray(slots)) {
    return [];
  }

  if (!requested) {
    return slots.slice(
      0,
      limit
    );
  }

  const target =
    toMinutes(requested);

  return [...slots]
    .sort((a, b) => {
      const distanceA =
        Math.abs(
          toMinutes(a) - target
        );

      const distanceB =
        Math.abs(
          toMinutes(b) - target
        );

      if (
        distanceA !== distanceB
      ) {
        return (
          distanceA -
          distanceB
        );
      }

      return (
        toMinutes(a) -
        toMinutes(b)
      );
    })
    .slice(0, limit);
}

/* =========================================================
   LISTADO Y DETECCIÓN DE SERVICIOS
========================================================= */

function formatServiceList(db) {
  return db.services
    .map(
      (service, index) =>
        `${index + 1}. ${service.name} · $${service.price}`
    )
    .join('\n');
}

function serviceByOption(text, db) {
  const value = String(text || '').trim();

  if (!/^\d+$/.test(value)) {
    return null;
  }

  const index = Number(value) - 1;

  if (
    index < 0 ||
    index >= db.services.length
  ) {
    return null;
  }

  return db.services[index];
}

function detectarServicioPersona(
  text,
  db
) {
  return (
    serviceByOption(text, db) ||
    findServiceFromText(text, db)
  );
}

/* =========================================================
   SERVICIOS POR PERSONA - LENGUAJE NATURAL
========================================================= */

function numeroOrdinal(text) {
  const t = normalizar(text);

  const values = {
    primero: 1,
    primera: 1,
    uno: 1,
    segundo: 2,
    segunda: 2,
    dos: 2,
    tercero: 3,
    tercera: 3,
    tres: 3,
    cuarto: 4,
    cuarta: 4,
    cuatro: 4,
    quinto: 5,
    quinta: 5,
    cinco: 5,
    sexto: 6,
    sexta: 6,
    seis: 6,
    septimo: 7,
    septima: 7,
    siete: 7,
    octavo: 8,
    octava: 8,
    ocho: 8,
    noveno: 9,
    novena: 9,
    nueve: 9,
    decimo: 10,
    decima: 10,
    diez: 10
  };

  for (
    const [word, value]
    of Object.entries(values)
  ) {
    if (
      new RegExp(
        `\\b${word}\\b`
      ).test(t)
    ) {
      return value;
    }
  }

  const numeric = t.match(
    /\b(?:persona|turno)\s*(\d{1,2})\b/
  );

  if (numeric) {
    return Number(numeric[1]);
  }

  return null;
}

function splitPersonAssignments(text) {
  const t = normalizar(text)
    .replace(/\s+/g, ' ')
    .trim();

  /*
   * Divide frases del estilo:
   * "el primero corte y barba y el segundo solo corte"
   * sin romper "corte y barba".
   */
  const marker =
    /\b(?:el|la)?\s*(primero|primera|segundo|segunda|tercero|tercera|cuarto|cuarta|quinto|quinta|sexto|sexta|septimo|septima|octavo|octava|noveno|novena|decimo|decima|persona\s*\d+|turno\s*\d+)\b/g;

  const matches = [
    ...t.matchAll(marker)
  ];

  if (!matches.length) {
    return [];
  }

  const pieces = [];

  for (
    let i = 0;
    i < matches.length;
    i++
  ) {
    const current = matches[i];

    const start =
      current.index;

    const end =
      i + 1 < matches.length
        ? matches[i + 1].index
        : t.length;

    pieces.push(
      t.slice(start, end).trim()
    );
  }

  return pieces;
}

function parsePersonAssignments(
  text,
  db,
  cantidad
) {
  const pieces =
    splitPersonAssignments(text);

  if (!pieces.length) {
    return null;
  }

  const assignments = [];

  for (const piece of pieces) {
    const index =
      numeroOrdinal(piece);

    const service =
      findServiceFromText(
        piece,
        db
      );

    if (
      !index ||
      !service ||
      index < 1 ||
      index > cantidad
    ) {
      return null;
    }

    assignments.push({
      index,
      serviceId: service.id,
      duration:
        serviceDuration(
          db,
          service.id
        )
    });
  }

  const unique =
    new Map();

  for (
    const assignment
    of assignments
  ) {
    unique.set(
      assignment.index,
      assignment
    );
  }

  if (
    unique.size !== cantidad
  ) {
    return null;
  }

  const result = [];

  for (
    let index = 1;
    index <= cantidad;
    index++
  ) {
    const assignment =
      unique.get(index);

    if (!assignment) {
      return null;
    }

    result.push({
      index,
      serviceId:
        assignment.serviceId,
      duration:
        assignment.duration,
      time: null,
      endTime: null
    });
  }

  return result;
}

function hasMultipleDifferentServices(
  text,
  db
) {
  const t = normalizar(text);

  const found = [];

  if (/\bcorte\b/.test(t)) {
    found.push('corte');
  }

  if (/\bbarba\b/.test(t)) {
    found.push('barba');
  }

  if (/\bdisen/.test(t)) {
    found.push('diseno');
  }

  /*
   * Una frase como "corte y barba"
   * puede ser un paquete válido para una sola persona.
   * Esta función se usa principalmente para detectar
   * ambigüedad cuando existen varias personas.
   */
  return found.length > 1;
}

function aplicarServiciosAUnaPersona(
  db,
  personas,
  personIndex,
  service
) {
  const person =
    personas.find(
      p =>
        p.index === personIndex
    );

  if (!person || !service) {
    return false;
  }

  person.serviceId =
    service.id;

  person.duration =
    serviceDuration(
      db,
      service.id
    );

  person.time = null;
  person.endTime = null;

  return true;
}

/* =========================================================
   DESCRIPCIÓN DE PERSONAS
========================================================= */

function nombreServicio(
  db,
  serviceId
) {
  return (
    db.services.find(
      service =>
        service.id === serviceId
    )?.name || 'Servicio'
  );
}

function descripcionPersonas(
  db,
  people = [],
  includeTimes = false
) {
  return people
    .map(person => {
      const serviceName =
        nombreServicio(
          db,
          person.serviceId
        );

      let line =
        `👤 Turno ${person.index}: ${serviceName}`;

      if (person.duration) {
        line +=
          ` · ${person.duration} min`;
      }

      if (
        includeTimes &&
        person.time &&
        person.endTime
      ) {
        line +=
          ` · ${formatHora(person.time)} – ${formatHora(person.endTime)}`;
      }

      return line;
    })
    .join('\n');
}

/* =========================================================
   PLANES DE HORARIOS
========================================================= */

function planStart(plan = []) {
  if (!plan.length) {
    return null;
  }

  return plan[0].time || null;
}

function planEnd(plan = []) {
  if (!plan.length) {
    return null;
  }

  return (
    plan[
      plan.length - 1
    ].endTime || null
  );
}

function planIsConsecutive(
  plan = []
) {
  if (plan.length <= 1) {
    return true;
  }

  for (
    let i = 1;
    i < plan.length;
    i++
  ) {
    if (
      plan[i - 1].endTime !==
      plan[i].time
    ) {
      return false;
    }
  }

  return true;
}

function clonePlan(plan = []) {
  return plan.map(
    person => ({
      ...person
    })
  );
}

function samePlan(
  a = [],
  b = []
) {
  if (
    a.length !== b.length
  ) {
    return false;
  }

  return a.every(
    (person, index) =>
      person.time ===
        b[index]?.time &&
      person.endTime ===
        b[index]?.endTime &&
      person.serviceId ===
        b[index]?.serviceId
  );
}

function formatPlanOption(
  db,
  plan,
  label = null
) {
  const lines = [];

  if (label) {
    lines.push(label);
  }

  for (const person of plan) {
    lines.push(
      `Turno ${person.index}: ` +
      `${nombreServicio(
        db,
        person.serviceId
      )} · ` +
      `${formatHora(
        person.time
      )} – ` +
      `${formatHora(
        person.endTime
      )}`
    );
  }

  return lines.join('\n');
}

/* =========================================================
   GENERACIÓN DE OPCIONES DE GRUPO
========================================================= */

function generateGroupOptions(
  db,
  date,
  barberId,
  people,
  requestedTime
) {
  const options = [];

  /*
   * OPCIÓN 1:
   * Intentar exactamente la hora solicitada
   * con todos los turnos consecutivos.
   */
  if (requestedTime) {
    const exactConsecutive =
      buildConsecutivePlan(
        db,
        date,
        barberId,
        people,
        requestedTime
      );

    if (exactConsecutive) {
      options.push({
        type: 'consecutive',
        plan:
          exactConsecutive
      });
    }
  }

  /*
   * OPCIONES CONSECUTIVAS CERCANAS.
   */
  const consecutiveStarts =
    findConsecutiveStarts(
      db,
      date,
      barberId,
      people
    );

  const nearby =
    nearestSlots(
      consecutiveStarts,
      requestedTime,
      4
    );

  for (const start of nearby) {
    const plan =
      buildConsecutivePlan(
        db,
        date,
        barberId,
        people,
        start
      );

    if (!plan) {
      continue;
    }

    if (
      !options.some(
        option =>
          samePlan(
            option.plan,
            plan
          )
      )
    ) {
      options.push({
        type: 'consecutive',
        plan
      });
    }
  }

  /*
   * OPCIÓN SEPARADA:
   * Si existen huecos individuales,
   * se aprovechan aunque no formen
   * un bloque continuo.
   */
  const separated =
    buildSeparatedPlan(
      db,
      date,
      barberId,
      people,
      requestedTime
    );

  if (
    separated &&
    !options.some(
      option =>
        samePlan(
          option.plan,
          separated
        )
    )
  ) {
    options.push({
      type:
        planIsConsecutive(
          separated
        )
          ? 'consecutive'
          : 'separated',
      plan: separated
    });
  }

  /*
   * Máximo cuatro alternativas
   * para no llenar WhatsApp.
   */
  return options.slice(0, 4);
}

function groupOptionsMessage(
  db,
  options
) {
  if (!options.length) {
    return '';
  }

  return options
    .map(
      (option, index) => {
        const title =
          option.type ===
          'separated'
            ? `*${index + 1}. TURNOS SEPARADOS*`
            : `*${index + 1}. TURNOS SEGUIDOS*`;

        return formatPlanOption(
          db,
          option.plan,
          title
        );
      }
    )
    .join('\n\n');
}

/* =========================================================
   CANCELACIÓN Y CIERRE GLOBAL
========================================================= */

function esCancelarGlobal(text) {
  const t =
    normalizar(text);

  return (
    /\b(cancelar|cancela|cancelalo|cancelarla|cancelar reserva|cancelar cita|cancelar turno|salir)\b/.test(
      t
    ) ||
    /\bya no quiero reservar\b/.test(
      t
    ) ||
    /\bno quiero reservar\b/.test(
      t
    )
  );
}

function esCierreSocial(text) {
  const t =
    normalizar(text);

  return (
    /\b(gracias|muchas gracias|eso es todo|nada mas|ya no necesito|no necesito mas|hasta luego|chao|adios|buen dia)\b/.test(
      t
    )
  );
}

function esConfirmar(text) {
  return (
    normalizar(text).trim() ===
    'confirmar'
  );
}

function esEditar(text) {
  const t =
    normalizar(text);

  return (
    /\b(editar|modificar|cambiar)\b/.test(
      t
    )
  );
}

/* =========================================================
   SESIONES DE WHATSAPP
========================================================= */

const waSessions =
  new Map();

function resetSession(from) {
  waSessions.delete(from);
}

function getSession(from) {
  return (
    waSessions.get(from) || {
      step: 'idle',
      data: {}
    }
  );
}

function saveSession(
  from,
  session
) {
  waSessions.set(
    from,
    session
  );
}

function ensureBarber(
  session,
  db
) {
  const active =
    db.barbers.filter(
      barber =>
        barber.active !== false
    );

  if (
    !session.data.barberId &&
    active.length === 1
  ) {
    session.data.barberId =
      active[0].id;
  }

  return session;
}

/* =========================================================
   CREAR / RECREAR PERSONAS DE SESIÓN
========================================================= */

function ensurePeople(
  session,
  db
) {
  const cantidad =
    Math.max(
      1,
      Number(
        session.data
          .cantidadPersonas
      ) || 1
    );

  if (
    !Array.isArray(
      session.data.people
    ) ||
    session.data.people.length !==
      cantidad
  ) {
    session.data.people =
      crearPersonas(
        cantidad
      );
  }

  /*
   * Para una sola persona podemos
   * reutilizar serviceId si ya se detectó.
   */
  if (
    cantidad === 1 &&
    session.data.serviceId
  ) {
    const person =
      session.data.people[0];

    person.serviceId =
      session.data.serviceId;

    actualizarDuracionPersona(
      db,
      person
    );
  }

  return session.data.people;
}

/* =========================================================
   SIGUIENTE PERSONA SIN SERVICIO
========================================================= */

function nextPersonWithoutService(
  people = []
) {
  return (
    people.find(
      person =>
        !person.serviceId
    ) || null
  );
}

/* =========================================================
   MENSAJES DEL FLUJO
========================================================= */

function pedirCantidad(from, session) {
  session.step = 'people';
  saveSession(from, session);

  return sendWhatsApp(
    from,
  '👥 ¿Cuántos turnos necesitas reservar?'
     
  );
}

function pedirServicioPersona(
  from,
  db,
  session
) {
  const people =
    ensurePeople(
      session,
      db
    );

  const person =
    nextPersonWithoutService(
      people
    );

  if (!person) {
    return pedirSiguienteDato(
      from,
      db,
      session
    );
  }

  session.step =
    'person_service';

  session.data
    .currentPersonIndex =
    person.index;

  saveSession(
    from,
    session
  );

  const cantidad =
    session.data
      .cantidadPersonas || 1;

  let intro = '';

  if (cantidad === 1) {
    intro =
      '✂️ ¿Qué servicio necesitas?\n\n';
  } else {
    intro =
      `✂️ ¿Qué servicio necesita la persona ${person.index} de ${cantidad}?\n\n`;
  }

  return sendWhatsApp(
    from,
    intro +
    formatServiceList(db)
  );
}

function pedirFecha(
  from,
  session
) {
  session.step = 'date';
  saveSession(from, session);

  return sendWhatsApp(
  from,
  '📅 ¿Para qué día necesitas la reserva?'
);
}

function pedirBarbero(
  from,
  db,
  session
) {
  const active =
    db.barbers.filter(
      barber =>
        barber.active !== false
    );

  session.step = 'barber';
  saveSession(from, session);

  return sendWhatsApp(
    from,
    '💈 ¿Con qué barbero deseas reservar?\n\n' +
    active
      .map(
        (barber, index) =>
          `${index + 1}. ${barber.name}`
      )
      .join('\n')
  );
}

function pedirHora(
  from,
  session
) {
  session.step = 'time';
  delete session.data.lastGroupOptions;

  saveSession(from, session);

return sendWhatsApp(
  from,
  '🕐 ¿A qué hora te gustaría comenzar?'
);
}

function pedirNombre(
  from,
  session
) {
  session.step = 'name';
  saveSession(from, session);

  return sendWhatsApp(
    from,
    'Perfecto 👌 ¿A nombre de quién ' +
    'registro la reserva?'
  );
}

/* =========================================================
   APLICAR PLAN DE HORARIOS
========================================================= */

function aplicarPlan(
  session,
  plan
) {
  session.data.people =
    clonePlan(plan);

  session.data.time =
    planStart(plan);

  session.data.endTime =
    planEnd(plan);

  session.data.scheduleType =
    planIsConsecutive(plan)
      ? 'consecutive'
      : 'separated';

  delete session.data
    .lastGroupOptions;

  return session;
}

/* =========================================================
   BUSCAR HORARIOS PARA LA RESERVA
========================================================= */

async function procesarHoraSolicitada(
  from,
  db,
  session,
  requestedTime
) {
  const people =
    ensurePeople(
      session,
      db
    );

  if (
    !todasPersonasConServicio(
      people
    )
  ) {
    return pedirServicioPersona(
      from,
      db,
      session
    );
  }

  const options =
    generateGroupOptions(
      db,
      session.data.date,
      session.data.barberId,
      people,
      requestedTime
    );

  if (!options.length) {
    session.step = 'time';
    session.data.requestedTime =
      requestedTime;

    saveSession(
      from,
      session
    );

    return sendWhatsApp(
      from,
      '😕 No encontré horarios suficientes ' +
      'para completar todos los turnos ese día.\n\n' +
      'Puedes decirme otra hora o escribir ' +
      '“cambiar día”.'
    );
  }

  /*
   * Si el horario solicitado permite
   * exactamente el plan consecutivo,
   * lo tomamos directamente.
   */
  const exact =
    options.find(
      option =>
        option.type ===
          'consecutive' &&
        planStart(
          option.plan
        ) === requestedTime
    );

  if (exact) {
    aplicarPlan(
      session,
      exact.plan
    );

    session.step = 'flow';

    saveSession(
      from,
      session
    );

    return pedirSiguienteDato(
      from,
      db,
      session
    );
  }

  /*
   * Si no cabe exactamente, mostramos
   * opciones seguidas y/o separadas.
   */
  session.step =
    'group_options';

  session.data.requestedTime =
    requestedTime;

  session.data.lastGroupOptions =
    options;

  saveSession(
    from,
    session
  );

  return sendWhatsApp(
    from,
    `A las ${formatHora(
      requestedTime
    )} no puedo completar todos los turnos ` +
    'exactamente como los pediste.\n\n' +
    'Estas son las mejores opciones disponibles:\n\n' +
    groupOptionsMessage(
      db,
      options
    ) +
    '\n\nResponde con el número de la opción que prefieras.'
  );
}

/* =========================================================
   SIGUIENTE DATO DEL FLUJO
========================================================= */

async function pedirSiguienteDato(
  from,
  db,
  session
) {
  const cantidad =
    Number(
      session.data
        .cantidadPersonas
    ) || 0;

  if (!cantidad) {
    return pedirCantidad(
      from,
      session
    );
  }

  ensurePeople(
    session,
    db
  );

  if (
    !todasPersonasConServicio(
      session.data.people
    )
  ) {
    return pedirServicioPersona(
      from,
      db,
      session
    );
  }

  if (!session.data.date) {
    return pedirFecha(
      from,
      session
    );
  }

  ensureBarber(
    session,
    db
  );

  if (!session.data.barberId) {
    return pedirBarbero(
      from,
      db,
      session
    );
  }

  const peopleHaveTimes =
    session.data.people.every(
      person =>
        person.time &&
        person.endTime
    );

  if (!peopleHaveTimes) {
    if (
      session.data.requestedTime
    ) {
      return procesarHoraSolicitada(
        from,
        db,
        session,
        session.data
          .requestedTime
      );
    }

    return pedirHora(
      from,
      session
    );
  }

  if (!session.data.name) {
    return pedirNombre(
      from,
      session
    );
  }

  return mostrarResumen(
    from,
    db,
    session
  );
}

/* =========================================================
   RESUMEN FINAL
========================================================= */

function mostrarResumen(
  from,
  db,
  session
) {
  const barberName =
    db.barbers.find(
      barber =>
        barber.id ===
        session.data.barberId
    )?.name || 'Master';

  const people =
    session.data.people || [];

  const scheduleLabel =
    planIsConsecutive(
      people
    )
      ? 'Turnos seguidos'
      : 'Turnos separados';

  session.step = 'confirm';

  saveSession(
    from,
    session
  );

  return sendWhatsApp(
    from,
    '📋 *Resumen de tu reserva*\n\n' +
    `👤 Nombre: ${session.data.name}\n` +
    `👥 Turnos: ${people.length}\n` +
    `💈 Barbero: ${barberName}\n` +
    `📅 Fecha: ${session.data.date}\n` +
    `🗓️ Modalidad: ${scheduleLabel}\n\n` +
    descripcionPersonas(
      db,
      people,
      true
    ) +
    '\n\n¿Qué deseas hacer?\n' +
    '✅ *CONFIRMAR* — guardar la reserva\n' +
    '✏️ *EDITAR* — modificarla\n' +
    '❌ *CANCELAR* — cancelar el proceso'
  );
}

/* =========================================================
   REVALIDACIÓN ANTES DE GUARDAR
========================================================= */

function planStillAvailable(
  db,
  date,
  barberId,
  people
) {
  const tentative = [];

  for (const person of people) {
    if (
      !person.time ||
      !person.endTime ||
      !person.serviceId
    ) {
      return false;
    }

    const start =
      toMinutes(
        person.time
      );

    const duration =
      Number(
        person.duration
      ) ||
      serviceDuration(
        db,
        person.serviceId
      );

    if (
      !isIntervalAvailable(
        db,
        date,
        barberId,
        start,
        duration,
        tentative
      )
    ) {
      return false;
    }

    tentative.push({
      start,
      end:
        start + duration
    });
  }

  return true;
}

/* =========================================================
   GUARDAR RESERVA DE WHATSAPP
========================================================= */

function crearBookingDesdeSesion(
  db,
  from,
  session
) {
  const people =
    clonePlan(
      session.data.people || []
    );

  const first =
    people[0];

  const booking = {
    id: `BK-${Date.now()}`,
    name:
      session.data.name,
    phone: from,

    /*
     * Estos campos se mantienen para
     * compatibilidad con el panel y
     * funciones anteriores.
     */
    serviceId:
      first?.serviceId || null,

    cantidadPersonas:
      people.length || 1,

    barberId:
      session.data.barberId,

    date:
      session.data.date,

    time:
      first?.time || null,

    endTime:
      planEnd(people),

    /*
     * Nuevo detalle completo.
     */
    people,

    scheduleType:
      planIsConsecutive(
        people
      )
        ? 'consecutive'
        : 'separated',

    source: 'whatsapp',
    status: 'confirmed',
    createdAt:
      new Date().toISOString()
  };

  return booking;
}

function confirmacionBooking(
  db,
  booking
) {
  const barberName =
    db.barbers.find(
      barber =>
        barber.id ===
        booking.barberId
    )?.name || 'Master';

  const modalidad =
    booking.scheduleType ===
      'separated'
      ? 'Turnos separados'
      : 'Turnos seguidos';

  return (
    '✅ *¡Reserva confirmada!*\n\n' +
    `👤 ${booking.name}\n` +
    `👥 ${booking.people.length} turno${
      booking.people.length === 1
        ? ''
        : 's'
    }\n` +
    `💈 ${barberName}\n` +
    `📅 ${booking.date}\n` +
    `🗓️ ${modalidad}\n\n` +
    descripcionPersonas(
      db,
      booking.people,
      true
    ) +
    '\n\n' +
    `Código: ${booking.id}\n\n` +
    'Cuando necesites otra reserva, ' +
    'escríbeme “quiero reservar”. 💈'
  );
}

/* =========================================================
   EDICIÓN
========================================================= */

function campoEditar(text) {
  const t =
    normalizar(text);

  if (
    /\b(dia|fecha)\b/.test(t)
  ) {
    return 'date';
  }

  if (
    /\b(hora|horario)\b/.test(t)
  ) {
    return 'time';
  }

  if (
    /\b(servicio|servicios|corte|barba|diseno)\b/.test(
      t
    )
  ) {
    return 'service';
  }

  if (
    /\b(persona|personas|turno|turnos|cantidad)\b/.test(
      t
    )
  ) {
    return 'people';
  }

  if (
    /\b(barbero|barbera)\b/.test(
      t
    )
  ) {
    return 'barber';
  }

  if (
    /\bnombre\b/.test(t)
  ) {
    return 'name';
  }

  return null;
}

function limpiarHorarios(
  session
) {
  if (
    Array.isArray(
      session.data.people
    )
  ) {
    for (
      const person
      of session.data.people
    ) {
      person.time = null;
      person.endTime = null;
    }
  }

  session.data.time = null;
  session.data.endTime = null;

  delete session.data
    .lastGroupOptions;

  return session;
}

/* =========================================================
   RUTAS API DE LA WEB
========================================================= */

app.get(
  '/api/config',
  (req, res) => {
    const db = readDB();

    res.json({
      services: db.services,
      barbers: db.barbers,
      gallery: db.gallery
    });
  }
);

app.get(
  '/api/bookings',
  (req, res) => {
    res.json(
      readDB().bookings
    );
  }
);

app.get(
  '/api/availability',
  (req, res) => {
    const {
      date,
      barberId,
      serviceId
    } = req.query;

    if (
      !date ||
      !barberId ||
      !serviceId
    ) {
      return res
        .status(400)
        .json({
          error:
            'date, barberId y serviceId son obligatorios'
        });
    }

    const db = readDB();

    const duration =
      serviceDuration(
        db,
        serviceId
      );

    const slots =
      availableStartsForDuration(
        db,
        date,
        barberId,
        duration
      );

    res.json({
      date,
      barberId,
      serviceId,
      slots
    });
  }
);

app.post(
  '/api/bookings',
  (req, res) => {
    const {
      name,
      phone,
      serviceId,
      barberId,
      date,
      time,
      source = 'web'
    } = req.body;

    if (
      !name ||
      !phone ||
      !serviceId ||
      !barberId ||
      !date ||
      !time
    ) {
      return res
        .status(400)
        .json({
          error:
            'Faltan datos obligatorios'
        });
    }

    const db = readDB();

    const duration =
      serviceDuration(
        db,
        serviceId
      );

    const available =
      isIntervalAvailable(
        db,
        date,
        barberId,
        toMinutes(time),
        duration
      );

    if (!available) {
      return res
        .status(409)
        .json({
          error:
            'Ese horario acaba de ocuparse. Elige otro.'
        });
    }

    const endTime =
      toHHMM(
        toMinutes(time) +
        duration
      );

    const booking = {
      id: `BK-${Date.now()}`,
      name,
      phone,
      serviceId,
      barberId,
      date,
      time,
      endTime,
      cantidadPersonas: 1,
      people: [
        {
          index: 1,
          serviceId,
          duration,
          time,
          endTime
        }
      ],
      scheduleType:
        'consecutive',
      source,
      status: 'confirmed',
      createdAt:
        new Date().toISOString()
    };

    db.bookings.push(
      booking
    );

    writeDB(db);

    return res
      .status(201)
      .json(booking);
  }
);

app.patch(
  '/api/bookings/:id',
  (req, res) => {
    const db = readDB();

    const booking =
      db.bookings.find(
        item =>
          item.id ===
          req.params.id
      );

    if (!booking) {
      return res
        .status(404)
        .json({
          error:
            'Reserva no encontrada'
        });
    }

    Object.assign(
      booking,
      req.body
    );

    writeDB(db);

    res.json(booking);
  }
);

/* =========================================================
   VERIFICACIÓN WEBHOOK WHATSAPP
========================================================= */

app.get(
  '/webhooks/whatsapp',
  (req, res) => {
    const mode =
      req.query['hub.mode'];

    const token =
      req.query[
        'hub.verify_token'
      ];

    const challenge =
      req.query[
        'hub.challenge'
      ];

    if (
      mode === 'subscribe' &&
      token ===
        process.env
          .WHATSAPP_VERIFY_TOKEN
    ) {
      return res
        .status(200)
        .send(challenge);
    }

    return res.sendStatus(403);
  }
);

/* =========================================================
   ENVIAR MENSAJES WHATSAPP
========================================================= */

async function sendWhatsApp(
  to,
  body
) {
  const token =
    process.env.WHATSAPP_TOKEN;

  const phoneId =
    process.env
      .WHATSAPP_PHONE_NUMBER_ID;

  const version =
    process.env
      .WHATSAPP_GRAPH_VERSION ||
    'v23.0';

  if (
    !token ||
    !phoneId
  ) {
    console.log(
      '[DEMO WhatsApp]',
      to,
      body
    );

    return;
  }

  const response =
    await fetch(
      `https://graph.facebook.com/${version}/${phoneId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization:
            `Bearer ${token}`,
          'Content-Type':
            'application/json'
        },
        body: JSON.stringify({
          messaging_product:
            'whatsapp',
          to,
          type: 'text',
          text: {
            body
          }
        })
      }
    );

  if (!response.ok) {
    const errorText =
      await response.text();

    console.error(
      'Error enviando WhatsApp:',
      response.status,
      errorText
    );
  }
}

/* =========================================================
   WEBHOOK PRINCIPAL DE WHATSAPP
========================================================= */

app.post(
  '/webhooks/whatsapp',
  async (req, res) => {
    console.log(
      'WEBHOOK WHATSAPP RECIBIDO'
    );

    /*
     * Respondemos rápido a Meta para evitar
     * reintentos del mismo mensaje.
     */
    res.sendStatus(200);

    try {
      const value =
        req.body?.entry?.[0]
          ?.changes?.[0]?.value;

      const msg =
        value?.messages?.[0];

      if (!msg) {
        return;
      }

      const from = msg.from;

      const text =
        (
          msg.text?.body || ''
        ).trim();

      if (!text) {
        return sendWhatsApp(
          from,
          'Por ahora puedo ayudarte por texto. ' +
          'Escríbeme qué necesitas reservar. 💈'
        );
      }

      const lower =
        normalizar(text);

      const db = readDB();

      let session =
        getSession(from);

      /* =====================================================
         CANCELAR DESDE CUALQUIER PUNTO
      ===================================================== */

      if (
        esCancelarGlobal(text)
      ) {
        resetSession(from);

        return sendWhatsApp(
          from,
          '❌ Listo. El proceso de reserva quedó cancelado.\n\n' +
          'No se guardó ninguna cita. Cuando quieras comenzar otra, ' +
          'escríbeme “quiero reservar”. 💈'
        );
      }

      /* =====================================================
         CIERRE SOCIAL
      ===================================================== */

      if (
        esCierreSocial(text) &&
        session.step !==
          'confirm'
      ) {
        resetSession(from);

        return sendWhatsApp(
          from,
          '😊 ¡Con gusto! Fue un placer atenderte.\n\n' +
          'Cuando necesites otra cita, escríbeme “quiero reservar”. 💈'
        );
      }

      /* =====================================================
         CONFIRMACIÓN FINAL
      ===================================================== */

      if (
        session.step ===
        'confirm'
      ) {
        if (
          esEditar(text)
        ) {
          session.step =
            'edit';

          delete session.data
            .editField;

          saveSession(
            from,
            session
          );

          const directField =
            campoEditar(text);

          if (directField) {
            session.data
              .editField =
              directField;

            saveSession(
              from,
              session
            );

            return pedirCampoEdicion(
              from,
              db,
              session,
              directField
            );
          }

          return sendWhatsApp(
            from,
            '✏️ Claro. ¿Qué deseas editar?\n\n' +
            'Puedes escribir:\n' +
            '• día\n' +
            '• hora\n' +
            '• servicio\n' +
            '• personas\n' +
            '• barbero\n' +
            '• nombre'
          );
        }

        if (
          !esConfirmar(text)
        ) {
          return sendWhatsApp(
            from,
            'Responde *CONFIRMAR*, *EDITAR* o *CANCELAR* para continuar.'
          );
        }

        /*
         * Volvemos a leer la base justo
         * antes de guardar para evitar
         * dobles reservas.
         */
        const fresh =
          readDB();

        const people =
          session.data.people || [];

        if (
          !planStillAvailable(
            fresh,
            session.data.date,
            session.data.barberId,
            people
          )
        ) {
          limpiarHorarios(
            session
          );

          session.data
            .requestedTime =
            null;

          session.step =
            'time';

          saveSession(
            from,
            session
          );

          return sendWhatsApp(
            from,
            '⚠️ Uno de esos horarios acaba de ocuparse antes de confirmar.\n\n' +
            'Dime otra hora y buscaré nuevamente opciones para todos los turnos.'
          );
        }

        const booking =
          crearBookingDesdeSesion(
            fresh,
            from,
            session
          );

        fresh.bookings.push(
          booking
        );

        writeDB(fresh);

        resetSession(from);

        return sendWhatsApp(
          from,
          confirmacionBooking(
            fresh,
            booking
          )
        );
      }

      /* =====================================================
         FLUJO DE EDICIÓN
      ===================================================== */

      if (
        session.step ===
        'edit'
      ) {
        if (
          !session.data.editField
        ) {
          const field =
            campoEditar(text);

          if (!field) {
            return sendWhatsApp(
              from,
              'Dime qué deseas cambiar: ' +
              '*día*, *hora*, *servicio*, *personas*, *barbero* o *nombre*.'
            );
          }

          session.data.editField =
            field;

          saveSession(
            from,
            session
          );

          return pedirCampoEdicion(
            from,
            db,
            session,
            field
          );
        }

        return procesarEdicion(
          from,
          db,
          session,
          text
        );
      }

      /* =====================================================
         SALUDO
      ===================================================== */

      const greeting =
        /^(hola|buenas|buenos dias|buenas tardes|buenas noches|hey|ola)\b/.test(
          lower
        );

      const reservationIntent =
        /\b(reserv|agend|cita|turno|corte|barba|diseno)\b/.test(
          lower
        );

      if (
        greeting &&
        session.step ===
          'idle' &&
        !reservationIntent
      ) {
        return sendWhatsApp(
          from,
          '👋 ¡Hola! Bienvenido a El Máster 💈\n\n' +
          'Con gusto puedo ayudarte.\n' +
          'Dime cuántos turnos deseas reservar.'
        );
      }

      /* =====================================================
         INICIO DE NUEVA RESERVA
      ===================================================== */

      if (
        session.step ===
          'idle' &&
        (
          reservationIntent ||
          /\b(quiero|necesito|deseo).*(reserv|cita|turno)\b/.test(
            lower
          )
        )
      ) {
        session = {
          step: 'flow',
          data: {}
        };

        saveSession(
          from,
          session
        );
      }

      /*
       * Si el cliente escribió cualquier mensaje
       * estando sin sesión, iniciamos el flujo
       * en vez de dejarlo sin respuesta.
       */
      if (
        session.step ===
        'idle'
      ) {
        session = {
          step: 'flow',
          data: {}
        };

        saveSession(
          from,
          session
        );
      }

      /* =====================================================
         CANTIDAD DE PERSONAS
      ===================================================== */

      if (
        session.step ===
        'people'
      ) {
        const cantidad =
          extraerCantidadPersonas(
            text,
            true
          );

        if (
          !cantidad ||
          cantidad < 1 ||
          cantidad > 10
        ) {
          return sendWhatsApp(
            from,
            '👥 Indícame cuántos turnos necesitas, entre 1 y 10.'
          );
        }

        session.data
          .cantidadPersonas =
          cantidad;

        session.data.people =
          crearPersonas(
            cantidad
          );

        delete session.data
          .serviceId;

        limpiarHorarios(
          session
        );

        session.step =
          'flow';

        saveSession(
          from,
          session
        );

        return pedirSiguienteDato(
          from,
          db,
          session
        );
      }

      /* =====================================================
         SERVICIO DE CADA PERSONA
      ===================================================== */

      if (
        session.step ===
        'person_service'
      ) {
        const people =
          ensurePeople(
            session,
            db
          );

        const currentIndex =
          session.data
            .currentPersonIndex ||
          nextPersonWithoutService(
            people
          )?.index;

        /*
         * Antes de interpretar un número como
         * servicio, intentamos reconocer una frase
         * completa del tipo:
         *
         * "el primero corte y barba y
         *  el segundo solo corte"
         */
        if (
          session.data
            .cantidadPersonas > 1
        ) {
          const assignments =
            parsePersonAssignments(
              text,
              db,
              session.data
                .cantidadPersonas
            );

          if (assignments) {
            session.data.people =
              assignments;

            delete session.data
              .currentPersonIndex;

            limpiarHorarios(
              session
            );

            session.step =
              'flow';

            saveSession(
              from,
              session
            );

            return pedirSiguienteDato(
              from,
              db,
              session
            );
          }

          /*
           * Si hay varias personas y el cliente
           * escribe una frase ambigua como:
           * "un corte y una barba",
           * no asumimos quién quiere qué.
           */
          if (
            hasMultipleDifferentServices(
              text,
              db
            ) &&
            !numeroOrdinal(text)
          ) {
            return sendWhatsApp(
              from,
              'Para no equivocarme necesito saber qué servicio corresponde a cada persona. 👍\n\n' +
              'Por ejemplo:\n' +
              '“El primero corte y el segundo barba”\n\n' +
              'o dime ahora solamente el servicio de la persona ' +
              `${currentIndex}.`
            );
          }
        }

        const service =
          detectarServicioPersona(
            text,
            db
          );

        if (!service) {
          return sendWhatsApp(
            from,
            '✂️ No pude reconocer ese servicio.\n\n' +
            formatServiceList(db) +
            '\n\nResponde con el número o escribe el servicio.'
          );
        }

        aplicarServiciosAUnaPersona(
          db,
          people,
          currentIndex,
          service
        );

        /*
         * Compatibilidad con reserva individual.
         */
        if (
          people.length === 1
        ) {
          session.data.serviceId =
            service.id;
        }

        delete session.data
          .currentPersonIndex;

        limpiarHorarios(
          session
        );

        session.step =
          'flow';

        saveSession(
          from,
          session
        );

        return pedirSiguienteDato(
          from,
          db,
          session
        );
      }

      /* =====================================================
         FECHA
      ===================================================== */

      if (
        session.step ===
        'date'
      ) {
        const date =
          dateFromSpanish(text);

        if (!date) {
          return sendWhatsApp(
            from,
            '📅 No pude reconocer esa fecha.\n\n' +
            'Puedes decir “mañana”, “viernes” o escribir una fecha.'
          );
        }

        session.data.date =
          date;

        limpiarHorarios(
          session
        );

        session.step =
          'flow';

        saveSession(
          from,
          session
        );

        return pedirSiguienteDato(
          from,
          db,
          session
        );
      }

      /* =====================================================
         BARBERO
      ===================================================== */

      if (
        session.step ===
        'barber'
      ) {
        const active =
          db.barbers.filter(
            barber =>
              barber.active !==
              false
          );

        let chosen = null;

        if (
          /^\d+$/.test(
            text.trim()
          )
        ) {
          chosen =
            active[
              Number(
                text.trim()
              ) - 1
            ];
        }

        if (!chosen) {
          chosen =
            findBarberFromText(
              text,
              db
            );
        }

        if (!chosen) {
          return pedirBarbero(
            from,
            db,
            session
          );
        }

        session.data.barberId =
          chosen.id;

        limpiarHorarios(
          session
        );

        session.step =
          'flow';

        saveSession(
          from,
          session
        );

        return pedirSiguienteDato(
          from,
          db,
          session
        );
      }

      /* =====================================================
         HORA
      ===================================================== */

      if (
        session.step ===
        'time'
      ) {
        /*
         * Permitir cambiar el día directamente.
         */
        if (
          /\b(cambiar|otro).*(dia|fecha)\b/.test(
            lower
          )
        ) {
          session.data.date =
            null;

          session.data
            .requestedTime =
            null;

          limpiarHorarios(
            session
          );

          return pedirFecha(
            from,
            session
          );
        }

        const requested =
          extractRequestedTime(
            text
          );

        if (!requested) {
          return sendWhatsApp(
            from,
            '🕐 Dime una hora, por ejemplo “3 PM”, “4:10” o “a las 5 de la tarde”.'
          );
        }

        session.data
          .requestedTime =
          requested;

        saveSession(
          from,
          session
        );

        return procesarHoraSolicitada(
          from,
          db,
          session,
          requested
        );
      }

      /* =====================================================
         ELEGIR OPCIÓN DE HORARIOS
      ===================================================== */

      if (
        session.step ===
        'group_options'
      ) {
        const options =
          session.data
            .lastGroupOptions ||
          [];

        const selectedNumber =
          /^\d+$/.test(
            text.trim()
          )
            ? Number(
                text.trim()
              )
            : null;

        if (
          !selectedNumber ||
          selectedNumber < 1 ||
          selectedNumber >
            options.length
        ) {
          /*
           * También puede escribir otra hora
           * en vez de escoger una opción.
           */
          const anotherTime =
            extractRequestedTime(
              text
            );

          if (anotherTime) {
            session.data
              .requestedTime =
              anotherTime;

            return procesarHoraSolicitada(
              from,
              db,
              session,
              anotherTime
            );
          }

          return sendWhatsApp(
            from,
            'Responde con el número de la opción que prefieras, ' +
            'o dime otra hora.'
          );
        }

        const selected =
          options[
            selectedNumber - 1
          ];

        aplicarPlan(
          session,
          selected.plan
        );

        session.step =
          'flow';

        saveSession(
          from,
          session
        );

        return pedirSiguienteDato(
          from,
          db,
          session
        );
      }

      /* =====================================================
         NOMBRE
      ===================================================== */

      if (
        session.step ===
        'name'
      ) {
        if (
          text.length < 2
        ) {
          return sendWhatsApp(
            from,
            'Dime el nombre con el que deseas registrar la reserva.'
          );
        }

        session.data.name =
          text.trim();

        session.step =
          'flow';

        saveSession(
          from,
          session
        );

        return pedirSiguienteDato(
          from,
          db,
          session
        );
      }

      /* =====================================================
         FLUJO GENERAL
      ===================================================== */

      return pedirSiguienteDato(
        from,
        db,
        session
      );

    } catch (error) {
      console.error(
        'WhatsApp webhook error:',
        error
      );
    }
  }
);

/* =========================================================
   MENSAJES PARA EDICIÓN
========================================================= */

function pedirCampoEdicion(
  from,
  db,
  session,
  field
) {
  if (
    field === 'people'
  ) {
    return sendWhatsApp(
      from,
      '👥 ¿Cuántos turnos necesitas ahora? Puedes elegir de 1 a 10.'
    );
  }

  if (
    field === 'date'
  ) {
    return sendWhatsApp(
      from,
      '📅 Dime la nueva fecha. Por ejemplo: “mañana” o “viernes”.'
    );
  }

  if (
    field === 'time'
  ) {
    return sendWhatsApp(
      from,
      '🕐 Dime la nueva hora. Por ejemplo: “3 PM” o “4:10”.'
    );
  }

  if (
    field === 'service'
  ) {
    return sendWhatsApp(
      from,
      '✂️ Vamos a cambiar los servicios.\n\n' +
      'Te preguntaré nuevamente el servicio de cada turno.'
    );
  }

  if (
    field === 'barber'
  ) {
    const active =
      db.barbers.filter(
        barber =>
          barber.active !== false
      );

    return sendWhatsApp(
      from,
      '💈 Elige el nuevo barbero:\n\n' +
      active
        .map(
          (barber, index) =>
            `${index + 1}. ${barber.name}`
        )
        .join('\n')
    );
  }

  if (
    field === 'name'
  ) {
    return sendWhatsApp(
      from,
      '👤 Dime el nuevo nombre para la reserva.'
    );
  }

  return sendWhatsApp(
    from,
    'Dime el nuevo dato.'
  );
}

/* =========================================================
   PROCESAR EDICIÓN
========================================================= */

async function procesarEdicion(
  from,
  db,
  session,
  text
) {
  const field =
    session.data.editField;

  if (
    field === 'people'
  ) {
    const cantidad =
      extraerCantidadPersonas(
        text,
        true
      );

    if (
      !cantidad ||
      cantidad < 1 ||
      cantidad > 10
    ) {
      return sendWhatsApp(
        from,
        'Indícame una cantidad entre 1 y 10.'
      );
    }

    session.data
      .cantidadPersonas =
      cantidad;

    session.data.people =
      crearPersonas(
        cantidad
      );

    delete session.data
      .serviceId;

    limpiarHorarios(
      session
    );

    delete session.data
      .editField;

    session.step =
      'flow';

    saveSession(
      from,
      session
    );

    return pedirSiguienteDato(
      from,
      db,
      session
    );
  }

  if (
    field === 'date'
  ) {
    const date =
      dateFromSpanish(text);

    if (!date) {
      return sendWhatsApp(
        from,
        'No pude reconocer esa fecha. Puedes decir “mañana”, “viernes” o una fecha.'
      );
    }

    session.data.date =
      date;

    session.data
      .requestedTime =
      null;

    limpiarHorarios(
      session
    );
  }

  if (
    field === 'time'
  ) {
    const time =
      extractRequestedTime(
        text
      );

    if (!time) {
      return sendWhatsApp(
        from,
        'No pude reconocer esa hora. Por ejemplo: “3 PM” o “15:30”.'
      );
    }

    session.data
      .requestedTime =
      time;

    limpiarHorarios(
      session
    );
  }

  if (
    field === 'service'
  ) {
    /*
     * Reiniciamos únicamente los servicios.
     * Conservamos cantidad, fecha, barbero y nombre.
     */
    const cantidad =
      session.data
        .cantidadPersonas || 1;

    session.data.people =
      crearPersonas(
        cantidad
      );

    delete session.data
      .serviceId;

    limpiarHorarios(
      session
    );

    delete session.data
      .editField;

    session.step =
      'flow';

    saveSession(
      from,
      session
    );

    return pedirSiguienteDato(
      from,
      db,
      session
    );
  }

  if (
    field === 'barber'
  ) {
    const active =
      db.barbers.filter(
        barber =>
          barber.active !== false
      );

    let chosen = null;

    if (
      /^\d+$/.test(
        text.trim()
      )
    ) {
      chosen =
        active[
          Number(
            text.trim()
          ) - 1
        ];
    }

    if (!chosen) {
      chosen =
        findBarberFromText(
          text,
          db
        );
    }

    if (!chosen) {
      return pedirCampoEdicion(
        from,
        db,
        session,
        'barber'
      );
    }

    session.data.barberId =
      chosen.id;

    limpiarHorarios(
      session
    );
  }

  if (
    field === 'name'
  ) {
    if (
      text.trim().length < 2
    ) {
      return sendWhatsApp(
        from,
        'Dime un nombre válido para la reserva.'
      );
    }

    session.data.name =
      text.trim();
  }

  delete session.data
    .editField;

  session.step =
    'flow';

  saveSession(
    from,
    session
  );

  return pedirSiguienteDato(
    from,
    db,
    session
  );
}

/* =========================================================
   INICIAR SERVIDOR
========================================================= */

app.listen(
  PORT,
  () => {
    console.log(
      `Barbería: http://localhost:${PORT}`
    );
  }
);
