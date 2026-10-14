#!/usr/bin/env node
'use strict';
/*
  Respaldo de la aplicación en ejecución usando SOLO peticiones GET.
  Guarda lo que hoy está en data/db.json del servidor (reservas, barberos,
  horarios, servicios) y lo que está en PostgreSQL vía API.

  Uso:
    node scripts/respaldo/respaldo-api.js https://TU-SERVICIO.onrender.com [carpeta]

  Por defecto guarda en respaldos/<fecha>/ (carpeta ignorada por git:
  contiene teléfonos de clientes; no se sube al repositorio).
*/
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RUTAS = [
  ['respaldo-completo.json', '/api/admin/backup'],
  ['config.json', '/api/config'],
  ['reservas.json', '/api/bookings'],
  ['barberos.json', '/api/admin/barbers'],
  ['horarios.json', '/api/admin/hours'],
  ['servicios.json', '/api/admin/services'],
  ['negocio.json', '/api/admin/business'],
  ['configuracion.json', '/api/admin/settings'],
  ['productos.json', '/api/admin/products'],
  ['caja-hoy.json', '/api/cash/today'],
  ['imagenes-lista.json', '/api/admin/media'],
  ['sitio-publico.json', '/api/public/site'],
  ['salud.json', '/api/health']
];

async function main() {
  const base = String(process.argv[2] || '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) {
    console.log('Uso: node scripts/respaldo/respaldo-api.js https://TU-SERVICIO.onrender.com [carpeta]');
    process.exitCode = 2;
    return;
  }
  const sello = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.resolve(process.argv[3] || path.join('respaldos', `api-${sello}`));
  fs.mkdirSync(dir, { recursive: true });
  const manifiesto = { origen: base, fecha: new Date().toISOString(), archivos: [] };

  for (const [archivo, ruta] of RUTAS) {
    try {
      const r = await fetch(base + ruta, { method: 'GET', headers: { Accept: 'application/json' } });
      const cuerpo = Buffer.from(await r.arrayBuffer());
      fs.writeFileSync(path.join(dir, archivo), cuerpo);
      const sha256 = crypto.createHash('sha256').update(cuerpo).digest('hex');
      manifiesto.archivos.push({ archivo, ruta, estado: r.status, bytes: cuerpo.length, sha256 });
      console.log(`${r.ok ? 'OK ' : 'ERR'} ${r.status} ${ruta} → ${archivo} (${cuerpo.length} bytes)`);
    } catch (e) {
      manifiesto.archivos.push({ archivo, ruta, error: e.message });
      console.log(`ERR ${ruta}: ${e.message}`);
    }
  }

  /* Resumen para comprobar el respaldo a simple vista. */
  try {
    const todo = JSON.parse(fs.readFileSync(path.join(dir, 'respaldo-completo.json'), 'utf8'));
    manifiesto.resumen = {
      reservas: (todo.bookings || []).length,
      barberos: (todo.barbers || []).length,
      servicios: (todo.services || []).length,
      horariosPersonalizados: Object.keys(todo.hoursConfig || {}).length > 0,
      seccionesConfiguracion: Object.keys(todo.settings || {})
    };
    console.log('Resumen:', JSON.stringify(manifiesto.resumen));
  } catch { /* el respaldo completo no se pudo leer */ }

  fs.writeFileSync(path.join(dir, 'MANIFIESTO.json'), JSON.stringify(manifiesto, null, 2));
  console.log(`Respaldo guardado en ${dir}`);
  if (manifiesto.archivos.some(a => a.error || a.estado >= 400)) {
    console.log('Atención: algunas rutas fallaron; revisa MANIFIESTO.json.');
    process.exitCode = 1;
  }
}

main();
