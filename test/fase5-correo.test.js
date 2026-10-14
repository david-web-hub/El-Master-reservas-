'use strict';
/*
  Fase 5 · correo: plantillas, envío por Resend (contra un servidor falso:
  no sale ningún mensaje real), manejo de errores, registro en producción
  y enlaces vencidos o usados.
*/
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { iniciarServidor, urlBasePruebas, cookieDe } = require('./apoyo/servidor');
const { iniciarResendFalso } = require('./apoyo/resend-falso');
const { construirCorreo, crearCorreo } = require('../correo');

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

const enlaceDe = (html, tipo) => (html.match(new RegExp(`${tipo}=([A-Za-z0-9_-]+)`)) || [])[1];

test.describe('Fase 5 · plantillas de correo', () => {
  test('cada plantilla tiene asunto, HTML con la marca, botón, enlace y texto plano', () => {
    const enlace = 'https://reservas.example/acceso.html#verificar=abc';
    for (const plantilla of ['confirmacion', 'recuperacion', 'invitacion', 'prueba']) {
      const c = construirCorreo(plantilla, { nombre: 'Ana', negocio: 'El Máster', rol: 'Barbero', invitante: 'Carlos', enlace });
      assert.ok(c.asunto.length > 10, plantilla);
      assert.match(c.html, /MASTER RESERVAS/);
      assert.match(c.html, /#f4c94d/i, 'color dorado de la marca');
      assert.ok(c.html.includes(`href="${enlace}"`), 'botón con el enlace');
      assert.ok(c.texto.includes(enlace), 'versión de texto con el enlace');
    }
    assert.match(construirCorreo('invitacion', { negocio: 'El Máster', enlace }).asunto, /El Máster/);
  });

  test('los datos se escapan: un nombre con HTML no se interpreta', () => {
    const c = construirCorreo('invitacion', {
      nombre: '<img src=x onerror=alert(1)>', negocio: '<script>alert(1)</script>', invitante: '"><b>x</b>',
      enlace: 'https://reservas.example/acceso.html#invitacion=abc'
    });
    assert.ok(!c.html.includes('<script>alert(1)</script>'));
    assert.ok(!c.html.includes('<img src=x'));
    assert.ok(!c.html.includes('"><b>x</b>'));
    assert.ok(c.html.includes('&lt;script&gt;'));
  });

  test('sin credenciales: en desarrollo solo se muestra en la consola; en producción no se envía nada', async () => {
    const lineas = [];
    const registro = { log: l => lineas.push(l), warn: l => lineas.push(l), error: l => lineas.push(l) };
    const llamado = () => { throw new Error('no debería llamar a la red'); };
    const desarrollo = crearCorreo({ registro, fetchImpl: llamado });
    assert.equal(desarrollo.configurado, false);
    assert.deepEqual(await desarrollo.enviar({ para: 'a@b.co', plantilla: 'confirmacion', datos: { enlace: 'https://x/#verificar=1' } }),
      { ok: true, modo: 'demostracion' });
    const produccion = crearCorreo({ registro, produccion: true, fetchImpl: llamado });
    const r = await produccion.enviar({ para: 'a@b.co', plantilla: 'confirmacion', datos: { enlace: 'https://x/#verificar=2' } });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'NO_CONFIGURADO');
    assert.ok(!lineas.join('\n').includes('verificar=2'), 'en producción el enlace no se registra');
  });
});

test.describe('Fase 5 · envío por Resend (servidor falso)', { skip: omitir }, () => {
  let resend;
  let s;
  let pool;
  test.before(async () => {
    resend = await iniciarResendFalso();
    s = await iniciarServidor({
      postgres: true,
      env: {
        RESEND_API_KEY: 're_prueba_no_real', CORREO_REMITENTE: 'Master Reservas <no-responder@reservas.example>',
        CORREO_RESPONDER_A: 'soporte@reservas.example', RESEND_API_URL: resend.url,
        PUBLIC_BASE_URL: 'https://reservas.example', CORREO_TIEMPO_LIMITE_MS: '400'
      }
    });
    pool = crearPool();
  });
  test.after(async () => {
    if (s) { await s.detener(); s.borrar(); }
    if (resend) await resend.cerrar();
    if (pool) await pool.end();
  });

  test('confirmación de cuenta: se envía con credenciales por variables de entorno y el enlace funciona', async () => {
    const correo = `resend-${unico()}@prueba.test`;
    const antes = resend.recibidos.length;
    const desde = s.logs.length;
    const r = await s.pedir('POST', '/api/auth/registro', { businessName: 'Resend ' + unico(), name: 'Ana', email: correo, password: CLAVE }, { cookie: null });
    assert.equal(r.status, 201);
    assert.equal(r.json.emailSent, true);
    const m = resend.recibidos[antes];
    assert.equal(m.metodo, 'POST');
    assert.equal(m.cabeceras.authorization, 'Bearer re_prueba_no_real');
    assert.ok(m.cabeceras['idempotency-key']);
    assert.equal(m.cuerpo.from, 'Master Reservas <no-responder@reservas.example>');
    assert.deepEqual(m.cuerpo.to, [correo]);
    assert.equal(m.cuerpo.reply_to, 'soporte@reservas.example');
    assert.match(m.cuerpo.subject, /Confirma tu correo/);
    assert.match(m.cuerpo.html, /https:\/\/reservas\.example\/acceso\.html#verificar=/, 'enlace con PUBLIC_BASE_URL');
    assert.match(m.cuerpo.text, /verificar=/);
    const registros = s.logs.slice(desde).join('\n');
    assert.ok(!registros.includes('[DEMO CORREO]'), 'con credenciales no se usa el modo demostración');
    assert.ok(!/verificar=/.test(registros), 'el enlace no aparece en los registros');
    assert.ok(!registros.includes('re_prueba_no_real'), 'la clave no aparece en los registros');

    assert.equal((await s.pedir('POST', '/api/auth/verificar', { token: enlaceDe(m.cuerpo.html, 'verificar') }, { cookie: null })).status, 200);
    assert.equal((await s.pedir('POST', '/api/auth/login', { email: correo, password: CLAVE }, { cookie: null })).status, 200);
  });

  test('recuperación de contraseña e invitación usan sus plantillas', async () => {
    const antes = resend.recibidos.length;
    await s.pedir('POST', '/api/auth/recuperar', { email: s.correo }, { cookie: null });
    const rec = resend.recibidos[antes];
    assert.match(rec.cuerpo.subject, /Restablece tu contraseña/);
    assert.ok(enlaceDe(rec.cuerpo.html, 'restablecer'));

    const invitado = `inv-${unico()}@prueba.test`;
    const r = await s.pedir('POST', '/api/admin/usuarios', { email: invitado, name: 'Invitada', role: 'staff' });
    assert.equal(r.json.emailSent, true);
    const inv = resend.recibidos[antes + 1];
    assert.deepEqual(inv.cuerpo.to, [invitado]);
    assert.match(inv.cuerpo.subject, /Invitación a El Máster/);
    assert.match(inv.cuerpo.html, /Recepción y caja/);
    assert.ok(enlaceDe(inv.cuerpo.html, 'invitacion'));
  });

  test('un fallo temporal se reintenta una vez con la misma clave de idempotencia', async () => {
    resend.responder({ status: 500, body: { name: 'internal_server_error', message: 'Error' } });
    const antes = resend.recibidos.length;
    const r = await s.pedir('POST', '/api/admin/usuarios', { email: `reintento-${unico()}@prueba.test`, role: 'staff' });
    assert.equal(r.json.emailSent, true);
    const [a, b] = resend.recibidos.slice(antes);
    assert.ok(a && b, 'dos intentos');
    assert.equal(a.cabeceras['idempotency-key'], b.cabeceras['idempotency-key'], 'Resend no duplica el mensaje');
  });

  test('errores de envío: rechazo y tiempo agotado se informan sin perder la cuenta ni la invitación', async () => {
    /* Rechazo (422): no se reintenta. */
    resend.responder({ status: 422, body: { name: 'validation_error', message: 'Dirección no válida' } });
    const antes = resend.recibidos.length;
    const correo = `rechazo-${unico()}@prueba.test`;
    const reg = await s.pedir('POST', '/api/auth/registro', { businessName: 'Rechazo ' + unico(), name: 'Ana', email: correo, password: CLAVE }, { cookie: null });
    assert.equal(reg.status, 201, 'la cuenta se crea aunque el correo falle');
    assert.equal(reg.json.emailSent, false);
    assert.equal(resend.recibidos.length, antes + 1, 'un rechazo no se reintenta');
    /* Se puede pedir otro enlace y funciona. */
    await s.pedir('POST', '/api/auth/verificacion/reenviar', { email: correo }, { cookie: null });
    const nuevo = resend.recibidos.at(-1);
    assert.equal((await s.pedir('POST', '/api/auth/verificar', { token: enlaceDe(nuevo.cuerpo.html, 'verificar') }, { cookie: null })).status, 200);

    /* Tiempo agotado (dos veces): la invitación queda creada y se puede reenviar. */
    resend.responder({ status: 200, demoraMs: 1500 }, { status: 200, demoraMs: 1500 });
    const invitado = `lento-${unico()}@prueba.test`;
    const inv = await s.pedir('POST', '/api/admin/usuarios', { email: invitado, role: 'staff' });
    assert.equal(inv.status, 201);
    assert.equal(inv.json.emailSent, false);
    assert.ok((await s.pedir('GET', '/api/admin/invitaciones')).json.invitations.some(x => x.email === invitado));
    const re = await s.pedir('POST', `/api/admin/invitaciones/${inv.json.invitation.id}/reenviar`, {});
    assert.equal(re.json.emailSent, true);

    /* La recuperación responde igual aunque el envío falle (no revela cuentas). */
    resend.responder({ status: 500 }, { status: 500 });
    const rec = await s.pedir('POST', '/api/auth/recuperar', { email: s.correo }, { cookie: null });
    assert.equal(rec.status, 200);
    const fallos = (await pool.query(`SELECT detail FROM auth_events WHERE type = 'correo_fallido' ORDER BY id DESC LIMIT 3`)).rows;
    assert.ok(fallos.length >= 2, 'los fallos quedan registrados');
    assert.ok(fallos.every(f => !JSON.stringify(f).includes('re_prueba_no_real')));
  });
});

test.describe('Fase 5 · registro en producción', { skip: omitir }, () => {
  test('se abre solo con REGISTRO_ABIERTO=1 y el correo configurado', async () => {
    const resend = await iniciarResendFalso();
    const env = {
      RENDER: 'true', REGISTRO_ABIERTO: '1', RESEND_API_KEY: 're_prueba_no_real',
      CORREO_REMITENTE: 'no-responder@reservas.example', RESEND_API_URL: resend.url
    };
    const sinUrl = await iniciarServidor({ postgres: true, env });
    const listo = await iniciarServidor({ postgres: true, env: { ...env, PUBLIC_BASE_URL: 'https://reservas.example' } });
    try {
      const datos = () => ({ businessName: 'Prod ' + unico(), name: 'Ana', email: `p-${unico()}@prueba.test`, password: CLAVE });
      assert.equal((await sinUrl.pedir('POST', '/api/auth/registro', datos(), { cookie: null })).status, 403, 'falta PUBLIC_BASE_URL');
      assert.equal((await listo.pedir('GET', '/api/auth/config', undefined, { cookie: null })).json.registrationOpen, true);
      const r = await listo.pedir('POST', '/api/auth/registro', datos(), { cookie: null });
      assert.equal(r.status, 201);
      assert.equal(r.json.emailSent, true);
      assert.match(resend.recibidos.at(-1).cuerpo.html, /https:\/\/reservas\.example\/acceso\.html#verificar=/);
    } finally {
      for (const x of [sinUrl, listo]) { await x.detener(); x.borrar(); }
      await resend.cerrar();
    }
  });
});

test.describe('Fase 5 · enlaces de un solo uso y vencidos', { skip: omitir }, () => {
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

  async function enlaceDemo(correo, tipo, desde) {
    const linea = await s.esperarLog(new RegExp(`\\[DEMO CORREO\\] ${correo.replace(/[.+]/g, '\\$&')} `), 5000, desde);
    return linea.match(new RegExp(`${tipo}=([A-Za-z0-9_-]+)`))[1];
  }

  test('confirmación: usado, vencido e inventado tienen mensajes distintos', async () => {
    const correo = `enl-${unico()}@prueba.test`;
    let desde = s.logs.length;
    await s.pedir('POST', '/api/auth/registro', { businessName: 'Enl ' + unico(), name: 'Ana', email: correo, password: CLAVE }, { cookie: null });
    const t1 = await enlaceDemo(correo, 'verificar', desde);
    await pool.query(`UPDATE email_verifications SET expires_at = NOW() - interval '1 second' WHERE token_hash = encode(sha256($1::bytea), 'hex')`, [t1]);
    const vencido = await s.pedir('POST', '/api/auth/verificar', { token: t1 }, { cookie: null });
    assert.equal(vencido.json.code, 'ENLACE_VENCIDO');
    assert.equal((await s.pedir('POST', '/api/auth/verificar', { token: 'z'.repeat(43) }, { cookie: null })).json.code, 'ENLACE_INVALIDO');
    desde = s.logs.length;
    await s.pedir('POST', '/api/auth/verificacion/reenviar', { email: correo }, { cookie: null });
    const t2 = await enlaceDemo(correo, 'verificar', desde);
    assert.equal((await s.pedir('POST', '/api/auth/verificar', { token: t2 }, { cookie: null })).status, 200);
    assert.equal((await s.pedir('POST', '/api/auth/verificar', { token: t2 }, { cookie: null })).json.code, 'ENLACE_USADO');
  });

  test('recuperación: usado y vencido tienen mensajes distintos; uno nuevo anula al anterior', async () => {
    let desde = s.logs.length;
    await s.pedir('POST', '/api/auth/recuperar', { email: s.correo }, { cookie: null });
    const t1 = await enlaceDemo(s.correo, 'restablecer', desde);
    desde = s.logs.length;
    await s.pedir('POST', '/api/auth/recuperar', { email: s.correo }, { cookie: null });
    const t2 = await enlaceDemo(s.correo, 'restablecer', desde);
    assert.equal((await s.pedir('POST', '/api/auth/restablecer', { token: t1, password: 'Otra-clave-segura-123' }, { cookie: null })).json.code, 'ENLACE_USADO', 'el anterior quedó anulado');
    await pool.query(`UPDATE password_resets SET expires_at = NOW() - interval '1 second' WHERE token_hash = encode(sha256($1::bytea), 'hex')`, [t2]);
    assert.equal((await s.pedir('POST', '/api/auth/restablecer', { token: t2, password: 'Otra-clave-segura-123' }, { cookie: null })).json.code, 'ENLACE_VENCIDO');
    assert.equal((await s.pedir('POST', '/api/auth/login', { email: s.correo, password: s.clave }, { cookie: null })).status, 200, 'la contraseña no cambió');
    assert.ok(cookieDe(await s.pedir('POST', '/api/auth/login', { email: s.correo, password: s.clave }, { cookie: null })));
  });
});
