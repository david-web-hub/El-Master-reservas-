'use strict';
/*
  Fase 3: cuentas, sesiones, recuperación, roles y aislamiento.
  Requiere TEST_DATABASE_URL (las cuentas viven en PostgreSQL).
*/
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { iniciarServidor, urlBasePruebas, cookieDe, crearCuenta, proximoDia } = require('./apoyo/servidor');

const URL_PG = urlBasePruebas();
const omitir = URL_PG ? false : 'Define TEST_DATABASE_URL con una base de pruebas';
const CLAVE = 'Una-clave-bastante-segura-7';
const unico = () => Math.random().toString(36).slice(2, 10);

function crearPool() {
  const sinSsl = new URL(URL_PG).searchParams.get('sslmode') === 'disable';
  return new Pool({ connectionString: URL_PG, ssl: sinSsl ? false : { rejectUnauthorized: false }, max: 2 });
}

/*
  Registra una barbería nueva por la API, confirma el correo con el enlace
  que llega (modo demostración) e inicia sesión. Devuelve la cookie.
*/
async function registrar(s, extra = {}) {
  const id = unico();
  const datos = {
    businessName: `Barbería ${id}`, name: 'Dueña Prueba', email: `duena-${id}@prueba.test`, password: CLAVE, ...extra
  };
  const desde = s.logs.length;
  const r = await s.pedir('POST', '/api/auth/registro', datos, { cookie: null });
  let cookie = cookieDe(r);
  if (r.status === 201 && r.json.verificationRequired) {
    const linea = await s.esperarLog(new RegExp(`\\[DEMO CORREO\\] ${datos.email.replace(/[.+]/g, '\\$&')} `), 5000, desde);
    const token = linea.match(/verificar=([A-Za-z0-9_-]+)/)[1];
    const v = await s.pedir('POST', '/api/auth/verificar', { token }, { cookie: null });
    if (v.status !== 200) throw new Error('No se pudo verificar el correo: ' + v.texto);
    const login = await s.pedir('POST', '/api/auth/login', { email: datos.email, password: CLAVE }, { cookie: null });
    cookie = cookieDe(login);
    r.login = login;
  }
  return { r, cookie, datos };
}

async function enlaceDeCorreo(s, correo, desde) {
  const linea = await s.esperarLog(new RegExp(`\\[DEMO CORREO\\] ${correo.replace(/[.+]/g, '\\$&')} `), 5000, desde);
  return linea.match(/restablecer=([A-Za-z0-9_-]+)/)[1];
}

test.describe('Fase 3 · seguridad', { skip: omitir }, () => {
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

  test('todas las rutas de administración exigen sesión; las públicas siguen abiertas', async () => {
    const protegidas = [
      ['GET', '/api/config'], ['GET', '/api/bookings'], ['PATCH', '/api/bookings/BK-1', { status: 'confirmed' }],
      ['GET', '/api/admin/services'], ['POST', '/api/admin/services', { name: 'X', price: 1, duration: 10 }],
      ['PATCH', '/api/admin/services/corte', { price: 0 }],
      ['GET', '/api/admin/products'], ['POST', '/api/admin/products', { name: 'X', price: 1 }],
      ['PATCH', '/api/admin/products/x', { price: 1 }],
      ['POST', '/api/sales', { paymentMethod: 'cash', items: [] }], ['GET', '/api/cash/today'], ['POST', '/api/cash/close', {}],
      ['GET', '/api/admin/reports?from=2026-01-01&to=2026-01-02'], ['GET', '/api/admin/business'],
      ['PUT', '/api/admin/business', { name: 'X' }], ['GET', '/api/admin/barbers'], ['POST', '/api/admin/barbers', { name: 'X' }],
      ['PATCH', '/api/admin/barbers/master', { name: 'X' }], ['GET', '/api/admin/settings'],
      ['POST', '/api/admin/settings', { section: 'pagina', data: {} }], ['GET', '/api/admin/hours'], ['PUT', '/api/admin/hours', { hours: {} }],
      ['GET', '/api/admin/media'], ['POST', '/api/admin/media', { kind: 'logo', image: 'x' }], ['DELETE', '/api/admin/media/logo'],
      ['GET', '/api/admin/backup'], ['GET', '/api/admin/usuarios'], ['POST', '/api/admin/usuarios', {}],
      ['PATCH', '/api/admin/usuarios/x', {}], ['GET', '/api/admin/ruta-que-no-existe']
    ];
    for (const [m, ruta, cuerpo] of protegidas) {
      const r = await s.pedir(m, ruta, cuerpo, { cookie: null });
      assert.equal(r.status, 401, `${m} ${ruta} debe exigir sesión`);
    }
    const falsa = await s.pedir('GET', '/api/bookings', undefined, { cookie: 'mr_sesion=' + 'A'.repeat(43) });
    assert.equal(falsa.status, 401, 'una cookie inventada no sirve');

    assert.equal((await s.pedir('GET', '/api/public/site', undefined, { cookie: null })).status, 200);
    assert.equal((await s.pedir('GET', `/api/availability?date=${proximoDia(1)}&barberId=master&serviceIds=corte`, undefined, { cookie: null })).status, 200);
    const reserva = await s.pedir('POST', '/api/bookings', { name: 'Cliente Público', phone: '0990009001', barberId: 'master', serviceIds: ['corte'], date: proximoDia(1), time: '08:00' }, { cookie: null });
    assert.equal(reserva.status, 201, 'los clientes reservan sin cuenta');
    assert.equal((await s.pedir('GET', '/api/health', undefined, { cookie: null })).status, 200);
    assert.match(await s.enviarWhatsApp('hola', '593990009001'), /Bienvenido/, 'Elia sigue respondiendo');
  });

  test('el panel redirige a la pantalla de acceso sin sesión', async () => {
    const sin = await s.pedir('GET', '/admin.html', undefined, { cookie: null });
    assert.equal(sin.status, 302);
    assert.equal(sin.headers.get('location'), '/acceso.html');
    const con = await s.pedir('GET', '/admin.html');
    assert.equal(con.status, 200);
    assert.match(con.texto, /El Máster \| Administración/);
    assert.equal((await s.pedir('GET', '/acceso.html', undefined, { cookie: null })).status, 200);
    assert.equal((await s.pedir('GET', '/', undefined, { cookie: null })).status, 200, 'la página pública sigue abierta');
    assert.equal(sin.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(sin.headers.get('x-frame-options'), 'SAMEORIGIN');
  });

  test('registro: barbería nueva, propietario, cookie segura y contraseña cifrada', async () => {
    const { r, cookie, datos } = await registrar(s, { country: 'CO', currency: 'COP', timezone: 'America/Bogota' });
    assert.equal(r.status, 201, r.texto);
    assert.equal(r.json.role, 'owner');
    assert.equal(r.json.verificationRequired, true, 'el registro exige confirmar el correo');
    assert.equal(cookieDe(r), null, 'sin correo confirmado no hay sesión');
    const setCookie = r.login.headers.getSetCookie().find(c => c.startsWith('mr_sesion='));
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.ok(!r.login.texto.includes(cookie.split('=')[1]), 'el identificador de sesión no va en el cuerpo');

    const sesion = await s.pedir('GET', '/api/auth/sesion', undefined, { cookie });
    assert.equal(sesion.json.business.id, r.json.business.id);
    assert.equal(sesion.json.role, 'owner');
    assert.ok(sesion.json.permissions.includes('*'));

    const [u] = (await pool.query('SELECT password_hash FROM users WHERE lower(email) = $1', [datos.email])).rows;
    assert.match(u.password_hash, /^scrypt\$/);
    assert.ok(!u.password_hash.includes(CLAVE));
    const tokens = (await pool.query('SELECT token_hash FROM sessions WHERE business_id = $1', [r.json.business.id])).rows;
    assert.ok(tokens.every(t => t.token_hash !== cookie.split('=')[1]), 'solo se guarda el resumen de la sesión');

    const [b] = (await pool.query('SELECT currency, timezone, status FROM businesses WHERE id = $1', [r.json.business.id])).rows;
    assert.deepEqual(b, { currency: 'COP', timezone: 'America/Bogota', status: 'trial' });
    assert.equal((await pool.query(`SELECT 1 FROM platform_events WHERE business_id = $1 AND type = 'business.created'`, [r.json.business.id])).rowCount, 1);

    const agenda = await s.pedir('GET', '/api/bookings', undefined, { cookie });
    assert.deepEqual(agenda.json, [], 'la barbería nueva empieza sin reservas');
  });

  test('registro rechaza datos inválidos, correos y direcciones repetidos', async () => {
    const { datos } = await registrar(s);
    const repetido = await s.pedir('POST', '/api/auth/registro', { ...datos, businessName: 'Otra ' + unico() }, { cookie: null });
    assert.equal(repetido.status, 409);
    /* Mismo nombre de barbería: recibe otra dirección pública en lugar de un error. */
    const mismoNombre = await s.pedir('POST', '/api/auth/registro', { ...datos, email: `otra-${unico()}@prueba.test` }, { cookie: null });
    assert.equal(mismoNombre.status, 201);
    assert.match(mismoNombre.json.business.slug, /-2$/, 'la misma dirección pública no se repite');
    for (const malo of [{ password: 'corta' }, { password: '1234567890' }, { email: 'no-es-correo' }, { businessName: '' }, { name: '' }]) {
      const r = await s.pedir('POST', '/api/auth/registro', { ...datos, email: `x-${unico()}@prueba.test`, businessName: 'B ' + unico(), ...malo }, { cookie: null });
      assert.equal(r.status, 400, JSON.stringify(malo));
    }
  });

  test('inicio de sesión: mismo mensaje para correo inexistente y contraseña incorrecta', async () => {
    const { datos } = await registrar(s);
    const mala = await s.pedir('POST', '/api/auth/login', { email: datos.email, password: 'otra-cosa-cualquiera' }, { cookie: null });
    const nadie = await s.pedir('POST', '/api/auth/login', { email: `nadie-${unico()}@prueba.test`, password: 'otra-cosa-cualquiera' }, { cookie: null });
    assert.equal(mala.status, 401);
    assert.equal(nadie.status, 401);
    assert.equal(mala.json.error, nadie.json.error);
    const ok = await s.pedir('POST', '/api/auth/login', { email: datos.email.toUpperCase(), password: CLAVE }, { cookie: null });
    assert.equal(ok.status, 200);
  });

  test('la cuenta se bloquea tras 10 intentos fallidos', async () => {
    const { datos } = await registrar(s);
    for (let i = 0; i < 10; i++) {
      assert.equal((await s.pedir('POST', '/api/auth/login', { email: datos.email, password: 'incorrecta-' + i }, { cookie: null })).status, 401);
    }
    const bloqueada = await s.pedir('POST', '/api/auth/login', { email: datos.email, password: CLAVE }, { cookie: null });
    assert.equal(bloqueada.status, 429, 'ni siquiera la contraseña correcta entra mientras está bloqueada');
    await pool.query('UPDATE users SET locked_until = NOW() - interval \'1 second\' WHERE lower(email) = $1', [datos.email]);
    assert.equal((await s.pedir('POST', '/api/auth/login', { email: datos.email, password: CLAVE }, { cookie: null })).status, 200);
  });

  test('cerrar sesión invalida la cookie; sesiones vencidas o de barberías suspendidas no sirven', async () => {
    const { cookie, r } = await registrar(s);
    assert.equal((await s.pedir('GET', '/api/bookings', undefined, { cookie })).status, 200);
    assert.equal((await s.pedir('POST', '/api/auth/logout', {}, { cookie })).status, 200);
    assert.equal((await s.pedir('GET', '/api/bookings', undefined, { cookie })).status, 401, 'la cookie anterior ya no sirve');

    const { cookie: c2, datos } = await registrar(s);
    await pool.query(`UPDATE sessions SET expires_at = NOW() - interval '1 second' WHERE user_id = (SELECT id FROM users WHERE lower(email) = $1)`, [datos.email]);
    assert.equal((await s.pedir('GET', '/api/bookings', undefined, { cookie: c2 })).status, 401, 'sesión vencida');

    const { cookie: c3, r: r3 } = await registrar(s);
    await pool.query(`UPDATE businesses SET status = 'suspended' WHERE id = $1`, [r3.json.business.id]);
    assert.equal((await s.pedir('GET', '/api/bookings', undefined, { cookie: c3 })).status, 401, 'barbería suspendida');
    assert.ok(r.json.business.id);
  });

  test('recuperación de contraseña: enlace de un solo uso, sin revelar cuentas, cierra sesiones', async () => {
    const { datos, cookie } = await registrar(s);
    const desde = s.logs.length;
    const pedido = await s.pedir('POST', '/api/auth/recuperar', { email: datos.email }, { cookie: null });
    const inexistente = await s.pedir('POST', '/api/auth/recuperar', { email: `nadie-${unico()}@prueba.test` }, { cookie: null });
    assert.equal(pedido.status, 200);
    assert.deepEqual(pedido.json, inexistente.json, 'misma respuesta exista o no la cuenta');
    const token = await enlaceDeCorreo(s, datos.email, desde);

    const [fila] = (await pool.query('SELECT token_hash FROM password_resets ORDER BY created_at DESC LIMIT 1')).rows;
    assert.notEqual(fila.token_hash, token, 'el enlace se guarda solo como resumen');

    assert.equal((await s.pedir('POST', '/api/auth/restablecer', { token, password: 'corta' }, { cookie: null })).status, 400);
    const nueva = 'Otra-clave-muy-distinta-42';
    assert.equal((await s.pedir('POST', '/api/auth/restablecer', { token, password: nueva }, { cookie: null })).status, 200);
    assert.equal((await s.pedir('POST', '/api/auth/restablecer', { token, password: 'Tercera-clave-distinta-9' }, { cookie: null })).status, 400, 'un solo uso');
    assert.equal((await s.pedir('GET', '/api/bookings', undefined, { cookie })).status, 401, 'las sesiones anteriores se cerraron');
    assert.equal((await s.pedir('POST', '/api/auth/login', { email: datos.email, password: CLAVE }, { cookie: null })).status, 401);
    assert.equal((await s.pedir('POST', '/api/auth/login', { email: datos.email, password: nueva }, { cookie: null })).status, 200);

    const desde2 = s.logs.length;
    await s.pedir('POST', '/api/auth/recuperar', { email: datos.email }, { cookie: null });
    const vencido = await enlaceDeCorreo(s, datos.email, desde2);
    await pool.query(`UPDATE password_resets SET expires_at = NOW() - interval '1 second' WHERE used_at IS NULL`);
    assert.equal((await s.pedir('POST', '/api/auth/restablecer', { token: vencido, password: 'Cuarta-clave-distinta-5' }, { cookie: null })).status, 400, 'enlace vencido');
    assert.equal((await s.pedir('POST', '/api/auth/restablecer', { token: 'x'.repeat(43), password: 'Cuarta-clave-distinta-5' }, { cookie: null })).status, 400, 'enlace inventado');
  });

  test('cambiar la contraseña exige la actual y cierra las otras sesiones', async () => {
    const { datos, cookie } = await registrar(s);
    const otra = cookieDe(await s.pedir('POST', '/api/auth/login', { email: datos.email, password: CLAVE }, { cookie: null }));
    assert.equal((await s.pedir('POST', '/api/auth/cambiar-clave', { currentPassword: 'mal', newPassword: 'Nueva-clave-segura-11' }, { cookie })).status, 400);
    assert.equal((await s.pedir('POST', '/api/auth/cambiar-clave', { currentPassword: CLAVE, newPassword: 'Nueva-clave-segura-11' }, { cookie })).status, 200);
    assert.equal((await s.pedir('GET', '/api/bookings', undefined, { cookie })).status, 200, 'la sesión actual sigue');
    assert.equal((await s.pedir('GET', '/api/bookings', undefined, { cookie: otra })).status, 401, 'las demás se cierran');
  });

  test('solicitudes que modifican datos desde otro sitio se rechazan (CSRF)', async () => {
    const otro = await s.pedir('POST', '/api/admin/barbers', { name: 'Desde otro sitio' }, { headers: { Origin: 'https://sitio-malicioso.example' } });
    assert.equal(otro.status, 403);
    const login = await s.pedir('POST', '/api/auth/login', { email: s.correo, password: s.clave }, { cookie: null, headers: { Origin: 'https://sitio-malicioso.example' } });
    assert.equal(login.status, 403);
    const mismo = await s.pedir('POST', '/api/admin/barbers', { name: 'Mismo sitio' }, { headers: { Origin: s.base } });
    assert.equal(mismo.status, 201);
  });

  test('una barbería no puede ver ni modificar a otra aunque altere la solicitud', async () => {
    /* A = barbería principal del servidor (propietario de prueba). B = barbería registrada. */
    const reservaA = await s.pedir('POST', '/api/bookings', { name: 'Cliente de A', phone: '0990009100', barberId: 'master', serviceIds: ['barba'], date: proximoDia(2), time: '09:00' }, { cookie: null });
    const idA = reservaA.json.booking.id;
    await s.pedir('POST', '/api/admin/settings', { section: 'pagina', data: { title: 'Secreto de A' } });
    const prodA = (await s.pedir('POST', '/api/admin/products', { name: 'Producto de A', price: 3 })).json.product.id;

    const { cookie: b, r } = await registrar(s);
    const idB = r.json.business.id;
    const trucos = [
      {}, { headers: { 'X-Business-Id': s.negocio } }
    ];
    for (const t of trucos) {
      const op = { cookie: b, headers: t.headers };
      const reservas = await s.pedir('GET', `/api/bookings?businessId=${s.negocio}&business_id=${s.negocio}`, undefined, op);
      assert.ok(!reservas.json.some(x => x.id === idA), 'B no ve reservas de A');
      assert.equal((await s.pedir('PATCH', `/api/bookings/${idA}`, { status: 'cancelled', businessId: s.negocio }, op)).status, 404);
      const ajustes = await s.pedir('GET', `/api/admin/settings?businessId=${s.negocio}`, undefined, op);
      assert.ok(!JSON.stringify(ajustes.json).includes('Secreto de A'));
      assert.equal((await s.pedir('PATCH', `/api/admin/products/${prodA}`, { price: 0, business_id: s.negocio }, op)).status, 404);
      const respaldo = await s.pedir('GET', '/api/admin/backup', undefined, op);
      assert.ok(!respaldo.texto.includes('Cliente de A'));
      assert.ok(!respaldo.texto.includes('Secreto de A'));
    }
    await s.pedir('POST', '/api/admin/settings', { section: 'pagina', data: { title: 'De B' }, businessId: s.negocio }, { cookie: b });
    assert.equal((await s.pedir('GET', '/api/admin/settings')).json.settings.pagina.title, 'Secreto de A', 'A no cambia');
    assert.equal((await s.pedir('GET', '/api/bookings')).json.find(x => x.id === idA).status, 'confirmed');

    /* Iniciar sesión pidiendo otra barbería tampoco sirve. */
    const { datos } = await registrar(s);
    const intento = await s.pedir('POST', '/api/auth/login', { email: datos.email, password: CLAVE, businessId: s.negocio }, { cookie: null });
    assert.equal(intento.status, 403);
    assert.ok(idB);
  });

  test('roles: propietario, administrador, recepción y barbero tienen permisos distintos', async () => {
    const desde = s.logs.length;
    const correo = rol => `${rol}-${s.negocio}@prueba.test`;
    for (const [rol, extra] of [['admin', {}], ['staff', {}], ['barber', { barberId: 'master' }]]) {
      const r = await s.pedir('POST', '/api/admin/usuarios', { email: correo(rol), name: rol, role: rol, ...extra });
      assert.equal(r.status, 201, r.texto);
      assert.equal(r.json.invitation.role, rol);
    }
    /* Las invitaciones llegan como enlace: la persona crea su contraseña y acepta. */
    const cookies = {};
    for (const rol of ['admin', 'staff', 'barber']) {
      const linea = await s.esperarLog(new RegExp(`\\[DEMO CORREO\\] ${correo(rol).replace(/[.+]/g, '\\$&')} `), 5000, desde);
      const token = linea.match(/invitacion=([A-Za-z0-9_-]+)/)[1];
      const acepta = await s.pedir('POST', '/api/auth/invitacion/aceptar', { token, name: 'Persona ' + rol, password: CLAVE }, { cookie: null });
      assert.equal(acepta.status, 200, acepta.texto);
      cookies[rol] = cookieDe(acepta);
    }
    assert.equal((await s.pedir('POST', '/api/admin/usuarios', { email: `x-${unico()}@prueba.test`, role: 'barber' })).status, 400, 'barbero sin ficha');

    const nuevoBarbero = (await s.pedir('POST', '/api/admin/barbers', { name: 'Otro Barbero' })).json.barber.id;
    const deOtro = (await s.pedir('POST', '/api/bookings', { name: 'Cliente Otro', phone: '0990009200', barberId: nuevoBarbero, serviceIds: ['corte'], date: proximoDia(4), time: '10:00' }, { cookie: null })).json.booking.id;
    const propia = (await s.pedir('POST', '/api/bookings', { name: 'Cliente Master', phone: '0990009201', barberId: 'master', serviceIds: ['corte'], date: proximoDia(4), time: '10:00' }, { cookie: null })).json.booking.id;

    const esperado = {
      'GET /api/config': { admin: 200, staff: 200, barber: 200 },
      'GET /api/bookings': { admin: 200, staff: 200, barber: 200 },
      'GET /api/cash/today': { admin: 200, staff: 200, barber: 403 },
      'GET /api/admin/products': { admin: 200, staff: 200, barber: 403 },
      'POST /api/admin/products': { admin: 200, staff: 403, barber: 403 },
      'GET /api/admin/reports': { admin: 200, staff: 403, barber: 403 },
      'POST /api/admin/settings': { admin: 200, staff: 403, barber: 403 },
      'POST /api/admin/barbers': { admin: 201, staff: 403, barber: 403 },
      'GET /api/admin/backup': { admin: 200, staff: 403, barber: 403 },
      'GET /api/admin/usuarios': { admin: 200, staff: 403, barber: 403 },
      'POST /api/admin/usuarios': { admin: 403, staff: 403, barber: 403 }
    };
    const hoy = new Date().toISOString().slice(0, 10);
    const cuerpos = {
      'POST /api/admin/products': { name: 'P ' + unico(), price: 1 },
      'POST /api/admin/settings': { section: 'notificaciones', data: {} },
      'POST /api/admin/barbers': { name: 'B ' + unico() },
      'POST /api/admin/usuarios': { email: `y-${unico()}@prueba.test`, role: 'staff' }
    };
    for (const [clave, porRol] of Object.entries(esperado)) {
      const [m, ruta] = clave.split(' ');
      for (const [rol, status] of Object.entries(porRol)) {
        const url = ruta === '/api/admin/reports' ? `${ruta}?from=${hoy}&to=${hoy}` : ruta;
        const r = await s.pedir(m, url, cuerpos[clave], { cookie: cookies[rol] });
        assert.equal(r.status, status, `${rol}: ${clave}`);
      }
    }

    const verBarbero = (await s.pedir('GET', '/api/bookings', undefined, { cookie: cookies.barber })).json;
    assert.ok(verBarbero.some(x => x.id === propia));
    assert.ok(verBarbero.every(x => x.barberId === 'master'), 'el barbero solo ve sus reservas');
    assert.equal((await s.pedir('PATCH', `/api/bookings/${deOtro}`, { status: 'in_progress' }, { cookie: cookies.barber })).status, 404);
    assert.equal((await s.pedir('PATCH', `/api/bookings/${propia}`, { status: 'in_progress' }, { cookie: cookies.barber })).status, 200);
    assert.ok((await s.pedir('GET', '/api/bookings', undefined, { cookie: cookies.staff })).json.some(x => x.id === deOtro));

    /* Cambiar o desactivar a alguien surte efecto de inmediato. */
    const lista = (await s.pedir('GET', '/api/admin/usuarios')).json.users;
    const staff = lista.find(u => u.email === correo('staff'));
    assert.equal((await s.pedir('PATCH', `/api/admin/usuarios/${staff.id}`, { status: 'disabled' })).status, 200);
    assert.equal((await s.pedir('GET', '/api/bookings', undefined, { cookie: cookies.staff })).status, 401);
    const admin = lista.find(u => u.email === correo('admin'));
    assert.equal((await s.pedir('PATCH', `/api/admin/usuarios/${admin.id}`, { role: 'owner' }, { cookie: cookies.admin })).status, 403, 'un administrador no se nombra propietario');

    const yo = lista.find(u => u.email === s.correo);
    assert.equal((await s.pedir('PATCH', `/api/admin/usuarios/${yo.id}`, { role: 'admin' })).status, 400, 'siempre queda un propietario');
    assert.equal((await s.pedir('PATCH', `/api/admin/usuarios/${staff.id}`, { role: 'staff' }, { cookie: (await registrar(s)).cookie })).status, 404, 'otra barbería no ve a estos usuarios');
  });

  test('una persona con dos barberías elige a cuál entra y solo ve esa', async () => {
    const { datos, r } = await registrar(s);
    await crearCuenta(s.negocio, datos.email, CLAVE, 'staff');
    const sin = await s.pedir('POST', '/api/auth/login', { email: datos.email, password: CLAVE }, { cookie: null });
    assert.equal(sin.status, 409);
    assert.equal(sin.json.businesses.length, 2);
    const enA = cookieDe(await s.pedir('POST', '/api/auth/login', { email: datos.email, password: CLAVE, businessId: s.negocio }, { cookie: null }));
    const enB = cookieDe(await s.pedir('POST', '/api/auth/login', { email: datos.email, password: CLAVE, businessId: r.json.business.id }, { cookie: null }));
    assert.equal((await s.pedir('GET', '/api/auth/sesion', undefined, { cookie: enA })).json.role, 'staff');
    assert.equal((await s.pedir('GET', '/api/auth/sesion', undefined, { cookie: enB })).json.role, 'owner');
    assert.equal((await s.pedir('GET', '/api/admin/backup', undefined, { cookie: enA })).status, 403, 'en A solo tiene permisos de recepción');
    assert.equal((await s.pedir('GET', '/api/admin/backup', undefined, { cookie: enB })).status, 200);
  });
});

test('límite de intentos por IP en el inicio de sesión', { skip: omitir }, async () => {
  const s = await iniciarServidor({ postgres: true, env: { AUTH_LIMITE_IP: '5' }, sesion: false });
  try {
    const estados = [];
    for (let i = 0; i < 7; i++) {
      estados.push((await s.pedir('POST', '/api/auth/login', { email: `x${i}@prueba.test`, password: 'cualquier-cosa-1' })).status);
    }
    assert.deepEqual(estados, [401, 401, 401, 401, 401, 429, 429]);
  } finally {
    await s.detener();
    s.borrar();
  }
});

test('El Máster: el script de consola crea al propietario y este ve los datos existentes', { skip: omitir }, async () => {
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  const path = require('node:path');
  const s = await iniciarServidor({ postgres: true, sesion: false });
  try {
    const reserva = await s.pedir('POST', '/api/bookings', { name: 'Cliente Existente', phone: '0990009300', barberId: 'master', serviceIds: ['corte'], date: proximoDia(5), time: '11:00' });
    assert.equal(reserva.status, 201);
    assert.equal((await s.pedir('GET', '/api/bookings')).status, 401, 'sin propietario el panel está cerrado');

    const correo = `dueno-${s.negocio}@prueba.test`;
    const salida = await promisify(execFile)(process.execPath,
      [path.join(__dirname, '..', 'scripts', 'cuentas', 'crear-propietario.js'), '--negocio', s.negocio, '--email', correo, '--nombre', 'Dueño'],
      { env: { PATH: process.env.PATH, DATABASE_URL: URL_PG, PUBLIC_BASE_URL: 'https://reservas.example' } });
    const token = salida.stdout.match(/https:\/\/reservas\.example\/acceso\.html#restablecer=([A-Za-z0-9_-]+)/)[1];
    assert.equal((await s.pedir('POST', '/api/auth/restablecer', { token, password: CLAVE })).status, 200);
    const cookie = cookieDe(await s.pedir('POST', '/api/auth/login', { email: correo, password: CLAVE }));
    const sesion = (await s.pedir('GET', '/api/auth/sesion', undefined, { cookie })).json;
    assert.equal(sesion.role, 'owner');
    assert.equal(sesion.business.id, s.negocio);
    assert.ok((await s.pedir('GET', '/api/bookings', undefined, { cookie })).json.some(b => b.id === reserva.json.booking.id));
  } finally {
    await s.detener();
    s.borrar();
  }
});
