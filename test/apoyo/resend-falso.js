'use strict';
/*
  Servidor local que imita la API de Resend (POST /emails) para probar el
  envío real sin mandar ningún correo. Guarda cada solicitud recibida y
  responde según una cola configurable (estado, cuerpo y demora).
*/
const http = require('node:http');

async function iniciarResendFalso() {
  const recibidos = [];
  const respuestas = [];
  const server = http.createServer((req, res) => {
    let cuerpo = '';
    req.on('data', c => { cuerpo += c; });
    req.on('end', () => {
      let json = null;
      try { json = JSON.parse(cuerpo); } catch { json = null; }
      recibidos.push({ metodo: req.method, ruta: req.url, cabeceras: req.headers, cuerpo: json });
      const r = respuestas.shift() || { status: 200, body: { id: 'correo_' + recibidos.length } };
      setTimeout(() => {
        if (res.writableEnded) return;
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r.body || {}));
      }, r.demoraMs || 0);
    });
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${server.address().port}/emails`;
  return {
    url,
    recibidos,
    /* Próximas respuestas, en orden: { status, body, demoraMs }. */
    responder(...lista) { respuestas.push(...lista); },
    cerrar() {
      server.closeAllConnections?.();
      return new Promise(ok => server.close(ok));
    }
  };
}

module.exports = { iniciarResendFalso };
