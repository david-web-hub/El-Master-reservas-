#!/usr/bin/env node
'use strict';
/*
  Exporta la agenda de una barbería desde PostgreSQL al formato de
  data/db.json (solo lectura). Sirve como respaldo adicional y para
  volver a la versión anterior si fuera necesario.

  Uso:
    DATABASE_URL=... node scripts/migracion/exportar.js <salida.json> [--negocio el-master]
*/
const fs = require('node:fs');
const { argumentos, crearPool, negocioDe, exigirEsquema } = require('./comun');

async function main() {
  const { pos, op } = argumentos(process.argv.slice(2));
  if (!pos[0]) {
    console.log('Uso: node scripts/migracion/exportar.js <salida.json> [--negocio el-master]');
    process.exitCode = 2;
    return;
  }
  if (fs.existsSync(pos[0])) throw new Error(`${pos[0]} ya existe; elige otro nombre (no se sobrescribe).`);
  const negocio = negocioDe(op);
  const pool = crearPool();
  try {
    await exigirEsquema(pool);
    const client = await pool.connect();
    try {
      await client.query('BEGIN TRANSACTION READ ONLY');
      const db = {};
      for (const r of (await client.query('SELECT key, data FROM business_state WHERE business_id = $1 ORDER BY key', [negocio])).rows) db[r.key] = r.data;
      db.barbers = (await client.query('SELECT data FROM barbers WHERE business_id = $1 ORDER BY position, created_at, id', [negocio])).rows.map(r => r.data);
      db.services = (await client.query('SELECT data FROM services WHERE business_id = $1 ORDER BY position, created_at, id', [negocio])).rows.map(r => r.data);
      db.bookings = (await client.query('SELECT data FROM bookings WHERE business_id = $1 ORDER BY seq', [negocio])).rows.map(r => r.data);
      await client.query('ROLLBACK');
      fs.writeFileSync(pos[0], JSON.stringify(db, null, 2), { mode: 0o600 });
      console.log(`Exportado ${pos[0]}: ${db.barbers.length} barberos, ${db.services.length} servicios, ${db.bookings.length} reservas`);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch(e => { console.error('ERROR:', e.message); process.exitCode = 1; });
