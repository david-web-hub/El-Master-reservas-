'use strict';
/*
  Firma de las peticiones entre servidores (El Máster Reservas ⇄ Panel Maestro).
  Este archivo es idéntico en los dos repositorios: si cambia uno, debe cambiar el otro
  (las pruebas de ambos comprueban el mismo vector de prueba).

  Cada petición lleva:
    X-Plataforma-Fecha  milisegundos desde 1970 (se aceptan ±5 minutos)
    X-Plataforma-Nonce  valor aleatorio de un solo uso
    X-Plataforma-Firma  HMAC-SHA256 en hexadecimal de:
      "MR-PLATAFORMA-v1\n<MÉTODO>\n<ruta con consulta>\n<fecha>\n<nonce>\n<SHA-256 del cuerpo>"
  La clave compartida (PLATAFORMA_CLAVE) nunca viaja ni llega al navegador.
*/
const crypto = require('crypto');

const VERSION = 'MR-PLATAFORMA-v1';
const VENTANA_MS = 5 * 60 * 1000;
const CLAVE_MIN = 32;

const sha256 = texto => crypto.createHash('sha256').update(texto || '', 'utf8').digest('hex');

function textoFirma({ metodo, ruta, fecha, nonce, cuerpo }) {
  return [VERSION, String(metodo).toUpperCase(), ruta, String(fecha), nonce, sha256(cuerpo)].join('\n');
}

function firmar(clave, datos) {
  return crypto.createHmac('sha256', clave).update(textoFirma(datos)).digest('hex');
}

/* Cabeceras para enviar una petición firmada. */
function cabecerasFirmadas(clave, { metodo, ruta, cuerpo = '', fecha = Date.now(), nonce = crypto.randomBytes(16).toString('hex') }) {
  return {
    'X-Plataforma-Fecha': String(fecha),
    'X-Plataforma-Nonce': nonce,
    'X-Plataforma-Firma': firmar(clave, { metodo, ruta, fecha, nonce, cuerpo })
  };
}

/* Claves válidas: la actual y, durante un cambio de clave, la anterior. */
function clavesConfiguradas(env = process.env) {
  return [env.PLATAFORMA_CLAVE, env.PLATAFORMA_CLAVE_ANTERIOR]
    .map(c => String(c || ''))
    .filter(c => c.length >= CLAVE_MIN);
}

/*
  Verificador con memoria de nonces usados (protege contra repeticiones dentro
  de la ventana de 5 minutos). Devuelve { ok: true } o { ok: false, motivo }.
*/
function crearVerificador({ claves, ahora = () => Date.now() } = {}) {
  const usados = new Map();

  function limpiar(t) {
    for (const [n, vence] of usados) if (vence <= t) usados.delete(n);
  }

  return function verificar({ metodo, ruta, cuerpo = '', cabeceras = {} }) {
    const lista = typeof claves === 'function' ? claves() : claves;
    if (!lista || !lista.length) return { ok: false, motivo: 'NO_CONFIGURADA' };
    const h = k => {
      const v = cabeceras[k.toLowerCase()] ?? cabeceras[k];
      return typeof v === 'string' ? v : '';
    };
    const fecha = h('X-Plataforma-Fecha');
    const nonce = h('X-Plataforma-Nonce');
    const firma = h('X-Plataforma-Firma');
    if (!/^\d{10,16}$/.test(fecha) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(firma)) {
      return { ok: false, motivo: 'CABECERAS' };
    }
    const t = ahora();
    if (Math.abs(t - Number(fecha)) > VENTANA_MS) return { ok: false, motivo: 'FECHA' };
    const recibida = Buffer.from(firma, 'hex');
    const valida = lista.some(clave => {
      const esperada = Buffer.from(firmar(clave, { metodo, ruta, fecha, nonce, cuerpo }), 'hex');
      return esperada.length === recibida.length && crypto.timingSafeEqual(esperada, recibida);
    });
    if (!valida) return { ok: false, motivo: 'FIRMA' };
    if (usados.size > 50000) limpiar(t);
    if (usados.has(nonce)) return { ok: false, motivo: 'REPETIDA' };
    usados.set(nonce, t + 2 * VENTANA_MS);
    return { ok: true };
  };
}

module.exports = { firmar, textoFirma, cabecerasFirmadas, crearVerificador, clavesConfiguradas, VENTANA_MS, CLAVE_MIN, VERSION };
