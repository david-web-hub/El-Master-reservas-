'use strict';
/*
  Fase 7: barberías reales e independientes.
  - Registro: cada barbería con su dirección, su primer barbero y su enlace.
  - Página pública de reservas por barbería (/b/<dirección>/); la principal sigue en "/".
  - Aislamiento de reservas y datos entre barberías.
  - WhatsApp propio de cada barbería (credenciales cifradas, webhook firmado).
  - Correo en producción: verificación obligatoria, reenvío y errores de Resend.
  Requiere TEST_DATABASE_URL.
*/
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { iniciarServidor, urlBasePruebas, cookieDe, proximoDia } = require('./apoyo/servidor');
const { iniciarMetaFalso } = require('./apoyo/meta-falso');
const { iniciarResendFalso } = require('./apoyo/resend-falso');
const { cabecerasFirmadas } = require('../firma-plataforma');

const URL_PG = urlBasePruebas();
const omitir = URL_PG ? false : 'Define TEST_DATABASE_URL con una base de pruebas';
const CLAVE_PLATAFORMA = 'clave-de-plataforma-solo-para-pruebas-0123456789';
const CLAVE = 'Una-clave-bastante-segura-7';
const NUMERO_EL_MASTER = '100000000000001';
const unico = () => Math.random().toString(36).slice(2, 10);
const esperar = ms => new Promise(r => setTimeout(r, ms));

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

async function enlaceDemo(s, correo, desde) {
  const linea = await s.esperarLog(new RegExp(`\\[DEMO CORREO\\] ${correo.replace(/[.+]/g, '\\$&')} `), 5000, desde);
  return linea.match(/verificar=([A-Za-z0-9_-]+)/)[1];
}

/* Registro real por la API, confirmación del correo e inicio de sesión. */
async function registrar(s, businessName, name = 'Dueño') {
  const correo = `dueno-${unico()}@prueba.test`;
  const desde = s.logs.length;
  const r = await s.pedir('POST', '/api/auth/registro', { businessName, name, email: correo, password: CLAVE, phone: '+593 99 000 0000' }, { cookie: null });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  await s.pedir('POST', '/api/auth/verificar', { token: await enlaceDemo(s, correo, desde) }, { cookie: null });
  const login = await s.pedir('POST', '/api/auth/login', { email: correo, password: CLAVE }, { cookie: null });
  assert.equal(login.status, 200);
  return { id: r.json.business.id, slug: r.json.business.slug, nombre: businessName, correo, cookie: cookieDe(login) };
}

const firmar = (secreto, cuerpo) => 'sha256=' + crypto.createHmac('sha256', secreto).update(cuerpo).digest('hex');
function mensajeMeta(numero, from, texto) {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp', metadata: { phone_number_id: numero, display_phone_number: '593990000000' },
      messages: [{ from, id: 'wamid.' + unico(), timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: texto } }]
    } }] }]
  });
}

test.describe('Fase 7 · barberías independientes', { skip: omitir }, () => {
  let s, meta, pool, A, B;
  const nombreBase = 'Fade Zone ' + unico();

  test.before(async () => {
    meta = await iniciarMetaFalso();
    pool = crearPool();
    s = await iniciarServidor({
      postgres: true,
      env: { PLATAFORMA_CLAVE: CLAVE_PLATAFORMA, WHATSAPP_GRAPH_URL: meta.url, WHATSAPP_PHONE_NUMBER_ID: NUMERO_EL_MASTER }
    });
    A = await registrar(s, nombreBase, 'Carlos');
    B = await registrar(s, nombreBase, 'Luis');
  });
  test.after(async () => {
    await s.detener();
    s.borrar();
    await meta.cerrar();
    await pool.end();
  });

  test('registro: el mismo nombre recibe otra dirección; cada una con su barbero y su enlace', async () => {
    assert.notEqual(A.slug, B.slug);
    assert.equal(B.slug, A.slug + '-2');
    const sesion = (await s.pedir('GET', '/api/auth/sesion', undefined, { cookie: A.cookie })).json;
    assert.equal(sesion.publicUrl, `${s.base}/b/${A.slug}/`);
    const barberos = (await s.pedir('GET', '/api/admin/barbers', undefined, { cookie: A.cookie })).json;
    const lista = barberos.barbers || barberos;
    assert.deepEqual(lista.map(b => b.name), ['Carlos'], 'primer barbero con el nombre del dueño');
    const principal = (await s.pedir('GET', '/api/auth/sesion')).json;
    assert.equal(principal.publicUrl, `${s.base}/`, 'la principal sigue en la raíz');
  });

  test('página pública: cada barbería muestra lo suyo y la principal no cambia', async () => {
    const sinBarra = await s.pedir('GET', `/b/${A.slug}`, undefined, { cookie: null });
    assert.equal(sinBarra.status, 301);
    assert.equal(sinBarra.headers.get('location'), `/b/${A.slug}/`);
    const pagina = await s.pedir('GET', `/b/${A.slug}/`, undefined, { cookie: null });
    assert.equal(pagina.status, 200);
    assert.match(pagina.texto, /const BASE = /);
    const siteA = (await s.pedir('GET', `/b/${A.slug}/api/public/site`, undefined, { cookie: null })).json;
    const siteB = (await s.pedir('GET', `/b/${B.slug}/api/public/site`, undefined, { cookie: null })).json;
    const raiz = (await s.pedir('GET', '/api/public/site', undefined, { cookie: null })).json;
    assert.equal(siteA.business.name, nombreBase);
    assert.deepEqual(siteA.barbers.map(b => b.name), ['Carlos']);
    assert.deepEqual(siteB.barbers.map(b => b.name), ['Luis']);
    assert.notEqual(raiz.business.name, nombreBase, 'la raíz sigue siendo la barbería principal');
    assert.equal((await s.pedir('GET', '/', undefined, { cookie: null })).status, 200);

    const noExiste = await s.pedir('GET', '/b/no-existe-' + unico() + '/', undefined, { cookie: null });
    assert.equal(noExiste.status, 404);
    assert.match(noExiste.texto, /Barbería no encontrada/);
    assert.equal((await s.pedir('GET', '/b/no-existe-' + unico() + '/api/public/site', undefined, { cookie: null })).json.code, 'BARBERIA_NO_ENCONTRADA');
    /* Bajo /b/ solo hay rutas públicas: nada de administración, sesiones, cuentas ni WhatsApp. */
    for (const ruta of ['/api/admin/barbers', '/api/bookings', '/api/auth/sesion', '/acceso.html', '/admin.html', '/webhooks/whatsapp', '/api/config']) {
      const r = await s.pedir('GET', `/b/${A.slug}${ruta}`, undefined, { cookie: A.cookie });
      assert.equal(r.status, 404, ruta);
    }
  });

  test('una reserva desde la página de A llega solo a A; B y la principal no la ven', async () => {
    const fecha = proximoDia(2);
    const dispA = await s.pedir('GET', `/b/${A.slug}/api/availability?date=${fecha}&barberId=barbero-1&serviceIds=corte`, undefined, { cookie: null });
    assert.equal(dispA.status, 200);
    assert.ok(dispA.json.slots.includes('10:00'), JSON.stringify(dispA.json));
    const reserva = { name: 'Cliente de A', phone: '0991234567', barberId: 'barbero-1', serviceIds: ['corte'], date: fecha, time: '10:00' };
    const r = await s.pedir('POST', `/b/${A.slug}/api/bookings`, reserva, { cookie: null });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const libreEnA = (await s.pedir('GET', `/b/${A.slug}/api/availability?date=${fecha}&barberId=barbero-1&serviceIds=corte`, undefined, { cookie: null })).json.slots;
    const libreEnB = (await s.pedir('GET', `/b/${B.slug}/api/availability?date=${fecha}&barberId=barbero-1&serviceIds=corte`, undefined, { cookie: null })).json.slots;
    assert.ok(!libreEnA.includes('10:00'), 'ocupado en A');
    assert.ok(libreEnB.includes('10:00'), 'libre en B: agendas separadas');
    const deA = JSON.stringify((await s.pedir('GET', '/api/bookings', undefined, { cookie: A.cookie })).json);
    const deB = JSON.stringify((await s.pedir('GET', '/api/bookings', undefined, { cookie: B.cookie })).json);
    const principal = JSON.stringify((await s.pedir('GET', '/api/bookings')).json);
    assert.match(deA, /Cliente de A/);
    assert.doesNotMatch(deB, /Cliente de A/);
    assert.doesNotMatch(principal, /Cliente de A/);
    const enBase = await pool.query('SELECT business_id FROM bookings WHERE id = $1', [r.json.booking?.id || r.json.id]);
    if (enBase.rowCount) assert.equal(enBase.rows[0].business_id, A.id);
  });

  test('aislamiento: un propietario no entra a otra barbería ni cambia su configuración', async () => {
    const cambio = await s.pedir('POST', '/api/auth/cambiar-barberia', { businessId: B.id }, { cookie: A.cookie });
    assert.ok([403, 404].includes(cambio.status), `no puede pasar a B (${cambio.status})`);
    /* Aunque envíe el id de B, el cambio se aplica a su propia barbería (la de su sesión). */
    A.nombre = 'Fade A ' + unico();
    const r = await s.pedir('PUT', '/api/admin/business', { name: A.nombre, businessId: B.id }, { cookie: A.cookie });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const siteA = (await s.pedir('GET', `/b/${A.slug}/api/public/site`, undefined, { cookie: null })).json;
    const siteB = (await s.pedir('GET', `/b/${B.slug}/api/public/site`, undefined, { cookie: null })).json;
    assert.equal(siteA.business.name, A.nombre, 'A cambió su nombre');
    assert.equal(siteB.business.name, nombreBase, 'B no cambió');
  });

  test('cambio de nombre: llega al Panel Maestro y a la sesión, con el mismo id y la misma dirección', async () => {
    const antes = (await plataforma(s, 'GET', '/api/plataforma/negocios')).json.businesses;
    const nuevo = 'Barbería de prueba Master Fade ' + unico();
    const r = await s.pedir('PUT', '/api/admin/business', { name: nuevo }, { cookie: A.cookie });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const despues = (await plataforma(s, 'GET', '/api/plataforma/negocios')).json.businesses;
    const a = despues.find(b => b.id === A.id);
    assert.equal(a.name, nuevo, 'el Panel Maestro recibe el nombre nuevo');
    assert.equal(a.slug, A.slug, 'la dirección no cambia');
    assert.equal(despues.length, antes.length, 'sin barberías duplicadas');
    for (const b of antes.filter(x => x.id !== A.id)) {
      assert.equal(despues.find(x => x.id === b.id).name, b.name, `${b.id} no cambia`);
    }
    assert.equal((await plataforma(s, 'GET', `/api/plataforma/negocios/${A.id}`)).json.business.name, nuevo);
    const sesion = (await s.pedir('GET', '/api/auth/sesion', undefined, { cookie: A.cookie })).json;
    assert.equal(sesion.business.name, nuevo, 'la sesión también lo usa');
    assert.equal((await s.pedir('GET', `/b/${A.slug}/api/public/site`, undefined, { cookie: null })).json.business.name, nuevo);
    A.nombre = nuevo;
  });

  test('Panel Maestro: enlace y estado de WhatsApp de cada barbería, sin datos de clientes ni secretos', async () => {
    const r = await plataforma(s, 'GET', '/api/plataforma/negocios');
    assert.equal(r.status, 200);
    const a = r.json.businesses.find(b => b.id === A.id);
    assert.equal(a.publicUrl, `${s.base}/b/${A.slug}/`);
    assert.deepEqual(a.whatsapp, { connected: false });
    assert.equal(r.json.businesses.find(b => b.id === s.negocio).publicUrl, `${s.base}/`);
    assert.doesNotMatch(JSON.stringify(r.json), /Cliente de A|0991234567/);
    const estado = (await plataforma(s, 'GET', '/api/plataforma/estado')).json;
    assert.equal(estado.verificacionObligatoria, true);
    assert.equal(estado.registroAbierto, true);
    assert.equal(estado.whatsappNegocios, true);
    const prueba = await plataforma(s, 'POST', '/api/plataforma/correo/prueba', { para: 'admin@prueba.test' });
    assert.equal(prueba.status, 200, 'en pruebas el correo se muestra en la consola');
    assert.equal((await plataforma(s, 'POST', '/api/plataforma/correo/prueba', { para: 'no-es-correo' })).status, 400);
  });

  test('WhatsApp: cada barbería conecta su número; se comprueba con Meta y se guarda cifrado', async () => {
    const principal = (await s.pedir('GET', '/api/admin/whatsapp')).json;
    assert.equal(principal.principal, true, 'la principal usa la configuración del servidor');
    assert.equal((await s.pedir('PUT', '/api/admin/whatsapp', { phoneNumberId: '123456' })).status, 409);

    const estado = (await s.pedir('GET', '/api/admin/whatsapp', undefined, { cookie: A.cookie })).json;
    assert.equal(estado.available, true);
    assert.equal(estado.connected, false);
    assert.match(estado.webhookUrl, new RegExp(`^${s.base}/webhooks/whatsapp/n/[A-Za-z0-9_-]{20,}$`));
    assert.ok(estado.verifyToken.length >= 20);
    assert.equal((await s.pedir('GET', '/api/admin/whatsapp', undefined, { cookie: B.cookie })).json.verifyToken === estado.verifyToken, false);

    const tokenA = 'EAAtokenDePruebaDeLaBarberiaA' + unico();
    const secretoA = 'secretoapp' + unico() + unico();
    meta.registrar('200000000000001', { token: tokenA, secreto: secretoA, telefono: '+593 99 111 0001', nombre: 'Fade Zone A' });
    const datos = { phoneNumberId: '200000000000001', wabaId: '300000000000001', accessToken: tokenA, appSecret: secretoA };

    const malSecreto = await s.pedir('PUT', '/api/admin/whatsapp', { ...datos, appSecret: 'otraclavesecreta1234' }, { cookie: A.cookie });
    assert.equal(malSecreto.status, 400);
    assert.match(malSecreto.json.error, /Meta no aceptó/);
    const reservado = await s.pedir('PUT', '/api/admin/whatsapp', { ...datos, phoneNumberId: NUMERO_EL_MASTER }, { cookie: A.cookie });
    assert.equal(reservado.json.code, 'NUMERO_RESERVADO', 'el número de El Máster no se reutiliza');
    assert.equal((await s.pedir('PUT', '/api/admin/whatsapp', { ...datos, phoneNumberId: 'abc' }, { cookie: A.cookie })).status, 400);

    const ok = await s.pedir('PUT', '/api/admin/whatsapp', datos, { cookie: A.cookie });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.connected, true);
    assert.equal(ok.json.displayPhone, '+593 99 111 0001');
    assert.ok(!ok.texto.includes(tokenA) && !ok.texto.includes(secretoA), 'nunca se devuelven el token ni la clave');
    assert.ok(meta.suscripciones.includes('300000000000001'));
    const fila = (await pool.query('SELECT * FROM business_whatsapp WHERE business_id = $1', [A.id])).rows[0];
    assert.ok(!JSON.stringify(fila).includes(tokenA) && !JSON.stringify(fila).includes(secretoA), 'guardado cifrado');

    const otra = await s.pedir('PUT', '/api/admin/whatsapp', datos, { cookie: B.cookie });
    assert.equal(otra.json.code, 'NUMERO_EN_USO', 'un número pertenece a una sola barbería');

    /* Un barbero sin permiso de configuración no ve los datos del webhook. */
    const sinPermiso = await s.pedir('GET', '/api/admin/whatsapp', undefined, { cookie: null });
    assert.equal(sinPermiso.status, 401);
    A.whatsapp = { ...datos, webhookUrl: estado.webhookUrl, verifyToken: estado.verifyToken };
    B.webhookUrl = (await s.pedir('GET', '/api/admin/whatsapp', undefined, { cookie: B.cookie })).json.webhookUrl;
  });

  test('WhatsApp: Meta verifica el webhook de la barbería y solo se aceptan mensajes firmados', async () => {
    const ruta = new URL(A.whatsapp.webhookUrl).pathname;
    const verificar = token => s.pedir('GET', `${ruta}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=reto123`, undefined, { cookie: null });
    assert.equal((await verificar('token-incorrecto')).status, 403);
    const v = await verificar(A.whatsapp.verifyToken);
    assert.equal(v.status, 200);
    assert.equal(v.texto, 'reto123');
    assert.ok((await s.pedir('GET', '/api/admin/whatsapp', undefined, { cookie: A.cookie })).json.webhookVerifiedAt);

    const cuerpo = mensajeMeta(A.whatsapp.phoneNumberId, '593980000001', 'hola');
    const enviar = (destino, texto, firma) => s.pedir('POST', destino, texto, { cookie: null, headers: firma ? { 'X-Hub-Signature-256': firma } : {} });
    assert.equal((await enviar(ruta, cuerpo)).status, 401, 'sin firma');
    assert.equal((await enviar(ruta, cuerpo, firmar('otra-clave-secreta', cuerpo))).status, 401, 'firma de otra app');
    assert.equal((await enviar(new URL(B.webhookUrl).pathname, cuerpo, firmar(A.whatsapp.appSecret, cuerpo))).status, 401, 'el webhook de B no acepta mensajes de A');
    assert.equal((await enviar('/webhooks/whatsapp/n/' + 'x'.repeat(24), cuerpo, firmar(A.whatsapp.appSecret, cuerpo))).status, 404);

    const antes = meta.enviados.length;
    assert.equal((await enviar(ruta, cuerpo, firmar(A.whatsapp.appSecret, cuerpo))).status, 200);
    for (let i = 0; i < 100 && meta.enviados.length === antes; i++) await esperar(50);
    const respuesta = meta.enviados.at(-1);
    assert.ok(respuesta, 'Elia respondió');
    assert.equal(respuesta.desde, A.whatsapp.phoneNumberId, 'desde el número de A');
    assert.equal(respuesta.para, '593980000001');
    assert.ok(respuesta.texto.includes(A.nombre), 'con el nombre de A: ' + respuesta.texto);
    assert.ok((await s.pedir('GET', '/api/admin/whatsapp', undefined, { cookie: A.cookie })).json.lastMessageAt);
  });

  test('WhatsApp: el webhook de El Máster ignora mensajes de otros números y no usa su número para otras barberías', async () => {
    const desde = s.stdout.length;
    const r = await s.pedir('POST', '/webhooks/whatsapp', mensajeMeta(A.whatsapp.phoneNumberId, '593980000077', 'hola'), { cookie: null });
    assert.equal(r.status, 200);
    await esperar(300);
    assert.ok(!s.stdout.slice(desde).includes('593980000077'), 'no se respondió desde El Máster');
    /* B no conectó WhatsApp: sus avisos no salen por ningún número (tampoco el de El Máster). */
    const antes = meta.enviados.length;
    const cuerpo = mensajeMeta(NUMERO_EL_MASTER, '593980000088', 'hola');
    await s.pedir('POST', '/webhooks/whatsapp', cuerpo, { cookie: null });
    await esperar(300);
    assert.equal(meta.enviados.length, antes, 'El Máster sin token: solo modo demostración');
  });

  test('WhatsApp: suscripción vencida, Elia no toma reservas; desconectar corta el webhook', async () => {
    const actual = (await plataforma(s, 'GET', `/api/plataforma/negocios/${A.id}`)).json.business.subscription;
    const vencer = await plataforma(s, 'PUT', `/api/plataforma/negocios/${A.id}/suscripcion`, {
      status: 'expired', plan: actual.plan, trialEndsAt: null, currentPeriodEnd: null, version: actual.version + 1
    });
    assert.equal(vencer.status, 200, JSON.stringify(vencer.json));
    const ruta = new URL(A.whatsapp.webhookUrl).pathname;
    const cuerpo = mensajeMeta(A.whatsapp.phoneNumberId, '593980000002', 'quiero reservar');
    const antes = meta.enviados.length;
    await s.pedir('POST', ruta, cuerpo, { cookie: null, headers: { 'X-Hub-Signature-256': firmar(A.whatsapp.appSecret, cuerpo) } });
    for (let i = 0; i < 100 && meta.enviados.length === antes; i++) await esperar(50);
    assert.match(meta.enviados.at(-1).texto, /no está recibiendo reservas/);
    const web = await s.pedir('POST', `/b/${A.slug}/api/bookings`, { name: 'Otro', phone: '0991234500', barberId: 'barbero-1', serviceIds: ['corte'], date: proximoDia(3), time: '11:00' }, { cookie: null });
    assert.equal(web.json.code, 'SUSCRIPCION_VENCIDA');

    const suspender = await plataforma(s, 'PUT', `/api/plataforma/negocios/${A.id}/suscripcion`, {
      status: 'suspended', plan: actual.plan, trialEndsAt: null, currentPeriodEnd: null, version: actual.version + 2
    });
    assert.equal(suspender.status, 200);
    assert.equal((await s.pedir('GET', `/b/${A.slug}/`, undefined, { cookie: null })).status, 404, 'suspendida: sin página pública');
    await plataforma(s, 'PUT', `/api/plataforma/negocios/${A.id}/suscripcion`, {
      status: 'active', plan: actual.plan, trialEndsAt: null, currentPeriodEnd: null, version: actual.version + 3
    });
    assert.equal((await s.pedir('GET', `/b/${A.slug}/`, undefined, { cookie: null })).status, 200, 'reactivada');

    const login = await s.pedir('POST', '/api/auth/login', { email: A.correo, password: CLAVE }, { cookie: null });
    const fuera = await s.pedir('DELETE', '/api/admin/whatsapp', undefined, { cookie: cookieDe(login) });
    assert.equal(fuera.status, 200);
    assert.equal(fuera.json.connected, false);
    const nuevo = mensajeMeta(A.whatsapp.phoneNumberId, '593980000003', 'hola');
    assert.equal((await s.pedir('POST', ruta, nuevo, { cookie: null, headers: { 'X-Hub-Signature-256': firmar(A.whatsapp.appSecret, nuevo) } })).status, 401);
  });
});

test.describe('Fase 7 · correo y verificación en producción', { skip: omitir }, () => {
  test('la verificación es obligatoria aunque VERIFICAR_CORREO=0; reenvío y errores de Resend', async () => {
    const resend = await iniciarResendFalso();
    const s = await iniciarServidor({
      postgres: true,
      env: {
        RENDER: 'true', REGISTRO_ABIERTO: '1', VERIFICAR_CORREO: '0', RESEND_API_KEY: 're_prueba_no_real',
        CORREO_REMITENTE: 'Master Reservas <no-responder@reservas.example>', RESEND_API_URL: resend.url,
        PUBLIC_BASE_URL: 'https://reservas.example'
      }
    });
    try {
      const config = (await s.pedir('GET', '/api/auth/config', undefined, { cookie: null })).json;
      assert.equal(config.registrationOpen, true);
      assert.equal(config.emailVerification, true);
      const correo = `prod-${unico()}@prueba.test`;
      const r = await s.pedir('POST', '/api/auth/registro', { businessName: 'Barbería Real ' + unico(), name: 'Ana', email: correo, password: CLAVE }, { cookie: null });
      assert.equal(r.status, 201);
      assert.equal(r.json.verificationRequired, true);
      assert.equal(r.json.emailSent, true);
      assert.equal(cookieDe(r), null, 'sin sesión hasta confirmar');
      const login = await s.pedir('POST', '/api/auth/login', { email: correo, password: CLAVE }, { cookie: null });
      assert.equal(login.status, 403);
      assert.equal(cookieDe(login), null);

      const enviados = resend.recibidos.length;
      const re = await s.pedir('POST', '/api/auth/verificacion/reenviar', { email: correo }, { cookie: null });
      assert.equal(re.status, 200);
      assert.equal(resend.recibidos.length, enviados + 1, 'se envió otro enlace');
      const html = resend.recibidos.at(-1).cuerpo.html;
      const token = html.match(/https:\/\/reservas\.example\/acceso\.html#verificar=([A-Za-z0-9_-]+)/)[1];
      assert.equal((await s.pedir('POST', '/api/auth/verificar', { token: 'token-falso-' + 'x'.repeat(30) }, { cookie: null })).status >= 400, true);
      assert.equal((await s.pedir('POST', '/api/auth/verificar', { token }, { cookie: null })).status, 200);
      const dentro = await s.pedir('POST', '/api/auth/login', { email: correo, password: CLAVE }, { cookie: null });
      assert.equal(dentro.status, 200);
      const sesion = (await s.pedir('GET', '/api/auth/sesion', undefined, { cookie: cookieDe(dentro) })).json;
      assert.equal(sesion.publicUrl, `https://reservas.example/b/${r.json.business.slug}/`);
      /* Sin WHATSAPP_CLAVE_CIFRADO en producción, la conexión de WhatsApp queda desactivada. */
      assert.equal((await s.pedir('GET', '/api/admin/whatsapp', undefined, { cookie: cookieDe(dentro) })).json.available, false);

      /* Resend rechaza el envío: la cuenta queda pendiente y se avisa; nunca se activa sola. */
      resend.responder({ status: 422, body: { name: 'validation_error', message: 'domain not verified' } });
      const otro = `prod-${unico()}@prueba.test`;
      const fallo = await s.pedir('POST', '/api/auth/registro', { businessName: 'Barbería Dos ' + unico(), name: 'Eva', email: otro, password: CLAVE }, { cookie: null });
      assert.equal(fallo.status, 201);
      assert.equal(fallo.json.emailSent, false);
      assert.equal((await s.pedir('POST', '/api/auth/login', { email: otro, password: CLAVE }, { cookie: null })).status, 403);
    } finally {
      await s.detener();
      s.borrar();
      await resend.cerrar();
    }
  });
});

test.describe('Fase 7 · nombres guardados antes de la corrección', { skip: omitir }, () => {
  test('la migración copia al Panel el nombre que guardó el propietario, sin tocar ids, reservas ni otras barberías', async () => {
    const { reiniciar } = require('./apoyo/servidor');
    const pool = crearPool();
    let s = await iniciarServidor({ postgres: true, env: { PLATAFORMA_CLAVE: CLAVE_PLATAFORMA } });
    try {
      const X = await registrar(s, 'bleesd ' + unico(), 'Dueño X');
      const Y = await registrar(s, 'Otra ' + unico(), 'Dueño Y');
      const nuevo = 'Barbería de prueba Master Fade ' + unico();
      assert.equal((await s.pedir('PUT', '/api/admin/business', { name: nuevo }, { cookie: X.cookie })).status, 200);
      const reserva = await s.pedir('POST', `/b/${X.slug}/api/bookings`,
        { name: 'Cliente X', phone: '0991231231', barberId: 'barbero-1', serviceIds: ['corte'], date: proximoDia(4), time: '09:00' }, { cookie: null });
      assert.equal(reserva.status, 201, JSON.stringify(reserva.json));
      /* Así quedó en producción con la versión anterior: la agenda con el nombre nuevo y la ficha con el original. */
      await pool.query('UPDATE businesses SET name = $2 WHERE id = $1', [X.id, X.nombre]);
      assert.equal((await plataforma(s, 'GET', `/api/plataforma/negocios/${X.id}`)).json.business.name, X.nombre);
      const fichaY = (await pool.query('SELECT * FROM businesses WHERE id = $1', [Y.id])).rows[0];
      const totales = async () => (await pool.query(
        `SELECT (SELECT count(*) FROM businesses)::int AS b, (SELECT count(*) FROM users)::int AS u, (SELECT count(*) FROM bookings)::int AS r`)).rows[0];
      const antes = await totales();
      const susX = (await pool.query('SELECT status, plan, trial_ends_at, subscription_version, slug FROM businesses WHERE id = $1', [X.id])).rows[0];

      await pool.query(`DELETE FROM master_reservas_migrations WHERE version = '2026-10-fase7-002'`);
      s = await reiniciar(s);
      assert.ok(s.logs.some(l => l.includes('MIGRACIÓN APLICADA: 2026-10-fase7-002')));

      assert.equal((await plataforma(s, 'GET', `/api/plataforma/negocios/${X.id}`)).json.business.name, nuevo, 'el Panel recibe el nombre actualizado');
      assert.deepEqual((await pool.query('SELECT status, plan, trial_ends_at, subscription_version, slug FROM businesses WHERE id = $1', [X.id])).rows[0], susX,
        'ni la dirección ni la suscripción cambian');
      const fichaY2 = (await pool.query('SELECT * FROM businesses WHERE id = $1', [Y.id])).rows[0];
      assert.deepEqual(fichaY2, fichaY, 'otra barbería queda idéntica');
      assert.deepEqual(await totales(), antes, 'mismas barberías, usuarios y reservas');
      const login = await s.pedir('POST', '/api/auth/login', { email: X.correo, password: CLAVE }, { cookie: null });
      assert.equal(login.status, 200, 'la cuenta sigue funcionando');
      assert.match(JSON.stringify((await s.pedir('GET', '/api/bookings', undefined, { cookie: cookieDe(login) })).json), /Cliente X/);
    } finally {
      await s.detener();
      s.borrar();
      await pool.end();
    }
  });
});
