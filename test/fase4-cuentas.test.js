'use strict';
/*
  Fase 4 (servidor): verificación de correo, registro cerrado en
  producción y verificación en dos pasos. Requiere TEST_DATABASE_URL.
*/
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { iniciarServidor, urlBasePruebas, cookieDe } = require('./apoyo/servidor');
const { codigoTotp, desdeBase32 } = require('../autenticacion');

const URL_PG = urlBasePruebas();
const omitir = URL_PG ? false : 'Define TEST_DATABASE_URL con una base de pruebas';
const CLAVE = 'Una-clave-bastante-segura-7';
const unico = () => Math.random().toString(36).slice(2, 10);

function crearPool() {
  const sinSsl = new URL(URL_PG).searchParams.get('sslmode') === 'disable';
  const pool = new Pool({ connectionString: URL_PG, ssl: sinSsl ? false : { rejectUnauthorized: false }, max: 2 });
  pool.on('error', () => {});
  return pool;
}

function cookieNombre(respuesta, nombre) {
  const c = respuesta.headers.getSetCookie().find(x => x.startsWith(nombre + '='));
  return c ? c.split(';')[0] : null;
}

async function enlace(s, correo, tipo, desde) {
  const linea = await s.esperarLog(new RegExp(`\\[DEMO CORREO\\] ${correo.replace(/[.+]/g, '\\$&')} `), 5000, desde);
  return linea.match(new RegExp(`${tipo}=([A-Za-z0-9_-]+)`))[1];
}

/* Código TOTP actual para una clave base32 (como lo haría la aplicación del teléfono). */
const codigoActual = (clave, desplazamiento = 0) => codigoTotp(desdeBase32(clave), Math.floor(Date.now() / 30000) + desplazamiento);

test.describe('Fase 4 · verificación de correo', { skip: omitir }, () => {
  let s;
  test.before(async () => { s = await iniciarServidor({ postgres: true }); });
  test.after(async () => { if (s) { await s.detener(); s.borrar(); } });

  test('el registro no abre sesión hasta confirmar el correo', async () => {
    const correo = `verif-${unico()}@prueba.test`;
    const desde = s.logs.length;
    const r = await s.pedir('POST', '/api/auth/registro', { businessName: 'Verif ' + unico(), name: 'Ana', email: correo, password: CLAVE }, { cookie: null });
    assert.equal(r.status, 201);
    assert.equal(r.json.verificationRequired, true);
    assert.equal(cookieDe(r), null);

    const mala = await s.pedir('POST', '/api/auth/login', { email: correo, password: 'incorrecta-123456' }, { cookie: null });
    assert.equal(mala.status, 401, 'con contraseña incorrecta no revela que la cuenta existe');
    const sinVerificar = await s.pedir('POST', '/api/auth/login', { email: correo, password: CLAVE }, { cookie: null });
    assert.equal(sinVerificar.status, 403);
    assert.equal(sinVerificar.json.code, 'CORREO_NO_VERIFICADO');
    assert.equal(cookieDe(sinVerificar), null);

    const token = await enlace(s, correo, 'verificar', desde);
    assert.equal((await s.pedir('POST', '/api/auth/verificar', { token: 'x'.repeat(43) }, { cookie: null })).status, 400, 'enlace inventado');
    assert.equal((await s.pedir('POST', '/api/auth/verificar', { token }, { cookie: null })).status, 200);
    assert.equal((await s.pedir('POST', '/api/auth/verificar', { token }, { cookie: null })).status, 400, 'un solo uso');
    const ok = await s.pedir('POST', '/api/auth/login', { email: correo, password: CLAVE }, { cookie: null });
    assert.equal(ok.status, 200);
    assert.ok(cookieDe(ok));
  });

  test('reenviar la confirmación: misma respuesta exista o no la cuenta; el enlace anterior deja de servir', async () => {
    const correo = `reenvio-${unico()}@prueba.test`;
    const desde = s.logs.length;
    await s.pedir('POST', '/api/auth/registro', { businessName: 'Reenvio ' + unico(), name: 'Luis', email: correo, password: CLAVE }, { cookie: null });
    const primero = await enlace(s, correo, 'verificar', desde);
    const desde2 = s.logs.length;
    const a = await s.pedir('POST', '/api/auth/verificacion/reenviar', { email: correo }, { cookie: null });
    const b = await s.pedir('POST', '/api/auth/verificacion/reenviar', { email: `nadie-${unico()}@prueba.test` }, { cookie: null });
    assert.deepEqual(a.json, b.json);
    const segundo = await enlace(s, correo, 'verificar', desde2);
    assert.notEqual(primero, segundo);
    assert.equal((await s.pedir('POST', '/api/auth/verificar', { token: primero }, { cookie: null })).status, 400);
    assert.equal((await s.pedir('POST', '/api/auth/verificar', { token: segundo }, { cookie: null })).status, 200);
  });

  test('aceptar una invitación confirma el correo al crear la contraseña', async () => {
    const correo = `invitado-${unico()}@prueba.test`;
    const desde = s.logs.length;
    assert.equal((await s.pedir('POST', '/api/admin/usuarios', { email: correo, role: 'staff' })).status, 201);
    const token = await enlace(s, correo, 'invitacion', desde);
    assert.equal((await s.pedir('POST', '/api/auth/invitacion/aceptar', { token, name: 'Invitado', password: CLAVE }, { cookie: null })).status, 200);
    assert.equal((await s.pedir('POST', '/api/auth/login', { email: correo, password: CLAVE }, { cookie: null })).status, 200);
  });

  test('la pantalla de acceso sabe si el registro está abierto', async () => {
    const c = (await s.pedir('GET', '/api/auth/config', undefined, { cookie: null })).json;
    assert.deepEqual(c, { ok: true, accounts: true, registrationOpen: true, emailVerification: true, twoFactorAvailable: true });
  });
});

test.describe('Fase 4 · registro y dos pasos en producción', { skip: omitir }, () => {
  test('en producción el registro está cerrado: sin correo configurado no se abre ni con REGISTRO_ABIERTO=1', async () => {
    const prod = await iniciarServidor({ postgres: true, env: { RENDER: 'true' } });
    const pedido = await iniciarServidor({ postgres: true, env: { RENDER: 'true', REGISTRO_ABIERTO: '1', CLAVE_DOS_PASOS: 'clave-de-prueba-larga-y-aleatoria' } });
    const cerrado = await iniciarServidor({ postgres: true, env: { REGISTRO_ABIERTO: '0' } });
    try {
      const datos = { businessName: 'Prod ' + unico(), name: 'Ana', email: `prod-${unico()}@prueba.test`, password: CLAVE };
      assert.equal((await prod.pedir('POST', '/api/auth/registro', datos, { cookie: null })).status, 403);
      const cp = (await prod.pedir('GET', '/api/auth/config', undefined, { cookie: null })).json;
      assert.equal(cp.registrationOpen, false);
      assert.equal(cp.twoFactorAvailable, false, 'sin CLAVE_DOS_PASOS en producción no se usa una clave inventada');
      assert.equal((await prod.pedir('POST', '/api/auth/2fa/iniciar', {})).status, 503);

      assert.equal((await cerrado.pedir('POST', '/api/auth/registro', { ...datos, email: `c-${unico()}@prueba.test` }, { cookie: null })).status, 403);

      /* REGISTRO_ABIERTO=1 sin correo: sigue cerrado y lo avisa al arrancar. */
      assert.equal((await pedido.pedir('POST', '/api/auth/registro', { ...datos, email: `a-${unico()}@prueba.test` }, { cookie: null })).status, 403);
      assert.equal((await pedido.pedir('GET', '/api/auth/config', undefined, { cookie: null })).json.registrationOpen, false);
      assert.ok(pedido.logs.some(l => /REGISTRO_ABIERTO=1 pero el correo no está configurado/.test(l)));
      assert.equal((await pedido.pedir('GET', '/api/auth/config', undefined, { cookie: null })).json.twoFactorAvailable, true);

      /* Sin correo en producción, los enlaces nunca aparecen en los registros. */
      const desde = pedido.logs.length;
      assert.equal((await pedido.pedir('POST', '/api/auth/recuperar', { email: pedido.correo }, { cookie: null })).status, 200);
      assert.equal((await pedido.pedir('POST', '/api/admin/usuarios', { email: `inv-${unico()}@prueba.test`, role: 'staff' })).json.emailSent, false);
      await new Promise(res => setTimeout(res, 200));
      const registros = pedido.logs.slice(desde).join('\n');
      assert.ok(!/verificar=|restablecer=|invitacion=/.test(registros), 'en producción el enlace nunca aparece en los registros');
      assert.match(registros, /correo no configurado/);
    } finally {
      for (const x of [prod, pedido, cerrado]) { await x.detener(); x.borrar(); }
    }
  });
});

test.describe('Fase 4 · verificación en dos pasos', { skip: omitir }, () => {
  let s;
  let pool;
  test.before(async () => {
    s = await iniciarServidor({ postgres: true });
    pool = crearPool();
  });
  test.after(async () => {
    if (s) { await s.detener(); s.borrar(); }
    if (pool) await pool.end();
  });

  async function entrar(email, password) {
    return s.pedir('POST', '/api/auth/login', { email, password }, { cookie: null });
  }

  async function segundoPaso(login, code) {
    const desafio = cookieNombre(login, 'mr_dos_pasos');
    return s.pedir('POST', '/api/auth/2fa/verificar', { code }, { cookie: desafio });
  }

  test('activar, entrar con código, códigos de recuperación y desactivar', async () => {
    const estado0 = (await s.pedir('GET', '/api/auth/2fa')).json;
    assert.deepEqual([estado0.available, estado0.enabled], [true, false]);

    const ini = await s.pedir('POST', '/api/auth/2fa/iniciar', {});
    assert.equal(ini.status, 200);
    assert.match(ini.json.otpauthUrl, /^otpauth:\/\/totp\//);
    const clave = ini.json.secret;
    const [u] = (await pool.query('SELECT totp_pending_secret FROM users WHERE lower(email) = $1', [s.correo])).rows;
    assert.ok(!u.totp_pending_secret.includes(clave), 'el secreto se guarda cifrado');

    assert.equal((await s.pedir('POST', '/api/auth/2fa/activar', { code: '000000' })).status, 400);
    const act = await s.pedir('POST', '/api/auth/2fa/activar', { code: codigoActual(clave) });
    assert.equal(act.status, 200, act.texto);
    assert.equal(act.json.recoveryCodes.length, 10);
    const recuperacion = act.json.recoveryCodes;
    assert.equal((await s.pedir('GET', '/api/auth/2fa')).json.enabled, true);
    assert.equal((await s.pedir('GET', '/api/auth/sesion')).json.twoFactor, true);

    /* La contraseña sola ya no basta. */
    const paso1 = await entrar(s.correo, s.clave);
    assert.equal(paso1.status, 202);
    assert.equal(paso1.json.twoFactorRequired, true);
    assert.equal(cookieDe(paso1), null, 'sin código no hay sesión');
    assert.match(paso1.headers.getSetCookie().find(c => c.startsWith('mr_dos_pasos=')), /HttpOnly.*SameSite=Strict/);
    assert.equal((await segundoPaso(paso1, '123456')).status, 401);
    /* El código siguiente (aceptado con ±30 s): el actual ya se usó al activar. */
    const usado = codigoActual(clave, 1);
    const bien = await segundoPaso(paso1, usado);
    assert.equal(bien.status, 200, bien.texto);
    const sesion = cookieDe(bien);
    assert.equal((await s.pedir('GET', '/api/bookings', undefined, { cookie: sesion })).status, 200);

    /* El mismo código no se puede usar otra vez. */
    const otra = await entrar(s.correo, s.clave);
    assert.equal((await segundoPaso(otra, usado)).status, 401, 'código ya usado');

    /* Un desafío solo admite 5 intentos. */
    const intentos = await entrar(s.correo, s.clave);
    for (let i = 0; i < 5; i++) await segundoPaso(intentos, '000000');
    const tarde = await segundoPaso(intentos, recuperacion[0]);
    assert.equal(tarde.status, 401);
    assert.equal(tarde.json.code, 'DESAFIO_INVALIDO');

    /* Código de recuperación: sirve una sola vez. */
    const conRecuperacion = await segundoPaso(await entrar(s.correo, s.clave), recuperacion[0]);
    assert.equal(conRecuperacion.status, 200);
    assert.equal((await segundoPaso(await entrar(s.correo, s.clave), recuperacion[0])).status, 401);
    assert.equal((await s.pedir('GET', '/api/auth/2fa')).json.recoveryCodesLeft, 9);

    /* Un desafío inventado no abre sesión. */
    assert.equal((await s.pedir('POST', '/api/auth/2fa/verificar', { code: codigoActual(clave) }, { cookie: 'mr_dos_pasos=' + 'B'.repeat(43) })).status, 401);

    /* Desactivar exige contraseña y código. */
    assert.equal((await s.pedir('POST', '/api/auth/2fa/desactivar', { password: 'mal', code: recuperacion[1] })).status, 400);
    assert.equal((await s.pedir('POST', '/api/auth/2fa/desactivar', { password: s.clave, code: '000000' })).status, 400);
    assert.equal((await s.pedir('POST', '/api/auth/2fa/desactivar', { password: s.clave, code: recuperacion[1] })).status, 200);
    assert.equal((await entrar(s.correo, s.clave)).status, 200, 'sin dos pasos vuelve a entrar con la contraseña');
  });

  test('sin sesión no se puede consultar ni activar la verificación en dos pasos', async () => {
    for (const [m, ruta] of [['GET', '/api/auth/2fa'], ['POST', '/api/auth/2fa/iniciar'], ['POST', '/api/auth/2fa/activar'], ['POST', '/api/auth/2fa/desactivar']]) {
      assert.equal((await s.pedir(m, ruta, m === 'POST' ? {} : undefined, { cookie: null })).status, 401, ruta);
    }
  });
});

test('aislamiento: los usuarios y la seguridad de una barbería no son visibles para otra', { skip: omitir }, async () => {
  const s = await iniciarServidor({ postgres: true });
  try {
    /* Barbería B registrada y verificada. */
    const correo = `b-${unico()}@prueba.test`;
    const desde = s.logs.length;
    await s.pedir('POST', '/api/auth/registro', { businessName: 'B ' + unico(), name: 'Dueño B', email: correo, password: CLAVE }, { cookie: null });
    await s.pedir('POST', '/api/auth/verificar', { token: await enlace(s, correo, 'verificar', desde) }, { cookie: null });
    const b = cookieDe(await s.pedir('POST', '/api/auth/login', { email: correo, password: CLAVE }, { cookie: null }));

    const deA = (await s.pedir('GET', '/api/admin/usuarios')).json.users;
    const deB = (await s.pedir('GET', '/api/admin/usuarios', undefined, { cookie: b })).json.users;
    assert.deepEqual(deB.map(u => u.email), [correo], 'B solo ve a su propio equipo');
    assert.ok(!deA.some(u => u.email === correo), 'A no ve al dueño de B');

    const propietarioA = deA.find(u => u.email === s.correo);
    for (const cambio of [{ status: 'disabled' }, { role: 'staff' }]) {
      assert.equal((await s.pedir('PATCH', `/api/admin/usuarios/${propietarioA.id}`, cambio, { cookie: b })).status, 404);
    }
    assert.equal((await s.pedir('POST', '/api/admin/usuarios', { email: s.correo, role: 'owner', businessId: s.negocio }, { cookie: b })).status, 201,
      'B puede invitar ese correo a B (queda pendiente)…');
    const sesionA = (await s.pedir('GET', '/api/auth/sesion')).json;
    assert.equal(sesionA.role, 'owner');
    assert.equal(sesionA.business.id, s.negocio, '…pero eso no le da acceso a A ni cambia la sesión de A');
    assert.ok((await s.pedir('GET', '/api/admin/usuarios', undefined, { cookie: b })).json.users.every(u => u.email !== s.correo || u.role === 'owner'));
    const listaA = (await s.pedir('GET', '/api/admin/usuarios')).json.users;
    assert.ok(!listaA.some(u => u.email === correo), 'A sigue sin ver a B');

    /* La verificación en dos pasos de B no toca la cuenta de A. */
    await s.pedir('POST', '/api/auth/2fa/iniciar', {}, { cookie: b });
    assert.equal((await s.pedir('GET', '/api/auth/2fa')).json.enabled, false);
  } finally {
    await s.detener();
    s.borrar();
  }
});
