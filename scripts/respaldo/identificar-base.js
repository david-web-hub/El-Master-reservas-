#!/usr/bin/env node
'use strict';
/*
  Identifica, SOLO LECTURA, la base PostgreSQL a la que apunta DATABASE_URL.

  Uso (en la Shell de Render de cada servicio, o en local con la URL externa):
    node scripts/respaldo/identificar-base.js > huella-reservas.json
  Comparar las huellas de las dos aplicaciones:
    node scripts/respaldo/identificar-base.js comparar huella-reservas.json huella-panel.json

  No imprime usuario, contraseña ni host: el host se muestra como huella SHA-256.
  Abre una transacción READ ONLY, así que no puede modificar nada.
*/
const crypto = require('node:crypto');
const fs = require('node:fs');

const huella = v => crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 16);

async function identificar() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL no está definida en este entorno');
  const { Client } = require('pg');
  const destino = new URL(url);
  const sslMode = destino.searchParams.get('sslmode');
  const client = new Client({
    connectionString: url,
    ssl: sslMode === 'disable' ? false : { rejectUnauthorized: false },
    statement_timeout: 15000
  });
  await client.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    const info = (await client.query(`
      SELECT current_database() AS base,
             current_user AS usuario,
             version() AS version,
             inet_server_port() AS puerto,
             pg_database_size(current_database()) AS bytes,
             now() AS fecha`)).rows[0];
    /* pg_control_system() puede requerir permisos de superusuario (Render no los da). */
    await client.query('SAVEPOINT sid');
    try {
      info.system_identifier = (await client.query('SELECT system_identifier::text AS s FROM pg_control_system()')).rows[0].s;
    } catch {
      await client.query('ROLLBACK TO SAVEPOINT sid');
      info.system_identifier = null;
    }
    const tablas = (await client.query(`
      SELECT table_schema AS esquema, table_name AS tabla
      FROM information_schema.tables
      WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY 1, 2`)).rows;
    for (const t of tablas) {
      const q = `SELECT count(*)::bigint AS n FROM ${client.escapeIdentifier(t.esquema)}.${client.escapeIdentifier(t.tabla)}`;
      t.filas = Number((await client.query(q)).rows[0].n);
    }
    await client.query('ROLLBACK');
    const conocidas = {
      masterReservas: ['sales', 'cash_sessions', 'products', 'admin_settings', 'media_assets', 'businesses', 'bookings', 'barbers', 'services'],
      panelMaestro: ['master_fade_plans', 'master_fade_plan_changes']
    };
    const nombres = new Set(tablas.map(t => t.tabla));
    return {
      generado: new Date().toISOString(),
      servicioRender: process.env.RENDER_SERVICE_NAME || null,
      huellaHost: huella(destino.hostname + ':' + (destino.port || 5432)),
      huellaUsuario: huella(info.usuario),
      base: info.base,
      systemIdentifier: info.system_identifier,
      version: info.version,
      tamanoMB: Math.round(Number(info.bytes) / 1048576 * 10) / 10,
      sslmode: sslMode || '(no indicado; el servidor fuerza SSL)',
      contieneTablasDe: Object.fromEntries(Object.entries(conocidas).map(([k, v]) => [k, v.filter(x => nombres.has(x))])),
      tablas
    };
  } finally {
    await client.end();
  }
}

function comparar(a, b) {
  const x = JSON.parse(fs.readFileSync(a, 'utf8'));
  const y = JSON.parse(fs.readFileSync(b, 'utf8'));
  /* system_identifier identifica el servidor aunque se use la URL interna en un servicio y la externa en otro. */
  const mismoServidor = x.systemIdentifier && y.systemIdentifier
    ? x.systemIdentifier === y.systemIdentifier
    : x.huellaHost === y.huellaHost;
  if (!x.systemIdentifier || !y.systemIdentifier) {
    console.log('Aviso: sin system_identifier se compara por host; la URL interna y la externa de Render tienen hosts distintos.');
  }
  const mismaBase = mismoServidor && x.base === y.base;
  console.log(`Mismo servidor PostgreSQL: ${mismoServidor ? 'SÍ' : 'NO'}`);
  console.log(`Misma base de datos:       ${mismaBase ? 'SÍ (comparten PostgreSQL)' : 'NO'}`);
  console.log(`Mismo usuario:             ${x.huellaUsuario === y.huellaUsuario ? 'SÍ' : 'NO'}`);
  if (mismaBase) {
    const ta = new Set(x.tablas.map(t => `${t.esquema}.${t.tabla}`));
    console.log('Tablas que ven ambas:', y.tablas.map(t => `${t.esquema}.${t.tabla}`).filter(t => ta.has(t)).join(', ') || '(ninguna)');
  }
}

const [modo, a, b] = process.argv.slice(2);
if (modo === 'comparar') {
  comparar(a, b);
} else {
  identificar()
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch(e => { console.error('No se pudo identificar la base:', e.message); process.exitCode = 1; });
}
