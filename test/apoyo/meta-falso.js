'use strict';
/*
  Servidor local que imita la API Graph de Meta (WhatsApp Cloud API) para
  probar la conexión de cada barbería sin tocar Meta de verdad.
  - Cada número registrado tiene su token y la clave secreta de su app:
    las peticiones solo se aceptan con ese token y su appsecret_proof.
  - Guarda los mensajes enviados (número de origen, destinatario y texto).
*/
const http = require('node:http');
const crypto = require('node:crypto');

async function iniciarMetaFalso() {
  const numeros = new Map();
  const enviados = [];
  const suscripciones = [];
  const server = http.createServer((req, res) => {
    let cuerpo = '';
    req.on('data', c => { cuerpo += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const partes = url.pathname.split('/').filter(Boolean);
      const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
      const responder = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
      const error = mensaje => responder(401, { error: { message: mensaje, type: 'OAuthException', code: 190 } });
      const autorizado = n => n && n.token === token &&
        url.searchParams.get('appsecret_proof') === crypto.createHmac('sha256', n.secreto).update(token).digest('hex');

      if (partes[1] && partes[2] === 'subscribed_apps' && req.method === 'POST') {
        suscripciones.push(partes[1]);
        return responder(200, { success: true });
      }
      const n = numeros.get(partes[1]);
      if (req.method === 'GET' && partes.length === 2) {
        if (!n) return responder(400, { error: { message: 'Unsupported get request.', code: 100 } });
        if (n.token !== token) return error('Invalid OAuth access token.');
        if (!autorizado(n)) return error('Invalid appsecret_proof provided in the API argument');
        return responder(200, { id: partes[1], display_phone_number: n.telefono, verified_name: n.nombre });
      }
      if (req.method === 'POST' && partes[2] === 'messages') {
        if (!autorizado(n)) return error('Invalid OAuth access token.');
        let json = {};
        try { json = JSON.parse(cuerpo); } catch { /* vacío */ }
        enviados.push({ desde: partes[1], para: json.to, texto: json.text?.body || '' });
        return responder(200, { messages: [{ id: 'wamid.' + enviados.length }] });
      }
      responder(404, { error: { message: 'No encontrado' } });
    });
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    enviados,
    suscripciones,
    registrar(id, datos) { numeros.set(String(id), datos); },
    cerrar() {
      server.closeAllConnections?.();
      return new Promise(ok => server.close(ok));
    }
  };
}

module.exports = { iniciarMetaFalso };
