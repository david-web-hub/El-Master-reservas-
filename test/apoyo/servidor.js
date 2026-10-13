'use strict';
/*
  Arranca una copia aislada de Master Reservas para las pruebas.

  - Copia server.js, public/ y data/db.json a una carpeta temporal: las pruebas
    nunca escriben en data/db.json del repositorio.
  - El entorno se construye desde cero: no hereda tokens de WhatsApp/Meta ni
    DATABASE_URL reales. Sin WHATSAPP_TOKEN, el servidor solo registra
    "[DEMO WhatsApp]" en consola y no envía nada a Meta.
  - PostgreSQL solo se usa si TEST_DATABASE_URL apunta a una base de pruebas.
*/
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

/* Código de la aplicación a probar. MASTER_RESERVAS_RAIZ permite probar otra versión (p. ej. la rama principal). */
const RAIZ = path.resolve(process.env.MASTER_RESERVAS_RAIZ || path.join(__dirname, '..', '..'));
const MODULOS = path.resolve(__dirname, '..', '..', 'node_modules');
const VERIFY_TOKEN = 'token-de-prueba';

/* Rechaza cualquier base que no sea claramente de pruebas. */
function urlBasePruebas() {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch { throw new Error('TEST_DATABASE_URL no es una URL válida'); }
  const nombre = url.pathname.replace(/^\//, '');
  if (!/(test|prueba)/i.test(nombre)) {
    throw new Error('TEST_DATABASE_URL debe apuntar a una base cuyo nombre contenga "test" o "prueba"');
  }
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (!local && process.env.ALLOW_REMOTE_TEST_DB !== '1') {
    throw new Error('TEST_DATABASE_URL apunta a un servidor remoto; usa una base local o ALLOW_REMOTE_TEST_DB=1');
  }
  if (process.env.DATABASE_URL && process.env.DATABASE_URL === raw) {
    throw new Error('TEST_DATABASE_URL no puede ser igual a DATABASE_URL');
  }
  return raw;
}

function puertoLibre() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function prepararCarpeta(db) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'master-reservas-prueba-'));
  fs.copyFileSync(path.join(RAIZ, 'server.js'), path.join(dir, 'server.js'));
  fs.cpSync(path.join(RAIZ, 'public'), path.join(dir, 'public'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data'));
  const destino = path.join(dir, 'data', 'db.json');
  if (db === undefined) fs.copyFileSync(path.join(RAIZ, 'data', 'db.json'), destino);
  else if (db !== null) fs.writeFileSync(destino, JSON.stringify(db, null, 2));
  return dir;
}

class Servidor {
  constructor(dir, { postgres }) {
    this.dir = dir;
    this.postgres = postgres;
    this.logs = [];
    this.stdout = '';
    this.proc = null;
    this.base = null;
  }

  get archivoDb() { return path.join(this.dir, 'data', 'db.json'); }
  leerDb() { return JSON.parse(fs.readFileSync(this.archivoDb, 'utf8')); }

  async iniciar() {
    const port = await puertoLibre();
    const env = {
      PATH: process.env.PATH,
      HOME: os.tmpdir(),
      NODE_PATH: MODULOS,
      PORT: String(port),
      TZ: 'UTC',
      WHATSAPP_VERIFY_TOKEN: VERIFY_TOKEN,
      WHATSAPP_TOKEN: '',
      WHATSAPP_PHONE_NUMBER_ID: ''
    };
    const pg = this.postgres ? urlBasePruebas() : null;
    if (pg) {
      env.DATABASE_URL = pg;
    } else {
      /* Sin base: apunta a un puerto cerrado para que pg falle de inmediato. */
      env.PGHOST = '127.0.0.1';
      env.PGPORT = '1';
      env.PGCONNECT_TIMEOUT = '1';
    }
    this.proc = spawn(process.execPath, ['server.js'], { cwd: this.dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const recoger = chunk => {
      for (const linea of String(chunk).split('\n')) if (linea.trim()) this.logs.push(linea);
    };
    this.proc.stdout.on('data', chunk => { this.stdout += String(chunk); recoger(chunk); });
    this.proc.stderr.on('data', recoger);
    this.base = `http://127.0.0.1:${port}`;
    await this.esperarLog(/EL MÁSTER RESERVAS INICIADO/, 15000);
    if (pg) await this.esperarLog(/TABLAS ADMINISTRATIVAS Y DE CAJA LISTAS|ERROR INICIALIZANDO POSTGRESQL/, 15000);
    return this;
  }

  async esperarLog(regex, ms = 5000, desde = 0) {
    const fin = Date.now() + ms;
    while (Date.now() < fin) {
      const linea = this.logs.slice(desde).find(l => regex.test(l));
      if (linea) return linea;
      if (this.proc.exitCode !== null) throw new Error('El servidor terminó:\n' + this.logs.join('\n'));
      await new Promise(r => setTimeout(r, 25));
    }
    throw new Error(`No apareció ${regex} en los registros:\n` + this.logs.slice(-40).join('\n'));
  }

  async detener() {
    if (!this.proc || this.proc.exitCode !== null) return;
    const salida = new Promise(r => this.proc.once('exit', r));
    this.proc.kill('SIGTERM');
    await salida;
  }

  async pedir(metodo, ruta, cuerpo) {
    const res = await fetch(this.base + ruta, {
      method: metodo,
      headers: cuerpo === undefined ? {} : { 'Content-Type': 'application/json' },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo)
    });
    const texto = await res.text();
    let json = null;
    try { json = JSON.parse(texto); } catch { /* respuesta no JSON */ }
    return { status: res.status, json, texto, headers: res.headers };
  }

  /*
    Envía un mensaje de texto al webhook como lo haría Meta y devuelve la
    respuesta de Elia. Sin WHATSAPP_TOKEN, sendWhatsApp() solo escribe
    "[DEMO WhatsApp] <número> <texto>" en la salida estándar.
  */
  async enviarWhatsApp(texto, from = '593990000001', extraValue = {}) {
    const desde = this.stdout.length;
    const r = await this.pedir('POST', '/webhooks/whatsapp', {
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', ...extraValue, messages: [{ from, id: 'wamid.prueba' + desde, type: 'text', text: { body: texto } }] } }] }]
    });
    if (r.status !== 200) throw new Error('El webhook respondió ' + r.status);
    const marca = `[DEMO WhatsApp] ${from} `;
    const fin = Date.now() + 5000;
    while (Date.now() < fin) {
      const i = this.stdout.indexOf(marca, desde);
      if (i !== -1) {
        await new Promise(res => setTimeout(res, 100));
        let texto = this.stdout.slice(i + marca.length);
        const siguiente = texto.search(/\n(\[DEMO WhatsApp\]|WEBHOOK WHATSAPP RECIBIDO)/);
        if (siguiente !== -1) texto = texto.slice(0, siguiente);
        return texto.trim();
      }
      await new Promise(res => setTimeout(res, 25));
    }
    return null;
  }

  borrar() { fs.rmSync(this.dir, { recursive: true, force: true }); }
}

/* Servidor nuevo en una carpeta nueva (equivale a un despliegue limpio). */
async function iniciarServidor({ db, postgres = false } = {}) {
  return new Servidor(prepararCarpeta(db), { postgres }).iniciar();
}

/* Reinicia el proceso conservando la misma carpeta (equivale a reiniciar en un disco persistente). */
async function reiniciar(servidor) {
  await servidor.detener();
  const nuevo = new Servidor(servidor.dir, { postgres: servidor.postgres });
  return nuevo.iniciar();
}

/* Fecha YYYY-MM-DD del próximo día de la semana pedido (1 = lunes), al menos 2 días después de hoy. */
function proximoDia(diaSemana) {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 2);
  while (d.getUTCDay() !== diaSemana) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

module.exports = { iniciarServidor, reiniciar, urlBasePruebas, proximoDia, RAIZ, VERIFY_TOKEN };
