#!/usr/bin/env node
'use strict';
/*
  Inventario de SOLO LECTURA de la base a la que apunta DATABASE_URL.
  Clasifica cada tabla y cuenta sus filas. No muestra datos, contraseñas,
  correos ni la dirección de la base: solo nombres de tablas y cantidades.

    DATABASE_URL=... node scripts/despliegue/inventario.js [--json]

  Clases:
    reservas-actual  Tablas que crea la versión que hoy está en producción
                     (main): ventas, caja, productos, configuración e imágenes.
                     La versión nueva las reutiliza (con business_id).
    reservas-nueva   Tablas de las fases 1 a 6 (agenda, cuentas, plataforma).
    panel            Tablas del Panel Maestro (master_fade_*).
    otra             Cualquier otra tabla. Nunca se toca.
*/
const { Pool } = require('pg');

const RESERVAS_ACTUAL = ['sales', 'cash_sessions', 'products', 'admin_settings', 'media_assets'];
const RESERVAS_NUEVA = [
  'master_reservas_migrations', 'businesses', 'business_state', 'barbers', 'services', 'bookings', 'booking_slots',
  'data_imports', 'platform_events', 'platform_plans', 'users', 'memberships', 'sessions', 'password_resets',
  'auth_events', 'email_verifications', 'totp_recovery_codes', 'login_challenges', 'invitations'
];

function clase(tabla) {
  if (RESERVAS_ACTUAL.includes(tabla)) return 'reservas-actual';
  if (RESERVAS_NUEVA.includes(tabla)) return 'reservas-nueva';
  if (tabla.startsWith('master_fade_')) return 'panel';
  return 'otra';
}

function crearPool() {
  if (!process.env.DATABASE_URL) throw new Error('Define DATABASE_URL');
  const sinSsl = /sslmode=disable/.test(process.env.DATABASE_URL);
  return new Pool({ connectionString: process.env.DATABASE_URL, ssl: sinSsl ? false : { rejectUnauthorized: false }, max: 1 });
}

async function inventario(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    const base = (await client.query('SELECT current_database() AS nombre, version() AS version')).rows[0];
    const tablas = (await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`)).rows.map(r => r.table_name);
    const filas = [];
    for (const t of tablas) {
      const n = (await client.query(`SELECT count(*)::int AS n FROM ${client.escapeIdentifier(t)}`)).rows[0].n;
      filas.push({ tabla: t, clase: clase(t), filas: n });
    }
    const resumen = {};
    for (const f of filas) resumen[f.clase] = (resumen[f.clase] || 0) + 1;
    /* Detalle útil sin datos personales: barberías y cuentas (solo cantidades). */
    const extra = {};
    if (tablas.includes('businesses')) {
      extra.barberias = (await client.query(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'active')::int AS activas FROM businesses`)).rows[0];
    }
    if (tablas.includes('users')) extra.cuentas = (await client.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
    if (tablas.includes('master_fade_admins')) extra.administradoresPanel = (await client.query('SELECT count(*)::int AS n FROM master_fade_admins')).rows[0].n;
    await client.query('ROLLBACK');
    return {
      base: base.nombre,
      postgres: base.version.split(' ').slice(0, 2).join(' '),
      fecha: new Date().toISOString(),
      compartidaConPanel: Boolean(resumen.panel && (resumen['reservas-actual'] || resumen['reservas-nueva'])),
      resumen,
      extra,
      tablas: filas
    };
  } finally {
    client.release();
  }
}

async function main() {
  const pool = crearPool();
  try {
    const inv = await inventario(pool);
    if (process.argv.includes('--json')) return console.log(JSON.stringify(inv, null, 2));
    console.log(`Base: ${inv.base} · ${inv.postgres} · ${inv.fecha}`);
    console.log(`Compartida con el Panel Maestro: ${inv.compartidaConPanel ? 'SÍ' : 'no'}`);
    for (const c of ['reservas-actual', 'reservas-nueva', 'panel', 'otra']) {
      const lista = inv.tablas.filter(t => t.clase === c);
      if (!lista.length) continue;
      console.log(`\n[${c}]`);
      for (const t of lista) console.log(`  ${t.tabla.padEnd(34)} ${String(t.filas).padStart(8)} filas`);
    }
    if (Object.keys(inv.extra).length) console.log('\n' + JSON.stringify(inv.extra));
  } finally {
    await pool.end();
  }
}

if (require.main === module) main().catch(e => { console.error('ERROR:', e.message); process.exitCode = 1; });

module.exports = { inventario, clase, crearPool, RESERVAS_ACTUAL, RESERVAS_NUEVA };
