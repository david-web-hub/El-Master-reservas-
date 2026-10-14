'use strict';
/*
  Integración con el Panel Maestro (fase 6).

  - El Panel Maestro administra planes y suscripciones; El Máster Reservas guarda
    una copia y la APLICA (el acceso nunca depende de que el Panel responda).
  - El Panel solo recibe datos administrativos y cifras. Nunca nombres, teléfonos
    ni reservas de los clientes finales.
  - Las barberías protegidas (El Máster) no se pueden vencer, suspender ni dejar
    con pago pendiente: ni desde el Panel, ni por fechas, ni directamente en la
    base (restricción businesses_protegida_activa).
*/

const ESTADOS = ['trial', 'active', 'past_due', 'expired', 'suspended'];
const ESTADOS_BLOQUEO = ['past_due', 'expired', 'suspended'];
const DIA_MS = 24 * 3600 * 1000;

class ErrorPlataforma extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const iso = v => (v ? new Date(v).toISOString() : null);

/* Estado que se aplica de verdad: tiene en cuenta las fechas y la protección. */
function estadoEfectivo(b, ahora = new Date()) {
  if (b.protected) return 'active';
  const vencida = fecha => fecha && new Date(fecha) <= ahora;
  if (b.status === 'suspended' || b.status === 'expired') return b.status;
  if (b.status === 'trial') return vencida(b.trial_ends_at) ? 'expired' : 'trial';
  if (b.status === 'active') return vencida(b.current_period_end) ? 'expired' : 'active';
  if (b.status === 'past_due') return 'past_due';
  return 'active';
}

function resumenSuscripcion(b, ahora = new Date()) {
  const estado = estadoEfectivo(b, ahora);
  const fin = estado === 'trial' ? b.trial_ends_at : b.current_period_end;
  return {
    status: estado,
    storedStatus: b.status,
    plan: b.plan || null,
    trialEndsAt: iso(b.trial_ends_at),
    currentPeriodEnd: iso(b.current_period_end),
    version: b.subscription_version || 0,
    protected: Boolean(b.protected),
    /* Reservas nuevas: se impiden si venció o está suspendida. */
    canBook: !['expired', 'suspended'].includes(estado),
    daysLeft: fin && !b.protected ? Math.max(0, Math.ceil((new Date(fin) - ahora) / DIA_MS)) : null
  };
}

function fechaOpcional(v, campo) {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new ErrorPlataforma(400, 'DATOS_INVALIDOS', `Fecha no válida: ${campo}`);
  return d.toISOString();
}

function crearPlataforma({ pool }) {

  /* Marca como protegidas las barberías indicadas (El Máster). Si alguna quedó bloqueada por error, se reactiva. */
  async function protegerNegocios(ids, registro = console) {
    for (const id of ids.filter(Boolean)) {
      const r = await pool.query(
        `UPDATE businesses SET protected = TRUE,
                status = CASE WHEN status IN ('active', 'trial') THEN status ELSE 'active' END,
                updated_at = NOW()
         WHERE id = $1 RETURNING status`, [id]);
      if (r.rowCount) {
        registro.log(`BARBERÍA PROTEGIDA: ${id} (no puede vencer ni suspenderse)`);
      }
    }
  }

  async function filaNegocio(id) {
    const r = await pool.query('SELECT * FROM businesses WHERE id = $1', [id]);
    return r.rows[0] || null;
  }

  async function suscripcion(businessId, ahora = new Date()) {
    const b = await filaNegocio(businessId);
    return b ? resumenSuscripcion(b, ahora) : null;
  }

  /*
    Datos administrativos y estadísticas. Solo cifras sobre clientes y reservas:
    ningún nombre, teléfono ni detalle de una reserva sale de aquí.
  */
  async function consultarNegocios(id) {
    const ventas = (await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'sales' AND column_name = 'business_id'`)).rowCount > 0;
    const r = await pool.query(
      `SELECT b.*,
              (SELECT count(*) FROM barbers x WHERE x.business_id = b.id)::int AS n_barbers,
              (SELECT count(*) FROM memberships m WHERE m.business_id = b.id AND m.status = 'active')::int AS n_users,
              (SELECT count(*) FROM bookings x WHERE x.business_id = b.id)::int AS n_bookings,
              (SELECT count(*) FROM bookings x WHERE x.business_id = b.id
                 AND x.created_at > NOW() - interval '30 days')::int AS n_bookings_30d,
              (SELECT count(*) FROM bookings x WHERE x.business_id = b.id
                 AND x.booking_date >= CURRENT_DATE AND coalesce(x.status, '') <> 'cancelled')::int AS n_upcoming,
              (SELECT count(DISTINCT regexp_replace(x.customer_phone, '\\D', '', 'g')) FROM bookings x
                 WHERE x.business_id = b.id AND coalesce(x.customer_phone, '') <> '')::int AS n_clients,
              ${ventas ? `(SELECT coalesce(sum(s.total), 0) FROM sales s WHERE s.business_id = b.id
                 AND s.created_at > NOW() - interval '30 days')::float` : '0::float'} AS sales_30d,
              o.name AS owner_name, o.email AS owner_email
       FROM businesses b
       LEFT JOIN LATERAL (
         SELECT u.name, u.email FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE m.business_id = b.id AND m.role = 'owner' AND m.status = 'active'
         ORDER BY m.created_at LIMIT 1) o ON TRUE
       ${id ? 'WHERE b.id = $1' : ''}
       ORDER BY b.created_at, b.id`, id ? [id] : []);
    const ahora = new Date();
    return r.rows.map(b => ({
      id: b.id,
      slug: b.slug,
      name: b.name,
      country: b.country,
      currency: b.currency,
      timezone: b.timezone,
      createdAt: iso(b.created_at),
      owner: b.owner_name || b.owner_email ? { name: b.owner_name || '', email: b.owner_email || '' } : null,
      subscription: resumenSuscripcion(b, ahora),
      stats: {
        barbers: b.n_barbers,
        users: b.n_users,
        bookings: b.n_bookings,
        bookingsLast30Days: b.n_bookings_30d,
        upcomingBookings: b.n_upcoming,
        clients: b.n_clients,
        salesLast30Days: Math.round(b.sales_30d * 100) / 100
      }
    }));
  }

  const listarNegocios = () => consultarNegocios(null);

  async function negocio(id) {
    const [b] = await consultarNegocios(String(id));
    if (!b) throw new ErrorPlataforma(404, 'NO_ENCONTRADO', 'Barbería no encontrada');
    return b;
  }

  /*
    Aplica la suscripción que decide el Panel Maestro. "version" crece con cada
    cambio en el Panel: una versión igual es una repetición (no hace nada) y una
    menor es un cambio antiguo que llega tarde (se rechaza).
  */
  async function aplicarSuscripcion(id, datos = {}) {
    const estado = String(datos.status || '');
    if (!ESTADOS.includes(estado)) throw new ErrorPlataforma(400, 'DATOS_INVALIDOS', 'Estado de suscripción no válido');
    const version = Number(datos.version);
    if (!Number.isInteger(version) || version < 1) throw new ErrorPlataforma(400, 'DATOS_INVALIDOS', 'Versión no válida');
    const plan = datos.plan === null || datos.plan === undefined ? null : String(datos.plan).trim().slice(0, 60) || null;
    const finPrueba = fechaOpcional(datos.trialEndsAt, 'trialEndsAt');
    const finPeriodo = fechaOpcional(datos.currentPeriodEnd, 'currentPeriodEnd');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const b = (await client.query('SELECT * FROM businesses WHERE id = $1 FOR UPDATE', [String(id)])).rows[0];
      if (!b) throw new ErrorPlataforma(404, 'NO_ENCONTRADO', 'Barbería no encontrada');
      if (b.protected && ESTADOS_BLOQUEO.includes(estado)) {
        throw new ErrorPlataforma(409, 'NEGOCIO_PROTEGIDO', 'Esta barbería está protegida: no se puede vencer, suspender ni dejar con pago pendiente.');
      }
      if (version < b.subscription_version) {
        throw new ErrorPlataforma(409, 'VERSION_ANTIGUA', 'Llegó un cambio más antiguo que el aplicado');
      }
      if (version === b.subscription_version) {
        await client.query('ROLLBACK');
        return resumenSuscripcion(b);
      }
      const r = await client.query(
        `UPDATE businesses SET status = $2, plan = $3, trial_ends_at = $4, current_period_end = $5,
                subscription_version = $6, subscription_updated_at = NOW(), updated_at = NOW()
         WHERE id = $1 RETURNING *`, [b.id, estado, plan, finPrueba, finPeriodo, version]);
      await client.query(
        `INSERT INTO platform_events (business_id, type, payload) VALUES ($1, 'subscription.applied', $2::jsonb)`,
        [b.id, JSON.stringify({ status: estado, plan, trialEndsAt: finPrueba, currentPeriodEnd: finPeriodo, version })]);
      await client.query('COMMIT');
      return resumenSuscripcion(r.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /* Copia del catálogo de planes del Panel Maestro (precios y días de prueba). */
  async function sincronizarPlanes(lista) {
    if (!Array.isArray(lista) || lista.length > 50) throw new ErrorPlataforma(400, 'DATOS_INVALIDOS', 'Lista de planes no válida');
    const planes = lista.map((p, i) => {
      const nombre = String(p && p.name || '').trim();
      const dias = Number(p && p.trialDays);
      const precio = Number(p && p.price);
      if (!nombre || nombre.length > 60 || !Number.isInteger(dias) || dias < 0 || dias > 365 || !Number.isFinite(precio) || precio < 0) {
        throw new ErrorPlataforma(400, 'DATOS_INVALIDOS', `Plan no válido en la posición ${i + 1}`);
      }
      return { nombre, dias, precio, activo: p.active !== false, posicion: i };
    });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM platform_plans');
      for (const p of planes) {
        await client.query(
          `INSERT INTO platform_plans (name, price, trial_days, active, position) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (name) DO UPDATE SET price = EXCLUDED.price, trial_days = EXCLUDED.trial_days,
             active = EXCLUDED.active, position = EXCLUDED.position, updated_at = NOW()`,
          [p.nombre, p.precio, p.dias, p.activo, p.posicion]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    return catalogo();
  }

  async function catalogo() {
    const r = await pool.query('SELECT name, price, trial_days, active FROM platform_plans ORDER BY position, name');
    return r.rows.map(p => ({ name: p.name, price: Number(p.price), trialDays: p.trial_days, active: p.active }));
  }

  /* Bandeja de salida: eventos que el Panel todavía no confirmó. */
  async function eventosPendientes(limite = 100) {
    const n = Math.min(Math.max(Number(limite) || 100, 1), 500);
    const r = await pool.query(
      `SELECT id, business_id, type, payload, created_at, attempts FROM platform_events
       WHERE delivered_at IS NULL ORDER BY id LIMIT $1`, [n]);
    if (r.rowCount) {
      await pool.query('UPDATE platform_events SET attempts = attempts + 1 WHERE id = ANY($1::bigint[])', [r.rows.map(e => e.id)]);
    }
    return r.rows.map(e => ({
      id: Number(e.id), businessId: e.business_id, type: e.type, payload: e.payload, createdAt: iso(e.created_at)
    }));
  }

  async function confirmarEventos(ids) {
    if (!Array.isArray(ids) || ids.length > 500 || !ids.every(i => Number.isSafeInteger(i) && i > 0)) {
      throw new ErrorPlataforma(400, 'DATOS_INVALIDOS', 'Lista de eventos no válida');
    }
    const r = await pool.query(
      'UPDATE platform_events SET delivered_at = NOW() WHERE id = ANY($1::bigint[]) AND delivered_at IS NULL', [ids]);
    return r.rowCount;
  }

  return {
    protegerNegocios, suscripcion, listarNegocios, negocio, aplicarSuscripcion,
    sincronizarPlanes, catalogo, eventosPendientes, confirmarEventos
  };
}

module.exports = { crearPlataforma, ErrorPlataforma, estadoEfectivo, resumenSuscripcion, ESTADOS };
