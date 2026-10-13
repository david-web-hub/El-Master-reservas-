'use strict';
/* =========================================================
   CUENTAS, SESIONES Y PERMISOS

   - Contraseñas: scrypt con sal aleatoria (nunca se guardan).
   - Sesiones: identificador aleatorio de 256 bits en una cookie
     HttpOnly; en la base solo se guarda su resumen SHA-256.
   - Recuperación: enlace de un solo uso, válido 1 hora, que
     también se guarda solo como resumen.
   - Cada sesión pertenece a UNA barbería: la barbería de cada
     petición sale de la sesión, nunca de lo que envíe el navegador.
   - Bloqueo temporal de la cuenta tras varios intentos fallidos.
========================================================= */
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

const ROLES = ['owner', 'admin', 'staff', 'barber'];

/* Permisos de cada rol. "*" = todos. */
const PERMISOS_ROL = {
  owner: ['*'],
  admin: ['panel', 'reservas', 'caja', 'productos', 'productos.ver', 'clientes', 'informes', 'configuracion', 'respaldo', 'usuarios.ver'],
  staff: ['panel', 'reservas', 'caja', 'productos.ver', 'clientes'],
  barber: ['panel', 'reservas.propias']
};

const NOMBRES_ROL = { owner: 'Propietario', admin: 'Administrador', staff: 'Recepción y caja', barber: 'Barbero' };

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const CLAVE_MIN = 10;
const CLAVE_MAX = 200;
const CORREO = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
const CLAVES_COMUNES = new Set(['1234567890', '0123456789', 'contraseña', 'contrasena', 'password12', 'password123', 'qwertyuiop', 'barberia123', 'elmaster123', 'administrador']);

class ErrorAuth extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const resumen = valor => crypto.createHash('sha256').update(String(valor)).digest('hex');
const tokenAleatorio = () => crypto.randomBytes(32).toString('base64url');
const nuevoId = () => 'usr_' + crypto.randomBytes(12).toString('hex');

function normalizarCorreo(email) {
  return String(email || '').trim().toLowerCase();
}

function validarCorreo(email) {
  const e = normalizarCorreo(email);
  if (!CORREO.test(e) || e.length > 254) throw new ErrorAuth(400, 'CORREO_INVALIDO', 'Escribe un correo válido');
  return e;
}

function validarClave(clave, { correo = '', nombre = '' } = {}) {
  const c = String(clave || '');
  if (c.length < CLAVE_MIN) throw new ErrorAuth(400, 'CLAVE_DEBIL', `La contraseña debe tener al menos ${CLAVE_MIN} caracteres`);
  if (c.length > CLAVE_MAX) throw new ErrorAuth(400, 'CLAVE_LARGA', 'La contraseña es demasiado larga');
  const baja = c.toLowerCase();
  if (new Set(c).size < 4 || CLAVES_COMUNES.has(baja) ||
      (correo && baja.includes(correo.split('@')[0])) ||
      (nombre && nombre.length >= 4 && baja.includes(nombre.toLowerCase()))) {
    throw new ErrorAuth(400, 'CLAVE_DEBIL', 'La contraseña es muy fácil de adivinar; usa una frase o combinación distinta');
  }
  return c;
}

async function cifrarClave(clave) {
  const sal = crypto.randomBytes(16);
  const hash = await scrypt(String(clave), sal, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, sal.toString('base64'), hash.toString('base64')].join('$');
}

async function claveCorrecta(clave, guardado) {
  const partes = String(guardado || '').split('$');
  if (partes.length !== 6 || partes[0] !== 'scrypt') return false;
  const [, N, r, p, sal, hash] = partes;
  const esperado = Buffer.from(hash, 'base64');
  const calculado = await scrypt(String(clave), Buffer.from(sal, 'base64'), esperado.length,
    { N: Number(N), r: Number(r), p: Number(p) });
  return crypto.timingSafeEqual(calculado, esperado);
}

/* Resumen falso para que una cuenta inexistente tarde lo mismo que una real. */
let resumenFalso = null;
async function compararFalso(clave) {
  if (!resumenFalso) resumenFalso = await cifrarClave(crypto.randomBytes(16).toString('hex'));
  await claveCorrecta(clave, resumenFalso);
  return false;
}

function permisosDe(rol) {
  return new Set(PERMISOS_ROL[rol] || []);
}

function tienePermiso(rol, permiso) {
  const p = permisosDe(rol);
  return p.has('*') || p.has(permiso);
}

/* =========================================================
   VERIFICACIÓN EN DOS PASOS (TOTP, RFC 6238)
   Compatible con Google Authenticator, Microsoft
   Authenticator, 1Password, etc. El secreto se guarda cifrado
   con AES-256-GCM; los códigos de recuperación, como resumen.
========================================================= */
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(buf) {
  let bits = 0;
  let valor = 0;
  let salida = '';
  for (const byte of buf) {
    valor = (valor << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      salida += BASE32[(valor >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) salida += BASE32[(valor << (5 - bits)) & 31];
  return salida;
}

function desdeBase32(texto) {
  const limpio = String(texto).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let valor = 0;
  const bytes = [];
  for (const c of limpio) {
    valor = (valor << 5) | BASE32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      bytes.push((valor >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function codigoTotp(secreto, paso) {
  const contador = Buffer.alloc(8);
  contador.writeBigUInt64BE(BigInt(paso));
  const h = crypto.createHmac('sha1', secreto).update(contador).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, '0');
}

/* Devuelve el paso de tiempo del código si es válido (±30 s de tolerancia); si no, null. */
function pasoTotpValido(secreto, codigo, ahora = Date.now()) {
  const c = String(codigo || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const actual = Math.floor(ahora / 30000);
  for (const d of [0, -1, 1]) {
    const esperado = Buffer.from(codigoTotp(secreto, actual + d));
    if (crypto.timingSafeEqual(esperado, Buffer.from(c))) return actual + d;
  }
  return null;
}

function cifrar(clave, datos) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', clave, iv);
  const enc = Buffer.concat([c.update(datos), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

function descifrar(clave, texto) {
  const [v, iv, tag, enc] = String(texto || '').split('.');
  if (v !== 'v1') throw new Error('Formato de secreto desconocido');
  const d = crypto.createDecipheriv('aes-256-gcm', clave, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]);
}

function codigoRecuperacion() {
  const t = crypto.randomBytes(5).toString('hex');
  return `${t.slice(0, 5)}-${t.slice(5)}`;
}

/* =========================================================
   LIMITADOR DE INTENTOS EN MEMORIA (por IP y acción)
========================================================= */
function crearLimitador({ maximo, ventanaMs }) {
  const marcas = new Map();
  return {
    permitir(clave) {
      const ahora = Date.now();
      const lista = (marcas.get(clave) || []).filter(t => ahora - t < ventanaMs);
      if (lista.length >= maximo) {
        marcas.set(clave, lista);
        return false;
      }
      lista.push(ahora);
      marcas.set(clave, lista);
      if (marcas.size > 50000) marcas.clear();
      return true;
    }
  };
}

/* =========================================================
   SERVICIO DE AUTENTICACIÓN
========================================================= */
function crearAutenticacion({
  pool,
  almacen,
  enviarCorreo,
  urlBase = () => '',
  duracionSesionMs = 14 * 24 * 3600 * 1000,
  maxIntentosCuenta = 10,
  bloqueoMs = 15 * 60 * 1000,
  limiteIp = 30,
  /* Exigir correo verificado a las cuentas creadas con el registro. */
  verificarCorreo = true,
  /* Clave de 32 bytes para cifrar los secretos de dos pasos; sin ella, la función no está disponible. */
  claveDosPasos = null,
  nombreServicio = 'Master Reservas',
  registro = console
}) {
  const limitador = crearLimitador({ maximo: limiteIp, ventanaMs: 15 * 60 * 1000 });

  async function evento(cliente, tipo, { userId = null, businessId = null, ip = null, detalle = {} } = {}) {
    await (cliente || pool).query(
      'INSERT INTO auth_events (user_id, business_id, type, ip, detail) VALUES ($1, $2, $3, $4, $5::jsonb)',
      [userId, businessId, tipo, ip, JSON.stringify(detalle)]).catch(e => registro.error('ERROR REGISTRANDO EVENTO DE SEGURIDAD:', e.message));
  }

  function limitar(accion, ip) {
    if (!limitador.permitir(`${accion}:${ip || '-'}`)) {
      throw new ErrorAuth(429, 'DEMASIADOS_INTENTOS', 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.');
    }
  }

  async function negociosDeUsuario(userId) {
    const r = await pool.query(
      `SELECT m.business_id AS id, b.name, b.slug, m.role
       FROM memberships m JOIN businesses b ON b.id = m.business_id
       WHERE m.user_id = $1 AND m.status = 'active' AND b.status <> 'suspended'
       ORDER BY m.created_at`, [userId]);
    return r.rows;
  }

  async function crearSesion(cliente, userId, businessId, { ip, userAgent } = {}) {
    const token = tokenAleatorio();
    await (cliente || pool).query(
      `INSERT INTO sessions (token_hash, user_id, business_id, expires_at, ip, user_agent)
       VALUES ($1, $2, $3, NOW() + ($4::text || ' milliseconds')::interval, $5, $6)`,
      [resumen(token), userId, businessId, String(duracionSesionMs), ip || null, String(userAgent || '').slice(0, 300)]);
    return token;
  }

  /* ---------------- REGISTRO ---------------- */
  async function registrar(datos = {}, { ip, userAgent } = {}) {
    limitar('registro', ip);
    const nombre = String(datos.name || '').trim().slice(0, 120);
    if (nombre.length < 2) throw new ErrorAuth(400, 'NOMBRE_REQUERIDO', 'Escribe tu nombre');
    const correo = validarCorreo(datos.email);
    const clave = validarClave(datos.password, { correo, nombre });
    const nombreNegocio = String(datos.businessName || '').trim().slice(0, 120);
    if (nombreNegocio.length < 2) throw new ErrorAuth(400, 'NEGOCIO_REQUERIDO', 'Escribe el nombre de tu barbería');
    const slug = String(datos.slug || nombreNegocio).toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
    if (slug.length < 3) throw new ErrorAuth(400, 'SLUG_INVALIDO', 'Elige una dirección de al menos 3 letras o números');

    const hash = await cifrarClave(clave);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['master-reservas:correo:' + correo]);
      const existe = await client.query('SELECT 1 FROM users WHERE lower(email) = $1', [correo]);
      if (existe.rowCount) {
        throw new ErrorAuth(409, 'CORREO_EXISTE', 'Ya existe una cuenta con ese correo. Inicia sesión o recupera tu contraseña.');
      }
      let negocio;
      try {
        negocio = await almacen.crearNegocio({
          id: slug, slug, name: nombreNegocio,
          country: datos.country, currency: datos.currency, locale: datos.locale, timezone: datos.timezone,
          plan: datos.plan, contactEmail: correo, contactPhone: datos.phone,
          trialEndsAt: new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString()
        }, { client });
      } catch (error) {
        if (error.code === 'NEGOCIO_EXISTE') throw new ErrorAuth(409, 'SLUG_EXISTE', 'Esa dirección ya está en uso; elige otra.');
        if (error.code === 'SLUG_INVALIDO' || error.code === 'NEGOCIO_INVALIDO') throw new ErrorAuth(400, 'SLUG_INVALIDO', 'Elige otra dirección para tu barbería');
        throw error;
      }
      const userId = nuevoId();
      await client.query(
        `INSERT INTO users (id, email, name, password_hash, password_changed_at, email_verified_at)
         VALUES ($1, $2, $3, $4, NOW(), $5)`,
        [userId, correo, nombre, hash, verificarCorreo ? null : new Date()]);
      await client.query(
        `INSERT INTO memberships (user_id, business_id, role) VALUES ($1, $2, 'owner')`, [userId, negocio.id]);
      /* Con verificación: no se abre sesión hasta confirmar el correo. */
      const token = verificarCorreo ? null : await crearSesion(client, userId, negocio.id, { ip, userAgent });
      const tokenVerificacion = verificarCorreo ? await crearVerificacion(client, userId) : null;
      await evento(client, 'registro', { userId, businessId: negocio.id, ip });
      await client.query('COMMIT');
      await almacen.cargarNegocio(negocio.id);
      if (tokenVerificacion) await enviarVerificacion(correo, nombre, tokenVerificacion);
      return {
        token,
        verificacionPendiente: Boolean(tokenVerificacion),
        usuario: { id: userId, email: correo, name: nombre },
        negocio,
        rol: 'owner'
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /* ---------------- INICIO DE SESIÓN ---------------- */
  async function iniciarSesion({ email, password, businessId } = {}, { ip, userAgent } = {}) {
    limitar('login', ip);
    const correo = normalizarCorreo(email);
    const clave = String(password || '');
    const generico = new ErrorAuth(401, 'CREDENCIALES', 'Correo o contraseña incorrectos');
    if (!correo || !clave || clave.length > CLAVE_MAX) {
      await compararFalso(clave);
      throw generico;
    }
    const r = await pool.query('SELECT * FROM users WHERE lower(email) = $1', [correo]);
    const u = r.rows[0];
    if (!u || !u.password_hash) {
      await compararFalso(clave);
      await evento(null, 'login_fallido', { ip, detalle: { motivo: 'cuenta' } });
      throw generico;
    }
    if (u.locked_until && new Date(u.locked_until) > new Date()) {
      await evento(null, 'login_bloqueado', { userId: u.id, ip });
      throw new ErrorAuth(429, 'CUENTA_BLOQUEADA', 'Demasiados intentos fallidos. Espera unos minutos o recupera tu contraseña.');
    }
    if (!(await claveCorrecta(clave, u.password_hash)) || u.status !== 'active') {
      const fallos = u.failed_attempts + 1;
      await pool.query(
        `UPDATE users SET failed_attempts = $2::int,
                locked_until = CASE WHEN $2::int >= $3::int
                                    THEN NOW() + ($4::text || ' milliseconds')::interval
                                    ELSE locked_until END
         WHERE id = $1`, [u.id, fallos, maxIntentosCuenta, String(bloqueoMs)]);
      await evento(null, 'login_fallido', { userId: u.id, ip, detalle: { fallos } });
      throw generico;
    }
    /* Solo después de comprobar la contraseña: no revela qué correos existen. */
    if (verificarCorreo && !u.email_verified_at) {
      await evento(null, 'login_sin_verificar', { userId: u.id, ip });
      throw new ErrorAuth(403, 'CORREO_NO_VERIFICADO', 'Confirma tu correo para entrar. Revisa tu bandeja o pide un nuevo enlace.');
    }
    const negocios = await negociosDeUsuario(u.id);
    if (!negocios.length) throw new ErrorAuth(403, 'SIN_BARBERIA', 'Tu cuenta no tiene acceso a ninguna barbería activa');
    let elegido = negocios[0];
    if (businessId) {
      elegido = negocios.find(n => n.id === businessId || n.slug === businessId);
      if (!elegido) throw new ErrorAuth(403, 'SIN_ACCESO', 'No tienes acceso a esa barbería');
    } else if (negocios.length > 1) {
      throw Object.assign(new ErrorAuth(409, 'ELEGIR_BARBERIA', 'Elige la barbería a la que quieres entrar'),
        { negocios: negocios.map(n => ({ id: n.id, name: n.name })) });
    }
    await pool.query('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [u.id]);
    /* Verificación en dos pasos activada: falta el código. */
    if (u.totp_enabled_at) {
      const desafio = tokenAleatorio();
      await pool.query(
        `INSERT INTO login_challenges (token_hash, user_id, business_id, expires_at)
         VALUES ($1, $2, $3, NOW() + interval '5 minutes')`, [resumen(desafio), u.id, elegido.id]);
      await evento(null, 'login_paso1', { userId: u.id, businessId: elegido.id, ip });
      return { requiereDosPasos: true, desafio };
    }
    return completarInicio(u, elegido, { ip, userAgent });
  }

  async function completarInicio(u, elegido, { ip, userAgent } = {}) {
    await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [u.id]);
    await almacen.cargarNegocio(elegido.id);
    const token = await crearSesion(null, u.id, elegido.id, { ip, userAgent });
    await evento(null, 'login', { userId: u.id, businessId: elegido.id, ip });
    return { token, usuario: { id: u.id, email: u.email, name: u.name }, negocio: { id: elegido.id, name: elegido.name }, rol: elegido.role };
  }

  /* Sesión válida + pertenencia vigente. Devuelve null si no hay sesión. */
  async function leerSesion(token) {
    if (!token || typeof token !== 'string' || token.length > 100) return null;
    const r = await pool.query(
      `SELECT s.token_hash, s.user_id, s.business_id, s.last_seen_at, u.email, u.name, u.totp_enabled_at,
              m.role, m.barber_id, b.name AS business_name, b.status AS business_status
       FROM sessions s
       JOIN users u ON u.id = s.user_id AND u.status = 'active'
       JOIN memberships m ON m.user_id = s.user_id AND m.business_id = s.business_id AND m.status = 'active'
       JOIN businesses b ON b.id = s.business_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > NOW()`,
      [resumen(token)]);
    const s = r.rows[0];
    if (!s || s.business_status === 'suspended') return null;
    if (Date.now() - new Date(s.last_seen_at).getTime() > 5 * 60 * 1000) {
      pool.query('UPDATE sessions SET last_seen_at = NOW() WHERE token_hash = $1', [s.token_hash]).catch(() => {});
    }
    return {
      usuario: { id: s.user_id, email: s.email, name: s.name },
      negocio: { id: s.business_id, name: s.business_name },
      rol: s.role,
      barberId: s.barber_id || null,
      dosPasos: Boolean(s.totp_enabled_at)
    };
  }

  async function cerrarSesion(token, { ip } = {}) {
    if (!token) return;
    const r = await pool.query(
      'UPDATE sessions SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL RETURNING user_id, business_id',
      [resumen(token)]);
    if (r.rowCount) await evento(null, 'logout', { userId: r.rows[0].user_id, businessId: r.rows[0].business_id, ip });
  }

  /* ---------------- RECUPERACIÓN ---------------- */
  async function solicitarRecuperacion(email, { ip } = {}) {
    limitar('recuperar', ip);
    const correo = normalizarCorreo(email);
    if (!CORREO.test(correo)) return;
    const r = await pool.query(`SELECT id, email, name FROM users WHERE lower(email) = $1 AND status = 'active'`, [correo]);
    const u = r.rows[0];
    /* Respuesta idéntica exista o no la cuenta (no revela qué correos están registrados). */
    if (!u) {
      await evento(null, 'recuperacion_sin_cuenta', { ip });
      return;
    }
    const token = tokenAleatorio();
    await pool.query(
      `UPDATE password_resets SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`, [u.id]);
    await pool.query(
      `INSERT INTO password_resets (token_hash, user_id, expires_at, ip) VALUES ($1, $2, NOW() + interval '1 hour', $3)`,
      [resumen(token), u.id, ip || null]);
    await evento(null, 'recuperacion_solicitada', { userId: u.id, ip });
    const enlace = `${urlBase()}/acceso.html#restablecer=${token}`;
    await enviarCorreo({
      para: u.email,
      asunto: 'Restablece tu contraseña de Master Reservas',
      texto: `Hola ${u.name || ''}:\n\nPara crear una nueva contraseña abre este enlace (válido 1 hora, un solo uso):\n${enlace}\n\nSi no lo pediste, ignora este mensaje: tu contraseña no cambia.`,
      enlace
    });
  }

  async function restablecerClave(token, nuevaClave, { ip } = {}) {
    limitar('restablecer', ip);
    const r = await pool.query(
      `SELECT p.user_id, u.email, u.name FROM password_resets p JOIN users u ON u.id = p.user_id
       WHERE p.token_hash = $1 AND p.used_at IS NULL AND p.expires_at > NOW()`,
      [resumen(String(token || ''))]);
    const fila = r.rows[0];
    if (!fila) throw new ErrorAuth(400, 'ENLACE_INVALIDO', 'El enlace no es válido o ya venció. Pide uno nuevo.');
    const clave = validarClave(nuevaClave, { correo: fila.email, nombre: fila.name });
    const hash = await cifrarClave(clave);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const usado = await client.query(
        'UPDATE password_resets SET used_at = NOW() WHERE token_hash = $1 AND used_at IS NULL', [resumen(String(token))]);
      if (!usado.rowCount) throw new ErrorAuth(400, 'ENLACE_INVALIDO', 'El enlace ya se utilizó');
      await client.query(
        `UPDATE users SET password_hash = $2, password_changed_at = NOW(), failed_attempts = 0, locked_until = NULL,
                email_verified_at = COALESCE(email_verified_at, NOW()), updated_at = NOW() WHERE id = $1`, [fila.user_id, hash]);
      /* Cierra todas las sesiones abiertas con la contraseña anterior. */
      await client.query('UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [fila.user_id]);
      await evento(client, 'clave_restablecida', { userId: fila.user_id, ip });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function cambiarClave(sesion, actual, nueva, tokenActual, { ip } = {}) {
    limitar('cambiar-clave', ip);
    const r = await pool.query('SELECT password_hash, email, name FROM users WHERE id = $1', [sesion.usuario.id]);
    const u = r.rows[0];
    if (!u || !(await claveCorrecta(String(actual || ''), u.password_hash))) {
      throw new ErrorAuth(400, 'CLAVE_ACTUAL', 'La contraseña actual no es correcta');
    }
    const hash = await cifrarClave(validarClave(nueva, { correo: u.email, nombre: u.name }));
    await pool.query('UPDATE users SET password_hash = $2, password_changed_at = NOW(), updated_at = NOW() WHERE id = $1',
      [sesion.usuario.id, hash]);
    await pool.query('UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND token_hash <> $2 AND revoked_at IS NULL',
      [sesion.usuario.id, resumen(tokenActual)]);
    await evento(null, 'clave_cambiada', { userId: sesion.usuario.id, businessId: sesion.negocio.id, ip });
  }

  /* ---------------- VERIFICACIÓN DE CORREO ---------------- */
  async function crearVerificacion(cliente, userId) {
    const token = tokenAleatorio();
    await cliente.query('UPDATE email_verifications SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL', [userId]);
    await cliente.query(
      `INSERT INTO email_verifications (token_hash, user_id, expires_at) VALUES ($1, $2, NOW() + interval '24 hours')`,
      [resumen(token), userId]);
    return token;
  }

  async function enviarVerificacion(correo, nombre, token) {
    const enlace = `${urlBase()}/acceso.html#verificar=${token}`;
    await enviarCorreo({
      para: correo,
      asunto: 'Confirma tu correo en Master Reservas',
      texto: `Hola ${nombre || ''}:\n\nConfirma tu correo para activar tu cuenta (enlace válido 24 horas):\n${enlace}\n\nSi no creaste esta cuenta, ignora este mensaje.`,
      enlace
    });
  }

  async function confirmarCorreo(token, { ip } = {}) {
    limitar('verificar', ip);
    const r = await pool.query(
      `UPDATE email_verifications SET used_at = NOW()
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW() RETURNING user_id`,
      [resumen(String(token || ''))]);
    if (!r.rowCount) throw new ErrorAuth(400, 'ENLACE_INVALIDO', 'El enlace no es válido o ya venció. Pide uno nuevo.');
    await pool.query('UPDATE users SET email_verified_at = COALESCE(email_verified_at, NOW()), updated_at = NOW() WHERE id = $1', [r.rows[0].user_id]);
    await evento(null, 'correo_verificado', { userId: r.rows[0].user_id, ip });
  }

  /* Misma respuesta exista o no la cuenta. */
  async function reenviarVerificacion(email, { ip } = {}) {
    limitar('reenviar-verificacion', ip);
    const correo = normalizarCorreo(email);
    if (!CORREO.test(correo)) return;
    const u = (await pool.query(
      `SELECT id, email, name FROM users WHERE lower(email) = $1 AND email_verified_at IS NULL AND status = 'active'`,
      [correo])).rows[0];
    if (!u) return;
    const token = await crearVerificacion(pool, u.id);
    await enviarVerificacion(u.email, u.name, token);
    await evento(null, 'verificacion_reenviada', { userId: u.id, ip });
  }

  /* ---------------- VERIFICACIÓN EN DOS PASOS ---------------- */
  function exigirDosPasosDisponible() {
    if (!claveDosPasos) {
      throw new ErrorAuth(503, 'DOS_PASOS_NO_DISPONIBLE', 'La verificación en dos pasos todavía no está habilitada en este servidor');
    }
  }

  async function estadoDosPasos(sesion) {
    const u = (await pool.query('SELECT totp_enabled_at FROM users WHERE id = $1', [sesion.usuario.id])).rows[0];
    const r = await pool.query(
      'SELECT count(*)::int AS n FROM totp_recovery_codes WHERE user_id = $1 AND used_at IS NULL', [sesion.usuario.id]);
    return { available: Boolean(claveDosPasos), enabled: Boolean(u?.totp_enabled_at), recoveryCodesLeft: r.rows[0].n };
  }

  async function iniciarDosPasos(sesion, { ip } = {}) {
    exigirDosPasosDisponible();
    limitar('dos-pasos', ip);
    const u = (await pool.query('SELECT email, totp_enabled_at FROM users WHERE id = $1', [sesion.usuario.id])).rows[0];
    if (u.totp_enabled_at) throw new ErrorAuth(409, 'DOS_PASOS_ACTIVO', 'La verificación en dos pasos ya está activada');
    const secreto = crypto.randomBytes(20);
    await pool.query('UPDATE users SET totp_pending_secret = $2 WHERE id = $1', [sesion.usuario.id, cifrar(claveDosPasos, secreto)]);
    const clave = base32(secreto);
    const etiqueta = encodeURIComponent(`${nombreServicio}:${u.email}`);
    return {
      secret: clave,
      otpauthUrl: `otpauth://totp/${etiqueta}?secret=${clave}&issuer=${encodeURIComponent(nombreServicio)}&algorithm=SHA1&digits=6&period=30`
    };
  }

  async function activarDosPasos(sesion, codigo, { ip } = {}) {
    exigirDosPasosDisponible();
    limitar('dos-pasos', ip);
    const u = (await pool.query('SELECT totp_pending_secret, totp_enabled_at FROM users WHERE id = $1', [sesion.usuario.id])).rows[0];
    if (u.totp_enabled_at) throw new ErrorAuth(409, 'DOS_PASOS_ACTIVO', 'La verificación en dos pasos ya está activada');
    if (!u.totp_pending_secret) throw new ErrorAuth(400, 'SIN_CONFIGURAR', 'Primero genera la clave para tu aplicación');
    const secreto = descifrar(claveDosPasos, u.totp_pending_secret);
    const paso = pasoTotpValido(secreto, codigo);
    if (paso === null) throw new ErrorAuth(400, 'CODIGO_INVALIDO', 'El código no es correcto. Revisa la hora del teléfono e inténtalo de nuevo.');
    const codigos = Array.from({ length: 10 }, codigoRecuperacion);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE users SET totp_secret = totp_pending_secret, totp_pending_secret = NULL, totp_enabled_at = NOW(),
                totp_last_step = $2, updated_at = NOW() WHERE id = $1`, [sesion.usuario.id, paso]);
      await client.query('DELETE FROM totp_recovery_codes WHERE user_id = $1', [sesion.usuario.id]);
      for (const c of codigos) {
        await client.query('INSERT INTO totp_recovery_codes (code_hash, user_id) VALUES ($1, $2)', [resumen(c), sesion.usuario.id]);
      }
      await evento(client, 'dos_pasos_activado', { userId: sesion.usuario.id, businessId: sesion.negocio.id, ip });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    return { recoveryCodes: codigos };
  }

  /* Comprueba un código de la aplicación o un código de recuperación (este último, de un solo uso). */
  async function codigoDosPasosCorrecto(userId, codigo) {
    const u = (await pool.query('SELECT totp_secret, totp_last_step FROM users WHERE id = $1', [userId])).rows[0];
    if (!u?.totp_secret) return false;
    const limpio = String(codigo || '').trim().toLowerCase();
    if (/^[0-9a-f]{5}-[0-9a-f]{5}$/.test(limpio)) {
      const r = await pool.query(
        'UPDATE totp_recovery_codes SET used_at = NOW() WHERE code_hash = $1 AND user_id = $2 AND used_at IS NULL',
        [resumen(limpio), userId]);
      return r.rowCount === 1;
    }
    const paso = pasoTotpValido(descifrar(claveDosPasos, u.totp_secret), limpio);
    if (paso === null) return false;
    /* Un código ya usado no sirve otra vez (evita reutilizarlo si alguien lo ve). */
    const r = await pool.query(
      `UPDATE users SET totp_last_step = $2 WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)`,
      [userId, paso]);
    return r.rowCount === 1;
  }

  async function completarDosPasos(desafio, codigo, { ip, userAgent } = {}) {
    exigirDosPasosDisponible();
    limitar('dos-pasos', ip);
    const fila = (await pool.query(
      `UPDATE login_challenges SET attempts = attempts + 1
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW() AND attempts < 5
       RETURNING user_id, business_id`, [resumen(String(desafio || ''))])).rows[0];
    if (!fila) throw new ErrorAuth(401, 'DESAFIO_INVALIDO', 'El paso de verificación venció. Inicia sesión otra vez.');
    if (!(await codigoDosPasosCorrecto(fila.user_id, codigo))) {
      await evento(null, 'dos_pasos_fallido', { userId: fila.user_id, ip });
      throw new ErrorAuth(401, 'CODIGO_INVALIDO', 'El código no es correcto');
    }
    await pool.query('UPDATE login_challenges SET used_at = NOW() WHERE token_hash = $1', [resumen(String(desafio))]);
    const u = (await pool.query('SELECT * FROM users WHERE id = $1 AND status = \'active\'', [fila.user_id])).rows[0];
    const elegido = (await negociosDeUsuario(fila.user_id)).find(n => n.id === fila.business_id);
    if (!u || !elegido) throw new ErrorAuth(403, 'SIN_ACCESO', 'No tienes acceso a esa barbería');
    return completarInicio(u, elegido, { ip, userAgent });
  }

  async function desactivarDosPasos(sesion, clave, codigo, { ip } = {}) {
    exigirDosPasosDisponible();
    limitar('dos-pasos', ip);
    const u = (await pool.query('SELECT password_hash, totp_enabled_at FROM users WHERE id = $1', [sesion.usuario.id])).rows[0];
    if (!u.totp_enabled_at) throw new ErrorAuth(409, 'DOS_PASOS_INACTIVO', 'La verificación en dos pasos no está activada');
    if (!(await claveCorrecta(String(clave || ''), u.password_hash))) throw new ErrorAuth(400, 'CLAVE_ACTUAL', 'La contraseña no es correcta');
    if (!(await codigoDosPasosCorrecto(sesion.usuario.id, codigo))) throw new ErrorAuth(400, 'CODIGO_INVALIDO', 'El código no es correcto');
    await pool.query(
      `UPDATE users SET totp_secret = NULL, totp_pending_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL,
              updated_at = NOW() WHERE id = $1`, [sesion.usuario.id]);
    await pool.query('DELETE FROM totp_recovery_codes WHERE user_id = $1', [sesion.usuario.id]);
    await evento(null, 'dos_pasos_desactivado', { userId: sesion.usuario.id, businessId: sesion.negocio.id, ip });
  }

  /* ---------------- USUARIOS DE LA BARBERÍA ---------------- */
  async function listarUsuarios(businessId) {
    const r = await pool.query(
      `SELECT u.id, u.email, u.name, m.role, m.barber_id, m.status, m.created_at, u.last_login_at
       FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.business_id = $1 ORDER BY m.created_at`, [businessId]);
    return r.rows.map(x => ({
      id: x.id, email: x.email, name: x.name, role: x.role, roleName: NOMBRES_ROL[x.role],
      barberId: x.barber_id, status: x.status, createdAt: x.created_at, lastLoginAt: x.last_login_at
    }));
  }

  function validarRol(role, barberId, db) {
    if (!ROLES.includes(role)) throw new ErrorAuth(400, 'ROL_INVALIDO', 'Rol no válido');
    if (role === 'barber') {
      if (!barberId || !(db.barbers || []).some(b => b.id === barberId)) {
        throw new ErrorAuth(400, 'BARBERO_REQUERIDO', 'Elige el barbero al que pertenece esta cuenta');
      }
    }
  }

  /*
    Agrega a una persona a la barbería. Si no tiene cuenta, se crea sin
    contraseña y recibe un enlace para crearla (el mismo de recuperación).
  */
  async function agregarUsuario(sesion, datos = {}, db, { ip } = {}) {
    const correo = validarCorreo(datos.email);
    const nombre = String(datos.name || '').trim().slice(0, 120);
    const rol = String(datos.role || '');
    const barberId = datos.barberId ? String(datos.barberId) : null;
    validarRol(rol, barberId, db);
    if (rol === 'owner' && sesion.rol !== 'owner') throw new ErrorAuth(403, 'SIN_PERMISO', 'Solo un propietario puede agregar propietarios');
    const client = await pool.connect();
    let creado = false;
    let userId;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['master-reservas:correo:' + correo]);
      const ex = await client.query('SELECT id FROM users WHERE lower(email) = $1', [correo]);
      if (ex.rowCount) {
        userId = ex.rows[0].id;
      } else {
        userId = nuevoId();
        creado = true;
        await client.query('INSERT INTO users (id, email, name) VALUES ($1, $2, $3)', [userId, correo, nombre]);
      }
      const m = await client.query(
        `INSERT INTO memberships (user_id, business_id, role, barber_id) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, business_id) DO NOTHING`, [userId, sesion.negocio.id, rol, barberId]);
      if (!m.rowCount) throw new ErrorAuth(409, 'YA_ES_MIEMBRO', 'Esa persona ya tiene acceso a esta barbería');
      await evento(client, 'usuario_agregado', { userId: sesion.usuario.id, businessId: sesion.negocio.id, ip, detalle: { nuevo: userId, rol } });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    if (creado) await solicitarRecuperacionInterna(userId);
    return (await listarUsuarios(sesion.negocio.id)).find(u => u.id === userId);
  }

  async function solicitarRecuperacionInterna(userId) {
    const u = (await pool.query('SELECT email FROM users WHERE id = $1', [userId])).rows[0];
    if (u) await solicitarRecuperacion(u.email, { ip: 'interno:' + userId });
  }

  async function propietariosActivos(cliente, businessId) {
    const r = await cliente.query(
      `SELECT count(*)::int AS n FROM memberships WHERE business_id = $1 AND role = 'owner' AND status = 'active'`, [businessId]);
    return r.rows[0].n;
  }

  async function modificarUsuario(sesion, userId, cambios = {}, db, { ip } = {}) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['master-reservas:miembros:' + sesion.negocio.id]);
      const actual = (await client.query(
        'SELECT * FROM memberships WHERE user_id = $1 AND business_id = $2 FOR UPDATE', [String(userId), sesion.negocio.id])).rows[0];
      if (!actual) throw new ErrorAuth(404, 'NO_ENCONTRADO', 'Usuario no encontrado en esta barbería');
      const rol = cambios.role !== undefined ? String(cambios.role) : actual.role;
      const barberId = cambios.barberId !== undefined ? (cambios.barberId ? String(cambios.barberId) : null) : actual.barber_id;
      const estado = cambios.status !== undefined ? String(cambios.status) : actual.status;
      if (!['active', 'disabled'].includes(estado)) throw new ErrorAuth(400, 'ESTADO_INVALIDO', 'Estado no válido');
      validarRol(rol, barberId, db);
      if ((rol === 'owner' || actual.role === 'owner') && sesion.rol !== 'owner') {
        throw new ErrorAuth(403, 'SIN_PERMISO', 'Solo un propietario puede cambiar a otro propietario');
      }
      await client.query(
        `UPDATE memberships SET role = $3, barber_id = $4, status = $5, updated_at = NOW()
         WHERE user_id = $1 AND business_id = $2`, [actual.user_id, sesion.negocio.id, rol, rol === 'barber' ? barberId : null, estado]);
      if (await propietariosActivos(client, sesion.negocio.id) < 1) {
        throw new ErrorAuth(400, 'ULTIMO_PROPIETARIO', 'La barbería debe conservar al menos un propietario activo');
      }
      if (estado !== 'active' || rol !== actual.role) {
        await client.query('UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND business_id = $2 AND revoked_at IS NULL',
          [actual.user_id, sesion.negocio.id]);
      }
      await evento(client, 'usuario_modificado', { userId: sesion.usuario.id, businessId: sesion.negocio.id, ip, detalle: { usuario: actual.user_id, rol, estado } });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    return (await listarUsuarios(sesion.negocio.id)).find(u => u.id === String(userId));
  }

  /* Primera cuenta de una barbería existente (por ejemplo, El Máster). Solo desde la línea de comandos. */
  async function crearPropietario(businessId, { email, name }) {
    const correo = validarCorreo(email);
    const existe = await pool.query('SELECT 1 FROM businesses WHERE id = $1', [businessId]);
    if (!existe.rowCount) throw new ErrorAuth(404, 'NEGOCIO', `La barbería "${businessId}" no existe`);
    const client = await pool.connect();
    let userId;
    try {
      await client.query('BEGIN');
      const ex = await client.query('SELECT id FROM users WHERE lower(email) = $1', [correo]);
      userId = ex.rowCount ? ex.rows[0].id : nuevoId();
      if (!ex.rowCount) await client.query('INSERT INTO users (id, email, name) VALUES ($1, $2, $3)', [userId, correo, String(name || '').slice(0, 120)]);
      await client.query(
        `INSERT INTO memberships (user_id, business_id, role) VALUES ($1, $2, 'owner')
         ON CONFLICT (user_id, business_id) DO UPDATE SET role = 'owner', status = 'active', updated_at = NOW()`,
        [userId, businessId]);
      await evento(client, 'propietario_creado', { userId, businessId, ip: 'consola' });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    const token = tokenAleatorio();
    await pool.query(
      `INSERT INTO password_resets (token_hash, user_id, expires_at, ip) VALUES ($1, $2, NOW() + interval '24 hours', 'consola')`,
      [resumen(token), userId]);
    return { userId, token };
  }

  return {
    registrar,
    iniciarSesion,
    confirmarCorreo,
    reenviarVerificacion,
    estadoDosPasos,
    iniciarDosPasos,
    activarDosPasos,
    completarDosPasos,
    desactivarDosPasos,
    disponibleDosPasos: () => Boolean(claveDosPasos),
    leerSesion,
    cerrarSesion,
    solicitarRecuperacion,
    restablecerClave,
    cambiarClave,
    listarUsuarios,
    agregarUsuario,
    modificarUsuario,
    crearPropietario,
    negociosDeUsuario
  };
}

module.exports = {
  crearAutenticacion,
  codigoTotp,
  desdeBase32,
  ErrorAuth,
  tienePermiso,
  permisosDe,
  cifrarClave,
  claveCorrecta,
  validarClave,
  PERMISOS_ROL,
  NOMBRES_ROL,
  ROLES
};
