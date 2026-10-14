#!/usr/bin/env node
'use strict';
/*
  Importa un respaldo (data/db.json o el respaldo del panel) a PostgreSQL.

  Uso:
    DATABASE_URL=... node scripts/migracion/importar.js <respaldo.json> [--negocio el-master]          # simulación
    DATABASE_URL=... node scripts/migracion/importar.js <respaldo.json> [--negocio el-master] --aplicar

  Reglas (nunca borra nada):
  - Registros que no existen en la base: se agregan.
  - Registros que solo vienen de la importación automática y nadie
    modificó después: se actualizan con la versión del respaldo.
  - Registros creados o modificados desde la aplicación: se conservan.
  - Reservas que chocarían con otra ya guardada: no se importan y se
    listan para revisarlas a mano.
  Sin --aplicar todo ocurre en una transacción que se deshace al final.
  Después de aplicar, reinicia el servicio para que cargue los datos.
*/
const { crearAlmacen } = require('../../almacen');
const { argumentos, crearPool, negocioDe, exigirEsquema, leerRespaldo, intervalosAproximados } = require('./comun');

async function main() {
  const { pos, op } = argumentos(process.argv.slice(2));
  if (!pos[0]) {
    console.log('Uso: node scripts/migracion/importar.js <respaldo.json> [--negocio el-master] [--aplicar]');
    process.exitCode = 2;
    return;
  }
  const negocio = negocioDe(op);
  const aplicar = op.aplicar === true;
  const { formato, db } = leerRespaldo(pos[0]);
  console.log(`Respaldo: ${pos[0]} (${formato})`);
  console.log(`Contenido: ${(db.barbers || []).length} barberos, ${(db.services || []).length} servicios, ${(db.bookings || []).length} reservas`);
  console.log(`Barbería destino: ${negocio} · Modo: ${aplicar ? 'APLICAR' : 'SIMULACIÓN (no se guarda nada)'}`);

  const pool = crearPool();
  try {
    await exigirEsquema(pool);
    const almacen = crearAlmacen({
      modo: 'postgres', pool, negocio, archivo: null,
      datosIniciales: () => ({}), intervalos: intervalosAproximados,
      registro: { log() {}, error: console.error }
    });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['master-reservas:negocio:' + negocio]);
      const resumen = await almacen._insertarTodo(client, negocio, db, 'respaldo', { comprobarSolapes: true, fusionar: true });
      if (aplicar) {
        await client.query('INSERT INTO data_imports (business_id, source, summary) VALUES ($1, $2, $3::jsonb)',
          [negocio, 'respaldo:' + require('node:path').basename(pos[0]), JSON.stringify(resumen)]);
        await client.query('COMMIT');
      } else {
        await client.query('ROLLBACK');
      }
      console.log('Resultado:');
      console.log(`  Nuevos: ${resumen.barbers} barberos, ${resumen.services} servicios, ${resumen.bookings} reservas, ${resumen.state} ajustes`);
      console.log(`  Actualizados (sin cambios posteriores en la app): ${resumen.actualizados}`);
      console.log(`  Conservados (ya existían o se modificaron en la app): ${resumen.conservados}`);
      if (resumen.conflictos.length) {
        console.log(`  NO importadas por choque de horario: ${resumen.conflictos.length}`);
        for (const c of resumen.conflictos) console.log(`    - ${c.id} · ${c.date} ${c.time} · barbero ${c.barberId}`);
      }
      console.log(aplicar
        ? 'Importación aplicada. Reinicia el servicio para que cargue los datos.'
        : 'Simulación terminada: no se guardó nada. Repite con --aplicar para importar.');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch(e => { console.error('ERROR:', e.message); process.exitCode = 1; });
