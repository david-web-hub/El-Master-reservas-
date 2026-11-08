'use strict';
/*
  Pagos de suscripción con Payphone (Paso 1, modo de pruebas) contra un Payphone SIMULADO.
  - Configuración: desactivado por defecto; producción exige autorización expresa.
  - Checkout: monto del plan en centavos, clientTransactionId único, sin datos de tarjeta.
  - Confirmación en el servidor (API Confirm): aprobado, rechazado, monto distinto,
    respuesta ajena, Payphone caído y reintentos.
  - Sin cobros ni activaciones duplicados: confirmaciones repetidas y simultáneas.
  - Panel Maestro como autoridad: el pago se aplica de forma provisional hasta que
    el Panel lo registra (paymentsAppliedSeq); una suspensión del Panel prevalece.
  - Ningún dato sensible de la tarjeta queda guardado.
  Requiere TEST_DATABASE_URL. La prueba de navegador requiere además Chromium.
*/
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Pool } = require('pg');
const { iniciarServidor, urlBasePruebas, cookieDe } = require('./apoyo/servidor');
const { cabecerasFirmadas } = require('../firma-plataforma');
const { abrirNavegador } = require('./apoyo/navegador');
const { leerConfiguracion, sumarMes, crearPagos, CONFIRM_OFICIAL, CAJITA_JS_OFICIAL } = require('../pagos');

const URL_PG = urlBasePruebas();
const omitir = URL_PG ? false : 'Define TEST_DATABASE_URL con una base de pruebas';
const CLAVE_PLATAFORMA = 'clave-de-plataforma-solo-para-pruebas-0123456789';
const CLAVE = 'Una-clave-bastante-segura-7';
const TOKEN = 'token-payphone-de-prueba';
const STORE = 'store-de-prueba';
const unico = () => Math.random().toString(36).slice(2, 10);
const CATALOGO = [
  { name: 'Individual', price: 10.99, trialDays: 7, active: true, maxBarbers: 1 },
  { name: 'Pro', price: 19.99, trialDays: 7, active: true, maxBarbers: 4 },
  { name: 'Business', price: 34.99, trialDays: 7, active: true, maxBarbers: 10 }
];
const DIA = 24 * 3600 * 1000;

/* ---------- Payphone simulado: API Confirm y una Cajita mínima ---------- */
function payphoneSimulado() {
  const transacciones = new Map(); // clientTransactionId -> { id, amount }
  const reglas = new Map();        // clientTransactionId -> cambios en la respuesta
  const llamadas = [];
  /* Payphone asigna ids únicos: el simulado empieza en un número al azar para no repetir los de otras ejecuciones. */
  let siguiente = 100000000 + Math.floor(Math.random() * 800000000);
  const leer = req => new Promise(ok => { let t = ''; req.on('data', c => { t += c; }); req.on('end', () => { try { ok(JSON.parse(t || '{}')); } catch { ok({}); } }); });
  const srv = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    const json = (status, cuerpo) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(cuerpo)); };
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (req.method === 'GET' && req.url === '/cajita.css') { res.writeHead(200, { 'Content-Type': 'text/css' }); return res.end('#pagar-simulado{padding:10px}'); }
    if (req.method === 'GET' && req.url === '/cajita.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      return res.end(`window.PPaymentButtonBox = class {
        constructor(o) { this.o = o; window.__cajita = o; }
        render(id) {
          const b = document.createElement('button');
          b.id = 'pagar-simulado'; b.textContent = 'Pagar (Payphone simulado)';
          b.onclick = async () => {
            const r = await fetch('${'http://127.0.0.1:' + '__PUERTO__'}/box', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(this.o) });
            const { id } = await r.json();
            location.href = '/pagos/payphone/respuesta?id=' + id + '&clientTransactionId=' + encodeURIComponent(this.o.clientTransactionId);
          };
          document.getElementById(id).appendChild(b);
        }
      };`.replace('__PUERTO__', String(srv.address().port)));
    }
    if (req.method === 'POST' && req.url === '/box') {
      const o = await leer(req);
      const id = pagar(o.clientTransactionId, o.amount);
      return json(200, { id });
    }
    if (req.method === 'POST' && req.url === '/api/confirm') {
      const cuerpo = await leer(req);
      llamadas.push({ auth: req.headers.authorization, cuerpo });
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { message: 'No autorizado', errorCode: 401 });
      const regla = reglas.get(cuerpo.clientTxId) || {};
      if (regla.fallos > 0) { regla.fallos--; return json(500, { message: 'Error interno simulado' }); }
      const tx = transacciones.get(cuerpo.clientTxId);
      if (!tx || tx.id !== Number(cuerpo.id)) return json(400, { message: 'La transacción no existe, verifique que el identificador enviado sea correcto.', errorCode: 20 });
      const codigo = regla.statusCode ?? 3;
      return json(200, {
        email: 'titular@prueba.test', cardType: 'Credit', bin: '530219', lastDigits: 'XX17', deferredCode: '00000000', deferred: false,
        cardBrandCode: '51', cardBrand: 'Mastercard Banco de Prueba', amount: regla.amount ?? tx.amount,
        clientTransactionId: regla.clientTransactionId ?? cuerpo.clientTxId, phoneNumber: '593999999999',
        statusCode: codigo, transactionStatus: codigo === 3 ? 'Approved' : 'Canceled', authorizationCode: codigo === 3 ? 'W' + tx.id : null,
        message: codigo === 2 ? 'Transacción rechazada por el emisor' : null, messageCode: 0, transactionId: tx.id,
        document: '1234567890', currency: 'USD', optionalParameter4: 'TITULAR DE PRUEBA', storeName: 'MF Plux', date: new Date().toISOString(),
        regionIso: 'EC', transactionType: 'Classic', reference: 'MF Plux'
      });
    }
    json(404, {});
  });
  /* Lo que hace la Cajita al cobrar: Payphone asigna un id a la transacción. */
  function pagar(ctx, amount) {
    const id = siguiente++;
    transacciones.set(ctx, { id, amount: Number(amount) });
    return id;
  }
  return {
    reglas, llamadas, pagar,
    iniciar: () => new Promise(ok => srv.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${srv.address().port}`))),
    cerrar: () => new Promise(ok => srv.close(ok))
  };
}

/* ---------- Unidades sin servidor ---------- */
test('configuración: desactivado por defecto y producción solo con autorización expresa', () => {
  assert.equal(leerConfiguracion({}).activo, false);
  assert.equal(leerConfiguracion({ PAGOS_PAYPHONE: 'si' }).activo, false);
  assert.match(leerConfiguracion({ PAGOS_PAYPHONE: 'pruebas', PAYPHONE_TOKEN: 'x' }).motivo, /PAYPHONE_STORE_ID/);
  const pruebas = leerConfiguracion({ PAGOS_PAYPHONE: 'pruebas', PAYPHONE_TOKEN: 't', PAYPHONE_STORE_ID: 's' });
  assert.equal(pruebas.activo, true);
  assert.equal(pruebas.modo, 'pruebas');
  assert.equal(pruebas.confirmUrl, CONFIRM_OFICIAL);
  const sinAutorizar = leerConfiguracion({ PAGOS_PAYPHONE: 'produccion', PAYPHONE_TOKEN: 't', PAYPHONE_STORE_ID: 's' });
  assert.equal(sinAutorizar.activo, false, 'producción sin PAGOS_REALES_AUTORIZADOS no cobra');
  const autorizado = leerConfiguracion({ PAGOS_PAYPHONE: 'produccion', PAYPHONE_TOKEN: 't', PAYPHONE_STORE_ID: 's', PAGOS_REALES_AUTORIZADOS: 'si' });
  assert.equal(autorizado.activo, true);
  /* En producción nunca se usan direcciones distintas de las oficiales de Payphone. */
  const desviado = leerConfiguracion({ PAGOS_PAYPHONE: 'pruebas', PAYPHONE_TOKEN: 't', PAYPHONE_STORE_ID: 's',
    PAYPHONE_CONFIRM_URL: 'https://otro.example/confirm', PAYPHONE_CAJITA_JS: 'https://otro.example/c.js' }, { produccion: true });
  assert.equal(desviado.confirmUrl, CONFIRM_OFICIAL);
  assert.equal(desviado.cajitaJs, CAJITA_JS_OFICIAL);
  assert.equal(leerConfiguracion({ PAGOS_PAYPHONE: 'pruebas', PAYPHONE_TOKEN: 't', PAYPHONE_STORE_ID: 's',
    PAYPHONE_CONFIRM_URL: 'http://127.0.0.1:1/confirm' }).confirmUrl, 'http://127.0.0.1:1/confirm');
  /* Un pago de prueba nunca activa una suscripción en producción, aunque se pida. */
  const pruebasEnProduccion = { PAGOS_PAYPHONE: 'pruebas', PAYPHONE_TOKEN: 't', PAYPHONE_STORE_ID: 's', PAGOS_PRUEBAS_ACTIVAN: 'si' };
  assert.equal(leerConfiguracion(pruebasEnProduccion, { produccion: true }).activaSuscripciones, false);
  assert.equal(leerConfiguracion({ ...pruebasEnProduccion, PAGOS_PRUEBAS_ACTIVAN: '' }).activaSuscripciones, false);
  assert.equal(leerConfiguracion(pruebasEnProduccion).activaSuscripciones, true, 'solo fuera de producción');
  assert.equal(autorizado.activaSuscripciones, true, 'un cobro real sí activa');
});

test('un mes de suscripción: mismo día del mes siguiente, o el último día si no existe', () => {
  assert.equal(sumarMes('2026-01-31T15:00:00.000Z').toISOString(), '2026-02-28T15:00:00.000Z');
  assert.equal(sumarMes('2028-01-31T15:00:00.000Z').toISOString(), '2028-02-29T15:00:00.000Z');
  assert.equal(sumarMes('2026-11-07T05:00:00.000Z').toISOString(), '2026-12-07T05:00:00.000Z');
  assert.equal(sumarMes('2026-12-15T00:00:00.000Z').toISOString(), '2027-01-15T00:00:00.000Z');
});

/* ---------- Servidor real con PostgreSQL y Payphone simulado ---------- */
function crearPool() {
  const sinSsl = new URL(URL_PG).searchParams.get('sslmode') === 'disable';
  const pool = new Pool({ connectionString: URL_PG, ssl: sinSsl ? false : { rejectUnauthorized: false }, max: 3 });
  pool.on('error', () => {});
  return pool;
}

async function plataforma(s, metodo, ruta, cuerpo) {
  const texto = cuerpo === undefined ? '' : JSON.stringify(cuerpo);
  const r = await fetch(s.base + ruta, {
    method: metodo,
    headers: { ...cabecerasFirmadas(CLAVE_PLATAFORMA, { metodo, ruta, cuerpo: texto }), ...(cuerpo === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: cuerpo === undefined ? undefined : texto
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function registrar(s, plan = 'Individual') {
  const correo = `pagos-${unico()}@prueba.test`;
  const desde = s.logs.length;
  const r = await s.pedir('POST', '/api/auth/registro',
    { businessName: `Barbería Pagos ${unico()}`, name: 'Dueña', email: correo, password: CLAVE, plan }, { cookie: null });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const linea = await s.esperarLog(new RegExp(`\\[DEMO CORREO\\] ${correo.replace(/[.+]/g, '\\$&')} `), 5000, desde);
  await s.pedir('POST', '/api/auth/verificar', { token: linea.match(/verificar=([A-Za-z0-9_-]+)/)[1] }, { cookie: null });
  const login = await s.pedir('POST', '/api/auth/login', { email: correo, password: CLAVE }, { cookie: null });
  assert.equal(login.status, 200);
  return { id: r.json.business.id, cookie: cookieDe(login) };
}

const suscripcion = async (s, b) => (await plataforma(s, 'GET', `/api/plataforma/negocios/${b.id}`)).json.business.subscription;
const iniciar = (s, b, plan) => s.pedir('POST', '/api/admin/pagos', { plan }, { cookie: b.cookie });
const respuesta = (s, id, ctx) => s.pedir('GET', `/pagos/payphone/respuesta?id=${id}&clientTransactionId=${encodeURIComponent(ctx)}`, undefined, { cookie: null });
const detalle = async (s, b, ctx) => (await s.pedir('GET', `/api/admin/pagos/${encodeURIComponent(ctx)}`, undefined, { cookie: b.cookie })).json.payment;

async function eventosDe(s, negocio) {
  const r = await plataforma(s, 'GET', '/api/plataforma/eventos?limite=200');
  assert.equal(r.status, 200);
  return r.json.events.filter(e => e.businessId === negocio && e.type.startsWith('payment.'));
}

test.describe('Pagos con Payphone simulado', { skip: omitir }, () => {
  let s, apagado, sinActivar, pp, pool, basePayphone;

  test.before(async () => {
    pool = crearPool();
    pp = payphoneSimulado();
    const base = basePayphone = await pp.iniciar();
    s = await iniciarServidor({ postgres: true, env: {
      PLATAFORMA_CLAVE: CLAVE_PLATAFORMA,
      PAGOS_PAYPHONE: 'pruebas', PAYPHONE_TOKEN: TOKEN, PAYPHONE_STORE_ID: STORE,
      PAYPHONE_CONFIRM_URL: base + '/api/confirm', PAYPHONE_CAJITA_JS: base + '/cajita.js', PAYPHONE_CAJITA_CSS: base + '/cajita.css',
      PAGOS_REVISION_MS: '300', PAGOS_REINTENTO_MS: '200',
      /* Solo fuera de producción: deja que los pagos de prueba activen suscripciones para probar ese flujo. */
      PAGOS_PRUEBAS_ACTIVAN: 'si'
    } });
    assert.equal((await plataforma(s, 'PUT', '/api/plataforma/planes', { plans: CATALOGO })).status, 200);
    apagado = await iniciarServidor({ postgres: true, env: { PLATAFORMA_CLAVE: CLAVE_PLATAFORMA } });
    /* Como en producción con credenciales de PRUEBAS: los pagos se confirman pero no activan nada. */
    sinActivar = await iniciarServidor({ postgres: true, env: {
      PLATAFORMA_CLAVE: CLAVE_PLATAFORMA, PAGOS_PAYPHONE: 'pruebas', PAYPHONE_TOKEN: TOKEN, PAYPHONE_STORE_ID: STORE,
      PAYPHONE_CONFIRM_URL: base + '/api/confirm', PAYPHONE_CAJITA_JS: base + '/cajita.js', PAYPHONE_CAJITA_CSS: base + '/cajita.css'
    } });
  });
  test.after(async () => {
    for (const x of [s, apagado, sinActivar]) { if (x) { await x.detener(); x.borrar(); } }
    if (pp) await pp.cerrar();
    if (pool) await pool.end();
  });

  test('sin PAGOS_PAYPHONE no se puede pagar y Planes no ofrece pagos', async () => {
    const r = await apagado.pedir('POST', '/api/admin/pagos', { plan: 'Pro' });
    assert.equal(r.status, 503);
    assert.equal(r.json.code, 'PAGOS_DESACTIVADOS');
    const planes = await apagado.pedir('GET', '/api/admin/planes');
    assert.deepEqual(planes.json.payments, { enabled: false, mode: null, activatesSubscriptions: false, reason: 'Los pagos en línea están desactivados' });
  });

  test('checkout: monto del plan en centavos, identificador único y ningún dato de tarjeta', async () => {
    assert.equal((await s.pedir('POST', '/api/admin/pagos', { plan: 'Pro' }, { cookie: null })).status, 401, 'requiere sesión');
    const principal = await s.pedir('POST', '/api/admin/pagos', { plan: 'Pro' });
    assert.equal(principal.status, 409, 'la barbería principal (protegida) no paga');
    assert.equal(principal.json.code, 'NEGOCIO_PROTEGIDO');

    const b = await registrar(s);
    assert.equal((await iniciar(s, b, 'Premium')).json.code, 'PLAN_INVALIDO');
    const vistos = new Set();
    for (const [plan, centavos] of [['Individual', 1099], ['Pro', 1999], ['Business', 3499]]) {
      const r = await iniciar(s, b, plan);
      assert.equal(r.status, 201, JSON.stringify(r.json));
      assert.equal(r.json.mode, 'pruebas');
      assert.equal(r.json.box.amount, centavos);
      assert.equal(r.json.box.amountWithoutTax, centavos);
      assert.equal(r.json.box.currency, 'USD');
      assert.equal(r.json.box.token, TOKEN);
      assert.equal(r.json.box.storeId, STORE);
      assert.match(r.json.box.clientTransactionId, /^MFP-[A-Z0-9]+-[A-F0-9]{24}$/);
      assert.ok(r.json.box.clientTransactionId.length <= 50, 'Payphone admite hasta 50 caracteres');
      assert.ok(!vistos.has(r.json.box.clientTransactionId));
      vistos.add(r.json.box.clientTransactionId);
      for (const campo of ['cardNumber', 'cvv', 'documentId', 'email', 'phoneNumber']) assert.ok(!(campo in r.json.box), campo);
    }
    /* Los formularios abiertos antes quedan reemplazados; solo el último está pendiente. */
    const estados = (await pool.query('SELECT status FROM subscription_payments WHERE business_id = $1 ORDER BY seq', [b.id])).rows.map(r => r.status);
    assert.deepEqual(estados, ['superseded', 'superseded', 'pending']);
    const planes = await s.pedir('GET', '/api/admin/planes', undefined, { cookie: b.cookie });
    assert.deepEqual(planes.json.payments, { enabled: true, mode: 'pruebas', activatesSubscriptions: true, reason: null });
  });

  test('pago aprobado: se confirma en el servidor y activa el plan después de la prueba gratuita', async () => {
    const b = await registrar(s, 'Individual');
    const antes = await suscripcion(s, b);
    assert.equal(antes.status, 'trial');
    const r = await iniciar(s, b, 'Pro');
    const ctx = r.json.box.clientTransactionId;
    const id = pp.pagar(ctx, r.json.box.amount);

    const vuelta = await respuesta(s, id, ctx);
    assert.equal(vuelta.status, 303);
    assert.equal(vuelta.headers.get('location'), `/pago.html?resultado=${encodeURIComponent(ctx)}`);
    assert.equal(pp.llamadas.at(-1).auth, `Bearer ${TOKEN}`, 'confirmación con el token del servidor');
    assert.deepEqual(pp.llamadas.at(-1).cuerpo, { id, clientTxId: ctx });

    const p = await detalle(s, b, ctx);
    assert.equal(p.status, 'approved');
    assert.equal(p.amount, 19.99);
    assert.deepEqual(p.card, { brand: 'Mastercard Banco de Prueba', type: 'Credit', lastDigits: '17' });
    /* La prueba de 7 días no se pierde: el mes pagado empieza cuando termina. */
    assert.equal(p.periodStart, antes.trialEndsAt);
    assert.equal(p.periodEnd, sumarMes(antes.trialEndsAt).toISOString());

    const despues = await suscripcion(s, b);
    assert.equal(despues.status, 'active');
    assert.equal(despues.plan, 'Pro');
    assert.equal(despues.currentPeriodEnd, p.periodEnd);
    assert.equal(despues.pendingPanelSync, true, 'provisional hasta que el Panel lo registre');
    assert.equal(despues.storedStatus, 'trial', 'el estado que decide el Panel no se toca');
    assert.equal(despues.version, antes.version, 'la versión del Panel no cambia');

    const [evento, ...otros] = await eventosDe(s, b.id);
    assert.equal(otros.length, 0);
    assert.equal(evento.type, 'payment.approved');
    assert.equal(evento.payload.plan, 'Pro');
    assert.equal(evento.payload.amountCents, 1999);
    assert.equal(evento.payload.transactionId, id);
    assert.equal(evento.payload.periodEnd, p.periodEnd);
    assert.equal(evento.payload.mode, 'pruebas');
    assert.equal(evento.payload.cardLastDigits, '17');
    assert.equal(evento.payload.activates, true);
    assert.ok(Number.isInteger(evento.payload.seq) && evento.payload.seq > 0);
  });

  test('sin duplicados: confirmaciones repetidas y simultáneas aplican el pago una sola vez', async () => {
    const b = await registrar(s);
    const r = await iniciar(s, b, 'Individual');
    const ctx = r.json.box.clientTransactionId;
    const id = pp.pagar(ctx, r.json.box.amount);
    const llamadasAntes = pp.llamadas.length;
    const resultados = await Promise.all(Array.from({ length: 6 }, () => respuesta(s, id, ctx)));
    assert.ok(resultados.every(x => x.status === 303));
    await respuesta(s, id, ctx);
    const fila = (await pool.query('SELECT * FROM businesses WHERE id = $1', [b.id])).rows[0];
    const pagosAprobados = (await pool.query(`SELECT count(*)::int AS n FROM subscription_payments WHERE business_id = $1 AND status = 'approved'`, [b.id])).rows[0].n;
    assert.equal(pagosAprobados, 1);
    assert.equal((await eventosDe(s, b.id)).length, 1, 'un solo aviso al Panel');
    assert.equal(new Date(fila.paid_through).toISOString(), (await detalle(s, b, ctx)).periodEnd, 'el período se amplió una sola vez');
    assert.ok(pp.llamadas.length - llamadasAntes <= 6, 'una vez aprobado no se vuelve a consultar');
    /* Otro id de Payphone para el mismo pago: se rechaza y no cambia nada. */
    const ajeno = await respuesta(s, id + 999, ctx);
    assert.match(ajeno.headers.get('location'), /error=1/);
    assert.equal((await detalle(s, b, ctx)).status, 'approved');
  });

  test('modo de pruebas sin PAGOS_PRUEBAS_ACTIVAN (como en producción): el pago se confirma pero no activa nada', async () => {
    const planes = await sinActivar.pedir('GET', '/api/admin/planes');
    assert.deepEqual(planes.json.payments, { enabled: true, mode: 'pruebas', activatesSubscriptions: false, reason: null });
    const b = await registrar(sinActivar, 'Individual');
    const antes = await suscripcion(sinActivar, b);
    const r = await iniciar(sinActivar, b, 'Business');
    const ctx = r.json.box.clientTransactionId;
    await respuesta(sinActivar, pp.pagar(ctx, r.json.box.amount), ctx);
    const p = await detalle(sinActivar, b, ctx);
    assert.equal(p.status, 'approved');
    assert.equal(p.activates, false);
    assert.equal(p.periodEnd, null);
    assert.equal(p.message, 'Pago de prueba: no activa ni cambia la suscripción');
    assert.deepEqual(await suscripcion(sinActivar, b), antes, 'la suscripción no cambia');
    const fila = (await pool.query('SELECT paid_plan, paid_through, paid_seq FROM businesses WHERE id = $1', [b.id])).rows[0];
    assert.deepEqual(fila, { paid_plan: null, paid_through: null, paid_seq: '0' });
    const [evento] = await eventosDe(sinActivar, b.id);
    assert.equal(evento.type, 'payment.approved');
    assert.equal(evento.payload.activates, false, 'el Panel no lo aplicará');
    assert.equal(evento.payload.mode, 'pruebas');
  });

  test('pago rechazado: no se cobra ni cambia la suscripción; se puede intentar de nuevo', async () => {
    const b = await registrar(s);
    const antes = await suscripcion(s, b);
    const r = await iniciar(s, b, 'Individual');
    const ctx = r.json.box.clientTransactionId;
    pp.reglas.set(ctx, { statusCode: 2 });
    await respuesta(s, pp.pagar(ctx, r.json.box.amount), ctx);
    const p = await detalle(s, b, ctx);
    assert.equal(p.status, 'canceled');
    assert.equal(p.message, 'Transacción rechazada por el emisor');
    assert.equal(p.periodEnd, null);
    assert.deepEqual(await suscripcion(s, b), antes);
    const [evento] = await eventosDe(s, b.id);
    assert.equal(evento.type, 'payment.canceled', 'el Panel también ve los rechazados');
    assert.equal((await iniciar(s, b, 'Individual')).status, 201, 'puede volver a intentarlo');
  });

  test('monto distinto o respuesta ajena: queda en revisión y no se activa nada', async () => {
    const b = await registrar(s);
    const antes = await suscripcion(s, b);
    const r = await iniciar(s, b, 'Business');
    const ctx = r.json.box.clientTransactionId;
    pp.reglas.set(ctx, { amount: 100 });
    await respuesta(s, pp.pagar(ctx, r.json.box.amount), ctx);
    assert.equal((await detalle(s, b, ctx)).status, 'review');
    assert.deepEqual(await suscripcion(s, b), antes);

    const r2 = await iniciar(s, b, 'Business');
    const ctx2 = r2.json.box.clientTransactionId;
    pp.reglas.set(ctx2, { clientTransactionId: 'MFP-OTRO-' + 'A'.repeat(24) });
    await respuesta(s, pp.pagar(ctx2, r2.json.box.amount), ctx2);
    assert.equal((await detalle(s, b, ctx2)).status, 'review');
    assert.deepEqual(await suscripcion(s, b), antes);
    const log = (await pool.query(`SELECT event FROM subscription_payment_log WHERE business_id = $1 AND level = 'error'`, [b.id])).rows.map(x => x.event);
    assert.equal(log.filter(e => e === 'pago.review').length, 2, 'quedan registradas para diagnóstico');

    /* Pagos que no existen o respuestas mal formadas: ningún cambio. */
    const desconocido = await respuesta(s, 123, 'MFP-ABCDEF-' + 'B'.repeat(24));
    assert.match(desconocido.headers.get('location'), /error=1/);
    assert.match((await respuesta(s, 'x', 'no-valido')).headers.get('location'), /error=1/);
  });

  test('Payphone no responde: el pago queda pendiente, se reintenta solo y no se abre otro cobro', async () => {
    const b = await registrar(s);
    const r = await iniciar(s, b, 'Pro');
    const ctx = r.json.box.clientTransactionId;
    pp.reglas.set(ctx, { fallos: 2 });
    await respuesta(s, pp.pagar(ctx, r.json.box.amount), ctx);
    const pendiente = (await pool.query('SELECT * FROM subscription_payments WHERE client_transaction_id = $1', [ctx])).rows[0];
    assert.equal(pendiente.status, 'pending');
    assert.match(pendiente.last_error, /Payphone respondió 500/);
    const otro = await iniciar(s, b, 'Pro');
    assert.equal(otro.status, 409, 'un pago en confirmación impide abrir otro');
    assert.equal(otro.json.code, 'PAGO_EN_PROCESO');
    /* La revisión periódica lo confirma en cuanto Payphone responde. */
    const fin = Date.now() + 10000;
    let p;
    while (Date.now() < fin && (p = await detalle(s, b, ctx)).status !== 'approved') await new Promise(x => setTimeout(x, 200));
    assert.equal(p.status, 'approved');
    assert.equal((await suscripcion(s, b)).plan, 'Pro');
  });

  test('Panel Maestro como autoridad: registra el pago, deja de ser provisional y su suspensión prevalece', async () => {
    const b = await registrar(s, 'Individual');
    const r = await iniciar(s, b, 'Pro');
    const ctx = r.json.box.clientTransactionId;
    await respuesta(s, pp.pagar(ctx, r.json.box.amount), ctx);
    const [evento] = await eventosDe(s, b.id);
    const provisional = await suscripcion(s, b);

    /* El Panel registra el pago: aplica el plan pagado y su período con una versión nueva. */
    const aplicar = await plataforma(s, 'PUT', `/api/plataforma/negocios/${b.id}/suscripcion`, {
      status: 'active', plan: 'Pro', trialEndsAt: provisional.trialEndsAt, currentPeriodEnd: evento.payload.periodEnd,
      version: provisional.version + 1, paymentsAppliedSeq: evento.payload.seq
    });
    assert.equal(aplicar.status, 200, JSON.stringify(aplicar.json));
    const registrada = await suscripcion(s, b);
    assert.equal(registrada.pendingPanelSync, false);
    assert.equal(registrada.status, 'active');
    assert.equal(registrada.storedStatus, 'active');
    assert.equal(registrada.plan, 'Pro');
    assert.equal(registrada.currentPeriodEnd, evento.payload.periodEnd);

    /* Renovar el mismo plan amplía desde el final del período pagado; cambiar de plan con un período vigente, no. */
    const cambio = await iniciar(s, b, 'Business');
    assert.equal(cambio.status, 409);
    assert.equal(cambio.json.code, 'CAMBIO_EN_PERIODO');
    const renov = await iniciar(s, b, 'Pro');
    const ctx2 = renov.json.box.clientTransactionId;
    await respuesta(s, pp.pagar(ctx2, renov.json.box.amount), ctx2);
    const p2 = await detalle(s, b, ctx2);
    assert.equal(p2.periodStart, evento.payload.periodEnd);
    assert.equal(p2.periodEnd, sumarMes(evento.payload.periodEnd).toISOString());
    const conRenovacion = await suscripcion(s, b);
    assert.equal(conRenovacion.pendingPanelSync, true);
    assert.equal(conRenovacion.currentPeriodEnd, p2.periodEnd);

    /* El Panel suspende (con la renovación aún sin registrar): la suspensión prevalece sobre el pago. */
    const suspender = await plataforma(s, 'PUT', `/api/plataforma/negocios/${b.id}/suscripcion`, {
      status: 'suspended', plan: 'Pro', trialEndsAt: provisional.trialEndsAt, currentPeriodEnd: evento.payload.periodEnd,
      version: registrada.version + 1
    });
    assert.equal(suspender.status, 200);
    assert.equal((await suscripcion(s, b)).status, 'suspended');
    assert.equal((await iniciar(s, b, 'Pro')).status, 401, 'una cuenta suspendida pierde la sesión');
    /* Y aunque llegara a pedirlo, el módulo de pagos tampoco abre un cobro para una cuenta suspendida. */
    const modulo = crearPagos({ pool, registro: { log() {}, error() {} }, config: leerConfiguracion({
      PAGOS_PAYPHONE: 'pruebas', PAYPHONE_TOKEN: TOKEN, PAYPHONE_STORE_ID: STORE, PAYPHONE_CONFIRM_URL: basePayphone + '/api/confirm' }) });
    await assert.rejects(modulo.iniciar(b.id, 'Pro'), e => e.code === 'SUSPENDIDA');
    /* Repetir la misma versión solo con el acuse del pago no cambia nada más. */
    const acuse = await plataforma(s, 'PUT', `/api/plataforma/negocios/${b.id}/suscripcion`, {
      status: 'suspended', plan: 'Pro', trialEndsAt: provisional.trialEndsAt, currentPeriodEnd: evento.payload.periodEnd,
      version: registrada.version + 1, paymentsAppliedSeq: p2 && (await eventosDe(s, b.id)).at(-1).payload.seq
    });
    assert.equal(acuse.status, 200);
    const final = await suscripcion(s, b);
    assert.equal(final.status, 'suspended');
    assert.equal(final.pendingPanelSync, false);
    assert.equal(final.version, registrada.version + 1);
  });

  test('formularios abandonados vencen; si aun así llega la respuesta de Payphone, se confirma', async () => {
    const b = await registrar(s);
    const r = await iniciar(s, b, 'Individual');
    const ctx = r.json.box.clientTransactionId;
    const config = leerConfiguracion({ PAGOS_PAYPHONE: 'pruebas', PAYPHONE_TOKEN: TOKEN, PAYPHONE_STORE_ID: STORE,
      PAYPHONE_CONFIRM_URL: basePayphone + '/api/confirm' });
    const futuro = crearPagos({ pool, config, reloj: () => new Date(Date.now() + 16 * 60 * 1000), registro: { log() {}, error() {} } });
    await futuro.revisarPendientes();
    assert.equal((await detalle(s, b, ctx)).status, 'expired');
    await respuesta(s, pp.pagar(ctx, r.json.box.amount), ctx);
    assert.equal((await detalle(s, b, ctx)).status, 'approved');
  });

  test('ningún dato sensible de la tarjeta ni del titular queda guardado', async () => {
    const filas = JSON.stringify((await pool.query('SELECT * FROM subscription_payments')).rows) +
      JSON.stringify((await pool.query('SELECT * FROM subscription_payment_log')).rows) +
      JSON.stringify((await pool.query(`SELECT payload FROM platform_events WHERE type LIKE 'payment.%'`)).rows);
    for (const dato of ['530219', 'XX17', 'titular@prueba.test', '1234567890', '593999999999', 'TITULAR DE PRUEBA', TOKEN]) {
      assert.ok(!filas.includes(dato), `no se guarda ${dato}`);
    }
    const digitos = (await pool.query('SELECT DISTINCT card_last_digits FROM subscription_payments WHERE card_last_digits IS NOT NULL')).rows;
    assert.ok(digitos.every(x => /^\d{1,4}$/.test(x.card_last_digits)));
  });

  test('navegador: Planes ofrece pagar, la Cajita (simulada) cobra y el resultado confirmado se muestra', async t => {
    const navegador = await abrirNavegador();
    if (!navegador) return t.skip('Chromium no disponible');
    const b = await registrar(s, 'Individual');
    const ctx = await navegador.newContext();
    try {
      const [nombre, valor] = b.cookie.split('=');
      await ctx.addCookies([{ name: nombre, value: valor, url: s.base }]);
      const page = await ctx.newPage();
      const errores = [];
      page.on('pageerror', e => errores.push(e.message));
      await page.goto(s.base + '/admin.html', { waitUntil: 'networkidle' });
      await page.evaluate(() => window.goTo('planes'));
      await page.locator('#pagosPruebas').waitFor();
      const enlace = page.locator('[data-plan="Pro"] a', { hasText: 'Pagar con tarjeta' });
      await enlace.click();
      await page.waitForURL(/\/pago\.html\?plan=Pro/);
      await page.locator('#pagar-simulado').waitFor();
      assert.equal(await page.textContent('#titulo'), 'Plan Pro');
      assert.ok(await page.isVisible('#modo'), 'avisa que es modo de pruebas');
      const caja = await page.evaluate(() => window.__cajita);
      assert.equal(caja.amount, 1999);
      await page.click('#pagar-simulado');
      await page.waitForURL(/\/pago\.html\?resultado=/);
      await page.locator('#estado.ok').waitFor();
      assert.match(await page.textContent('#estado'), /Pago aprobado\. Tu plan Pro está pagado hasta el/);
      assert.match(await page.textContent('#detalle'), /terminada en 17/);
      assert.deepEqual(errores, []);
      assert.equal((await suscripcion(s, b)).plan, 'Pro');
    } finally {
      await ctx.close();
      await navegador.close();
    }
  });
});
