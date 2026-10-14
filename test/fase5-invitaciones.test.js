'use strict';
/*
  Fase 5 (servidor): invitaciones que se aceptan expresamente, entre
  barberías distintas, con vencimiento, reenvío y revocación.
  Requiere TEST_DATABASE_URL.
*/
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { iniciarServidor, urlBasePruebas, cookieDe, crearCuenta } = require('./apoyo/servidor');
const { codigoTotp, desdeBase32 } = require('../autenticacion');

const URL_PG = urlBasePruebas();
const omitir = URL_PG ? false : 'Define TEST_DATABASE_URL con una base de pruebas';
const CLAVE = 'Una-clave-bastante-segura-7';
const unico = () => Math.random().toString(36).slice(2, 10);
const codigoActual = (clave, desplazamiento = 0) => codigoTotp(desdeBase32(clave), Math.floor(Date.now() / 30000) + desplazamiento);

function crearPool() {
  const sinSsl = new URL(URL_PG).searchParams.get('sslmode') === 'disable';
  const pool = new Pool({ connectionString: URL_PG, ssl: sinSsl ? false : { rejectUnauthorized: false }, max: 2 });
  pool.on('error', () => {});
  return pool;
}

async function enlace(s, correo, tipo, desde) {
  const linea = await s.esperarLog(new RegExp(`\\[DEMO CORREO\\] ${correo.replace(/[.+]/g, '\\$&')} `), 5000, desde);
  return linea.match(new RegExp(`${tipo}=([A-Za-z0-9_-]+)`))[1];
}

test.describe('Fase 5 · invitaciones', { skip: omitir }, () => {
  let s;
  let pool;
  /* Barbería B: registrada por su dueño, con su propia cuenta. */
  let correoB;
  let negocioB;
  let cookieB;

  /* Invita desde A (o desde la sesión indicada) y devuelve el código del enlace y la invitación. */
  async function invitar(correo, rol = 'staff', cookie) {
    const desde = s.logs.length;
    const r = await s.pedir('POST', '/api/admin/usuarios', { email: correo, name: 'Invitado', role: rol }, cookie ? { cookie } : {});
    assert.equal(r.status, 201, r.texto);
    assert.equal(r.json.invitation.status, 'pending');
    return { token: await enlace(s, correo, 'invitacion', desde), invitacion: r.json.invitation };
  }

  const negociosDe = async cookie => (await s.pedir('GET', '/api/auth/barberias', undefined, { cookie })).json.businesses.map(n => n.id).sort();
  const pertenencias = async correo => (await pool.query(
    'SELECT m.business_id, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE lower(u.email) = lower($1)', [correo])).rows;

  test.before(async () => {
    s = await iniciarServidor({ postgres: true });
    pool = crearPool();
    correoB = `duenob-${unico()}@prueba.test`;
    const desde = s.logs.length;
    await s.pedir('POST', '/api/auth/registro', { businessName: 'Barbería B ' + unico(), name: 'Dueño B', email: correoB, password: CLAVE }, { cookie: null });
    await s.pedir('POST', '/api/auth/verificar', { token: await enlace(s, correoB, 'verificar', desde) }, { cookie: null });
    const r = await s.pedir('POST', '/api/auth/login', { email: correoB, password: CLAVE }, { cookie: null });
    cookieB = cookieDe(r);
    negocioB = r.json.business.id;
    assert.notEqual(negocioB, s.negocio);
  });
  test.after(async () => {
    if (pool) await pool.end();
    if (s) { await s.detener(); s.borrar(); }
  });

  test('correo nuevo: queda pendiente sin dar acceso; al aceptar crea la cuenta; el enlace es de un solo uso', async () => {
    const correo = `nuevo-${unico()}@prueba.test`;
    const { token, invitacion } = await invitar(correo, 'staff');
    assert.deepEqual(await pertenencias(correo), [], 'antes de aceptar no hay acceso');
    assert.equal((await pool.query('SELECT 1 FROM users WHERE lower(email) = $1', [correo])).rowCount, 0, 'tampoco se crea la cuenta');
    assert.ok((await s.pedir('GET', '/api/admin/invitaciones')).json.invitations.some(i => i.id === invitacion.id));
    assert.ok(!(await s.pedir('GET', '/api/admin/usuarios')).json.users.some(u => u.email === correo), 'no figura como usuario');

    const consulta = await s.pedir('POST', '/api/auth/invitacion/consultar', { token }, { cookie: null });
    assert.equal(consulta.status, 200);
    assert.equal(consulta.json.invitation.email, correo);
    assert.equal(consulta.json.invitation.accountExists, false);
    assert.equal(consulta.json.invitation.roleName, 'Recepción y caja');

    assert.equal((await s.pedir('POST', '/api/auth/invitacion/aceptar', { token, name: 'Nuevo', password: 'corta' }, { cookie: null })).status, 400);
    const ok = await s.pedir('POST', '/api/auth/invitacion/aceptar', { token, name: 'Nuevo', password: CLAVE }, { cookie: null });
    assert.equal(ok.status, 200, ok.texto);
    assert.equal(ok.json.business.id, s.negocio);
    assert.equal(ok.json.role, 'staff');
    const sesion = (await s.pedir('GET', '/api/auth/sesion', undefined, { cookie: cookieDe(ok) })).json;
    assert.equal(sesion.business.id, s.negocio);
    assert.deepEqual(await pertenencias(correo), [{ business_id: s.negocio, role: 'staff' }]);

    for (const ruta of ['consultar', 'aceptar', 'rechazar']) {
      const otra = await s.pedir('POST', `/api/auth/invitacion/${ruta}`, { token, name: 'Otro', password: CLAVE }, { cookie: null });
      assert.equal(otra.status, 410, ruta);
      assert.equal(otra.json.code, 'INVITACION_CERRADA');
    }
    assert.ok(!(await s.pedir('GET', '/api/admin/invitaciones')).json.invitations.some(i => i.id === invitacion.id));
    assert.equal((await s.pedir('POST', '/api/auth/invitacion/consultar', { token: 'x'.repeat(43) }, { cookie: null })).json.code, 'INVITACION_INVALIDA');
  });

  test('cuenta de otra barbería: no entra a A sin aceptar; aceptar exige su contraseña; luego puede cambiar entre las dos', async () => {
    const { token } = await invitar(correoB, 'staff');
    assert.deepEqual(await negociosDe(cookieB), [negocioB], 'la invitación sola no da acceso');
    const login = await s.pedir('POST', '/api/auth/login', { email: correoB, password: CLAVE, businessId: s.negocio }, { cookie: null });
    assert.notEqual(login.json?.business?.id, s.negocio, 'tampoco al iniciar sesión pidiendo la barbería A');
    assert.equal((await s.pedir('POST', '/api/auth/cambiar-barberia', { businessId: s.negocio }, { cookie: cookieB })).status, 403);

    const consulta = (await s.pedir('POST', '/api/auth/invitacion/consultar', { token }, { cookie: null })).json.invitation;
    assert.equal(consulta.accountExists, true);
    for (const password of [undefined, 'incorrecta-123456']) {
      const r = await s.pedir('POST', '/api/auth/invitacion/aceptar', { token, password, name: 'Intruso' }, { cookie: null });
      assert.equal(r.status, 400);
      assert.equal(r.json.code, 'CLAVE_ACTUAL');
    }
    const usuario = (await pool.query('SELECT name, password_hash FROM users WHERE lower(email) = $1', [correoB])).rows[0];
    assert.equal(usuario.name, 'Dueño B', 'quien no conoce la contraseña no cambia la cuenta');
    assert.equal((await pool.query(
      `SELECT count(*)::int AS n FROM auth_events WHERE type = 'invitacion_clave_incorrecta' AND business_id = $1`, [s.negocio])).rows[0].n, 2);
    assert.deepEqual(await negociosDe(cookieB), [negocioB]);

    const ok = await s.pedir('POST', '/api/auth/invitacion/aceptar', { token, password: CLAVE }, { cookie: null });
    assert.equal(ok.status, 200, ok.texto);
    const enA = cookieDe(ok);
    assert.equal((await s.pedir('GET', '/api/auth/sesion', undefined, { cookie: enA })).json.role, 'staff');
    assert.deepEqual(await negociosDe(enA), [s.negocio, negocioB].sort());

    /* En A solo ve lo de A, con los permisos de recepción. */
    assert.equal((await s.pedir('GET', '/api/admin/usuarios', undefined, { cookie: enA })).status, 403);
    assert.equal((await s.pedir('GET', '/api/bookings', undefined, { cookie: enA })).status, 200);

    /* Cambio entre sus barberías sin escribir la contraseña; nunca a una ajena. */
    const aB = await s.pedir('POST', '/api/auth/cambiar-barberia', { businessId: negocioB }, { cookie: enA });
    assert.equal(aB.status, 200);
    const enB = cookieDe(aB);
    assert.equal((await s.pedir('GET', '/api/auth/sesion', undefined, { cookie: enB })).json.role, 'owner');
    assert.equal((await s.pedir('GET', '/api/auth/sesion', undefined, { cookie: enA })).status, 401, 'la sesión anterior se cierra');
    assert.equal((await s.pedir('POST', '/api/auth/cambiar-barberia', { businessId: 'prueba-inexistente' }, { cookie: enB })).status, 403);
    assert.equal((await s.pedir('POST', '/api/auth/cambiar-barberia', { businessId: s.negocio }, { cookie: null })).status, 401);

    /* Ya es miembro: no se puede invitar otra vez. */
    const otra = await s.pedir('POST', '/api/admin/usuarios', { email: correoB, role: 'staff' });
    assert.equal(otra.status, 409);
    assert.equal(otra.json.code, 'YA_ES_MIEMBRO');
    await pool.query('DELETE FROM memberships WHERE business_id = $1 AND user_id = (SELECT id FROM users WHERE lower(email) = $2)', [s.negocio, correoB]);
    cookieB = enB;
  });

  test('con dos pasos activos, aceptar exige también el código', async () => {
    const correo = `dospasos-${unico()}@prueba.test`;
    await crearCuenta(negocioB, correo, CLAVE, 'staff');
    const propia = await s.iniciarSesion(correo, CLAVE);
    const clave = (await s.pedir('POST', '/api/auth/2fa/iniciar', {}, { cookie: propia })).json.secret;
    assert.equal((await s.pedir('POST', '/api/auth/2fa/activar', { code: codigoActual(clave) }, { cookie: propia })).status, 200);

    const { token } = await invitar(correo, 'staff');
    assert.equal((await s.pedir('POST', '/api/auth/invitacion/consultar', { token }, { cookie: null })).json.invitation.twoFactor, true);
    const sinCodigo = await s.pedir('POST', '/api/auth/invitacion/aceptar', { token, password: CLAVE }, { cookie: null });
    assert.equal(sinCodigo.json.code, 'CODIGO_REQUERIDO');
    assert.equal((await s.pedir('POST', '/api/auth/invitacion/aceptar', { token, password: CLAVE, code: '000000' }, { cookie: null })).json.code, 'CODIGO_INVALIDO');
    assert.deepEqual((await pertenencias(correo)).map(p => p.business_id), [negocioB]);
    const ok = await s.pedir('POST', '/api/auth/invitacion/aceptar', { token, password: CLAVE, code: codigoActual(clave, 1) }, { cookie: null });
    assert.equal(ok.status, 200, ok.texto);
    assert.deepEqual((await pertenencias(correo)).map(p => p.business_id).sort(), [s.negocio, negocioB].sort());
  });

  test('desde «Mi cuenta»: aceptar o rechazar solo las propias; rechazar cierra el enlace', async () => {
    const { token, invitacion } = await invitar(correoB, 'admin');
    const mias = (await s.pedir('GET', '/api/auth/invitaciones', undefined, { cookie: cookieB })).json.invitations;
    assert.deepEqual(mias.map(i => [i.id, i.businessId, i.role]), [[invitacion.id, s.negocio, 'admin']]);
    assert.deepEqual((await s.pedir('GET', '/api/auth/invitaciones')).json.invitations, [], 'el dueño de A no ve invitaciones ajenas');
    assert.equal((await s.pedir('GET', '/api/auth/invitaciones', undefined, { cookie: null })).status, 401);

    /* Otra persona no puede responderla aunque conozca su identificador. */
    for (const accion of ['aceptar', 'rechazar']) {
      const r = await s.pedir('POST', `/api/auth/invitaciones/${invitacion.id}/${accion}`, {});
      assert.equal(r.status, 404, accion);
    }
    assert.equal((await s.pedir('POST', `/api/auth/invitaciones/${invitacion.id}/borrar`, {}, { cookie: cookieB })).status, 404);

    const no = await s.pedir('POST', `/api/auth/invitaciones/${invitacion.id}/rechazar`, {}, { cookie: cookieB });
    assert.equal(no.status, 200);
    assert.deepEqual(await negociosDe(cookieB), [negocioB]);
    assert.equal((await s.pedir('POST', '/api/auth/invitacion/aceptar', { token, password: CLAVE }, { cookie: null })).status, 410);
    assert.equal((await s.pedir('POST', `/api/auth/invitaciones/${invitacion.id}/aceptar`, {}, { cookie: cookieB })).status, 410);
    assert.ok(!(await s.pedir('GET', '/api/admin/invitaciones')).json.invitations.some(i => i.id === invitacion.id));

    const nueva = await invitar(correoB, 'admin');
    const si = await s.pedir('POST', `/api/auth/invitaciones/${nueva.invitacion.id}/aceptar`, {}, { cookie: cookieB });
    assert.equal(si.status, 200);
    assert.equal(si.json.business.id, s.negocio);
    assert.deepEqual(await negociosDe(cookieB), [s.negocio, negocioB].sort());
    assert.equal((await s.pedir('GET', '/api/auth/sesion', undefined, { cookie: cookieB })).json.business.id, negocioB, 'la sesión actual sigue en B');
    assert.equal((await s.pedir('POST', '/api/auth/invitacion/consultar', { token: nueva.token }, { cookie: null })).status, 410);
    await pool.query('DELETE FROM memberships WHERE business_id = $1 AND user_id = (SELECT id FROM users WHERE lower(email) = $2)', [s.negocio, correoB]);
  });

  test('vencimiento: la invitación vencida no sirve; reenviar da un enlace nuevo y anula el anterior', async () => {
    const correo = `vence-${unico()}@prueba.test`;
    const { token, invitacion } = await invitar(correo, 'staff');
    await pool.query(`UPDATE invitations SET expires_at = NOW() - interval '1 minute' WHERE id = $1`, [invitacion.id]);

    for (const ruta of ['consultar', 'aceptar', 'rechazar']) {
      const r = await s.pedir('POST', `/api/auth/invitacion/${ruta}`, { token, name: 'Tarde', password: CLAVE }, { cookie: null });
      assert.equal(r.status, 410, ruta);
      assert.equal(r.json.code, 'INVITACION_VENCIDA');
    }
    const pendiente = (await s.pedir('GET', '/api/admin/invitaciones')).json.invitations.find(i => i.id === invitacion.id);
    assert.equal(pendiente.expired, true, 'el propietario la ve como vencida');

    const desde = s.logs.length;
    const re = await s.pedir('POST', `/api/admin/invitaciones/${invitacion.id}/reenviar`, {});
    assert.equal(re.status, 200);
    assert.equal(re.json.invitation.expired, false);
    assert.ok(new Date(re.json.invitation.expiresAt) > new Date(Date.now() + 6 * 86400000), 'nuevo plazo de 7 días');
    const nuevo = await enlace(s, correo, 'invitacion', desde);
    assert.notEqual(nuevo, token);
    assert.equal((await s.pedir('POST', '/api/auth/invitacion/consultar', { token }, { cookie: null })).json.code, 'INVITACION_INVALIDA');
    assert.equal((await s.pedir('POST', '/api/auth/invitacion/aceptar', { token: nuevo, name: 'A tiempo', password: CLAVE }, { cookie: null })).status, 200);
    assert.equal((await s.pedir('POST', `/api/admin/invitaciones/${invitacion.id}/reenviar`, {})).status, 409, 'ya no está pendiente');
  });

  test('revocar y reemplazar: el enlace anterior deja de servir', async () => {
    const correo = `revoca-${unico()}@prueba.test`;
    const primera = await invitar(correo, 'staff');
    const segunda = await invitar(correo, 'admin');
    const lista = (await s.pedir('GET', '/api/admin/invitaciones')).json.invitations.filter(i => i.email === correo);
    assert.deepEqual(lista.map(i => [i.id, i.role]), [[segunda.invitacion.id, 'admin']], 'una sola pendiente por correo');
    assert.equal((await s.pedir('POST', '/api/auth/invitacion/aceptar', { token: primera.token, name: 'X', password: CLAVE }, { cookie: null })).json.code, 'INVITACION_CERRADA');

    assert.equal((await s.pedir('POST', `/api/admin/invitaciones/${segunda.invitacion.id}/revocar`, {})).status, 200);
    const r = await s.pedir('POST', '/api/auth/invitacion/aceptar', { token: segunda.token, name: 'X', password: CLAVE }, { cookie: null });
    assert.equal(r.status, 410);
    assert.equal(r.json.code, 'INVITACION_CERRADA');
    assert.equal((await s.pedir('POST', `/api/admin/invitaciones/${segunda.invitacion.id}/revocar`, {})).status, 409);
    assert.deepEqual(await pertenencias(correo), []);
    assert.equal((await pool.query('SELECT 1 FROM users WHERE lower(email) = $1', [correo])).rowCount, 0);
  });

  test('aislamiento entre barberías y permisos para invitar', async () => {
    const correo = `aislada-${unico()}@prueba.test`;
    const { invitacion } = await invitar(correo, 'staff');

    /* B no ve, no reenvía ni revoca las invitaciones de A. */
    const deB = (await s.pedir('GET', '/api/admin/invitaciones', undefined, { cookie: cookieB })).json.invitations;
    assert.ok(!deB.some(i => i.id === invitacion.id || i.email === correo));
    for (const accion of ['reenviar', 'revocar']) {
      const r = await s.pedir('POST', `/api/admin/invitaciones/${invitacion.id}/${accion}`, {}, { cookie: cookieB });
      assert.equal(r.status, 404, accion);
    }
    assert.ok((await s.pedir('GET', '/api/admin/invitaciones')).json.invitations.some(i => i.id === invitacion.id), 'sigue pendiente en A');

    /* Una invitación de B no aparece en A, y un businessId en el cuerpo no cambia de barbería. */
    const desde = s.logs.length;
    const deBaOtro = await s.pedir('POST', '/api/admin/usuarios', { email: `deb-${unico()}@prueba.test`, role: 'staff', businessId: s.negocio }, { cookie: cookieB });
    assert.equal(deBaOtro.status, 201);
    await s.esperarLog(/\[DEMO CORREO\] deb-/, 5000, desde);
    const [fila] = (await pool.query('SELECT business_id FROM invitations WHERE id = $1', [deBaOtro.json.invitation.id])).rows;
    assert.equal(fila.business_id, negocioB);
    assert.ok(!(await s.pedir('GET', '/api/admin/invitaciones')).json.invitations.some(i => i.id === deBaOtro.json.invitation.id));

    /* Recepción no ve ni invita; el administrador solo ve la lista; nadie invita sin sesión. */
    const recepcion = `recep-${unico()}@prueba.test`;
    const admin = `admin-${unico()}@prueba.test`;
    await crearCuenta(s.negocio, recepcion, CLAVE, 'staff');
    await crearCuenta(s.negocio, admin, CLAVE, 'admin');
    const cRecep = await s.iniciarSesion(recepcion, CLAVE);
    const cAdmin = await s.iniciarSesion(admin, CLAVE);
    assert.equal((await s.pedir('GET', '/api/admin/invitaciones', undefined, { cookie: cRecep })).status, 403);
    assert.equal((await s.pedir('POST', '/api/admin/usuarios', { email: `x-${unico()}@prueba.test`, role: 'staff' }, { cookie: cRecep })).status, 403);
    assert.equal((await s.pedir('GET', '/api/admin/invitaciones', undefined, { cookie: cAdmin })).status, 200);
    for (const [ruta, cuerpo] of [
      ['/api/admin/usuarios', { email: `x-${unico()}@prueba.test`, role: 'staff' }],
      [`/api/admin/invitaciones/${invitacion.id}/reenviar`, {}],
      [`/api/admin/invitaciones/${invitacion.id}/revocar`, {}]
    ]) {
      assert.equal((await s.pedir('POST', ruta, cuerpo, { cookie: cAdmin })).status, 403, ruta);
      assert.equal((await s.pedir('POST', ruta, cuerpo, { cookie: null })).status, 401, ruta);
    }
  });
});
