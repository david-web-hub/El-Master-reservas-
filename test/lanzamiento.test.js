'use strict';
/*
  Lanzamiento público de MF Plux (antes Master Plus).
  - masterfadeplus.com (SITIO_PUBLICO_DOMINIO) muestra la página pública con los planes del catálogo real;
    la aplicación de las barberías sigue en PUBLIC_BASE_URL sin cambios; nunca se enlaza al Panel Maestro (app.masterfadeplus.com).
  - Buscadores: el sitio se indexa; el acceso, los paneles y la API no.
  - Recorrido de un visitante en un navegador real (teléfono y computadora):
    página → plan → registro → confirmación → configuración → enlace de reservas → una reserva.
  - Al terminar la prueba gratuita: datos conservados, sin reservas nuevas y sin plan de pago concedido.
  Requiere TEST_DATABASE_URL.
*/
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { iniciarServidor, urlBasePruebas, cookieDe, proximoDia } = require('./apoyo/servidor');
const { cabecerasFirmadas } = require('../firma-plataforma');
const { abrirNavegador } = require('./apoyo/navegador');

const URL_PG = urlBasePruebas();
const omitir = URL_PG ? false : 'Define TEST_DATABASE_URL con una base de pruebas';
const CLAVE_PLATAFORMA = 'clave-de-plataforma-solo-para-pruebas-0123456789';
const CLAVE = 'Una-clave-bastante-segura-7';
const SITIO = 'masterfadeplus.com';
/* La aplicación de las barberías (El Máster Reservas). app.masterfadeplus.com es el Panel Maestro privado. */
const APP = 'reservas.masterfadeplus.com';
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

/* Petición con otro dominio (Host), como llegaría por masterfadeplus.com. */
async function enHost(s, host, ruta, opciones = {}) {
  const puerto = new URL(s.base).port;
  const r = await new Promise((resolve, reject) => {
    const req = require('node:http').request({ host: '127.0.0.1', port: puerto, path: ruta, method: opciones.metodo || 'GET', headers: { Host: `${host}:${puerto}`, ...(opciones.headers || {}) } }, res => {
      let datos = '';
      res.on('data', c => { datos += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, texto: datos }));
    });
    req.on('error', reject);
    req.end(opciones.cuerpo);
  });
  return r;
}

test.describe('Lanzamiento público de MF Plux', { skip: omitir }, () => {
  let s, pool, puerto, privada;

  test.before(async () => {
    pool = crearPool();
    s = await iniciarServidor({ postgres: true, env: {
      PLATAFORMA_CLAVE: CLAVE_PLATAFORMA, SITIO_PUBLICO_DOMINIO: SITIO, PUBLIC_BASE_URL: `http://${APP}:{PUERTO}`,
      SITIO_CONTACTO_EMAIL: 'hola@masterfadeplus.com'
    } });
    puerto = new URL(s.base).port;
    assert.equal((await plataforma(s, 'PUT', '/api/plataforma/planes', { plans: CATALOGO })).status, 200);
    /* Una barbería ya registrada: su nombre nunca debe aparecer en el sitio público. */
    const correo = `privada-${unico()}@prueba.test`;
    privada = 'Barbería Privada ' + unico();
    const desde = s.logs.length;
    assert.equal((await s.pedir('POST', '/api/auth/registro', { businessName: privada, name: 'Dueña', email: correo, password: CLAVE }, { cookie: null })).status, 201);
    await s.esperarLog(new RegExp(`\\[DEMO CORREO\\] ${correo.replace(/[.+]/g, '\\$&')} `), 5000, desde);
  });
  test.after(async () => {
    await s.detener();
    s.borrar();
    await pool.end();
  });

  test('la página principal: marca, funciones, planes del catálogo real y botones', async () => {
    const r = await enHost(s, SITIO, '/');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/html/);
    const html = r.texto;
    assert.match(html, /<title>MF Plux \| Reservas en línea y administración para barberías y salones de belleza<\/title>/);
    assert.match(html, /<meta name="description" content="[^"]{80,200}">/);
    assert.match(html, /<meta name="robots" content="index, follow">/);
    assert.match(html, /<link rel="canonical" href="https:\/\/masterfadeplus\.com\/">/);
    assert.match(html, /<html lang="es">/);
    assert.match(html, /"@type":"SoftwareApplication"/);
    assert.equal(r.headers['x-robots-tag'], undefined, 'se puede indexar');
    for (const p of CATALOGO) {
      assert.ok(html.includes(`data-plan="${p.name}"`), p.name);
      assert.ok(html.includes(`$${p.price.toFixed(2)}`), `${p.name} a $${p.price}`);
      assert.ok(html.includes(`href="http://${APP}:${puerto}/acceso.html?plan=${p.name}#registro"`), `Crear mi cuenta con ${p.name}`);
    }
    assert.match(html, /1 barbero o profesional<\/li>[\s\S]*Hasta 4 barberos o profesionales[\s\S]*Hasta 10 barberos o profesionales/);
    assert.match(html, /7 días de prueba gratis/);
    assert.match(html, /id="crearBarberia"[^>]*>Crear mi cuenta</);
    assert.ok(html.includes(`href="http://${APP}:${puerto}/acceso.html" id="iniciarSesion"`));
    assert.match(html, /href="\/privacidad"[\s\S]*href="\/condiciones"/);
    assert.match(html, /mailto:hola@masterfadeplus\.com/);
    /* Sin funciones pendientes ni datos de otros negocios ni el Panel Maestro. */
    assert.doesNotMatch(html, /whatsapp|elia|video/i);
    assert.doesNotMatch(html, /Panel Maestro|plataforma\//);
    assert.ok(!html.includes(privada), 'no muestra barberías registradas');
    assert.doesNotMatch(html, /El M[aá]ster/);
    assert.doesNotMatch(html, /<script(?! type="application\/ld\+json")/, 'sin JavaScript: carga rápida');
  });

  test('los cambios del catálogo del Panel se reflejan; un plan desactivado no se ofrece', async () => {
    const cambiado = [{ ...CATALOGO[0], price: 11.49 }, { ...CATALOGO[1], active: false }, CATALOGO[2]];
    assert.equal((await plataforma(s, 'PUT', '/api/plataforma/planes', { plans: cambiado })).status, 200);
    try {
      const html = (await enHost(s, SITIO, '/')).texto;
      assert.ok(html.includes('$11.49'));
      assert.ok(!html.includes('data-plan="Pro"'), 'Pro desactivado no aparece');
      assert.ok(html.includes('data-plan="Business"'));
    } finally {
      assert.equal((await plataforma(s, 'PUT', '/api/plataforma/planes', { plans: CATALOGO })).status, 200);
    }
  });

  test('privacidad, condiciones, robots.txt y sitemap.xml del dominio principal', async () => {
    for (const ruta of ['/privacidad', '/condiciones']) {
      const r = await enHost(s, SITIO, ruta);
      assert.equal(r.status, 200, ruta);
      assert.match(r.texto, new RegExp(`<link rel="canonical" href="https://masterfadeplus\\.com${ruta}">`));
      assert.match(r.texto, /hola@masterfadeplus\.com/);
    }
    assert.match((await enHost(s, SITIO, '/condiciones')).texto, /No se solicita medio de pago ni se realizan cobros automáticos/);
    const robots = await enHost(s, SITIO, '/robots.txt');
    assert.equal(robots.texto, 'User-agent: *\nAllow: /\n\nSitemap: https://masterfadeplus.com/sitemap.xml\n');
    const mapa = await enHost(s, SITIO, '/sitemap.xml');
    assert.match(mapa.headers['content-type'], /xml/);
    assert.deepEqual([...mapa.texto.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]),
      ['https://masterfadeplus.com/', 'https://masterfadeplus.com/privacidad', 'https://masterfadeplus.com/condiciones']);
  });

  test('www y cualquier otra dirección del dominio principal van a su sitio; nada privado se sirve allí', async () => {
    const www = await enHost(s, 'www.' + SITIO, '/condiciones?x=1');
    assert.equal(www.status, 301);
    assert.equal(www.headers.location, 'https://masterfadeplus.com/condiciones?x=1');
    for (const ruta of ['/admin.html', '/acceso.html', '/b/alguna/', '/api/bookings', '/politica-privacidad.html']) {
      const r = await enHost(s, SITIO, ruta);
      assert.equal(r.status, 301, ruta);
      assert.equal(r.headers.location, `http://${APP}:${puerto}${ruta}`);
    }
    const post = await enHost(s, SITIO, '/api/auth/login', { metodo: 'POST', headers: { 'Content-Type': 'application/json' }, cuerpo: '{}' });
    assert.equal(post.status, 404);
    assert.equal((await enHost(s, SITIO, '/api/health')).status, 200, 'el chequeo de salud sigue');
  });

  test('en la aplicación: la página de El Máster sigue en la raíz y lo privado no se indexa', async () => {
    const raiz = await enHost(s, APP, '/');
    assert.equal(raiz.status, 200);
    assert.doesNotMatch(raiz.texto, /MF Plux \| Reservas en línea/, 'la aplicación no cambia');
    assert.equal(raiz.headers['x-robots-tag'], undefined);
    for (const ruta of ['/acceso.html', '/admin.html', '/api/auth/config', '/salir.html']) {
      assert.equal((await enHost(s, APP, ruta)).headers['x-robots-tag'], 'noindex, nofollow', ruta);
    }
    assert.equal((await enHost(s, APP, '/robots.txt')).texto, 'User-agent: *\nDisallow: /api/\nAllow: /\n');
  });

  test('recorrido de un visitante en teléfono y computadora: página → plan → registro → configuración → enlace → reserva', async t => {
    const navegador = await abrirNavegador({ args: [`--host-resolver-rules=MAP ${SITIO} 127.0.0.1, MAP www.${SITIO} 127.0.0.1, MAP ${APP} 127.0.0.1`] });
    if (!navegador) return t.skip('Chromium no disponible');
    const vistas = [
      ['teléfono', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, 'Pro'],
      ['computadora', { viewport: { width: 1366, height: 900 } }, 'Business']
    ];
    try {
      for (const [nombreVista, vista, plan] of vistas) {
        const ctx = await navegador.newContext(vista);
        const page = await ctx.newPage();
        const errores = [];
        page.on('pageerror', e => errores.push(e.message));
        const sinDesborde = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

        /* 1. Página principal. */
        await page.goto(`http://${SITIO}:${puerto}/`);
        assert.equal(await page.title(), 'MF Plux | Reservas en línea y administración para barberías y salones de belleza');
        assert.ok(await sinDesborde(), `${nombreVista}: sin desplazamiento horizontal`);
        assert.ok(await page.locator('#crearBarberia').isVisible());
        await page.click('#crearBarberia');
        await page.locator(`[data-plan="${plan}"] a.btn`).waitFor();

        /* 2. Elige un plan → registro con el plan ya elegido. */
        await page.locator(`[data-plan="${plan}"] a.btn`).click();
        await page.waitForURL(u => u.host === `${APP}:${puerto}` && u.pathname === '/acceso.html');
        await page.locator('#reg-plan').waitFor({ state: 'visible' });
        assert.match(await page.textContent('#reg-plan'), new RegExp(`Plan ${plan}`));
        const correo = `visitante-${unico()}@prueba.test`;
        const barberia = `Barbería ${nombreVista} ${unico()}`;
        await page.click('#tipo-barberia');
        await page.fill('#reg-negocio', barberia);
        await page.fill('#reg-nombre', 'Visitante');
        await page.fill('#reg-email', correo);
        await page.fill('#reg-clave', CLAVE);
        const desde = s.logs.length;
        await page.click('#form-registro button[type="submit"]');
        const linea = await s.esperarLog(new RegExp(`\\[DEMO CORREO\\] ${correo.replace(/[.+]/g, '\\$&')} `), 5000, desde);

        /* 3. Confirma el correo con el enlace recibido e inicia sesión. */
        const enlace = linea.match(/(http\S+#verificar=[A-Za-z0-9_-]+)/)[1];
        assert.ok(enlace.startsWith(`http://${APP}:${puerto}/acceso.html#verificar=`), 'el correo lleva a la aplicación');
        await page.goto(enlace);
        await page.waitForFunction(() => /confirmad/i.test(document.body.innerText));
        await page.fill('#login-email', correo);
        await page.fill('#login-clave', CLAVE);
        await page.click('#form-login button[type="submit"]');
        await page.waitForURL(u => u.pathname === '/admin.html');
        await page.waitForFunction(() => typeof currentSession !== 'undefined' && currentSession !== null);
        assert.equal(await page.textContent('#brandName'), barberia.toUpperCase(), 'entra a su propia barbería');
        assert.ok(await sinDesborde());

        /* Solo ve su barbería: su prueba, su plan, sin datos de otras. */
        const sesion = await page.evaluate(() => currentSession);
        assert.equal(sesion.subscription.plan, plan);
        assert.equal(sesion.subscription.status, 'trial');
        assert.ok(Math.abs(new Date(sesion.subscription.trialEndsAt) - Date.now() - 7 * 864e5) < 120000, '7 días de prueba');
        const reservasIniciales = await page.evaluate(() => fetch('/api/bookings').then(r => r.json()));
        assert.doesNotMatch(JSON.stringify(reservasIniciales), /Cliente Real|Barbería Privada/);

        /* 4. Configura horarios, servicios y barberos (las mismas llamadas que hace su panel). */
        const api = (metodo, ruta, cuerpo) => page.evaluate(async ([m, r, c]) => {
          const res = await fetch(r, { method: m, headers: c ? { 'Content-Type': 'application/json' } : {}, body: c ? JSON.stringify(c) : undefined });
          return { status: res.status, json: await res.json().catch(() => null) };
        }, [metodo, ruta, cuerpo]);
        const semana = {};
        for (let d = 0; d < 7; d++) semana[d] = { open: true, from: '09:00', to: '18:00' };
        assert.equal((await api('PUT', '/api/admin/hours', { hours: semana })).status, 200);
        const servicio = await api('POST', '/api/admin/services', { name: 'Corte clásico', price: 8, duration: 30 });
        assert.ok(servicio.status < 300, JSON.stringify(servicio.json));
        const barbero = await api('POST', '/api/admin/barbers', { name: 'Leo' });
        assert.equal(barbero.status, 201, JSON.stringify(barbero.json));

        /* 5. Obtiene su enlace público en Configuración. */
        await page.evaluate(() => { goTo('configuracion'); openSetting('enlace'); });
        const publico = await page.inputValue('#publicLinkInput');
        assert.match(publico, new RegExp(`^http://${APP.replace(/\./g, '\\.')}:${puerto}/b/[a-z0-9-]+/$`));
        assert.ok(await sinDesborde());

        /* 6. Un cliente reserva en ese enlace y la reserva llega a su agenda. */
        const cliente = await ctx.browser().newContext(vista);
        const pc = await cliente.newPage();
        await pc.goto(publico);
        await pc.locator('#ctaBtn').waitFor();
        assert.equal(await pc.title(), barberia);
        await pc.click('#ctaBtn');
        await pc.locator('.opt:has-text("Leo")').click();
        await pc.locator('[data-svc]').filter({ hasText: 'Corte clásico' }).click();
        await pc.click('#toStep3');
        await pc.fill('#dateIn', proximoDia(2));
        await pc.locator('[data-time="10:00"]').click();
        await pc.click('#toStep4');
        await pc.fill('#bName', 'Cliente Lanzamiento');
        await pc.fill('#bPhone', '0991234567');
        await pc.click('#confirmBtn');
        await pc.locator('text=¡Reserva confirmada!').waitFor();
        await cliente.close();
        const agenda = await page.evaluate(() => fetch('/api/bookings').then(r => r.json()));
        assert.match(JSON.stringify(agenda), /Cliente Lanzamiento/);
        assert.deepEqual(errores, [], `${nombreVista}: sin errores de JavaScript`);
        await ctx.close();
      }
    } finally {
      await navegador.close();
    }
  });

  test('al terminar la prueba: se conservan los datos, no hay reservas nuevas y no se concede ningún plan de pago', async () => {
    const correo = `vence-${unico()}@prueba.test`;
    const desde = s.logs.length;
    const reg = await s.pedir('POST', '/api/auth/registro', { businessName: 'Barbería Vence ' + unico(), name: 'Dueño', email: correo, password: CLAVE, plan: 'Pro' }, { cookie: null });
    assert.equal(reg.status, 201);
    const linea = await s.esperarLog(new RegExp(`\\[DEMO CORREO\\] ${correo.replace(/[.+]/g, '\\$&')} `), 5000, desde);
    await s.pedir('POST', '/api/auth/verificar', { token: linea.match(/verificar=([A-Za-z0-9_-]+)/)[1] }, { cookie: null });
    const cookie = cookieDe(await s.pedir('POST', '/api/auth/login', { email: correo, password: CLAVE }, { cookie: null }));
    const slug = reg.json.business.slug;
    const reserva = { name: 'Antes de vencer', phone: '0990001111', barberId: 'barbero-1', serviceIds: ['corte'], date: proximoDia(3), time: '11:00' };
    assert.equal((await s.pedir('POST', `/b/${slug}/api/bookings`, reserva, { cookie: null })).status, 201);

    /* Pasa el tiempo: la prueba termina (nadie cambia el estado guardado). */
    await pool.query(`UPDATE businesses SET trial_ends_at = NOW() - interval '1 minute' WHERE id = $1`, [reg.json.business.id]);
    const sesion = (await s.pedir('GET', '/api/auth/sesion', undefined, { cookie })).json;
    assert.equal(sesion.subscription.status, 'expired');
    assert.equal(sesion.subscription.canBook, false);
    assert.equal(sesion.subscription.plan, 'Pro', 'sin ningún plan de pago nuevo');
    const nueva = await s.pedir('POST', `/b/${slug}/api/bookings`, { ...reserva, name: 'Después de vencer', time: '12:00' }, { cookie: null });
    assert.ok(nueva.status >= 400, 'no recibe reservas nuevas');
    assert.match(JSON.stringify((await s.pedir('GET', '/api/bookings', undefined, { cookie })).json), /Antes de vencer/, 'sus reservas se conservan');
    /* Puede pedir un plan, pero queda pendiente hasta que el Panel Maestro lo apruebe. */
    const pedir = await s.pedir('POST', '/api/admin/planes/solicitud', { plan: 'Business' }, { cookie });
    assert.equal(pedir.status, 201);
    assert.equal(pedir.json.subscription.status, 'expired');
    assert.equal(pedir.json.subscription.plan, 'Pro');
  });

  test('el sitio nunca enlaza al Panel Maestro: con PUBLIC_BASE_URL en app.<dominio> no se activa', async () => {
    const html = (await enHost(s, SITIO, '/')).texto + (await enHost(s, SITIO, '/privacidad')).texto + (await enHost(s, SITIO, '/condiciones')).texto;
    assert.ok(!html.includes('app.masterfadeplus.com'), 'ningún enlace al Panel Maestro');
    const panel = await iniciarServidor({ postgres: true, env: { SITIO_PUBLICO_DOMINIO: SITIO, PUBLIC_BASE_URL: 'https://app.masterfadeplus.com' } });
    try {
      assert.ok(panel.logs.some(l => /SITIO PÚBLICO DESACTIVADO: .*Panel Maestro/.test(l)));
      const r = await enHost(panel, SITIO, '/admin.html');
      assert.notEqual(r.headers.location, 'https://app.masterfadeplus.com/admin.html', 'no redirige al Panel Maestro');
      assert.doesNotMatch((await enHost(panel, SITIO, '/')).texto, /app\.masterfadeplus\.com/);
    } finally {
      await panel.detener();
      panel.borrar();
    }
  });

  test('sin SITIO_PUBLICO_DOMINIO o con la aplicación en el mismo dominio, el sitio no se activa', async () => {
    const mal = await iniciarServidor({ postgres: true, env: { SITIO_PUBLICO_DOMINIO: SITIO, PUBLIC_BASE_URL: `https://${SITIO}` } });
    try {
      assert.ok(mal.logs.some(l => /SITIO PÚBLICO DESACTIVADO: .*mismo dominio/.test(l)));
      const r = await enHost(mal, SITIO, '/');
      assert.doesNotMatch(r.texto, /MF Plux \| Reservas en línea/, 'no reemplaza la página de reservas');
    } finally {
      await mal.detener();
      mal.borrar();
    }
  });
});
