'use strict';
/*
  DIRECTORIO DE BARBERÍAS PÚBLICAS
  Cada barbería tiene su página de reservas en /b/<dirección>/ (la dirección
  es el "slug" que se crea al registrarse). La barbería principal sigue en "/".

  - Solo lectura: id, dirección, nombre, zona horaria y tipo de negocio
    (barbería o salón; vacío en los negocios anteriores). Nada privado.
  - Una barbería suspendida (y no protegida) no tiene página pública.
  - Se guarda en memoria unos segundos para no consultar la base en cada petición.
*/

const DIRECCION = /^[a-z0-9][a-z0-9-]{1,62}$/;

function crearDirectorio({ pool, ttlMs = 30000, zonaPorDefecto = 'America/Guayaquil' } = {}) {
  let porId = new Map();
  let porSlug = new Map();
  let cargadoEn = 0;
  let cargando = null;

  async function cargar() {
    if (!pool) return;
    const r = await pool.query(
      `SELECT id, slug, name, timezone, status, protected, business_type FROM businesses`);
    const ids = new Map();
    const slugs = new Map();
    for (const b of r.rows) {
      const fila = {
        id: b.id, slug: b.slug, name: b.name,
        timezone: b.timezone || zonaPorDefecto,
        tipo: b.business_type || null,
        publica: b.status !== 'suspended' || Boolean(b.protected)
      };
      ids.set(b.id, fila);
      slugs.set(b.slug, fila);
    }
    porId = ids;
    porSlug = slugs;
    cargadoEn = Date.now();
  }

  async function actualizar(forzar = false) {
    if (!forzar && Date.now() - cargadoEn < ttlMs) return;
    if (!cargando) cargando = cargar().finally(() => { cargando = null; });
    await cargando;
  }

  /* Barbería pública por su dirección, o null si no existe o no está disponible. */
  async function buscar(slug) {
    const s = String(slug || '').toLowerCase();
    if (!DIRECCION.test(s)) return null;
    await actualizar();
    let b = porSlug.get(s);
    /* Recién registrada: todavía no está en memoria. */
    if (!b) { await actualizar(true); b = porSlug.get(s); }
    return b && b.publica ? b : null;
  }

  function zona(id) {
    return (porId.get(id) || {}).timezone || zonaPorDefecto;
  }

  function slugDe(id) {
    return (porId.get(id) || {}).slug || null;
  }

  /* Tipo elegido al registrarse ('barberia' o 'salon'), o null en los negocios anteriores. */
  function tipoDe(id) {
    return (porId.get(id) || {}).tipo || null;
  }

  function nombreDe(id) {
    return (porId.get(id) || {}).name || null;
  }

  return { buscar, zona, slugDe, tipoDe, nombreDe, actualizar, invalidar: () => { cargadoEn = 0; } };
}

module.exports = { crearDirectorio, DIRECCION };
