'use strict';
/* Utilidades compartidas por los scripts de migración. Nunca imprimen DATABASE_URL. */
const fs = require('node:fs');
const { Pool } = require('pg');
const { validarNegocio } = require('../../almacen');

function argumentos(argv) {
  const pos = [];
  const op = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) op[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) op[k] = argv[++i];
      else op[k] = true;
    } else {
      pos.push(a);
    }
  }
  return { pos, op };
}

function crearPool() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Define DATABASE_URL en el entorno (no la escribas en el repositorio).');
  const sslDesactivado = new URL(url).searchParams.get('sslmode') === 'disable';
  return new Pool({ connectionString: url, ssl: sslDesactivado ? false : { rejectUnauthorized: false }, max: 2 });
}

function negocioDe(op) {
  return validarNegocio(op.negocio || process.env.DEFAULT_BUSINESS_ID || 'el-master');
}

async function exigirEsquema(pool) {
  const r = await pool.query(`SELECT to_regclass('public.bookings') AS t, to_regclass('public.master_reservas_migrations') AS m`);
  if (!r.rows[0].t || !r.rows[0].m) {
    throw new Error('La base todavía no tiene las tablas de la fase 1. Despliega primero la nueva versión.');
  }
}

/* Horario por día (como lo guarda PUT /api/admin/hours) a partir de hoursConfig. */
function horasDesdeConfig(config) {
  const out = {};
  for (const [dia, d] of Object.entries(config || {})) {
    if (!d || d.open !== true) { out[dia] = []; continue; }
    out[dia] = d.breakFrom && d.breakTo
      ? [[d.from, d.breakFrom], [d.breakTo, d.to]]
      : [[d.from, d.to]];
  }
  return out;
}

/*
  Acepta dos formatos:
  - data/db.json
  - respaldo del panel (/api/admin/backup), que trae "settings" de
    PostgreSQL (no se importa: ya está en la base) y "agendaSettings".
*/
function leerRespaldo(archivo) {
  const crudo = JSON.parse(fs.readFileSync(archivo, 'utf8'));
  const esRespaldoPanel = crudo && crudo.generatedAt && 'hoursConfig' in crudo;
  if (!esRespaldoPanel) return { formato: 'db.json', db: crudo };
  const db = {
    business: crudo.business || {},
    barbers: crudo.barbers || [],
    services: crudo.services || [],
    schedule: crudo.schedule || {},
    bookings: crudo.bookings || []
  };
  if (crudo.hoursConfig && Object.keys(crudo.hoursConfig).length) {
    db.hoursConfig = crudo.hoursConfig;
    db.hours = crudo.hours && Object.keys(crudo.hours).length ? crudo.hours : horasDesdeConfig(crudo.hoursConfig);
  }
  if (crudo.agendaSettings) db.settings = crudo.agendaSettings;
  return { formato: 'respaldo del panel', db };
}

const aMin = hhmm => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };

/*
  Intervalos aproximados para la importación. Al arrancar, el servidor
  los recalcula con el motor real de reservas.
*/
function intervalosAproximados(db, b) {
  if (Array.isArray(b.people) && b.people.some(p => p.time && p.endTime)) {
    return b.people.filter(p => p.time && p.endTime).map(p => ({ start: aMin(p.time), end: aMin(p.endTime) }));
  }
  if (!b.time) return [];
  if (b.endTime && aMin(b.endTime) > aMin(b.time)) return [{ start: aMin(b.time), end: aMin(b.endTime) }];
  const ids = Array.isArray(b.serviceIds) && b.serviceIds.length ? b.serviceIds : [b.serviceId];
  const dur = ids.reduce((t, id) => t + (Number((db.services || []).find(s => s.id === id)?.duration) || 40), 0);
  return [{ start: aMin(b.time), end: aMin(b.time) + dur * (Number(b.cantidadPersonas) || 1) }];
}

module.exports = { argumentos, crearPool, negocioDe, exigirEsquema, leerRespaldo, intervalosAproximados, horasDesdeConfig };
