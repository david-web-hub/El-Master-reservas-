'use strict';
/*
  Instalación limpia en Render SIN terminal (no hace falta Shell).

  1) ARCHIVAR_DEMO=<nombre exacto de la base>
     En el PRIMER arranque de la versión nueva, mueve las 5 tablas de la
     versión actual (ventas, caja, productos, configuración e imágenes de la
     demostración) al esquema "respaldo_demo" de la misma base. No borra
     nada: es el respaldo. Después se crean tablas nuevas, vacías.
     - Solo actúa si el nombre coincide con la base conectada; si no, la
       versión nueva no arranca (Render deja la anterior funcionando).
     - Solo actúa si la versión nueva nunca arrancó en esa base (no existe
       la tabla businesses). Después no hace nada aunque la variable siga.
     - Nunca toca tablas del Panel Maestro ni ninguna otra.
     Volver atrás: scripts/despliegue/restaurar-demo.sql

  2) PROPIETARIO_INICIAL_EMAIL / PROPIETARIO_INICIAL_CLAVE (y opcional
     PROPIETARIO_INICIAL_NOMBRE)
     Si la barbería principal todavía no tiene propietario, crea esa cuenta
     con esa contraseña (correo ya confirmado). Si ya tiene, no hace nada.
     Quita PROPIETARIO_INICIAL_CLAVE de Render después de entrar.
*/

const TABLAS_DEMO = ['sales', 'cash_sessions', 'products', 'admin_settings', 'media_assets'];
const ESQUEMA = 'respaldo_demo';

const ocultar = correo => String(correo).replace(/^(.).*?(@.*)$/, '$1***$2');

async function archivarDemo({ pool, confirmar, registro = console }) {
  if (!confirmar) return { hecho: false, motivo: 'sin-variable' };
  const base = (await pool.query('SELECT current_database() AS n')).rows[0].n;
  if (confirmar !== base) {
    const e = new Error(`ARCHIVAR_DEMO="${confirmar}" no coincide con la base conectada ("${base}"). No se toca nada y no se arranca.`);
    e.code = 'ARCHIVAR_DEMO';
    throw e;
  }
  if ((await pool.query(`SELECT to_regclass('public.businesses') AS t`)).rows[0].t) {
    registro.log('ARCHIVAR_DEMO: la versión nueva ya está instalada en esta base; no se archiva nada. Puedes quitar la variable.');
    return { hecho: false, motivo: 'ya-instalada' };
  }
  const presentes = (await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1::text[]) ORDER BY table_name`, [TABLAS_DEMO])).rows.map(r => r.table_name);
  if (!presentes.length) {
    registro.log('ARCHIVAR_DEMO: no hay tablas de la demostración; la base ya está limpia.');
    return { hecho: false, motivo: 'vacia' };
  }
  const ocupadas = (await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = ANY($2::text[])`,
    [ESQUEMA, TABLAS_DEMO])).rows.map(r => r.table_name);
  if (ocupadas.length) {
    const e = new Error(`El esquema ${ESQUEMA} ya tiene tablas (${ocupadas.join(', ')}). No se sobrescribe un respaldo; no se arranca.`);
    e.code = 'ARCHIVAR_DEMO';
    throw e;
  }
  const client = await pool.connect();
  const filas = {};
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${ESQUEMA}`);
    for (const t of presentes) {
      /* Mueve la tabla con sus índices, restricciones y secuencias; los datos no se copian ni se borran. */
      await client.query(`ALTER TABLE public.${client.escapeIdentifier(t)} SET SCHEMA ${ESQUEMA}`);
      filas[t] = (await client.query(`SELECT count(*)::int AS n FROM ${ESQUEMA}.${client.escapeIdentifier(t)}`)).rows[0].n;
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    error.code = 'ARCHIVAR_DEMO';
    throw error;
  } finally {
    client.release();
  }
  registro.log(`ARCHIVAR_DEMO: datos de la demostración guardados en el esquema ${ESQUEMA} (no se borró nada): ` +
    Object.entries(filas).map(([t, n]) => `${t}=${n}`).join(', '));
  return { hecho: true, filas };
}

async function propietarioInicial({ pool, autenticacion, negocio, email, clave, nombre = '', registro = console }) {
  if (!email || !clave || !autenticacion) return { hecho: false, motivo: 'sin-variables' };
  const ya = await pool.query(
    `SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.business_id = $1 AND m.role = 'owner' AND m.status = 'active' AND u.password_hash IS NOT NULL LIMIT 1`, [negocio]);
  if (ya.rowCount) {
    registro.log(`PROPIETARIO INICIAL: "${negocio}" ya tiene propietario; no se hace nada. Quita PROPIETARIO_INICIAL_CLAVE de Render.`);
    return { hecho: false, motivo: 'ya-tiene' };
  }
  try {
    const r = await autenticacion.crearPropietario(negocio, { email, name: nombre });
    await autenticacion.restablecerClave(r.token, clave, {});
  } catch (error) {
    registro.error(`PROPIETARIO INICIAL: no se pudo crear (${error.message}). La aplicación sigue funcionando; ` +
      'corrige la variable y reinicia, o usa scripts/cuentas/crear-propietario.js.');
    return { hecho: false, motivo: 'error' };
  }
  registro.log(`PROPIETARIO INICIAL CREADO para "${negocio}": ${ocultar(email)}. Quita PROPIETARIO_INICIAL_CLAVE de Render.`);
  return { hecho: true };
}

module.exports = { archivarDemo, propietarioInicial, TABLAS_DEMO, ESQUEMA };
