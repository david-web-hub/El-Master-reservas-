#!/usr/bin/env node
'use strict';
/*
  Deja la base de El Máster Reservas vacía para una instalación limpia.
  Borra SOLO las tablas de El Máster Reservas (las de la versión actual y,
  si existen, las de las fases 1 a 6). Nunca toca las del Panel Maestro
  (master_fade_*) ni ninguna otra tabla. Las credenciales de WhatsApp/Meta
  no están en la base (son variables de Render) y no se tocan.

  1) Ver qué se borraría (no cambia nada):
       DATABASE_URL=... node scripts/despliegue/limpiar-demo.js
  2) Ejecutar (solo con autorización, después de un respaldo):
       DATABASE_URL=... node scripts/despliegue/limpiar-demo.js --ejecutar \
         --confirmar <nombre exacto de la base> --respaldo respaldos/pg-<fecha>/base.dump

  Todo ocurre en una sola transacción: si algo falla, no se borra nada.
  Al arrancar, la versión nueva crea las tablas de nuevo, vacías.
*/
const fs = require('node:fs');
const { inventario, crearPool } = require('./inventario');

function argumentos(lista) {
  const op = {};
  for (let i = 0; i < lista.length; i++) {
    if (!lista[i].startsWith('--')) continue;
    const k = lista[i].slice(2);
    op[k] = lista[i + 1] && !lista[i + 1].startsWith('--') ? lista[++i] : true;
  }
  return op;
}

async function main() {
  const op = argumentos(process.argv.slice(2));
  const pool = crearPool();
  try {
    const antes = await inventario(pool);
    const borrar = antes.tablas.filter(t => t.clase === 'reservas-actual' || t.clase === 'reservas-nueva');
    const conservar = antes.tablas.filter(t => !borrar.includes(t));

    console.log(`Base: ${antes.base}`);
    console.log(`\nSe BORRARÍAN ${borrar.length} tablas de El Máster Reservas (datos de demostración):`);
    for (const t of borrar) console.log(`  - ${t.tabla.padEnd(30)} ${String(t.filas).padStart(8)} filas`);
    console.log(`\nSe CONSERVAN ${conservar.length} tablas:`);
    for (const t of conservar) console.log(`  = ${t.tabla.padEnd(30)} ${String(t.filas).padStart(8)} filas  (${t.clase})`);

    if (!op.ejecutar) {
      console.log('\nSimulación: no se cambió nada. Para ejecutar: --ejecutar --confirmar <base> --respaldo <archivo .dump>');
      return;
    }
    if (op.confirmar !== antes.base) throw new Error(`--confirmar debe ser exactamente el nombre de la base ("${antes.base}")`);
    if (typeof op.respaldo !== 'string' || !fs.existsSync(op.respaldo) || fs.statSync(op.respaldo).size === 0) {
      throw new Error('--respaldo debe indicar el archivo .dump del respaldo tomado antes (scripts/respaldo/respaldo-postgres.sh)');
    }
    if (!borrar.length) {
      console.log('\nNo hay tablas de El Máster Reservas: la base ya está limpia.');
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      /* Sin CASCADE: si alguna otra tabla dependiera de estas, falla y no se borra nada. */
      await client.query(`DROP TABLE ${borrar.map(t => client.escapeIdentifier(t.tabla)).join(', ')}`);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`no se borró nada: ${error.message}`);
    } finally {
      client.release();
    }

    /* Comprobación: las tablas conservadas siguen intactas. */
    const despues = await inventario(pool);
    for (const t of conservar) {
      const ahora = despues.tablas.find(x => x.tabla === t.tabla);
      if (!ahora || ahora.filas !== t.filas) throw new Error(`la tabla ${t.tabla} cambió; revisa la base`);
    }
    if (despues.tablas.some(t => t.clase === 'reservas-actual' || t.clase === 'reservas-nueva')) throw new Error('quedaron tablas de El Máster Reservas');
    console.log(`\nListo: ${borrar.length} tablas borradas; las ${conservar.length} conservadas siguen intactas.`);
  } finally {
    await pool.end();
  }
}

main().catch(e => { console.error('ERROR:', e.message); process.exitCode = 1; });
