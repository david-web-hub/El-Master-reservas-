#!/usr/bin/env node
'use strict';
/*
  Compara un respaldo con lo guardado en PostgreSQL (solo lectura).

  Uso:
    DATABASE_URL=... node scripts/migracion/verificar.js <respaldo.json> [--negocio el-master]

  Sale con código 1 si falta algún barbero, servicio o reserva del respaldo.
*/
const { argumentos, crearPool, negocioDe, exigirEsquema, leerRespaldo } = require('./comun');

function ordenar(v) {
  if (Array.isArray(v)) return v.map(ordenar);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, ordenar(v[k])]));
  return v;
}
const igual = (a, b) => JSON.stringify(ordenar(a)) === JSON.stringify(ordenar(b));

async function main() {
  const { pos, op } = argumentos(process.argv.slice(2));
  if (!pos[0]) {
    console.log('Uso: node scripts/migracion/verificar.js <respaldo.json> [--negocio el-master]');
    process.exitCode = 2;
    return;
  }
  const negocio = negocioDe(op);
  const { db } = leerRespaldo(pos[0]);
  const pool = crearPool();
  let faltan = 0;
  try {
    await exigirEsquema(pool);
    const client = await pool.connect();
    try {
      await client.query('BEGIN TRANSACTION READ ONLY');
      for (const [col, tabla] of [['barbers', 'barbers'], ['services', 'services'], ['bookings', 'bookings']]) {
        const filas = (await client.query(`SELECT id, data FROM ${tabla} WHERE business_id = $1`, [negocio])).rows;
        const enBase = new Map(filas.map(f => [f.id, f.data]));
        let iguales = 0, distintos = 0, ausentes = [];
        for (const r of db[col] || []) {
          const d = enBase.get(String(r.id));
          if (!d) ausentes.push(String(r.id));
          else if (igual(d, r)) iguales++;
          else distintos++;
        }
        faltan += ausentes.length;
        console.log(`${col}: respaldo ${(db[col] || []).length} · base ${filas.length} · iguales ${iguales} · ` +
          `modificados después ${distintos} · FALTAN ${ausentes.length}${ausentes.length ? ' (' + ausentes.join(', ') + ')' : ''}`);
      }
      const estado = (await client.query('SELECT key FROM business_state WHERE business_id = $1 ORDER BY key', [negocio])).rows.map(r => r.key);
      console.log(`Ajustes de agenda guardados: ${estado.join(', ') || '(ninguno)'}`);
      const imp = (await client.query('SELECT source, created_at FROM data_imports WHERE business_id = $1 ORDER BY id', [negocio])).rows;
      for (const i of imp) console.log(`Importación: ${i.source} · ${i.created_at.toISOString()}`);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
  console.log(faltan ? `ATENCIÓN: faltan ${faltan} registros del respaldo` : 'Todo el contenido del respaldo está en la base.');
  process.exitCode = faltan ? 1 : 0;
}

main().catch(e => { console.error('ERROR:', e.message); process.exitCode = 1; });
