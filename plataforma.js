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

  /*
    Límite de barberos de una barbería: el de su plan en el catálogo del Panel
    Maestro. Sin plan, con un plan sin límite o protegida (El Máster): sin límite.
    Cuentan los barberos activos (los desactivados se conservan y no cuentan).
  */
  const SQL_ACTIVOS = `(SELECT count(*) FROM barbers x WHERE x.business_id = b.id
                          AND coalesce(x.data->>'active', 'true') <> 'false')::int`;

  async function limitesDe(businessId, consulta = pool) {
    const r = await consulta.query(
      `SELECT b.plan, b.protected, pp.max_barbers, ${SQL_ACTIVOS} AS activos
       FROM businesses b LEFT JOIN platform_plans pp ON lower(pp.name) = lower(b.plan)
       WHERE b.id = $1`, [businessId]);
    const f = r.rows[0];
    if (!f) return null;
    return {
      plan: f.plan || null,
      maxBarbers: f.protected ? null : (f.max_barbers ?? null),
      activeBarbers: f.activos
    };
  }

  async function maximoDelPlan(plan, consulta = pool) {
    if (!plan) return null;
    const r = await consulta.query('SELECT max_barbers FROM platform_plans WHERE lower(name) = lower($1)', [plan]);
    return r.rows[0] ? r.rows[0].max_barbers ?? null : null;
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
              ${SQL_ACTIVOS} AS n_active_barbers,
              (SELECT pp.max_barbers FROM platform_plans pp WHERE lower(pp.name) = lower(b.plan)) AS plan_max_barbers,
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
        activeBarbers: b.n_active_barbers,
        /* Barberos activos que permite su plan (null = sin límite; El Máster no tiene límite). */
        maxBarbers: b.protected ? null : (b.plan_max_barbers ?? null),
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
      /*
        Bajar a un plan con menos barberos: no se borra ni se desactiva ninguno.
        El cambio se rechaza hasta que el propietario deje activos los que permite
        el plan nuevo. Los cambios de estado o fechas con el mismo plan no se bloquean.
      */
      const cambiaPlan = String(plan || '').toLowerCase() !== String(b.plan || '').toLowerCase();
      if (cambiaPlan && !b.protected) {
        const maximo = await maximoDelPlan(plan, client);
        const activos = (await client.query(
          `SELECT ${SQL_ACTIVOS} AS n FROM businesses b WHERE b.id = $1`, [b.id])).rows[0].n;
        if (maximo !== null && activos > maximo) {
          const e = new ErrorPlataforma(409, 'LIMITE_BARBEROS',
            `La barbería tiene ${activos} barberos activos y el plan ${plan} permite ${maximo}. ` +
            'El propietario debe desactivar barberos antes de cambiar a este plan (no se borra ninguno).');
          e.detalle = { activeBarbers: activos, maxBarbers: maximo };
          throw e;
        }
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

  /*
    SOLICITUDES DE CAMBIO DE PLAN (sección «Planes» del propietario).
    No hay cobros integrados: el propietario solo solicita; el plan cambia
    cuando el Panel Maestro aprueba y aplica la suscripción. Hasta entonces
    la barbería conserva su plan y sus límites actuales.
  */
  const formatoSolicitud = r => r ? {
    id: r.id, businessId: r.business_id, businessName: r.business_name || undefined,
    currentPlan: r.current_plan, requestedPlan: r.requested_plan, status: r.status,
    reason: r.reason || null, createdAt: iso(r.created_at), decidedAt: iso(r.decided_at)
  } : null;

  /* La pendiente, o la última resuelta en los últimos 30 días (para avisar al propietario). */
  async function solicitudDe(businessId) {
    const r = await pool.query(
      `SELECT * FROM plan_requests WHERE business_id = $1
         AND (status = 'pending' OR (status IN ('approved', 'rejected') AND decided_at > NOW() - interval '30 days'))
       ORDER BY (status = 'pending') DESC, created_at DESC LIMIT 1`, [businessId]);
    return formatoSolicitud(r.rows[0]);
  }

  async function solicitarPlan(businessId, planPedido, { userId } = {}) {
    const nombre = String(planPedido || '').trim();
    if (!nombre || nombre.length > 60) throw new ErrorPlataforma(400, 'PLAN_INVALIDO', 'Elige un plan.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const b = (await client.query('SELECT * FROM businesses WHERE id = $1 FOR UPDATE', [businessId])).rows[0];
      if (!b) throw new ErrorPlataforma(404, 'NO_ENCONTRADO', 'Barbería no encontrada');
      if (b.protected) {
        throw new ErrorPlataforma(409, 'NEGOCIO_PROTEGIDO', 'La barbería principal no tiene plan: no necesita cambiarlo.');
      }
      const plan = (await client.query(
        'SELECT name, max_barbers FROM platform_plans WHERE lower(name) = lower($1) AND active', [nombre])).rows[0];
      if (!plan) throw new ErrorPlataforma(400, 'PLAN_INVALIDO', 'Ese plan no está disponible. Elige otro.');
      if (String(b.plan || '').toLowerCase() === plan.name.toLowerCase()) {
        throw new ErrorPlataforma(400, 'MISMO_PLAN', `Ya tienes el plan ${plan.name}.`);
      }
      /* Misma regla de la fase 8: no se puede pedir un plan con menos barberos de los que hay activos. */
      const activos = (await client.query(`SELECT ${SQL_ACTIVOS} AS n FROM businesses b WHERE b.id = $1`, [b.id])).rows[0].n;
      if (plan.max_barbers !== null && activos > plan.max_barbers) {
        const e = new ErrorPlataforma(409, 'LIMITE_BARBEROS',
          `Tienes ${activos} barberos activos y el plan ${plan.name} permite ${plan.max_barbers}. ` +
          'Desactiva los que sobran en Configuración → Barberos antes de solicitar este plan (no se borra ninguno).');
        e.detalle = { activeBarbers: activos, maxBarbers: plan.max_barbers };
        throw e;
      }
      /* Una nueva solicitud reemplaza a la pendiente. */
      const anterior = (await client.query(
        `UPDATE plan_requests SET status = 'cancelled', decided_at = NOW() WHERE business_id = $1 AND status = 'pending' RETURNING id`,
        [b.id])).rows[0];
      const id = 'sol_' + require('node:crypto').randomBytes(9).toString('hex');
      const r = await client.query(
        `INSERT INTO plan_requests (id, business_id, current_plan, requested_plan, requested_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`, [id, b.id, b.plan || null, plan.name, userId || null]);
      await client.query(
        `INSERT INTO platform_events (business_id, type, payload) VALUES ($1, 'plan.requested', $2::jsonb)`,
        [b.id, JSON.stringify({ requestId: id, requestedPlan: plan.name, currentPlan: b.plan || null, replaced: anterior ? anterior.id : null })]);
      await client.query('COMMIT');
      return formatoSolicitud(r.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error.code === '23505') throw new ErrorPlataforma(409, 'SOLICITUD_EN_CURSO', 'Ya hay una solicitud en curso. Inténtalo de nuevo.');
      throw error;
    } finally {
      client.release();
    }
  }

  async function cancelarSolicitud(businessId) {
    const r = await pool.query(
      `UPDATE plan_requests SET status = 'cancelled', decided_at = NOW()
       WHERE business_id = $1 AND status = 'pending' RETURNING *`, [businessId]);
    if (!r.rowCount) throw new ErrorPlataforma(404, 'SIN_SOLICITUD', 'No tienes una solicitud pendiente.');
    await pool.query(
      `INSERT INTO platform_events (business_id, type, payload) VALUES ($1, 'plan.request.cancelled', $2::jsonb)`,
      [businessId, JSON.stringify({ requestId: r.rows[0].id })]);
    return formatoSolicitud(r.rows[0]);
  }

  /* Para el Panel Maestro: pendientes y las de los últimos 60 días. */
  async function listarSolicitudes() {
    const r = await pool.query(
      `SELECT p.*, b.name AS business_name FROM plan_requests p JOIN businesses b ON b.id = p.business_id
       WHERE p.status = 'pending' OR p.created_at > NOW() - interval '60 days'
       ORDER BY p.created_at DESC LIMIT 500`);
    return r.rows.map(formatoSolicitud);
  }

  /*
    El Panel Maestro resuelve una solicitud. Para aprobarla, antes tiene que
    haber aplicado la suscripción con el plan pedido (así el plan solo cambia
    por la vía de siempre, con versiones y las comprobaciones de la fase 8).
  */
  async function resolverSolicitud(id, datos = {}) {
    const estado = String(datos.status || '');
    if (!['approved', 'rejected'].includes(estado)) throw new ErrorPlataforma(400, 'DATOS_INVALIDOS', 'Estado no válido');
    const motivo = datos.reason === undefined || datos.reason === null ? null : String(datos.reason).trim().slice(0, 300) || null;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const s = (await client.query('SELECT * FROM plan_requests WHERE id = $1 FOR UPDATE', [String(id)])).rows[0];
      if (!s) throw new ErrorPlataforma(404, 'NO_ENCONTRADO', 'Solicitud no encontrada');
      if (s.status === estado) { await client.query('ROLLBACK'); return formatoSolicitud(s); }
      if (s.status !== 'pending') throw new ErrorPlataforma(409, 'YA_RESUELTA', 'Esta solicitud ya no está pendiente.');
      if (estado === 'approved') {
        const b = (await client.query('SELECT plan FROM businesses WHERE id = $1', [s.business_id])).rows[0];
        if (!b || String(b.plan || '').toLowerCase() !== s.requested_plan.toLowerCase()) {
          throw new ErrorPlataforma(409, 'PLAN_NO_APLICADO', 'Primero aplica la suscripción con el plan pedido.');
        }
      }
      const r = await client.query(
        `UPDATE plan_requests SET status = $2, reason = $3, decided_at = NOW() WHERE id = $1 RETURNING *`,
        [s.id, estado, motivo]);
      await client.query('COMMIT');
      return formatoSolicitud(r.rows[0]);
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
      /* maxBarbers: número de barberos activos permitidos (null = sin límite). Sin el campo, se conserva el actual. */
      let maximo;
      if (p && Object.prototype.hasOwnProperty.call(p, 'maxBarbers')) {
        maximo = p.maxBarbers === null ? null : Number(p.maxBarbers);
        if (maximo !== null && (!Number.isInteger(maximo) || maximo < 1 || maximo > 1000)) {
          throw new ErrorPlataforma(400, 'DATOS_INVALIDOS', `Límite de barberos no válido en la posición ${i + 1}`);
        }
      }
      return { nombre, dias, precio, activo: p.active !== false, posicion: i, maximo };
    });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const anteriores = new Map((await client.query('SELECT name, max_barbers FROM platform_plans')).rows.map(r => [r.name, r.max_barbers]));
      await client.query('DELETE FROM platform_plans');
      for (const p of planes) {
        const maximo = p.maximo === undefined ? (anteriores.get(p.nombre) ?? null) : p.maximo;
        await client.query(
          `INSERT INTO platform_plans (name, price, trial_days, active, position, max_barbers) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (name) DO UPDATE SET price = EXCLUDED.price, trial_days = EXCLUDED.trial_days,
             active = EXCLUDED.active, position = EXCLUDED.position, max_barbers = EXCLUDED.max_barbers, updated_at = NOW()`,
          [p.nombre, p.precio, p.dias, p.activo, p.posicion, maximo]);
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
    const r = await pool.query('SELECT name, price, trial_days, active, max_barbers FROM platform_plans ORDER BY position, name');
    return r.rows.map(p => ({ name: p.name, price: Number(p.price), trialDays: p.trial_days, active: p.active, maxBarbers: p.max_barbers }));
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
    protegerNegocios, suscripcion, limitesDe, listarNegocios, negocio, aplicarSuscripcion,
    solicitudDe, solicitarPlan, cancelarSolicitud, listarSolicitudes, resolverSolicitud,
    sincronizarPlanes, catalogo, eventosPendientes, confirmarEventos
  };
}

module.exports = { crearPlataforma, ErrorPlataforma, estadoEfectivo, resumenSuscripcion, ESTADOS };
