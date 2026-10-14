#!/usr/bin/env node
'use strict';
/*
  Crea (o asigna) la cuenta del propietario de una barbería existente,
  por ejemplo El Máster después del despliegue. No pide contraseña:
  muestra un enlace de un solo uso, válido 24 horas, para crearla.

  Uso (Shell de Render o local con la URL externa):
    DATABASE_URL=... PUBLIC_BASE_URL=https://tu-dominio \
      node scripts/cuentas/crear-propietario.js --negocio el-master --email dueno@correo.com --nombre "Nombre"

  El enlace es una credencial: no lo compartas por canales públicos.
*/
const { crearAutenticacion } = require('../../autenticacion');
const { argumentos, crearPool, negocioDe, exigirEsquema } = require('../migracion/comun');

async function main() {
  const { op } = argumentos(process.argv.slice(2));
  if (!op.email) {
    console.log('Uso: node scripts/cuentas/crear-propietario.js --negocio el-master --email correo [--nombre "Nombre"]');
    process.exitCode = 2;
    return;
  }
  const negocio = negocioDe(op);
  const pool = crearPool();
  try {
    await exigirEsquema(pool);
    const usuarios = await pool.query(`SELECT to_regclass('public.users') AS t`);
    if (!usuarios.rows[0].t) throw new Error('La base todavía no tiene las tablas de cuentas. Despliega primero la fase 3.');
    const auth = crearAutenticacion({ pool, almacen: null, enviarCorreo: async () => {} });
    const r = await auth.crearPropietario(negocio, { email: op.email, name: typeof op.nombre === 'string' ? op.nombre : '' });
    const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
    console.log(`Propietario listo para "${negocio}" (${op.email}).`);
    console.log('Abre este enlace para crear la contraseña (un solo uso, 24 horas):');
    console.log(`${base}/acceso.html#restablecer=${r.token}`);
  } finally {
    await pool.end();
  }
}

main().catch(e => { console.error('ERROR:', e.message); process.exitCode = 1; });
