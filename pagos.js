'use strict';
/*
  PAGOS DE SUSCRIPCIÓN CON PAYPHONE (Cajita de Pagos)

  Flujo (documentación oficial: docs.payphone.app/cajita-de-pagos):
  1. El propietario elige un plan. El servidor crea un pago «pending» con un
     clientTransactionId único y entrega a la página los datos de la Cajita.
  2. El cliente paga en la Cajita (Payphone pide los datos de la tarjeta; aquí
     nunca llegan). Payphone redirige a la URL de respuesta con id y
     clientTransactionId.
  3. El servidor confirma con la API Confirm de Payphone (si no se confirma en
     5 minutos, Payphone reversa el cobro). Solo con statusCode 3, el mismo
     clientTransactionId, el mismo id y el mismo monto el pago queda «approved».
  4. Un pago aprobado amplía el período pagado del negocio (paid_through) en la
     misma transacción que avisa al Panel Maestro (evento payment.approved).

  El Panel Maestro sigue siendo la autoridad de las suscripciones: el pago se
  aplica en Reservas de forma provisional hasta que el Panel lo registra y
  envía su suscripción con paymentsAppliedSeq (ver plataforma.js).

  Seguridad:
  - Token y StoreID solo en variables de entorno. El token también lo usa la
    Cajita en el navegador: así lo exige Payphone, que lo limita al dominio
    registrado en Payphone Developer.
  - No se guarda ningún dato de la tarjeta salvo marca, tipo (crédito/débito) y
    los últimos dígitos que devuelve Payphone. Nunca número completo ni CVV.
  - Desactivado por defecto. PAGOS_PAYPHONE=produccion exige además
    PAGOS_REALES_AUTORIZADOS=si.
*/
const crypto = require('node:crypto');
const { resumenSuscripcion } = require('./plataforma');

const CONFIRM_OFICIAL = 'https://paymentbox.payphonetodoesposible.com/api/confirm';
const CAJITA_JS_OFICIAL = 'https://cdn.payphonetodoesposible.com/box/v2.0/payphone-payment-box.js';
const CAJITA_CSS_OFICIAL = 'https://cdn.payphonetodoesposible.com/box/v2.0/payphone-payment-box.css';

/* Payphone: el formulario de la Cajita vale 10 minutos y la confirmación debe llegar en 5. */
const VIDA_FORMULARIO_MS = 10 * 60 * 1000;
/* Se sigue intentando confirmar un pago con id de Payphone durante 30 minutos; después queda en «error». */
const REINTENTOS_HASTA_MS = 30 * 60 * 1000;
const ESPERA_ENTRE_REINTENTOS_MS = 20 * 1000;
const TIEMPO_MAXIMO_MS = 15 * 1000;

/* «expired»: formulario abandonado sin respuesta de Payphone; si aun así llega la respuesta, se confirma. */
const FINALES = ['approved', 'canceled', 'review'];
const CONFIRMABLES = ['pending', 'superseded', 'error', 'expired'];

class ErrorPago extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/*
  Configuración (solo variables de entorno):
  - PAGOS_PAYPHONE: «pruebas» o «produccion». Cualquier otro valor: desactivado.
  - PAYPHONE_TOKEN y PAYPHONE_STORE_ID: credenciales de Payphone Developer.
  - PAGOS_REALES_AUTORIZADOS=si: obligatorio para «produccion».
  - PAYPHONE_CONFIRM_URL, PAYPHONE_CAJITA_JS, PAYPHONE_CAJITA_CSS: solo fuera de
    producción (pruebas automáticas con un Payphone simulado). En producción se
    usan siempre las direcciones oficiales.
  Nota: el ambiente (PRUEBAS o PRODUCCIÓN) lo decide la aplicación creada en
  Payphone Developer, no esta variable. En «pruebas» deben usarse las
  credenciales de una aplicación en ambiente de PRUEBAS.
*/
function leerConfiguracion(env = process.env, { produccion = false } = {}) {
  const modo = String(env.PAGOS_PAYPHONE || '').trim().toLowerCase();
  const base = { activo: false, modo: null, motivo: 'Los pagos en línea están desactivados' };
  if (!['pruebas', 'produccion'].includes(modo)) return base;
  const token = String(env.PAYPHONE_TOKEN || '').trim();
  const storeId = String(env.PAYPHONE_STORE_ID || '').trim();
  if (!token || !storeId) return { ...base, motivo: 'Faltan PAYPHONE_TOKEN o PAYPHONE_STORE_ID' };
  if (modo === 'produccion' && String(env.PAGOS_REALES_AUTORIZADOS || '').trim().toLowerCase() !== 'si') {
    return { ...base, motivo: 'Los cobros reales no están autorizados (PAGOS_REALES_AUTORIZADOS)' };
  }
  const local = (clave, oficial) => (!produccion && env[clave] ? String(env[clave]) : oficial);
  return {
    activo: true,
    modo,
    motivo: null,
    token,
    storeId,
    confirmUrl: local('PAYPHONE_CONFIRM_URL', CONFIRM_OFICIAL),
    cajitaJs: local('PAYPHONE_CAJITA_JS', CAJITA_JS_OFICIAL),
    cajitaCss: local('PAYPHONE_CAJITA_CSS', CAJITA_CSS_OFICIAL)
  };
}

/* Mismo día del mes siguiente; si no existe (31 de enero), el último día de ese mes. */
function sumarMes(fecha) {
  const d = new Date(fecha);
  const objetivo = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1,
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
  const ultimo = new Date(Date.UTC(objetivo.getUTCFullYear(), objetivo.getUTCMonth() + 1, 0)).getUTCDate();
  objetivo.setUTCDate(Math.min(d.getUTCDate(), ultimo));
  return objetivo;
}

const iso = v => (v ? new Date(v).toISOString() : null);

function nuevoClientTransactionId() {
  /* Máximo 50 caracteres (Payphone). Imposible de adivinar: incluye 12 bytes aleatorios. */
  return `MFP-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(12).toString('hex').toUpperCase()}`;
}
const CLIENT_TX = /^MFP-[A-Z0-9]{6,12}-[A-F0-9]{24}$/;

function resumenPago(p) {
  return {
    id: p.client_transaction_id,
    plan: p.plan,
    amount: p.amount_cents / 100,
    currency: p.currency,
    mode: p.mode,
    status: p.status,
    message: p.status_message || null,
    card: p.card_brand || p.card_last_digits
      ? { brand: p.card_brand || null, type: p.card_type || null, lastDigits: p.card_last_digits || null }
      : null,
    periodStart: iso(p.period_start),
    periodEnd: iso(p.period_end),
    createdAt: iso(p.created_at),
    confirmedAt: iso(p.confirmed_at)
  };
}

function crearPagos({ pool, config, fetchImpl = fetch, registro = console, reloj = () => new Date(),
  esperaReintentoMs = ESPERA_ENTRE_REINTENTOS_MS }) {
  const disponible = Boolean(pool && config && config.activo);

  async function bitacora(consulta, { seq = null, negocio = null, nivel = 'info', evento, detalle = {} }) {
    try {
      await consulta.query(
        `INSERT INTO subscription_payment_log (payment_seq, business_id, level, event, detail) VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [seq, negocio, nivel, evento, JSON.stringify(detalle)]);
    } catch (error) {
      registro.error('PAGOS: no se pudo escribir la bitácora:', error.message);
    }
    const linea = `PAGOS [${nivel}] ${evento}${negocio ? ' · ' + negocio : ''}${seq ? ' · pago ' + seq : ''}`;
    if (nivel === 'error') registro.error(linea, JSON.stringify(detalle));
    else registro.log(linea);
  }

  function estado() {
    return {
      enabled: disponible,
      mode: disponible ? config.modo : null,
      /* Motivo legible cuando están desactivados (sin secretos). */
      reason: disponible ? null : (config && config.motivo) || 'Los pagos en línea están desactivados'
    };
  }

  function exigirDisponible() {
    if (!disponible) throw new ErrorPago(503, 'PAGOS_DESACTIVADOS', (config && config.motivo) || 'Los pagos en línea están desactivados');
  }

  /* 1. Preparar el pago de un plan. */
  async function iniciar(businessId, planPedido, { userId = null } = {}) {
    exigirDisponible();
    const nombre = String(planPedido || '').trim();
    if (!nombre) throw new ErrorPago(400, 'PLAN_INVALIDO', 'Elige un plan');
    const ahora = reloj();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const b = (await client.query('SELECT * FROM businesses WHERE id = $1 FOR UPDATE', [String(businessId)])).rows[0];
      if (!b) throw new ErrorPago(404, 'NO_ENCONTRADO', 'Negocio no encontrado');
      if (b.protected) throw new ErrorPago(409, 'NEGOCIO_PROTEGIDO', 'Este negocio no necesita pagar una suscripción.');
      const sus = resumenSuscripcion(b, ahora);
      if (sus.status === 'suspended') {
        throw new ErrorPago(409, 'SUSPENDIDA', 'Tu cuenta está suspendida. Escríbenos para reactivarla antes de pagar.');
      }
      const plan = (await client.query(
        'SELECT name, price, max_barbers FROM platform_plans WHERE lower(name) = lower($1) AND active', [nombre])).rows[0];
      if (!plan) throw new ErrorPago(400, 'PLAN_INVALIDO', 'Ese plan no está disponible');
      const centavos = Math.round(Number(plan.price) * 100);
      if (!Number.isInteger(centavos) || centavos <= 0) throw new ErrorPago(400, 'PLAN_INVALIDO', 'Ese plan no tiene precio');
      /* Con un período pagado vigente solo se renueva el mismo plan (no se pierden días pagados). */
      const periodoVigente = sus.status === 'active' && sus.currentPeriodEnd && new Date(sus.currentPeriodEnd) > ahora;
      if (periodoVigente && String(sus.plan || '').toLowerCase() !== plan.name.toLowerCase()) {
        throw new ErrorPago(409, 'CAMBIO_EN_PERIODO',
          `Tu plan ${sus.plan} está pagado hasta el ${new Date(sus.currentPeriodEnd).toISOString().slice(0, 10)}. ` +
          'Puedes renovarlo o solicitar el cambio de plan.');
      }
      if (plan.max_barbers !== null && plan.max_barbers !== undefined) {
        const activos = (await client.query(
          `SELECT count(*)::int AS n FROM barbers WHERE business_id = $1 AND coalesce(data->>'active', 'true') <> 'false'`,
          [b.id])).rows[0].n;
        if (activos > plan.max_barbers) {
          throw new ErrorPago(409, 'LIMITE_BARBEROS',
            `Tienes ${activos} profesionales activos y el plan ${plan.name} permite ${plan.max_barbers}. Desactiva algunos antes de pagar este plan.`);
        }
      }
      /* Un pago ya enviado a Payphone y aún sin confirmar: no se abre otro (evita cobros duplicados). */
      const enCurso = (await client.query(
        `SELECT client_transaction_id FROM subscription_payments
          WHERE business_id = $1 AND status IN ('pending', 'superseded', 'error') AND payphone_transaction_id IS NOT NULL
            AND created_at > $2 LIMIT 1`, [b.id, new Date(ahora.getTime() - REINTENTOS_HASTA_MS)])).rows[0];
      if (enCurso) {
        throw new ErrorPago(409, 'PAGO_EN_PROCESO', 'Tienes un pago en proceso de confirmación. Espera unos minutos antes de intentarlo de nuevo.');
      }
      /* Formularios abiertos antes y sin pagar: quedan reemplazados (se pueden confirmar si se llegaran a pagar). */
      await client.query(
        `UPDATE subscription_payments SET status = 'superseded'
          WHERE business_id = $1 AND status = 'pending' AND payphone_transaction_id IS NULL`, [b.id]);
      const pago = (await client.query(
        `INSERT INTO subscription_payments
           (business_id, client_transaction_id, plan, amount_cents, currency, mode, status, created_by, created_at, expires_at)
         VALUES ($1, $2, $3, $4, 'USD', $5, 'pending', $6, $7, $8) RETURNING *`,
        [b.id, nuevoClientTransactionId(), plan.name, centavos, config.modo, userId, ahora,
          new Date(ahora.getTime() + VIDA_FORMULARIO_MS)])).rows[0];
      await bitacora(client, { seq: pago.seq, negocio: b.id, evento: 'pago.iniciado',
        detalle: { plan: plan.name, amountCents: centavos, mode: config.modo } });
      await client.query('COMMIT');
      return {
        payment: resumenPago(pago),
        mode: config.modo,
        scripts: { js: config.cajitaJs, css: config.cajitaCss },
        /* Parámetros de la Cajita (montos en centavos). Los datos del titular los pide Payphone. */
        box: {
          token: config.token,
          storeId: config.storeId,
          clientTransactionId: pago.client_transaction_id,
          amount: centavos,
          amountWithoutTax: centavos,
          currency: 'USD',
          reference: `MF Plux · Plan ${plan.name} · ${String(b.name || b.id)}`.slice(0, 100),
          lang: 'es',
          defaultMethod: 'card',
          timeZone: -5
        }
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /* Consulta a Payphone (API Confirm). Devuelve { ok, datos } o { ok: false, error }. */
  async function consultarPayphone(id, clientTxId) {
    const control = new AbortController();
    const t = setTimeout(() => control.abort(), TIEMPO_MAXIMO_MS);
    try {
      const r = await fetchImpl(config.confirmUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, clientTxId }),
        signal: control.signal,
        redirect: 'error'
      });
      const datos = await r.json().catch(() => null);
      if (r.status !== 200 || !datos || typeof datos !== 'object') {
        return { ok: false, error: `Payphone respondió ${r.status}${datos && datos.message ? ': ' + String(datos.message).slice(0, 200) : ''}`,
          codigo: datos && datos.errorCode };
      }
      return { ok: true, datos };
    } catch (error) {
      return { ok: false, error: error.name === 'AbortError' ? 'Payphone no respondió a tiempo' : 'No se pudo conectar con Payphone' };
    } finally {
      clearTimeout(t);
    }
  }

  /* Decide el resultado de la confirmación comparándola con lo que se cobró. */
  function interpretar(datos, pago, id) {
    const codigo = Number(datos.statusCode);
    const estadoTexto = String(datos.transactionStatus || '');
    if (String(datos.clientTransactionId || '') !== pago.client_transaction_id || Number(datos.transactionId) !== id) {
      return { estado: 'review', mensaje: 'La respuesta de Payphone no corresponde a este pago' };
    }
    if (codigo === 3 || estadoTexto === 'Approved') {
      if (Number(datos.amount) !== pago.amount_cents || String(datos.currency || 'USD').toUpperCase() !== pago.currency) {
        return { estado: 'review', mensaje: `Monto confirmado (${datos.amount} ${datos.currency || ''}) distinto del esperado (${pago.amount_cents} ${pago.currency})` };
      }
      return { estado: 'approved', mensaje: null };
    }
    if (codigo === 2 || estadoTexto === 'Canceled') {
      return { estado: 'canceled', mensaje: datos.message ? String(datos.message).slice(0, 300) : 'Pago no aprobado' };
    }
    return { estado: null, mensaje: `Estado de Payphone desconocido (${datos.statusCode} ${estadoTexto})` };
  }

  /* Período que cubre un pago aprobado: empieza cuando termina lo ya disponible (prueba o período pagado). */
  function periodoDelPago(b, ahora) {
    const sus = resumenSuscripcion(b, ahora);
    let inicio = ahora;
    if (sus.status === 'trial' && b.trial_ends_at && new Date(b.trial_ends_at) > inicio) inicio = new Date(b.trial_ends_at);
    if (sus.status === 'active' && sus.currentPeriodEnd && new Date(sus.currentPeriodEnd) > inicio) inicio = new Date(sus.currentPeriodEnd);
    return { inicio, fin: sumarMes(inicio) };
  }

  /* Aplica el resultado en una sola transacción: pago, período del negocio y aviso al Panel. */
  async function aplicarResultado(pagoSeq, id, resultado, datos) {
    const ahora = reloj();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pago = (await client.query('SELECT * FROM subscription_payments WHERE seq = $1 FOR UPDATE', [pagoSeq])).rows[0];
      /* Otra petición ya lo resolvió: no se aplica dos veces. */
      if (!pago || FINALES.includes(pago.status)) {
        await client.query('ROLLBACK');
        return pago;
      }
      const tarjeta = {
        brand: datos && datos.cardBrand ? String(datos.cardBrand).slice(0, 80) : null,
        type: datos && datos.cardType ? String(datos.cardType).slice(0, 20) : null,
        /* Payphone ya devuelve solo los últimos dígitos (por ejemplo «XX17»): se guardan como máximo 4 cifras. */
        last: datos && datos.lastDigits ? String(datos.lastDigits).replace(/\D/g, '').slice(-4) || null : null
      };
      let periodo = { inicio: null, fin: null };
      if (resultado.estado === 'approved') {
        const b = (await client.query('SELECT * FROM businesses WHERE id = $1 FOR UPDATE', [pago.business_id])).rows[0];
        periodo = periodoDelPago(b, ahora);
        await client.query(
          `UPDATE businesses SET paid_plan = $2, paid_through = $3, paid_seq = GREATEST(paid_seq, $4), updated_at = NOW()
            WHERE id = $1`, [b.id, pago.plan, periodo.fin, pago.seq]);
      }
      const r = (await client.query(
        `UPDATE subscription_payments
            SET status = $2, payphone_transaction_id = coalesce(payphone_transaction_id, $3),
                authorization_code = $4, card_brand = $5, card_type = $6, card_last_digits = $7,
                status_message = $8, period_start = $9, period_end = $10, confirmed_at = $11, last_error = NULL
          WHERE seq = $1 RETURNING *`,
        [pago.seq, resultado.estado, id, datos && datos.authorizationCode ? String(datos.authorizationCode).slice(0, 40) : null,
          tarjeta.brand, tarjeta.type, tarjeta.last, resultado.mensaje, periodo.inicio, periodo.fin, ahora])).rows[0];
      const tipo = { approved: 'payment.approved', canceled: 'payment.canceled', review: 'payment.review' }[resultado.estado];
      await client.query(
        `INSERT INTO platform_events (business_id, type, payload) VALUES ($1, $2, $3::jsonb)`,
        [r.business_id, tipo, JSON.stringify({
          seq: Number(r.seq), clientTransactionId: r.client_transaction_id, transactionId: Number(r.payphone_transaction_id),
          authorizationCode: r.authorization_code, plan: r.plan, amountCents: r.amount_cents, currency: r.currency, mode: r.mode,
          status: r.status, message: r.status_message, cardBrand: r.card_brand, cardLastDigits: r.card_last_digits,
          periodStart: iso(r.period_start), periodEnd: iso(r.period_end), confirmedAt: iso(r.confirmed_at)
        })]);
      await bitacora(client, { seq: r.seq, negocio: r.business_id, nivel: resultado.estado === 'review' ? 'error' : 'info',
        evento: `pago.${resultado.estado}`, detalle: { transactionId: id, plan: r.plan, amountCents: r.amount_cents,
          message: resultado.mensaje, periodEnd: iso(r.period_end) } });
      await client.query('COMMIT');
      return r;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /* 2. Confirmación (URL de respuesta de Payphone o reintento). Repetirla no cambia nada. */
  async function confirmar({ id, clientTransactionId }) {
    exigirDisponible();
    const ctx = String(clientTransactionId || '').trim();
    const idTexto = String(id ?? '').trim();
    if (!CLIENT_TX.test(ctx) || !/^\d{1,15}$/.test(idTexto) || Number(idTexto) <= 0) {
      throw new ErrorPago(400, 'DATOS_INVALIDOS', 'Respuesta de pago no válida');
    }
    const idPayphone = Number(idTexto);
    let pago = (await pool.query('SELECT * FROM subscription_payments WHERE client_transaction_id = $1', [ctx])).rows[0];
    if (!pago) {
      await bitacora(pool, { nivel: 'error', evento: 'pago.desconocido', detalle: { clientTransactionId: ctx, transactionId: idPayphone } });
      throw new ErrorPago(404, 'NO_ENCONTRADO', 'Pago no encontrado');
    }
    if (FINALES.includes(pago.status)) {
      if (pago.payphone_transaction_id && Number(pago.payphone_transaction_id) !== idPayphone) {
        await bitacora(pool, { seq: pago.seq, negocio: pago.business_id, nivel: 'error', evento: 'pago.id_distinto',
          detalle: { esperado: Number(pago.payphone_transaction_id), recibido: idPayphone } });
        throw new ErrorPago(409, 'ID_DISTINTO', 'La respuesta de Payphone no corresponde a este pago');
      }
      return resumenPago(pago);
    }
    /* El primer id de Payphone queda fijado: otro id para el mismo pago es una anomalía. */
    const fijado = await pool.query(
      `UPDATE subscription_payments SET payphone_transaction_id = $2
        WHERE seq = $1 AND payphone_transaction_id IS NULL RETURNING seq`, [pago.seq, idPayphone]);
    if (!fijado.rowCount) {
      pago = (await pool.query('SELECT * FROM subscription_payments WHERE seq = $1', [pago.seq])).rows[0];
      if (Number(pago.payphone_transaction_id) !== idPayphone) {
        await bitacora(pool, { seq: pago.seq, negocio: pago.business_id, nivel: 'error', evento: 'pago.id_distinto',
          detalle: { esperado: Number(pago.payphone_transaction_id), recibido: idPayphone } });
        throw new ErrorPago(409, 'ID_DISTINTO', 'La respuesta de Payphone no corresponde a este pago');
      }
    }
    return resumenPago(await consultarYAplicar(pago.seq));
  }

  async function consultarYAplicar(seq) {
    const pago = (await pool.query('SELECT * FROM subscription_payments WHERE seq = $1', [seq])).rows[0];
    if (!pago || !CONFIRMABLES.includes(pago.status) || !pago.payphone_transaction_id) return pago;
    const id = Number(pago.payphone_transaction_id);
    const ahora = reloj();
    const r = await consultarPayphone(id, pago.client_transaction_id);
    if (r.ok) {
      const resultado = interpretar(r.datos, pago, id);
      if (resultado.estado) return aplicarResultado(pago.seq, id, resultado, r.datos);
      r.error = resultado.mensaje;
    }
    /* No se pudo confirmar: se reintenta. Pasados 30 minutos queda en «error» para revisarlo a mano. */
    const vencido = ahora - new Date(pago.created_at) > REINTENTOS_HASTA_MS;
    const act = (await pool.query(
      `UPDATE subscription_payments SET attempts = attempts + 1, last_attempt_at = $2, last_error = $3,
              status = CASE WHEN $4 THEN 'error' ELSE status END
        WHERE seq = $1 AND status IN ('pending', 'superseded', 'error', 'expired') RETURNING *`,
      [pago.seq, ahora, String(r.error || 'Error desconocido').slice(0, 300), vencido])).rows[0];
    await bitacora(pool, { seq: pago.seq, negocio: pago.business_id, nivel: 'error', evento: 'pago.confirmacion_fallida',
      detalle: { transactionId: id, error: r.error, codigo: r.codigo ?? null, intento: act ? act.attempts : null, final: vencido } });
    return act || pago;
  }

  /* 3. Tarea periódica: reintenta confirmaciones pendientes y vence formularios abandonados. */
  async function revisarPendientes() {
    if (!disponible) return { reintentados: 0, vencidos: 0 };
    const ahora = reloj();
    const vencidos = await pool.query(
      `UPDATE subscription_payments SET status = 'expired'
        WHERE status IN ('pending', 'superseded') AND payphone_transaction_id IS NULL AND expires_at < $1
        RETURNING seq, business_id`, [new Date(ahora.getTime() - 5 * 60 * 1000)]);
    const pendientes = (await pool.query(
      `SELECT seq FROM subscription_payments
        WHERE status IN ('pending', 'superseded', 'error') AND payphone_transaction_id IS NOT NULL
          AND created_at > $1 AND (last_attempt_at IS NULL OR last_attempt_at < $2)
        ORDER BY seq LIMIT 20`,
      [new Date(ahora.getTime() - REINTENTOS_HASTA_MS - 60 * 1000), new Date(ahora.getTime() - esperaReintentoMs)])).rows;
    for (const p of pendientes) {
      try {
        await consultarYAplicar(p.seq);
      } catch (error) {
        registro.error('PAGOS: reintento fallido:', error.message);
      }
    }
    return { reintentados: pendientes.length, vencidos: vencidos.rowCount };
  }

  /* Historial del negocio (sin datos sensibles). */
  async function historial(businessId, limite = 20) {
    const r = await pool.query(
      `SELECT * FROM subscription_payments WHERE business_id = $1 AND status <> 'superseded'
        ORDER BY seq DESC LIMIT $2`, [String(businessId), Math.min(Math.max(Number(limite) || 20, 1), 100)]);
    return r.rows.map(resumenPago);
  }

  async function detalle(businessId, clientTransactionId) {
    const r = await pool.query(
      'SELECT * FROM subscription_payments WHERE business_id = $1 AND client_transaction_id = $2',
      [String(businessId), String(clientTransactionId || '')]);
    if (!r.rows[0]) throw new ErrorPago(404, 'NO_ENCONTRADO', 'Pago no encontrado');
    return resumenPago(r.rows[0]);
  }

  return { disponible, estado, iniciar, confirmar, revisarPendientes, historial, detalle };
}

module.exports = { crearPagos, leerConfiguracion, ErrorPago, sumarMes, CONFIRM_OFICIAL, CAJITA_JS_OFICIAL, CAJITA_CSS_OFICIAL };
