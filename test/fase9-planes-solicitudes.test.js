'use strict';
/*
  Fase 9: sección «Planes» del propietario.
  - Muestra el catálogo real del Panel Maestro (sin precios fijos en el código), el plan actual,
    la prueba o el estado de la suscripción y los barberos activos.
  - Sin cobros integrados, cambiar de plan es una SOLICITUD que aprueba el Panel Maestro:
    hasta entonces no cambia nada. Bajar con más barberos activos que el nuevo límite se rechaza.
  - Solo el propietario de cada barbería pide para la suya; El Máster sigue protegida.
  - El Panel Maestro lista y resuelve las solicitudes con la API firmada.
  Requiere TEST_DATABASE_URL.
*/
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { iniciarServidor, reiniciar, urlBasePruebas, cookieDe } = require('./apoyo/servidor');
const { cabecerasFirmadas } = require('../firma-plataforma');
const { abrirNavegador } = require('./apoyo/navegador');

const URL_PG = urlBasePruebas();
const omitir = URL_PG ? false : 'Define TEST_DATABASE_URL con una base de pruebas';
const CLAVE_PLATAFORMA = 'clave-de-plataforma-solo-para-pruebas-0123456789';
const CLAVE = 'Una-clave-bastante-segura-7';
const unico = () => Math.random().toString(36).slice(2, 10);
const CATALOGO = [
  { name: 'Individual', price: 10.99, trialDays: 7, active: true, maxBarbers: 1 },
  { name: 'Pro', price: 19.99, trialDays: 7, active: true, maxBarbers: 4 },
  { name: 'Business', price: 34.99, trialDays: 7, active: true, maxBarbers: 10 }
];

function crearPool() {
  const sinSsl = new URL(URL_PG).searchParams.get('sslmode') === 'disable';
  const pool = new Pool({ connectionString: URL_PG, ssl: sinSsl ? false : { rejectUnauthorized: false }, max: 2 });
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

async function registrar(s, plan) {
  const correo = `planes-${unico()}@prueba.test`;
  const desde = s.logs.length;
  const r = await s.pedir('POST', '/api/auth/registro',
    { businessName: `Barbería ${plan} ${unico()}`, name: 'Dueño', email: correo, password: CLAVE, plan }, { cookie: null });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const linea = await s.esperarLog(new RegExp(`\\[DEMO CORREO\\] ${correo.replace(/[.+]/g, '\\$&')} `), 5000, desde);
  await s.pedir('POST', '/api/auth/verificar', { token: linea.match(/verificar=([A-Za-z0-9_-]+)/)[1] }, { cookie: null });
  const login = await s.pedir('POST', '/api/auth/login', { email: correo, password: CLAVE }, { cookie: null });
  assert.equal(login.status, 200);
  return { id: r.json.business.id, correo, cookie: cookieDe(login) };
}

const planes = (s, b) => s.pedir('GET', '/api/admin/planes', undefined, { cookie: b.cookie });
const solicitar = (s, b, plan) => s.pedir('POST', '/api/admin/planes/solicitud', { plan }, { cookie: b.cookie });
const suscripcion = async (s, b) => (await plataforma(s, 'GET', `/api/plataforma/negocios/${b.id}`)).json.business.subscription;

/* Lo que hace el Panel Maestro al aprobar: aplica el plan (con sus validaciones) y luego marca la solicitud. */
async function aprobar(s, b, solicitud) {
  const actual = await suscripcion(s, b);
  const aplicar = await plataforma(s, 'PUT', `/api/plataforma/negocios/${b.id}/suscripcion`, {
    status: actual.storedStatus, plan: solicitud.requestedPlan, trialEndsAt: actual.trialEndsAt,
    currentPeriodEnd: actual.currentPeriodEnd, version: actual.version + 1
  });
  if (aplicar.status !== 200) return aplicar;
  return plataforma(s, 'POST', `/api/plataforma/solicitudes/${solicitud.id}/resolver`, { status: 'approved' });
}

test.describe('Fase 9 · sección Planes y solicitudes de cambio', { skip: omitir }, () => {
  let s, pool;

  test.before(async () => {
    pool = crearPool();
    s = await iniciarServidor({ postgres: true, env: { PLATAFORMA_CLAVE: CLAVE_PLATAFORMA } });
    const r = await plataforma(s, 'PUT', '/api/plataforma/planes', { plans: CATALOGO });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  });
  test.after(async () => {
    await plataforma(s, 'PUT', '/api/plataforma/planes', { plans: CATALOGO }).catch(() => {});
    await s.detener();
    s.borrar();
    await pool.end();
  });

  test('muestra el catálogo del Panel Maestro, el plan actual, la prueba y los barberos', async () => {
    const b = await registrar(s, 'Individual');
    const r = await planes(s, b);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.deepEqual(r.json.plans, CATALOGO.map(p => ({
      name: p.name, price: p.price, trialDays: p.trialDays, maxBarbers: p.maxBarbers, available: true, current: p.name === 'Individual'
    })));
    assert.equal(r.json.principal, false);
    assert.equal(r.json.subscription.plan, 'Individual');
    assert.equal(r.json.subscription.status, 'trial');
    assert.ok(r.json.subscription.trialEndsAt, 'fecha de fin de la prueba');
    assert.deepEqual(r.json.limits, { plan: 'Individual', maxBarbers: 1, activeBarbers: 1 });
    assert.equal(r.json.request, null);
  });

  test('los cambios del catálogo se reflejan solos; un plan desactivado no se ofrece, el contratado se conserva', async () => {
    const b = await registrar(s, 'Pro');
    const cambiado = [
      { ...CATALOGO[0], price: 11.49 },
      { ...CATALOGO[1], name: 'Pro', active: false },
      { ...CATALOGO[2], maxBarbers: 12 }
    ];
    assert.equal((await plataforma(s, 'PUT', '/api/plataforma/planes', { plans: cambiado })).status, 200);
    try {
      const r = (await planes(s, b)).json;
      assert.deepEqual(r.plans.map(p => [p.name, p.price, p.maxBarbers, p.available, p.current]),
        [['Individual', 11.49, 1, true, false], ['Pro', 19.99, 4, false, true], ['Business', 34.99, 12, true, false]]);
      assert.equal(r.subscription.plan, 'Pro', 'su plan contratado sigue igual');
      /* Otra barbería sin ese plan ya no lo ve. */
      const otra = await registrar(s, 'Individual');
      assert.deepEqual((await planes(s, otra)).json.plans.map(p => p.name), ['Individual', 'Business']);
      const pedir = await solicitar(s, otra, 'Pro');
      assert.equal(pedir.status, 400);
      assert.equal(pedir.json.code, 'PLAN_INVALIDO');
    } finally {
      assert.equal((await plataforma(s, 'PUT', '/api/plataforma/planes', { plans: CATALOGO })).status, 200);
    }
  });

  test('pedir un plan superior crea una solicitud pendiente y no concede nada antes de aprobarla', async () => {
    const b = await registrar(s, 'Individual');
    const r = await solicitar(s, b, 'pro');
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.match(r.json.message, /cuando Master Plus la apruebe/);
    assert.equal(r.json.request.status, 'pending');
    assert.equal(r.json.request.requestedPlan, 'Pro');
    assert.equal(r.json.request.currentPlan, 'Individual');
    /* Sin privilegios: sigue en Individual con 1 barbero. */
    assert.equal(r.json.subscription.plan, 'Individual');
    const extra = await s.pedir('POST', '/api/admin/barbers', { name: 'Segundo' }, { cookie: b.cookie });
    assert.equal(extra.status, 403);
    assert.equal(extra.json.code, 'LIMITE_BARBEROS');
    /* El mismo plan que ya tiene no se pide. */
    assert.equal((await solicitar(s, b, 'Individual')).json.code, 'MISMO_PLAN');
    /* Pedir otro reemplaza la pendiente (solo una a la vez). */
    const otra = await solicitar(s, b, 'Business');
    assert.equal(otra.status, 201);
    const filas = (await pool.query('SELECT requested_plan, status FROM plan_requests WHERE business_id = $1 ORDER BY created_at', [b.id])).rows;
    assert.deepEqual(filas.map(f => [f.requested_plan, f.status]), [['Pro', 'cancelled'], ['Business', 'pending']]);
    /* El Panel Maestro recibe el aviso. */
    const eventos = (await pool.query(`SELECT type FROM platform_events WHERE business_id = $1 AND type LIKE 'plan.%'`, [b.id])).rows.map(e => e.type);
    assert.deepEqual(eventos, ['plan.requested', 'plan.requested']);
  });

  test('el Panel Maestro lista y aprueba: el plan cambia y no se pierde ningún dato', async () => {
    const b = await registrar(s, 'Individual');
    const reserva = await s.pedir('POST', `/b/${(await pool.query('SELECT slug FROM businesses WHERE id = $1', [b.id])).rows[0].slug}/api/bookings`,
      { name: 'Cliente Fase 9', phone: '0991239999', barberId: 'barbero-1', serviceIds: ['corte'], date: require('./apoyo/servidor').proximoDia(3), time: '11:00' }, { cookie: null });
    assert.equal(reserva.status, 201, JSON.stringify(reserva.json));
    const pedida = (await solicitar(s, b, 'Pro')).json.request;
    const lista = await plataforma(s, 'GET', '/api/plataforma/solicitudes');
    assert.equal(lista.status, 200);
    const enLista = lista.json.requests.find(x => x.id === pedida.id);
    assert.equal(enLista.status, 'pending');
    assert.equal(enLista.businessId, b.id);
    assert.ok(enLista.businessName.startsWith('Barbería Individual'));

    /* Marcarla aprobada sin aplicar el plan no se permite. */
    const antes = await plataforma(s, 'POST', `/api/plataforma/solicitudes/${pedida.id}/resolver`, { status: 'approved' });
    assert.equal(antes.status, 409);
    assert.equal(antes.json.code, 'PLAN_NO_APLICADO');

    const ok = await aprobar(s, b, pedida);
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.request.status, 'approved');
    const r = (await planes(s, b)).json;
    assert.equal(r.subscription.plan, 'Pro');
    assert.equal(r.subscription.status, 'trial', 'el estado y las fechas no cambian');
    assert.equal(r.limits.maxBarbers, 4);
    assert.equal(r.request.status, 'approved', 'el propietario ve que se aprobó');
    assert.equal((await s.pedir('POST', '/api/admin/barbers', { name: 'Segundo' }, { cookie: b.cookie })).status, 201);
    assert.match(JSON.stringify((await s.pedir('GET', '/api/bookings', undefined, { cookie: b.cookie })).json), /Cliente Fase 9/);
    /* Repetir la misma decisión no falla; cambiarla sí. */
    assert.equal((await plataforma(s, 'POST', `/api/plataforma/solicitudes/${pedida.id}/resolver`, { status: 'approved' })).status, 200);
    const cambiar = await plataforma(s, 'POST', `/api/plataforma/solicitudes/${pedida.id}/resolver`, { status: 'rejected' });
    assert.equal(cambiar.status, 409);
    assert.equal(cambiar.json.code, 'YA_RESUELTA');
  });

  test('el Panel Maestro rechaza con un motivo; el propietario también puede cancelar', async () => {
    const b = await registrar(s, 'Individual');
    const pedida = (await solicitar(s, b, 'Business')).json.request;
    const r = await plataforma(s, 'POST', `/api/plataforma/solicitudes/${pedida.id}/resolver`, { status: 'rejected', reason: 'Primero confirma el pago' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const vista = (await planes(s, b)).json;
    assert.equal(vista.subscription.plan, 'Individual', 'nada cambia');
    assert.equal(vista.request.status, 'rejected');
    assert.equal(vista.request.reason, 'Primero confirma el pago');
    assert.equal((await plataforma(s, 'POST', '/api/plataforma/solicitudes/no-existe/resolver', { status: 'rejected' })).status, 404);
    assert.equal((await plataforma(s, 'POST', `/api/plataforma/solicitudes/${pedida.id}/resolver`, { status: 'otro' })).status, 400);

    /* Cancelar una pendiente. */
    assert.equal((await solicitar(s, b, 'Pro')).status, 201);
    const cancelar = await s.pedir('DELETE', '/api/admin/planes/solicitud', undefined, { cookie: b.cookie });
    assert.equal(cancelar.status, 200, JSON.stringify(cancelar.json));
    assert.notEqual(cancelar.json.request?.status, 'pending');
    assert.equal((await s.pedir('DELETE', '/api/admin/planes/solicitud', undefined, { cookie: b.cookie })).status, 404);
  });

  test('bajar de plan con más barberos activos que el nuevo límite se rechaza con explicación', async () => {
    const b = await registrar(s, 'Pro');
    for (let i = 0; i < 2; i++) assert.equal((await s.pedir('POST', '/api/admin/barbers', { name: 'B' + i }, { cookie: b.cookie })).status, 201);
    const r = await solicitar(s, b, 'Individual');
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'LIMITE_BARBEROS');
    assert.equal(r.json.activeBarbers, 3);
    assert.equal(r.json.maxBarbers, 1);
    assert.match(r.json.error, /Individual/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM plan_requests WHERE business_id = $1', [b.id])).rows[0].n, 0);
    const lista = (await s.pedir('GET', '/api/admin/barbers', undefined, { cookie: b.cookie })).json.barbers;
    assert.equal(lista.filter(x => x.active !== false).length, 3, 'no se desactivó ni borró ningún barbero');
    /* Si el propietario desactiva barberos, sí puede pedir bajar. */
    for (const x of lista.filter(x => x.id !== 'barbero-1')) {
      assert.equal((await s.pedir('PATCH', `/api/admin/barbers/${x.id}`, { active: false }, { cookie: b.cookie })).status, 200);
    }
    const ahora = await solicitar(s, b, 'Individual');
    assert.equal(ahora.status, 201, JSON.stringify(ahora.json));
    /* Si entre tanto reactiva un barbero (su plan Pro lo permite), la aprobación vuelve a validar el límite. */
    const id = lista.find(x => x.id !== 'barbero-1').id;
    assert.equal((await s.pedir('PATCH', `/api/admin/barbers/${id}`, { active: true }, { cookie: b.cookie })).status, 200);
    const aprobada = await aprobar(s, b, ahora.json.request);
    assert.equal(aprobada.status, 409, 'el Panel no puede aplicar la bajada con 2 activos');
    assert.equal((await suscripcion(s, b)).plan, 'Pro');
    assert.equal((await planes(s, b)).json.request.status, 'pending', 'la solicitud sigue pendiente');
  });

  test('solo el propietario pide, solo para su barbería; El Máster sigue protegida', async () => {
    const a = await registrar(s, 'Individual');
    const otra = await registrar(s, 'Individual');
    assert.equal((await s.pedir('GET', '/api/admin/planes', undefined, { cookie: null })).status, 401);
    assert.equal((await s.pedir('POST', '/api/admin/planes/solicitud', { plan: 'Pro' }, { cookie: null })).status, 401);
    /* Enviar el id de otra barbería no sirve: la solicitud es de la suya. */
    const r = await s.pedir('POST', '/api/admin/planes/solicitud', { plan: 'Pro', businessId: otra.id }, { cookie: a.cookie, headers: { 'X-Business-Id': otra.id } });
    assert.equal(r.status, 201);
    assert.equal(r.json.request.businessId, a.id);
    assert.equal((await planes(s, otra)).json.request, null, 'la otra barbería no tiene solicitudes');
    /* Sin la firma del Panel no se lista ni se aprueba nada. */
    assert.equal((await s.pedir('GET', '/api/plataforma/solicitudes', undefined, { cookie: a.cookie })).status, 401);
    assert.equal((await s.pedir('POST', `/api/plataforma/solicitudes/${r.json.request.id}/resolver`, { status: 'approved' }, { cookie: a.cookie })).status, 401);

    /* Un barbero o recepción de la barbería no puede pedir cambios de plan. */
    const desde = s.logs.length;
    const correo = `staff-${unico()}@prueba.test`;
    assert.equal((await s.pedir('POST', '/api/admin/usuarios', { email: correo, name: 'Recepción', role: 'staff' }, { cookie: a.cookie })).status, 201);
    const linea = await s.esperarLog(new RegExp(`\\[DEMO CORREO\\] ${correo.replace(/[.+]/g, '\\$&')} `), 5000, desde);
    const acepta = await s.pedir('POST', '/api/auth/invitacion/aceptar',
      { token: linea.match(/invitacion=([A-Za-z0-9_-]+)/)[1], name: 'Recepción', password: CLAVE }, { cookie: null });
    assert.equal(acepta.status, 200);
    const staff = cookieDe(acepta);
    assert.equal((await s.pedir('GET', '/api/admin/planes', undefined, { cookie: staff })).status, 403);
    assert.equal((await s.pedir('POST', '/api/admin/planes/solicitud', { plan: 'Business' }, { cookie: staff })).status, 403);
    assert.equal((await s.pedir('DELETE', '/api/admin/planes/solicitud', undefined, { cookie: staff })).status, 403);

    /* El Máster (principal y protegida) no pide cambios. */
    const principal = await s.pedir('POST', '/api/admin/planes/solicitud', { plan: 'Pro' });
    assert.equal(principal.status, 409);
    assert.equal(principal.json.code, 'NEGOCIO_PROTEGIDO');
    const vista = (await s.pedir('GET', '/api/admin/planes')).json;
    assert.equal(vista.principal, true);
    assert.equal(vista.subscription.protected, true);
  });

  test('las solicitudes siguen después de reiniciar', async () => {
    const b = await registrar(s, 'Individual');
    const pedida = (await solicitar(s, b, 'Business')).json.request;
    s = await reiniciar(s);
    const login = await s.pedir('POST', '/api/auth/login', { email: b.correo, password: CLAVE }, { cookie: null });
    b.cookie = cookieDe(login);
    const vista = (await planes(s, b)).json;
    assert.equal(vista.request.id, pedida.id);
    assert.equal(vista.request.status, 'pending');
    assert.ok((await plataforma(s, 'GET', '/api/plataforma/solicitudes')).json.requests.some(x => x.id === pedida.id));
  });

  test('la migración de la fase 9 es aditiva y se aplica una sola vez', async () => {
    const m = (await pool.query(`SELECT count(*)::int AS n FROM master_reservas_migrations WHERE version = '2026-10-fase9-001'`)).rows[0].n;
    assert.equal(m, 1);
    const antes = (await pool.query('SELECT count(*)::int AS n FROM plan_requests')).rows[0].n;
    assert.ok(antes > 0);
    s = await reiniciar(s);
    assert.ok(!s.logs.some(l => l.includes('MIGRACIÓN APLICADA: 2026-10-fase9-001')), 'no se repite');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM plan_requests')).rows[0].n, antes);
  });

  test('en el navegador: el menú Planes en teléfono y escritorio, el plan actual y una solicitud', async t => {
    const navegador = await abrirNavegador();
    if (!navegador) return t.skip('Chromium no disponible');
    try {
      const b = await registrar(s, 'Individual');
      for (const [nombreVista, vista] of [['teléfono', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }], ['escritorio', { viewport: { width: 1366, height: 900 } }]]) {
        const ctx = await navegador.newContext(vista);
        const [nombre, valor] = b.cookie.split('=');
        await ctx.addCookies([{ name: nombre, value: valor, url: s.base }]);
        const page = await ctx.newPage();
        const errores = [];
        page.on('pageerror', e => errores.push(e.message));
        page.on('dialog', d => d.accept());
        await page.goto(s.base + '/admin.html');
        await page.waitForFunction(() => typeof currentSession !== 'undefined' && currentSession !== null);
        const enMenu = page.locator(`${vista.isMobile ? '#mobileNav' : 'aside.sidebar'} >> text=Planes`).first();
        assert.ok(await enMenu.isVisible(), `Planes visible en el menú (${nombreVista})`);
        await enMenu.click();
        await page.locator('#planActual').waitFor();
        assert.match(await page.textContent('#planActual'), /Individual/);
        assert.match(await page.textContent('#planEstado'), /prueba/i);
        const tarjetas = await page.$$eval('[data-plan]', x => x.map(e => e.getAttribute('data-plan')));
        assert.deepEqual(tarjetas, ['Individual', 'Pro', 'Business']);
        assert.match(await page.textContent('[data-plan="Individual"]'), /Plan actual/);
        assert.match(await page.textContent('[data-plan="Pro"]'), /\$19\.99[\s\S]*4 barberos/);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'sin desplazamiento horizontal');
        if (vista.isMobile) {
          await page.locator('[data-plan="Pro"] button').click();
          await page.locator('#planRequest').waitFor();
          assert.match(await page.textContent('#planRequest'), /pendiente/i);
          assert.match(await page.textContent('[data-plan="Pro"]'), /Solicitud pendiente/);
        } else {
          assert.match(await page.textContent('#planRequest'), /pendiente/i, 'la solicitud persiste en otro dispositivo');
        }
        assert.deepEqual(errores, []);
        await ctx.close();
      }
      assert.equal((await planes(s, b)).json.subscription.plan, 'Individual', 'el plan no cambia sin aprobación');

      /* El Máster no ve la sección (está protegida). */
      const ctx = await navegador.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
      const [nombre, valor] = s.cookie.split('=');
      await ctx.addCookies([{ name: nombre, value: valor, url: s.base }]);
      const page = await ctx.newPage();
      await page.goto(s.base + '/admin.html');
      await page.waitForFunction(() => typeof currentSession !== 'undefined' && currentSession !== null);
      assert.equal(await page.evaluate(() => visiblePages().some(p => p[0] === 'planes')), false);
      await ctx.close();
    } finally {
      await navegador.close();
    }
  });
});
