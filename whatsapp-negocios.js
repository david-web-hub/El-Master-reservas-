'use strict';
/*
  WHATSAPP PROPIO DE CADA BARBERÍA
  La barbería principal (El Máster) sigue usando las variables del servidor
  (WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID…) y su webhook /webhooks/whatsapp.
  Cada barbería nueva conecta SU número, de SU cuenta de Meta:

  - El propietario pega en su panel el identificador del número, el token de
    acceso y la clave secreta de su aplicación de Meta. Se comprueban con Meta
    antes de guardarlos y se guardan cifrados (AES-256-GCM). Nunca se vuelven
    a mostrar ni salen del servidor.
  - Cada barbería tiene su propio webhook: /webhooks/whatsapp/n/<clave
    aleatoria>, con su propio token de verificación. Cada mensaje que llega se
    acepta solo si viene firmado con la clave secreta de esa barbería y para su
    número: una barbería nunca recibe ni ve mensajes de otra.
  - El número de El Máster no se puede conectar a otra barbería, y un número
    solo puede pertenecer a una barbería.
*/
const crypto = require('node:crypto');

class ErrorWhatsApp extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const ID_META = /^\d{5,30}$/;
const TOKEN_META = /^[A-Za-z0-9_\-.|]{20,1000}$/;
const SECRETO_APP = /^[A-Za-z0-9]{16,128}$/;

function crearCifrador(claveTexto) {
  if (!claveTexto) return null;
  const clave = crypto.createHash('sha256').update(String(claveTexto)).digest();
  return {
    cifrar(texto) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', clave, iv);
      const datos = Buffer.concat([c.update(String(texto), 'utf8'), c.final()]);
      return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), datos.toString('base64')].join(':');
    },
    descifrar(valor) {
      const [v, iv, tag, datos] = String(valor || '').split(':');
      if (v !== 'v1') throw new Error('Formato cifrado desconocido');
      const d = crypto.createDecipheriv('aes-256-gcm', clave, Buffer.from(iv, 'base64'));
      d.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(datos, 'base64')), d.final()]).toString('utf8');
    }
  };
}

const iguales = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const y = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(x, y);
};

/* Firma de Meta: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(cuerpo exacto, clave secreta de la app). */
function firmaValida(secreto, cuerpo, cabecera) {
  const m = /^sha256=([a-f0-9]{64})$/i.exec(String(cabecera || ''));
  if (!m || !secreto || typeof cuerpo !== 'string') return false;
  const esperada = crypto.createHmac('sha256', secreto).update(cuerpo, 'utf8').digest();
  return crypto.timingSafeEqual(esperada, Buffer.from(m[1].toLowerCase(), 'hex'));
}

const pruebaSecreto = (token, secreto) => crypto.createHmac('sha256', secreto).update(token).digest('hex');

function crearWhatsAppNegocios({
  pool,
  clave,
  graphUrl = 'https://graph.facebook.com',
  version = 'v23.0',
  numeroReservado = '',
  timeoutMs = 10000,
  registro = console,
  produccion = false
} = {}) {
  const cifrador = crearCifrador(clave);
  const cache = new Map();
  const disponible = Boolean(pool && cifrador);

  function exigirDisponible() {
    if (!disponible) {
      throw new ErrorWhatsApp(503, 'WHATSAPP_NO_DISPONIBLE',
        'La conexión de WhatsApp todavía no está activada en el servidor. Comunícate con MF Plux.');
    }
  }

  async function graph(metodo, ruta, token, secreto, cuerpo) {
    const url = new URL(`${graphUrl.replace(/\/+$/, '')}/${version}/${ruta}`);
    if (secreto) url.searchParams.set('appsecret_proof', pruebaSecreto(token, secreto));
    let r;
    try {
      r = await fetch(url, {
        method: metodo,
        headers: { Authorization: `Bearer ${token}`, ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      return { ok: false, status: 0, json: {}, error: 'Meta no respondió. Inténtalo de nuevo en unos minutos.' };
    }
    const json = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, json, error: r.ok ? null : (json.error?.message || `Meta respondió ${r.status}`) };
  }

  /* Crea (una vez) el webhook propio de la barbería: dirección aleatoria y token de verificación. */
  async function preparar(negocio) {
    exigirDisponible();
    const ya = await pool.query('SELECT * FROM business_whatsapp WHERE business_id = $1', [negocio]);
    if (ya.rowCount) return ya.rows[0];
    const r = await pool.query(
      `INSERT INTO business_whatsapp (business_id, webhook_key, verify_token_cifrado)
       VALUES ($1, $2, $3) ON CONFLICT (business_id) DO NOTHING RETURNING *`,
      [negocio, crypto.randomBytes(18).toString('base64url'), cifrador.cifrar(crypto.randomBytes(24).toString('base64url'))]);
    return r.rows[0] || (await pool.query('SELECT * FROM business_whatsapp WHERE business_id = $1', [negocio])).rows[0];
  }

  /* Lo que ve el propietario en su panel. Nunca incluye el token de acceso ni la clave secreta. */
  async function estado(negocio) {
    if (!disponible) return { available: false };
    const f = await preparar(negocio);
    return {
      available: true,
      connected: Boolean(f.enabled && f.access_token_cifrado),
      webhookPath: `/webhooks/whatsapp/n/${f.webhook_key}`,
      verifyToken: cifrador.descifrar(f.verify_token_cifrado),
      phoneNumberId: f.phone_number_id || '',
      wabaId: f.waba_id || '',
      displayPhone: f.display_phone || '',
      verifiedName: f.verified_name || '',
      connectedAt: f.connected_at,
      webhookVerifiedAt: f.webhook_verified_at,
      lastMessageAt: f.last_message_at,
      lastError: f.last_error || null
    };
  }

  async function conectar(negocio, datos = {}) {
    exigirDisponible();
    const phoneNumberId = String(datos.phoneNumberId || '').trim();
    const wabaId = String(datos.wabaId || '').trim();
    const accessToken = String(datos.accessToken || '').trim();
    const appSecret = String(datos.appSecret || '').trim();
    if (!ID_META.test(phoneNumberId)) throw new ErrorWhatsApp(400, 'DATO_INVALIDO', 'El identificador del número (Phone number ID) solo tiene dígitos.');
    if (wabaId && !ID_META.test(wabaId)) throw new ErrorWhatsApp(400, 'DATO_INVALIDO', 'El identificador de la cuenta de WhatsApp Business solo tiene dígitos.');
    if (!TOKEN_META.test(accessToken)) throw new ErrorWhatsApp(400, 'DATO_INVALIDO', 'Pega el token de acceso permanente completo.');
    if (!SECRETO_APP.test(appSecret)) throw new ErrorWhatsApp(400, 'DATO_INVALIDO', 'Pega la clave secreta de la aplicación de Meta (App Secret).');
    if (numeroReservado && phoneNumberId === String(numeroReservado)) {
      throw new ErrorWhatsApp(409, 'NUMERO_RESERVADO', 'Ese número pertenece a otra barbería. Conecta el número de WhatsApp de tu propia barbería.');
    }
    const otra = await pool.query('SELECT 1 FROM business_whatsapp WHERE phone_number_id = $1 AND business_id <> $2', [phoneNumberId, negocio]);
    if (otra.rowCount) throw new ErrorWhatsApp(409, 'NUMERO_EN_USO', 'Ese número ya está conectado a otra barbería.');

    /* Meta confirma a la vez el número, el token y la clave secreta (appsecret_proof). */
    const r = await graph('GET', `${phoneNumberId}?fields=display_phone_number,verified_name`, accessToken, appSecret);
    if (!r.ok) throw new ErrorWhatsApp(400, 'META_RECHAZO', `Meta no aceptó los datos: ${r.error}`);

    await preparar(negocio);
    let suscrita = null;
    if (wabaId) {
      const s = await graph('POST', `${wabaId}/subscribed_apps`, accessToken, appSecret);
      suscrita = s.ok;
      if (!s.ok) registro.error(`WHATSAPP ${negocio}: no se pudo suscribir la aplicación a la cuenta (${s.error}).`);
    }
    try {
      await pool.query(
        `UPDATE business_whatsapp SET phone_number_id = $2, waba_id = $3, display_phone = $4, verified_name = $5,
           access_token_cifrado = $6, app_secret_cifrado = $7, enabled = TRUE, connected_at = NOW(),
           last_error = NULL, updated_at = NOW()
         WHERE business_id = $1`,
        [negocio, phoneNumberId, wabaId || null, String(r.json.display_phone_number || '').slice(0, 40),
          String(r.json.verified_name || '').slice(0, 120), cifrador.cifrar(accessToken), cifrador.cifrar(appSecret)]);
    } catch (error) {
      if (error.code === '23505') throw new ErrorWhatsApp(409, 'NUMERO_EN_USO', 'Ese número ya está conectado a otra barbería.');
      throw error;
    }
    cache.delete(negocio);
    return { ...(await estado(negocio)), subscribed: suscrita };
  }

  async function desconectar(negocio) {
    exigirDisponible();
    await pool.query(
      `UPDATE business_whatsapp SET enabled = FALSE, phone_number_id = NULL, waba_id = NULL, display_phone = NULL,
         verified_name = NULL, access_token_cifrado = NULL, app_secret_cifrado = NULL, connected_at = NULL,
         webhook_verified_at = NULL, last_error = NULL, updated_at = NOW()
       WHERE business_id = $1`, [negocio]);
    cache.delete(negocio);
    return estado(negocio);
  }

  /* Webhook: barbería dueña de la dirección aleatoria. */
  async function porClave(clave) {
    if (!disponible || !/^[A-Za-z0-9_-]{16,64}$/.test(String(clave || ''))) return null;
    const r = await pool.query('SELECT * FROM business_whatsapp WHERE webhook_key = $1', [clave]);
    const f = r.rows[0];
    if (!f) return null;
    return {
      negocio: f.business_id,
      enabled: Boolean(f.enabled && f.access_token_cifrado),
      phoneNumberId: f.phone_number_id,
      verifyToken: () => cifrador.descifrar(f.verify_token_cifrado),
      appSecret: () => (f.app_secret_cifrado ? cifrador.descifrar(f.app_secret_cifrado) : null)
    };
  }

  async function credenciales(negocio) {
    if (!disponible) return null;
    const c = cache.get(negocio);
    if (c && Date.now() - c.t < 60000) return c.v;
    const r = await pool.query(
      'SELECT phone_number_id, access_token_cifrado, app_secret_cifrado, enabled FROM business_whatsapp WHERE business_id = $1', [negocio]);
    const f = r.rows[0];
    const v = f && f.enabled && f.access_token_cifrado
      ? { phoneNumberId: f.phone_number_id, token: cifrador.descifrar(f.access_token_cifrado), secreto: f.app_secret_cifrado ? cifrador.descifrar(f.app_secret_cifrado) : null }
      : null;
    cache.set(negocio, { t: Date.now(), v });
    return v;
  }

  /* Envío desde el número de la barbería. Sin número conectado no se envía nada. */
  async function enviar(negocio, para, texto) {
    const c = await credenciales(negocio).catch(error => {
      registro.error(`WHATSAPP ${negocio}: no se pudieron leer las credenciales (${error.message}).`);
      return null;
    });
    if (!c) {
      if (!produccion) registro.log(`[DEMO WhatsApp ${negocio}]`, para, texto);
      return { ok: false, motivo: 'SIN_CONEXION' };
    }
    const r = await graph('POST', `${c.phoneNumberId}/messages`, c.token, c.secreto, {
      messaging_product: 'whatsapp', to: para, type: 'text', text: { body: texto }
    });
    if (!r.ok) {
      registro.error(`ERROR ENVIANDO WHATSAPP (${negocio}): ${r.status} ${r.error}`);
      await anotar(negocio, { error: `Meta rechazó un envío: ${r.error}` });
    }
    return { ok: r.ok };
  }

  async function anotar(negocio, { verificado, mensaje, error } = {}) {
    if (!disponible) return;
    await pool.query(
      `UPDATE business_whatsapp SET
         webhook_verified_at = CASE WHEN $2 THEN NOW() ELSE webhook_verified_at END,
         last_message_at = CASE WHEN $3 THEN NOW() ELSE last_message_at END,
         last_error = CASE WHEN $4::text IS NOT NULL THEN $4::text WHEN $3 THEN NULL ELSE last_error END,
         updated_at = NOW()
       WHERE business_id = $1`,
      [negocio, Boolean(verificado), Boolean(mensaje), error ? String(error).slice(0, 300) : null]).catch(() => {});
  }

  /* Para el Panel Maestro: solo si está conectado. Sin números ni secretos. */
  async function resumenes() {
    if (!disponible) return new Map();
    const r = await pool.query(
      'SELECT business_id, enabled, webhook_verified_at, last_message_at FROM business_whatsapp');
    return new Map(r.rows.map(f => [f.business_id, {
      connected: Boolean(f.enabled),
      webhookVerified: Boolean(f.webhook_verified_at),
      lastMessageAt: f.last_message_at
    }]));
  }

  return { disponible, estado, conectar, desconectar, porClave, credenciales, enviar, anotar, resumenes, firmaValida, iguales };
}

module.exports = { crearWhatsAppNegocios, ErrorWhatsApp, firmaValida, crearCifrador };
