'use strict';
/*
  MF Plux: marca pública y tipo de negocio (barbería o salón de belleza).
  - Migración: solo añade una columna vacía; los negocios existentes (como El Máster) no cambian.
  - Registro: el tipo se guarda en la base y se conserva al cerrar sesión y al recargar.
  - Página pública de cada negocio: título, metadatos y textos según el tipo.
  - Mismos planes y precios para los dos tipos.
  - Dominio principal (mfplux.com): página comercial de MF Plux; El Máster sigue en su enlace
    y los webhooks de WhatsApp siguen llegando a la aplicación.
  Requiere TEST_DATABASE_URL.
*/
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Pool } = require('pg');
const { iniciarServidor, urlBasePruebas, VERIFY_TOKEN } = require('./apoyo/servidor');
const { cabecerasFirmadas } = require('../firma-plataforma');
const { abrirNavegador } = require('./apoyo/navegador');

const URL_PG = urlBasePruebas();
const omitir = URL_PG ? false : 'Define TEST_DATABASE_URL con una base de pruebas';
const CLAVE_PLATAFORMA = 'clave-de-plataforma-solo-para-pruebas-0123456789';
const CLAVE = 'Una-clave-bastante-segura-7';
const SITIO = 'mfplux.com';
const APP = 'reservas.mfplux.com';
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

/* Petición con otro dominio (Host), como llegaría por mfplux.com. */
function enHost(s, host, ruta, opciones = {}) {
  const puerto = new URL(s.base).port;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: puerto, path: ruta, method: opciones.metodo || 'GET', headers: { Host: `${host}:${puerto}`, ...(opciones.headers || {}) } }, res => {
      let datos = '';
      res.on('data', c => { datos += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, texto: datos }));
    });
    req.on('error', reject);
    req.end(opciones.cuerpo);
  });
}

test.describe('MF Plux: marca y tipo de negocio', { skip: omitir }, () => {
  let s, pool;
  const negocios = {};

  /* Registro por la API, como lo hace el formulario. Devuelve el negocio creado. */
  async function registrar(tipo, nombre) {
    const correo = `mfplux-${unico()}@prueba.test`;
    const cuerpo = { businessName: nombre, name: 'Propietaria', email: correo, password: CLAVE, plan: 'Pro' };
    if (tipo !== undefined) cuerpo.businessType = tipo;
    const desde = s.logs.length;
    const r = await s.pedir('POST', '/api/auth/registro', cuerpo, { cookie: null });
    if (r.status === 201) {
      const linea = await s.esperarLog(new RegExp(`\\[DEMO CORREO\\] ${correo.replace(/[.+]/g, '\\$&')} `), 5000, desde);
      return { status: r.status, json: r.json, correo, token: linea.match(/verificar=([A-Za-z0-9_-]+)/)[1] };
    }
    return { status: r.status, json: r.json, correo };
  }

  test.before(async () => {
    pool = crearPool();
    s = await iniciarServidor({ postgres: true, env: {
      PLATAFORMA_CLAVE: CLAVE_PLATAFORMA, SITIO_PUBLICO_DOMINIO: SITIO, PUBLIC_BASE_URL: `http://${APP}:{PUERTO}`
    } });
    assert.equal((await plataforma(s, 'PUT', '/api/plataforma/planes', { plans: CATALOGO })).status, 200);
    negocios.salon = await registrar('salon', 'Salón Bella ' + unico());
    negocios.barberia = await registrar('barberia', 'Norte Cuts ' + unico());
    negocios.sinTipo = await registrar(undefined, 'Enlace Antiguo ' + unico());
  });
  test.after(async () => {
    await s.detener();
    s.borrar();
    await pool.end();
  });

  test('migración: solo añade una columna vacía; los negocios existentes no cambian', async () => {
    const col = (await pool.query(
      `SELECT is_nullable, column_default FROM information_schema.columns WHERE table_name = 'businesses' AND column_name = 'business_type'`)).rows[0];
    assert.ok(col, 'existe la columna');
    assert.equal(col.is_nullable, 'YES');
    assert.equal(col.column_default, null, 'sin valor por defecto: ninguna fila existente se reescribe');
    const principal = (await pool.query('SELECT business_type, name FROM businesses WHERE id = $1', [s.negocio])).rows[0];
    assert.equal(principal.business_type, null, 'el negocio principal (como El Máster) queda sin tipo');
    const m = (await pool.query(`SELECT count(*)::int AS n FROM master_reservas_migrations WHERE version = '2026-10-mfplux-001'`)).rows[0].n;
    assert.equal(m, 1);
    await assert.rejects(pool.query(`UPDATE businesses SET business_type = 'spa' WHERE id = $1`, [s.negocio]), /check/i, 'solo barbería o salón');
  });

  test('registro: guarda barbería o salón; sin tipo (enlace antiguo) queda barbería; tipo inválido se rechaza', async () => {
    for (const [clave, esperado] of [['salon', 'salon'], ['barberia', 'barberia'], ['sinTipo', 'barberia']]) {
      const n = negocios[clave];
      assert.equal(n.status, 201, clave);
      assert.equal(n.json.business.businessType, esperado, clave);
      const fila = (await pool.query('SELECT business_type, plan FROM businesses WHERE contact_email = $1', [n.correo])).rows[0];
      assert.equal(fila.business_type, esperado, `${clave} en la base`);
      assert.equal(fila.plan, 'Pro', 'mismo plan para los dos tipos');
    }
    const malo = await registrar('spa', 'Spa ' + unico());
    assert.equal(malo.status, 400);
    assert.equal(malo.json.code, 'TIPO_INVALIDO');
    const sinNombre = await registrar('salon', '');
    assert.equal(sinNombre.status, 400);
    assert.match(sinNombre.json.error, /tu salón/);
  });

  test('el tipo se conserva al confirmar el correo, iniciar y cerrar sesión', async () => {
    const n = negocios.salon;
    assert.equal((await s.pedir('POST', '/api/auth/verificar', { token: n.token }, { cookie: null })).status, 200);
    for (let vuelta = 0; vuelta < 2; vuelta++) {
      const cookie = await s.iniciarSesion(n.correo, CLAVE);
      assert.equal((await s.pedir('GET', '/api/auth/sesion', undefined, { cookie })).status, 200);
      assert.equal((await s.pedir('POST', '/api/auth/logout', {}, { cookie })).status, 200);
    }
    const fila = (await pool.query('SELECT business_type FROM businesses WHERE contact_email = $1', [n.correo])).rows[0];
    assert.equal(fila.business_type, 'salon');
  });

  test('página pública: título y metadatos según el tipo; el negocio principal no cambia', async () => {
    const casos = [['salon', 'Salón de belleza', 'salón de belleza'], ['barberia', 'Barbería', 'barbería']];
    for (const [clave, titulo, texto] of casos) {
      const b = negocios[clave].json.business;
      const r = await fetch(`${s.base}/b/${b.slug}/`);
      assert.equal(r.status, 200);
      const html = await r.text();
      assert.ok(html.includes(`<title>${b.name} · ${titulo}</title>`), `${clave}: título`);
      assert.ok(html.includes(`<meta property="og:title" content="${b.name} · ${titulo}">`), `${clave}: og:title`);
      assert.match(html, new RegExp(`<meta name="description" content="Reserva en ${b.name}, ${texto}\\.`));
      assert.ok(html.includes(`<meta name="business-type" content="${clave}">`));
      const site = await (await fetch(`${s.base}/b/${b.slug}/api/public/site`)).json();
      assert.equal(site.business.type, clave);
    }
    /* Si el nombre ya dice la categoría, no se repite. */
    const repetido = await registrar('salon', 'Salón de belleza Luna ' + unico());
    const htmlRepetido = await (await fetch(`${s.base}/b/${repetido.json.business.slug}/`)).text();
    assert.ok(htmlRepetido.includes(`<title>${repetido.json.business.name}</title>`));
    /* Negocio principal (El Máster) y negocios anteriores: exactamente la página de antes. */
    const raiz = await (await fetch(s.base + '/')).text();
    assert.match(raiz, /<title>Reservas<\/title>/);
    assert.doesNotMatch(raiz, /business-type|og:title/);
    const sitePrincipal = await (await fetch(s.base + '/api/public/site')).json();
    assert.equal(sitePrincipal.business.type, null);
  });

  test('el Panel Maestro recibe el tipo de cada negocio', async () => {
    const r = await plataforma(s, 'GET', '/api/plataforma/negocios');
    assert.equal(r.status, 200);
    const porId = new Map(r.json.businesses.map(b => [b.id, b]));
    assert.equal(porId.get(negocios.salon.json.business.id).businessType, 'salon');
    assert.equal(porId.get(negocios.barberia.json.business.id).businessType, 'barberia');
    assert.equal(porId.get(s.negocio).businessType, null, 'el negocio principal sigue sin tipo');
  });

  test('mismos planes y precios para barberías y salones', async () => {
    const r = await (await fetch(s.base + '/api/public/planes')).json();
    assert.deepEqual(r.plans.map(p => [p.name, p.price, p.trialDays, p.maxBarbers]), CATALOGO.map(p => [p.name, p.price, p.trialDays, p.maxBarbers]));
  });

  test('mfplux.com: página comercial de MF Plux, El Máster en su enlace y webhooks intactos', async () => {
    const r = await enHost(s, SITIO, '/');
    assert.equal(r.status, 200);
    assert.match(r.texto, /<title>MF Plux \| Reservas en línea y administración para barberías y salones de belleza<\/title>/);
    assert.match(r.texto, /<meta property="og:site_name" content="MF Plux">/);
    assert.match(r.texto, /<link rel="canonical" href="https:\/\/mfplux\.com\/">/);
    assert.match(r.texto, /id="crearBarberia"[^>]*>Crear mi cuenta</);
    assert.doesNotMatch(r.texto, /Master Plus|MASTER PLUS|El Máster/);
    for (const p of CATALOGO) assert.ok(r.texto.includes(`$${p.price.toFixed(2)}`), p.name);
    /* La página de reservas del negocio principal sigue en su enlace propio, en la aplicación. */
    const puerto = new URL(s.base).port;
    const enlace = await enHost(s, SITIO, `/b/${s.negocio}/`);
    assert.equal(enlace.status, 301);
    assert.equal(enlace.headers.location, `http://${APP}:${puerto}/b/${s.negocio}/`);
    const enApp = await enHost(s, APP, `/b/${s.negocio}/`);
    assert.equal(enApp.status, 200);
    assert.match(enApp.texto, /<title>Reservas<\/title>/);
    /* Verificación del webhook de WhatsApp por el dominio principal: llega a la aplicación (antes redirigía). */
    const ver = await enHost(s, SITIO, `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=4242`);
    assert.equal(ver.status, 200);
    assert.equal(ver.texto, '4242');
    const post = await enHost(s, SITIO, '/webhooks/whatsapp', { metodo: 'POST', headers: { 'Content-Type': 'application/json' }, cuerpo: '{}' });
    assert.notEqual(post.status, 404, 'el sitio no bloquea el webhook');
    assert.notEqual(post.status, 301);
  });

  test('navegador: elegir barbería o salón antes de los datos y textos de la página pública', async t => {
    const navegador = await abrirNavegador();
    if (!navegador) return t.skip('Chromium no disponible');
    try {
      const page = await navegador.newPage({ viewport: { width: 390, height: 844 } });
      const errores = [];
      page.on('pageerror', e => errores.push(e.message));

      /* 1. Registro: primero el tipo; el formulario no aparece antes. */
      await page.goto(s.base + '/acceso.html#registro');
      assert.equal(await page.title(), 'MF Plux | Acceso');
      assert.equal(await page.isVisible('#tipo-barberia'), true);
      assert.equal(await page.isVisible('#tipo-salon'), true);
      assert.equal(await page.isVisible('#form-registro'), false);
      await page.click('#tipo-salon');
      assert.equal(await page.textContent('#reg-negocio-etiqueta'), 'Nombre del salón');
      assert.equal(await page.textContent('#reg-tipo-texto'), 'Salón de belleza');
      await page.click('#reg-cambiar-tipo');
      assert.equal(await page.isVisible('#form-registro'), false, 'se puede volver a elegir');
      await page.click('#tipo-salon');
      const correo = `navegador-${unico()}@prueba.test`;
      const nombre = 'Salón Navegador ' + unico();
      await page.fill('#reg-negocio', nombre);
      await page.fill('#reg-nombre', 'Lucía');
      await page.fill('#reg-email', correo);
      await page.fill('#reg-clave', CLAVE);
      await page.click('#form-registro button[type="submit"]');
      await page.waitForSelector('#vista-pendiente:not(.oculto)');
      const fila = (await pool.query('SELECT slug, business_type FROM businesses WHERE contact_email = $1', [correo])).rows[0];
      assert.equal(fila.business_type, 'salon');

      /* 2. Enlace con el tipo ya elegido (?tipo=). */
      await page.goto(s.base + '/acceso.html?tipo=barberia&plan=Pro#registro');
      await page.waitForSelector('#reg-plan:not(.oculto)');
      assert.equal(await page.isVisible('#form-registro'), true);
      assert.equal(await page.textContent('#reg-negocio-etiqueta'), 'Nombre de la barbería');
      assert.equal(await page.textContent('#reg-plan'), 'Plan Pro · $19.99 al mes · hasta 4 barberos · 7 días de prueba gratis');

      /* 3. Página pública del salón: «profesionales»; se mantiene al recargar. */
      for (let vuelta = 0; vuelta < 2; vuelta++) {
        if (vuelta === 0) await page.goto(`${s.base}/b/${fila.slug}/`); else await page.reload();
        await page.waitForSelector('#ctaBtn');
        assert.equal(await page.title(), `${nombre} · Salón de belleza`);
        assert.equal((await page.textContent('[data-go="barberos"]')).replace('☺', '').trim(), 'Profesionales');
        assert.equal(await page.textContent('.brand .categoria'), 'Salón de belleza');
      }
      await page.click('#ctaBtn');
      await page.waitForSelector('text=1. Elige tu profesional');

      /* 4. Página pública de una barbería: «barberos». */
      const barberia = negocios.sinTipo.json.business;
      await page.goto(`${s.base}/b/${barberia.slug}/`);
      await page.waitForSelector('#ctaBtn');
      assert.equal(await page.title(), `${barberia.name} · Barbería`);
      assert.equal((await page.textContent('[data-go="barberos"]')).replace('☺', '').trim(), 'Barberos');
      await page.click('#ctaBtn');
      await page.waitForSelector('text=1. Elige tu barbero');

      /* 5. Negocio principal (El Máster): sin categoría añadida, igual que antes. */
      await page.goto(s.base + '/');
      await page.waitForSelector('#ctaBtn');
      assert.equal(await page.locator('.brand .categoria').count(), 0);
      assert.doesNotMatch(await page.title(), /Barbería|Salón/);
      assert.equal((await page.textContent('[data-go="barberos"]')).replace('☺', '').trim(), 'Barberos');

      assert.deepEqual(errores, []);
    } finally {
      await navegador.close();
    }
  });
});
