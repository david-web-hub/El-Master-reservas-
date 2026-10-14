'use strict';
/* =========================================================
   CORREO: PLANTILLAS Y ENVÍO (Resend)

   - Credenciales solo por variables de entorno:
       RESEND_API_KEY, CORREO_REMITENTE, CORREO_RESPONDER_A (opcional)
   - Sin configurar:
       desarrollo y pruebas → se muestra "[DEMO CORREO] <para> <enlace>"
         en la consola (y una vista previa HTML si CORREO_VISTA_PREVIA_DIR);
       producción → no se envía nada y nunca se registra el enlace.
   - Errores: tiempo límite, un reintento ante fallos temporales con la
     misma clave de idempotencia (Resend no duplica el mensaje) y un
     resultado { ok, error } que el resto del sistema puede mostrar.
========================================================= */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const COLORES = {
  fondo: '#080a0c',
  tarjeta: '#101419',
  borde: '#252c34',
  oro: '#d4af37',
  oro2: '#f4c94d',
  texto: '#f7f7f7',
  apagado: '#9da6af'
};

const esc = valor => String(valor ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
})[c]);

/* Diseño común: tablas y estilos en línea para que se vea bien en Gmail, Outlook y móviles. */
function marco({ titulo, saludo, parrafos, boton, enlace, nota, preencabezado }) {
  const fuente = "Inter,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>${esc(titulo)}</title>
</head>
<body style="margin:0;padding:0;background:${COLORES.fondo};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preencabezado || titulo)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORES.fondo};">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
      <tr><td style="padding:0 4px 20px;">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td style="width:44px;height:44px;border-radius:13px;background:${COLORES.oro2};background-image:linear-gradient(145deg,${COLORES.oro2},#c99b22);text-align:center;vertical-align:middle;font-size:22px;color:#090909;">&#9819;</td>
          <td style="padding-left:12px;font-family:${fuente};">
            <div style="color:${COLORES.texto};font-weight:800;letter-spacing:.08em;font-size:15px;">MASTER RESERVAS</div>
            <div style="color:${COLORES.apagado};font-size:13px;">Administración de tu barbería</div>
          </td>
        </tr></table>
      </td></tr>
      <tr><td style="background:${COLORES.tarjeta};border:1px solid ${COLORES.borde};border-radius:18px;padding:28px 24px;font-family:${fuente};">
        <h1 style="margin:0 0 14px;color:${COLORES.texto};font-size:22px;line-height:1.3;">${esc(titulo)}</h1>
        <p style="margin:0 0 12px;color:${COLORES.texto};font-size:15px;line-height:1.6;">${esc(saludo)}</p>
        ${parrafos.map(p => `<p style="margin:0 0 12px;color:${COLORES.apagado};font-size:15px;line-height:1.6;">${p}</p>`).join('')}
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 18px;"><tr>
          <td style="border-radius:12px;background:${COLORES.oro2};background-image:linear-gradient(145deg,${COLORES.oro2},#c99b22);">
            <a href="${esc(enlace)}" style="display:inline-block;padding:13px 22px;color:#090909;font-weight:800;font-size:15px;text-decoration:none;font-family:${fuente};">${esc(boton)}</a>
          </td>
        </tr></table>
        <p style="margin:0 0 6px;color:${COLORES.apagado};font-size:12px;line-height:1.5;">Si el botón no funciona, copia este enlace en tu navegador:</p>
        <p style="margin:0 0 16px;font-size:12px;line-height:1.5;word-break:break-all;"><a href="${esc(enlace)}" style="color:${COLORES.oro2};">${esc(enlace)}</a></p>
        <p style="margin:0;padding-top:14px;border-top:1px solid ${COLORES.borde};color:${COLORES.apagado};font-size:12px;line-height:1.5;">${esc(nota)}</p>
      </td></tr>
      <tr><td style="padding:18px 4px 0;font-family:${fuente};color:${COLORES.apagado};font-size:12px;line-height:1.5;text-align:center;">
        Mensaje automático de Master Reservas. No compartas este enlace con nadie.
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
  return html;
}

const PLANTILLAS = {
  confirmacion: d => ({
    asunto: 'Confirma tu correo en Master Reservas',
    titulo: 'Confirma tu correo',
    saludo: `Hola${d.nombre ? ' ' + d.nombre : ''}:`,
    parrafos: [`Gracias por registrar <strong style="color:${COLORES.texto};">${esc(d.negocio || 'tu barbería')}</strong>. Confirma tu correo para activar la cuenta.`],
    boton: 'Confirmar mi correo',
    nota: `El enlace vence en ${d.vence || '24 horas'} y sirve una sola vez. Si no creaste esta cuenta, ignora este mensaje.`,
    texto: `Hola${d.nombre ? ' ' + d.nombre : ''}:\n\nConfirma tu correo para activar tu cuenta de Master Reservas:\n${d.enlace}\n\nEl enlace vence en ${d.vence || '24 horas'} y sirve una sola vez. Si no creaste esta cuenta, ignora este mensaje.`
  }),
  recuperacion: d => ({
    asunto: 'Restablece tu contraseña de Master Reservas',
    titulo: 'Crea una nueva contraseña',
    saludo: `Hola${d.nombre ? ' ' + d.nombre : ''}:`,
    parrafos: ['Recibimos una solicitud para cambiar la contraseña de tu cuenta. Al crear la nueva, se cerrarán las sesiones abiertas.'],
    boton: 'Crear nueva contraseña',
    nota: `El enlace vence en ${d.vence || '1 hora'} y sirve una sola vez. Si no lo pediste, ignora este mensaje: tu contraseña no cambia.`,
    texto: `Hola${d.nombre ? ' ' + d.nombre : ''}:\n\nPara crear una nueva contraseña abre este enlace:\n${d.enlace}\n\nVence en ${d.vence || '1 hora'} y sirve una sola vez. Si no lo pediste, ignora este mensaje: tu contraseña no cambia.`
  }),
  invitacion: d => ({
    asunto: `Invitación a ${d.negocio || 'una barbería'} en Master Reservas`,
    titulo: `Te invitaron a ${d.negocio || 'una barbería'}`,
    saludo: `Hola${d.nombre ? ' ' + d.nombre : ''}:`,
    parrafos: [
      `${esc(d.invitante || 'El equipo')} te invitó a unirte a <strong style="color:${COLORES.texto};">${esc(d.negocio || 'su barbería')}</strong> como <strong style="color:${COLORES.texto};">${esc(d.rol || 'miembro del equipo')}</strong>.`,
      d.cuentaExiste
        ? 'Abre el enlace para aceptar o rechazar la invitación con tu cuenta actual. No tendrás acceso hasta que la aceptes.'
        : 'Abre el enlace para crear tu contraseña y aceptar la invitación, o para rechazarla.'
    ],
    boton: 'Ver invitación',
    nota: `La invitación vence en ${d.vence || '7 días'} y sirve una sola vez. Si no esperabas este mensaje, puedes rechazarla o ignorarlo.`,
    texto: `Hola${d.nombre ? ' ' + d.nombre : ''}:\n\n${d.invitante || 'El equipo'} te invitó a unirte a ${d.negocio || 'su barbería'} como ${d.rol || 'miembro del equipo'} en Master Reservas.\n\nAbre este enlace para aceptarla o rechazarla:\n${d.enlace}\n\nVence en ${d.vence || '7 días'} y sirve una sola vez.`
  }),
  prueba: d => ({
    asunto: 'Prueba de correo de Master Reservas',
    titulo: 'El correo funciona',
    saludo: 'Hola:',
    parrafos: ['Este es un mensaje de prueba para comprobar la configuración de correo de Master Reservas.'],
    boton: 'Abrir Master Reservas',
    nota: 'Si recibiste este mensaje, el envío de correos está configurado correctamente.',
    texto: `Este es un mensaje de prueba de Master Reservas.\n${d.enlace}`
  })
};

/* Asunto, HTML y texto plano de una plantilla. */
function construirCorreo(plantilla, datos = {}) {
  const fabrica = PLANTILLAS[plantilla];
  if (!fabrica) throw new Error(`Plantilla de correo desconocida: ${plantilla}`);
  const p = fabrica(datos);
  return {
    asunto: p.asunto,
    html: marco({ ...p, enlace: datos.enlace, preencabezado: p.titulo }),
    texto: p.texto
  };
}

function crearCorreo({
  apiKey = '',
  remitente = '',
  responderA = '',
  apiUrl = 'https://api.resend.com/emails',
  produccion = false,
  vistaPreviaDir = '',
  timeoutMs = 10000,
  registro = console,
  fetchImpl = fetch
} = {}) {
  const configurado = Boolean(apiKey && remitente);

  async function llamarResend(cuerpo, clave) {
    const control = new AbortController();
    const temporizador = setTimeout(() => control.abort(), timeoutMs);
    try {
      const r = await fetchImpl(apiUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': clave
        },
        body: JSON.stringify(cuerpo),
        signal: control.signal
      });
      let json = {};
      try { json = await r.json(); } catch { json = {}; }
      return { status: r.status, json };
    } finally {
      clearTimeout(temporizador);
    }
  }

  async function enviar({ para, plantilla, datos = {} }) {
    const mensaje = construirCorreo(plantilla, datos);

    if (!configurado) {
      if (produccion) {
        registro.warn(`AVISO: correo no configurado; no se envió el mensaje "${plantilla}".`);
        return { ok: false, error: 'NO_CONFIGURADO', modo: 'sin-configurar' };
      }
      if (vistaPreviaDir) {
        fs.mkdirSync(vistaPreviaDir, { recursive: true });
        const nombre = `${Date.now()}-${plantilla}-${String(para).replace(/[^a-z0-9@._-]/gi, '_')}.html`;
        fs.writeFileSync(path.join(vistaPreviaDir, nombre), mensaje.html);
      }
      registro.log(`[DEMO CORREO] ${para} ${datos.enlace || ''}`);
      return { ok: true, modo: 'demostracion' };
    }

    const cuerpo = {
      from: remitente,
      to: [para],
      subject: mensaje.asunto,
      html: mensaje.html,
      text: mensaje.texto
    };
    if (responderA) cuerpo.reply_to = responderA;
    const clave = crypto.randomUUID();

    for (let intento = 1; intento <= 2; intento++) {
      try {
        const r = await llamarResend(cuerpo, clave);
        if (r.status >= 200 && r.status < 300) {
          return { ok: true, id: r.json.id || null, modo: 'resend' };
        }
        const temporal = r.status === 429 || r.status >= 500;
        registro.error(`ERROR ENVIANDO CORREO "${plantilla}" (intento ${intento}): ${r.status} ${r.json.name || ''} ${r.json.message || ''}`.trim());
        if (!temporal || intento === 2) {
          return { ok: false, error: 'ENVIO_RECHAZADO', status: r.status, modo: 'resend' };
        }
      } catch (error) {
        registro.error(`ERROR ENVIANDO CORREO "${plantilla}" (intento ${intento}): ${error.name === 'AbortError' ? 'tiempo de espera agotado' : error.message}`);
        if (intento === 2) return { ok: false, error: 'SIN_CONEXION', modo: 'resend' };
      }
      await new Promise(res => setTimeout(res, 500));
    }
    return { ok: false, error: 'ENVIO_FALLIDO', modo: 'resend' };
  }

  return { enviar, configurado, construirCorreo };
}

module.exports = { crearCorreo, construirCorreo, PLANTILLAS };
