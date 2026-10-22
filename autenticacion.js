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
  nombreServicio = 'MF Plux',
  /* Catálogo de planes del Panel Maestro (nombre, días de prueba); vacío si aún no se sincronizó. */
  catalogoPlanes = async () => [],
  /* Días de prueba si el catálogo todavía no llegó (el del Panel Maestro: 7). */
  diasPruebaPorDefecto = 7,
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
       WHERE m.user_id = $1 AND m.status = 'active' AND (b.status <> 'suspended' OR b.protected)
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
    /* Tipo de negocio elegido en «Crear mi cuenta». Sin tipo (enlaces anteriores): barbería. */
    const tipo = datos.businessType === undefined || datos.businessType === null || datos.businessType === '' ? 'barberia' : datos.businessType;
    if (!['barberia', 'salon'].includes(tipo)) throw new ErrorAuth(400, 'TIPO_INVALIDO', 'Elige si tu negocio es una barbería o un salón de belleza');
    const suNegocio = tipo === 'salon' ? 'tu salón' : 'tu barbería';
    const nombreNegocio = String(datos.businessName || '').trim().slice(0, 120);
    if (nombreNegocio.length < 2) throw new ErrorAuth(400, 'NEGOCIO_REQUERIDO', `Escribe el nombre de ${suNegocio}`);
    const slugPedido = Boolean(datos.slug);
    const slugBase = String(datos.slug || nombreNegocio).toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
    if (slugBase.length < 3) throw new ErrorAuth(400, 'SLUG_INVALIDO', 'Elige una dirección de al menos 3 letras o números');
    /* Dos barberías con el mismo nombre: la segunda recibe otra dirección (fade-zone-2, fade-zone-3…). */
    let slug = slugBase;
    if (!slugPedido) {
      const usadas = new Set((await pool.query(
        `SELECT slug FROM businesses WHERE slug = $1 OR slug LIKE $2`, [slugBase, slugBase + '-%'])).rows.map(r => r.slug));
      for (let n = 2; usadas.has(slug); n++) slug = `${slugBase}-${n}`;
    }
    /* Plan y días de prueba según el catálogo del Panel Maestro. */
    const planes = (await catalogoPlanes()).filter(p => p.active);
    const pedido = String(datos.plan || '').trim().toLowerCase();
    let plan = null;
    let diasPrueba = diasPruebaPorDefecto;
    if (planes.length) {
      plan = pedido ? planes.find(p => p.name.toLowerCase() === pedido) : planes[0];
      if (!plan) throw new ErrorAuth(400, 'PLAN_INVALIDO', 'El plan elegido no está disponible. Elige otro.');
      diasPrueba = plan.trialDays;
    }
    const nombrePlan = plan ? plan.name : (String(datos.plan || '').trim().slice(0, 60) || null);

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
          id: slug, slug, name: nombreNegocio, primerBarbero: nombre,
          country: datos.country, currency: datos.currency, locale: datos.locale, timezone: datos.timezone,
          plan: nombrePlan, contactEmail: correo, contactPhone: datos.phone, businessType: tipo,
          trialEndsAt: new Date(Date.now() + diasPrueba * 24 * 3600 * 1000).toISOString()
        }, { client });
      } catch (error) {
        if (error.code === 'NEGOCIO_EXISTE') throw new ErrorAuth(409, 'SLUG_EXISTE', 'Esa dirección ya está en uso; elige otra.');
        if (error.code === 'SLUG_INVALIDO' || error.code === 'NEGOCIO_INVALIDO') throw new ErrorAuth(400, 'SLUG_INVALIDO', `Elige otra dirección para ${suNegocio}`);
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
      const correoEnviado = tokenVerificacion
        ? await enviarVerificacion(correo, nombre, tokenVerificacion, negocio.name)
        : true;
      return {
        token,
        verificacionPendiente: Boolean(tokenVerificacion),
        correoEnviado,
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
              m.role, m.barber_id, b.name AS business_name, b.slug AS business_slug, b.status AS business_status, b.protected AS business_protected
       FROM sessions s
       JOIN users u ON u.id = s.user_id AND u.status = 'active'
       JOIN memberships m ON m.user_id = s.user_id AND m.business_id = s.business_id AND m.status = 'active'
       JOIN businesses b ON b.id = s.business_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > NOW()`,
      [resumen(token)]);
    const s = r.rows[0];
    if (!s || (s.business_status === 'suspended' && !s.business_protected)) return null;
    if (Date.now() - new Date(s.last_seen_at).getTime() > 5 * 60 * 1000) {
      pool.query('UPDATE sessions SET last_seen_at = NOW() WHERE token_hash = $1', [s.token_hash]).catch(() => {});
    }
    return {
      usuario: { id: s.user_id, email: s.email, name: s.name },
      negocio: { id: s.business_id, name: s.business_name, slug: s.business_slug },
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

  /*
    Revisa un enlace de un solo uso y explica por qué no sirve, si es el caso.
    Las filas se buscan solo por el resumen del código.
  */
  async function revisarEnlace(cliente, tabla, token, nombre) {
    const r = await (cliente || pool).query(
      `SELECT *, expires_at <= NOW() AS vencido FROM ${tabla} WHERE token_hash = $1 FOR UPDATE`,
      [resumen(String(token || ''))]);
    const fila = r.rows[0];
    if (!fila) throw new ErrorAuth(400, 'ENLACE_INVALIDO', `El enlace de ${nombre} no es válido. Revisa que esté completo o pide uno nuevo.`);
    if (fila.used_at) throw new ErrorAuth(400, 'ENLACE_USADO', `Este enlace de ${nombre} ya se usó. Si lo necesitas, pide uno nuevo.`);
    if (fila.vencido) throw new ErrorAuth(400, 'ENLACE_VENCIDO', `Este enlace de ${nombre} venció. Pide uno nuevo.`);
    return fila;
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
    const envio = await enviarCorreo({
      para: u.email,
      plantilla: 'recuperacion',
      datos: { nombre: u.name, enlace, vence: '1 hora' }
    });
    if (!envio.ok) await evento(null, 'correo_fallido', { userId: u.id, ip, detalle: { plantilla: 'recuperacion', error: envio.error } });
  }

  async function restablecerClave(token, nuevaClave, { ip } = {}) {
    limitar('restablecer', ip);
    const enlace = await revisarEnlace(null, 'password_resets', token, 'contraseña');
    const fila = (await pool.query('SELECT id AS user_id, email, name FROM users WHERE id = $1', [enlace.user_id])).rows[0];
    const clave = validarClave(nuevaClave, { correo: fila.email, nombre: fila.name });
    const hash = await cifrarClave(clave);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const usado = await client.query(
        'UPDATE password_resets SET used_at = NOW() WHERE token_hash = $1 AND used_at IS NULL', [resumen(String(token))]);
      if (!usado.rowCount) throw new ErrorAuth(400, 'ENLACE_USADO', 'Este enlace de contraseña ya se usó. Si lo necesitas, pide uno nuevo.');
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

  /* Devuelve true si el correo salió (o se mostró en modo demostración). */
  async function enviarVerificacion(correo, nombre, token, negocio) {
    const enlace = `${urlBase()}/acceso.html#verificar=${token}`;
    const envio = await enviarCorreo({
      para: correo,
      plantilla: 'confirmacion',
      datos: { nombre, negocio, enlace, vence: '24 horas' }
    });
    if (!envio.ok) await evento(null, 'correo_fallido', { detalle: { plantilla: 'confirmacion', error: envio.error } });
    return envio.ok;
  }

  async function confirmarCorreo(token, { ip } = {}) {
    limitar('verificar', ip);
    const client = await pool.connect();
    let userId;
    try {
      await client.query('BEGIN');
      const fila = await revisarEnlace(client, 'email_verifications', token, 'confirmación');
      userId = fila.user_id;
      await client.query('UPDATE email_verifications SET used_at = NOW() WHERE token_hash = $1', [fila.token_hash]);
      await client.query('UPDATE users SET email_verified_at = COALESCE(email_verified_at, NOW()), updated_at = NOW() WHERE id = $1', [userId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    await evento(null, 'correo_verificado', { userId, ip });
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
    await enviarVerificacion(u.email, u.name, token, null);
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

  /* ---------------- INVITACIONES ----------------
     Nadie obtiene acceso a una barbería sin aceptar expresamente:
     - Con el enlace del correo (un solo uso, 7 días): quien no tiene cuenta
       crea su contraseña; quien ya la tiene confirma con su contraseña (y su
       código de dos pasos si lo usa).
     - Desde «Mi cuenta», si ya inició sesión con ese mismo correo.
     La barbería puede reenviar o revocar mientras esté pendiente.
  */
  const DIAS_INVITACION = 7;
  const nuevoIdInvitacion = () => 'inv_' + crypto.randomBytes(10).toString('hex');

  function resumenInvitacion(x) {
    return {
      id: x.id, email: x.email, name: x.name, role: x.role, roleName: NOMBRES_ROL[x.role],
      barberId: x.barber_id, status: x.status, expiresAt: x.expires_at, createdAt: x.created_at,
      expired: new Date(x.expires_at) <= new Date()
    };
  }

  async function enviarInvitacion(inv, token, { cuentaExiste }) {
    const datos = (await pool.query(
      `SELECT b.name AS negocio, u.name AS invitante
       FROM businesses b LEFT JOIN users u ON u.id = $2 WHERE b.id = $1`, [inv.business_id, inv.invited_by])).rows[0] || {};
    const envio = await enviarCorreo({
      para: inv.email,
      plantilla: 'invitacion',
      datos: {
        nombre: inv.name, negocio: datos.negocio, invitante: datos.invitante,
        rol: NOMBRES_ROL[inv.role], cuentaExiste,
        enlace: `${urlBase()}/acceso.html#invitacion=${token}`, vence: `${DIAS_INVITACION} días`
      }
    });
    if (!envio.ok) {
      await evento(null, 'correo_fallido', { businessId: inv.business_id, detalle: { plantilla: 'invitacion', error: envio.error, invitacion: inv.id } });
    }
    return envio.ok;
  }

  async function invitarUsuario(sesion, datos = {}, db, { ip } = {}) {
    limitar('invitar', ip);
    const correo = validarCorreo(datos.email);
    const nombre = String(datos.name || '').trim().slice(0, 120);
    const rol = String(datos.role || '');
    const barberId = rol === 'barber' && datos.barberId ? String(datos.barberId) : null;
    validarRol(rol, barberId, db);
    if (rol === 'owner' && sesion.rol !== 'owner') throw new ErrorAuth(403, 'SIN_PERMISO', 'Solo un propietario puede invitar propietarios');
    const token = tokenAleatorio();
    const client = await pool.connect();
    let inv;
    let cuentaExiste = false;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['master-reservas:correo:' + correo]);
      const u = (await client.query('SELECT id, password_hash FROM users WHERE lower(email) = $1', [correo])).rows[0];
      cuentaExiste = Boolean(u && u.password_hash);
      if (u) {
        const m = (await client.query(
          'SELECT status FROM memberships WHERE user_id = $1 AND business_id = $2', [u.id, sesion.negocio.id])).rows[0];
        if (m) {
          throw new ErrorAuth(409, 'YA_ES_MIEMBRO', m.status === 'active'
            ? 'Esa persona ya tiene acceso a esta barbería'
            : 'Esa persona ya pertenece a esta barbería pero está desactivada: actívala desde la lista');
        }
      }
      /* Una invitación nueva reemplaza a la pendiente anterior para el mismo correo. */
      await client.query(
        `UPDATE invitations SET status = 'revoked', responded_at = NOW()
         WHERE business_id = $1 AND lower(email) = $2 AND status = 'pending'`, [sesion.negocio.id, correo]);
      inv = (await client.query(
        `INSERT INTO invitations (id, token_hash, business_id, email, name, role, barber_id, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() + ($9::text || ' days')::interval) RETURNING *`,
        [nuevoIdInvitacion(), resumen(token), sesion.negocio.id, correo, nombre, rol, barberId, sesion.usuario.id, String(DIAS_INVITACION)])).rows[0];
      await evento(client, 'invitacion_creada', { userId: sesion.usuario.id, businessId: sesion.negocio.id, ip, detalle: { invitacion: inv.id, rol } });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    const correoEnviado = await enviarInvitacion(inv, token, { cuentaExiste });
    return { invitacion: resumenInvitacion(inv), correoEnviado };
  }

  async function listarInvitaciones(businessId) {
    const r = await pool.query(
      `SELECT * FROM invitations WHERE business_id = $1 AND status = 'pending' ORDER BY created_at`, [businessId]);
    return r.rows.map(resumenInvitacion);
  }

  async function invitacionDeNegocio(cliente, sesion, id) {
    const inv = (await cliente.query(
      'SELECT * FROM invitations WHERE id = $1 AND business_id = $2 FOR UPDATE', [String(id), sesion.negocio.id])).rows[0];
    if (!inv) throw new ErrorAuth(404, 'NO_ENCONTRADO', 'Invitación no encontrada en esta barbería');
    if (inv.status !== 'pending') throw new ErrorAuth(409, 'INVITACION_CERRADA', 'Esa invitación ya no está pendiente');
    return inv;
  }

  async function revocarInvitacion(sesion, id, { ip } = {}) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inv = await invitacionDeNegocio(client, sesion, id);
      await client.query(`UPDATE invitations SET status = 'revoked', responded_at = NOW() WHERE id = $1`, [inv.id]);
      await evento(client, 'invitacion_revocada', { userId: sesion.usuario.id, businessId: sesion.negocio.id, ip, detalle: { invitacion: inv.id } });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /* Nuevo enlace y nuevo plazo; el enlace anterior deja de servir. */
  async function reenviarInvitacion(sesion, id, { ip } = {}) {
    limitar('invitar', ip);
    const token = tokenAleatorio();
    const client = await pool.connect();
    let inv;
    try {
      await client.query('BEGIN');
      const actual = await invitacionDeNegocio(client, sesion, id);
      inv = (await client.query(
        `UPDATE invitations SET token_hash = $2, expires_at = NOW() + ($3::text || ' days')::interval
         WHERE id = $1 RETURNING *`, [actual.id, resumen(token), String(DIAS_INVITACION)])).rows[0];
      await evento(client, 'invitacion_reenviada', { userId: sesion.usuario.id, businessId: sesion.negocio.id, ip, detalle: { invitacion: inv.id } });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    const u = (await pool.query('SELECT password_hash FROM users WHERE lower(email) = lower($1)', [inv.email])).rows[0];
    const correoEnviado = await enviarInvitacion(inv, token, { cuentaExiste: Boolean(u && u.password_hash) });
    return { invitacion: resumenInvitacion(inv), correoEnviado };
  }

  /* Invitación válida por su código; explica si venció, se usó o se revocó. */
  async function invitacionPorToken(cliente, token) {
    const inv = (await cliente.query(
      `SELECT i.*, i.expires_at <= NOW() AS vencida, b.name AS negocio, b.status AS estado_negocio, b.protected AS protegido
       FROM invitations i JOIN businesses b ON b.id = i.business_id
       WHERE i.token_hash = $1 FOR UPDATE OF i`, [resumen(String(token || ''))])).rows[0];
    if (!inv) throw new ErrorAuth(404, 'INVITACION_INVALIDA', 'La invitación no es válida. Revisa que el enlace esté completo.');
    const cerradas = {
      accepted: 'Esta invitación ya se aceptó.',
      declined: 'Esta invitación se rechazó.',
      revoked: 'La barbería canceló esta invitación o envió una más reciente.'
    };
    if (inv.status !== 'pending') throw new ErrorAuth(410, 'INVITACION_CERRADA', cerradas[inv.status] || 'La invitación ya no está disponible.');
    if (inv.vencida) throw new ErrorAuth(410, 'INVITACION_VENCIDA', 'La invitación venció. Pide a la barbería que te envíe una nueva.');
    if (inv.estado_negocio === 'suspended' && !inv.protegido) throw new ErrorAuth(410, 'INVITACION_CERRADA', 'La barbería no está disponible.');
    return inv;
  }

  async function consultarInvitacion(token, { ip } = {}) {
    limitar('invitacion', ip);
    const inv = await invitacionPorToken(pool, token);
    const u = (await pool.query(
      'SELECT password_hash, totp_enabled_at FROM users WHERE lower(email) = lower($1)', [inv.email])).rows[0];
    return {
      businessName: inv.negocio,
      email: inv.email,
      name: inv.name,
      role: inv.role,
      roleName: NOMBRES_ROL[inv.role],
      expiresAt: inv.expires_at,
      accountExists: Boolean(u && u.password_hash),
      twoFactor: Boolean(u && u.totp_enabled_at)
    };
  }

  /* Crea la pertenencia a partir de la invitación (dentro de una transacción). */
  async function crearPertenencia(client, inv, userId) {
    const m = await client.query(
      `INSERT INTO memberships (user_id, business_id, role, barber_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, business_id) DO NOTHING`, [userId, inv.business_id, inv.role, inv.barber_id]);
    if (!m.rowCount) throw new ErrorAuth(409, 'YA_ES_MIEMBRO', 'Ya tienes acceso a esta barbería');
    await client.query(
      `UPDATE invitations SET status = 'accepted', responded_at = NOW(), accepted_user_id = $2 WHERE id = $1`, [inv.id, userId]);
  }

  async function aceptarInvitacion(token, datos = {}, { ip, userAgent } = {}) {
    limitar('invitacion', ip);
    const client = await pool.connect();
    let userId;
    let inv;
    try {
      await client.query('BEGIN');
      inv = await invitacionPorToken(client, token);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['master-reservas:correo:' + inv.email.toLowerCase()]);
      const u = (await client.query('SELECT * FROM users WHERE lower(email) = lower($1)', [inv.email])).rows[0];
      if (u && u.password_hash) {
        /* Cuenta existente: debe demostrar que es suya. */
        if (u.status !== 'active' || !(await claveCorrecta(String(datos.password || ''), u.password_hash))) {
          /* Fuera de la transacción para que el registro no se pierda al deshacerla. */
          await evento(null, 'invitacion_clave_incorrecta', { userId: u.id, businessId: inv.business_id, ip });
          throw new ErrorAuth(400, 'CLAVE_ACTUAL', 'La contraseña no es correcta');
        }
        if (u.totp_enabled_at) {
          if (!datos.code) throw new ErrorAuth(400, 'CODIGO_REQUERIDO', 'Escribe el código de tu aplicación de dos pasos');
          if (!(await codigoDosPasosCorrecto(u.id, datos.code))) throw new ErrorAuth(400, 'CODIGO_INVALIDO', 'El código no es correcto');
        }
        userId = u.id;
      } else {
        /* Sin cuenta: la crea con el correo de la invitación (el enlace prueba que es suyo). */
        const nombre = String(datos.name || inv.name || '').trim().slice(0, 120);
        if (nombre.length < 2) throw new ErrorAuth(400, 'NOMBRE_REQUERIDO', 'Escribe tu nombre');
        const hash = await cifrarClave(validarClave(datos.password, { correo: inv.email, nombre }));
        if (u) {
          userId = u.id;
          await client.query(
            `UPDATE users SET name = $2, password_hash = $3, password_changed_at = NOW(), email_verified_at = NOW(),
                    updated_at = NOW() WHERE id = $1`, [u.id, nombre, hash]);
        } else {
          userId = nuevoId();
          await client.query(
            `INSERT INTO users (id, email, name, password_hash, password_changed_at, email_verified_at)
             VALUES ($1, $2, $3, $4, NOW(), NOW())`, [userId, inv.email.toLowerCase(), nombre, hash]);
        }
      }
      await crearPertenencia(client, inv, userId);
      await evento(client, 'invitacion_aceptada', { userId, businessId: inv.business_id, ip, detalle: { invitacion: inv.id } });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    const u = (await pool.query('SELECT * FROM users WHERE id = $1', [userId])).rows[0];
    return completarInicio(u, { id: inv.business_id, name: inv.negocio, role: inv.role }, { ip, userAgent });
  }

  async function rechazarInvitacion(token, { ip } = {}) {
    limitar('invitacion', ip);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inv = await invitacionPorToken(client, token);
      await client.query(`UPDATE invitations SET status = 'declined', responded_at = NOW() WHERE id = $1`, [inv.id]);
      await evento(client, 'invitacion_rechazada', { businessId: inv.business_id, ip, detalle: { invitacion: inv.id } });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /* Invitaciones pendientes para el correo de la sesión (panel → Mi cuenta). */
  async function misInvitaciones(sesion) {
    const r = await pool.query(
      `SELECT i.*, b.name AS negocio, u.name AS invitante
       FROM invitations i JOIN businesses b ON b.id = i.business_id LEFT JOIN users u ON u.id = i.invited_by
       WHERE lower(i.email) = lower($1) AND i.status = 'pending' AND i.expires_at > NOW() AND (b.status <> 'suspended' OR b.protected)
       ORDER BY i.created_at`, [sesion.usuario.email]);
    return r.rows.map(x => ({
      id: x.id, businessId: x.business_id, businessName: x.negocio, invitedBy: x.invitante,
      role: x.role, roleName: NOMBRES_ROL[x.role], expiresAt: x.expires_at
    }));
  }

  async function responderMiInvitacion(sesion, id, aceptar, { ip } = {}) {
    limitar('invitacion', ip);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inv = (await client.query(
        `SELECT i.*, b.name AS negocio FROM invitations i JOIN businesses b ON b.id = i.business_id
         WHERE i.id = $1 AND lower(i.email) = lower($2) FOR UPDATE OF i`, [String(id), sesion.usuario.email])).rows[0];
      /* La invitación de otra persona es "no encontrada": no se revela que existe. */
      if (!inv) throw new ErrorAuth(404, 'NO_ENCONTRADO', 'Invitación no encontrada');
      if (inv.status !== 'pending') throw new ErrorAuth(410, 'INVITACION_CERRADA', 'Esa invitación ya no está pendiente');
      if (new Date(inv.expires_at) <= new Date()) throw new ErrorAuth(410, 'INVITACION_VENCIDA', 'La invitación venció. Pide una nueva.');
      if (aceptar) {
        await crearPertenencia(client, inv, sesion.usuario.id);
      } else {
        await client.query(`UPDATE invitations SET status = 'declined', responded_at = NOW() WHERE id = $1`, [inv.id]);
      }
      await evento(client, aceptar ? 'invitacion_aceptada' : 'invitacion_rechazada',
        { userId: sesion.usuario.id, businessId: inv.business_id, ip, detalle: { invitacion: inv.id } });
      await client.query('COMMIT');
      return { businessId: inv.business_id, businessName: inv.negocio };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /* Pasar a otra barbería de la misma persona sin volver a escribir la contraseña. */
  async function cambiarNegocio(sesion, tokenActual, businessId, { ip, userAgent } = {}) {
    const elegido = (await negociosDeUsuario(sesion.usuario.id)).find(n => n.id === String(businessId || ''));
    if (!elegido) throw new ErrorAuth(403, 'SIN_ACCESO', 'No tienes acceso a esa barbería');
    const u = (await pool.query('SELECT * FROM users WHERE id = $1', [sesion.usuario.id])).rows[0];
    await cerrarSesion(tokenActual, { ip });
    return completarInicio(u, elegido, { ip, userAgent });
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
    invitarUsuario,
    listarInvitaciones,
    revocarInvitacion,
    reenviarInvitacion,
    consultarInvitacion,
    aceptarInvitacion,
    rechazarInvitacion,
    misInvitaciones,
    responderMiInvitacion,
    cambiarNegocio,
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
