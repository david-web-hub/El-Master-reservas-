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
const crypto = require('node:crypto');
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
  /* Módulos propios de la aplicación (pueden no existir en versiones anteriores). */
  for (const extra of ['almacen.js', 'autenticacion.js', 'correo.js', 'plataforma.js', 'firma-plataforma.js', 'despliegue-inicial.js', 'negocios-publicos.js', 'whatsapp-negocios.js']) {
    if (fs.existsSync(path.join(RAIZ, extra))) fs.copyFileSync(path.join(RAIZ, extra), path.join(dir, extra));
  }
  fs.cpSync(path.join(RAIZ, 'public'), path.join(dir, 'public'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data'));
  const destino = path.join(dir, 'data', 'db.json');
  if (db === undefined) fs.copyFileSync(path.join(RAIZ, 'data', 'db.json'), destino);
  else if (typeof db === 'string') fs.writeFileSync(destino, db);
  else if (db !== null) fs.writeFileSync(destino, JSON.stringify(db, null, 2));
  return dir;
}

/*
  Las pruebas generales usan data/db.json salvo que TEST_ALMACEN=postgres:
  así la misma batería comprueba los dos modos de almacenamiento.
*/
function postgresPorDefecto() {
  return process.env.TEST_ALMACEN === 'postgres' && Boolean(urlBasePruebas());
}

/* Cada servidor de prueba usa su propia barbería: las pruebas no se mezclan aunque compartan base. */
function negocioNuevo() {
  return 'prueba-' + crypto.randomBytes(5).toString('hex');
}

class Servidor {
  constructor(dir, { postgres, negocio, env = {}, sesion = true }) {
    this.dir = dir;
    this.postgres = postgres;
    this.envExtra = env;
    this.conSesion = sesion;
    this.cookie = null;
    this.negocio = negocio || negocioNuevo();
    this.logs = [];
    this.stdout = '';
    this.proc = null;
    this.base = null;
  }

  get archivoDb() { return path.join(this.dir, 'data', 'db.json'); }
  leerDb() { return JSON.parse(fs.readFileSync(this.archivoDb, 'utf8')); }

  /* Datos de la agenda tal como los guarda el servidor (archivo o PostgreSQL), vía respaldo administrativo. */
  async datos() {
    const r = await this.pedir('GET', '/api/admin/backup');
    if (r.status !== 200) throw new Error('No se pudo leer el respaldo: ' + r.status);
    return r.json;
  }

  async iniciar() {
    await this.arrancar();
    await this.esperarLog(/EL MÁSTER RESERVAS INICIADO/, 20000);
    if (this.postgres && this.conSesion) await this.prepararPropietario();
    return this;
  }

  /*
    Crea el propietario de la barbería de prueba e inicia sesión.
    Versiones sin cuentas (anteriores a la fase 3) se usan sin sesión.
  */
  async prepararPropietario() {
    const sondeo = await this.pedir('GET', '/api/auth/sesion');
    if (sondeo.status === 404) return;
    this.correo = `propietario-${this.negocio}@prueba.test`;
    this.clave = 'Clave-de-prueba-segura-1';
    await crearCuenta(this.negocio, this.correo, this.clave, 'owner');
    this.cookie = await this.iniciarSesion(this.correo, this.clave);
  }

  /* Inicia sesión y devuelve la cookie (no cambia la sesión por defecto del servidor). */
  async iniciarSesion(email, password, businessId) {
    const r = await fetch(this.base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, businessId })
    });
    if (r.status !== 200) throw new Error('No se pudo iniciar sesión: ' + r.status + ' ' + await r.text());
    return cookieDe(r);
  }

  async arrancar() {
    const port = await puertoLibre();
    const env = {
      PATH: process.env.PATH,
      HOME: os.tmpdir(),
      NODE_PATH: MODULOS,
      PORT: String(port),
      TZ: 'UTC',
      WHATSAPP_VERIFY_TOKEN: VERIFY_TOKEN,
      WHATSAPP_TOKEN: '',
      WHATSAPP_PHONE_NUMBER_ID: '',
      /* Límite alto: todas las pruebas salen de la misma IP. */
      AUTH_LIMITE_IP: '100000'
    };
    const pg = this.postgres ? urlBasePruebas() : null;
    if (pg) {
      env.DATABASE_URL = pg;
      env.DEFAULT_BUSINESS_ID = this.negocio;
    } else {
      /* Sin base (solo desarrollo): administración abierta en local. */
      env.ADMIN_SIN_CLAVE_LOCAL = '1';
      /* Sin base: apunta a un puerto cerrado para que pg falle de inmediato. */
      env.PGHOST = '127.0.0.1';
      env.PGPORT = '1';
      env.PGCONNECT_TIMEOUT = '1';
    }
    Object.assign(env, this.envExtra);
    this.proc = spawn(process.execPath, ['server.js'], { cwd: this.dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const recoger = chunk => {
      for (const linea of String(chunk).split('\n')) if (linea.trim()) this.logs.push(linea);
    };
    this.proc.stdout.on('data', chunk => { this.stdout += String(chunk); recoger(chunk); });
    this.proc.stderr.on('data', recoger);
    this.base = `http://127.0.0.1:${port}`;
    return this;
  }

  async esperarLog(regex, ms = 5000, desde = 0) {
    const fin = Date.now() + ms;
    while (Date.now() < fin) {
      const linea = this.logs.slice(desde).find(l => regex.test(l));
      if (linea) return linea;
      if (this.proc.exitCode !== null && !regex.test(this.logs.join('\n'))) {
        throw new Error('El servidor terminó:\n' + this.logs.join('\n'));
      }
      await new Promise(r => setTimeout(r, 25));
    }
    throw new Error(`No apareció ${regex} en los registros:\n` + this.logs.slice(-40).join('\n'));
  }

  async detener() {
    if (!this.proc || this.proc.exitCode !== null || this.proc.signalCode !== null) return;
    const salida = new Promise(r => this.proc.once('exit', r));
    this.proc.kill('SIGTERM');
    await salida;
  }

  /* opciones.cookie: null = sin sesión; texto = otra sesión; por defecto, la del propietario. */
  async pedir(metodo, ruta, cuerpo, opciones = {}) {
    const headers = { ...(opciones.headers || {}) };
    if (cuerpo !== undefined) headers['Content-Type'] = 'application/json';
    const cookie = 'cookie' in opciones ? opciones.cookie : this.cookie;
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(this.base + ruta, {
      method: metodo,
      headers,
      redirect: 'manual',
      body: cuerpo === undefined ? undefined : (typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo))
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

/* Cookie de sesión de una respuesta. */
function cookieDe(respuesta) {
  const lista = typeof respuesta.headers.getSetCookie === 'function'
    ? respuesta.headers.getSetCookie()
    : [respuesta.headers.get('set-cookie')].filter(Boolean);
  const c = lista.find(x => x.startsWith('mr_sesion='));
  return c ? c.split(';')[0] : null;
}

/* Crea una cuenta con contraseña y acceso a una barbería, directamente en la base de pruebas. */
async function crearCuenta(negocio, email, clave, rol = 'owner', barberId = null) {
  const { Pool } = require('pg');
  const { cifrarClave } = require(path.join(__dirname, '..', '..', 'autenticacion.js'));
  const url = urlBasePruebas();
  const sinSsl = new URL(url).searchParams.get('sslmode') === 'disable';
  const pool = new Pool({ connectionString: url, ssl: sinSsl ? false : { rejectUnauthorized: false }, max: 1 });
  try {
    const hash = await cifrarClave(clave);
    const ex = await pool.query('SELECT id FROM users WHERE lower(email) = lower($1)', [email]);
    const id = ex.rowCount ? ex.rows[0].id : 'usr_' + crypto.randomBytes(8).toString('hex');
    if (ex.rowCount) {
      await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [id, hash]);
    } else {
      await pool.query(
        'INSERT INTO users (id, email, name, password_hash, email_verified_at) VALUES ($1, $2, $3, $4, NOW())',
        [id, email, 'Persona de prueba', hash]);
    }
    await pool.query(
      `INSERT INTO memberships (user_id, business_id, role, barber_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, business_id) DO UPDATE SET role = EXCLUDED.role, barber_id = EXCLUDED.barber_id, status = 'active'`,
      [id, negocio, rol, barberId]);
    return id;
  } finally {
    await pool.end();
  }
}

/* Servidor nuevo en una carpeta nueva (equivale a un despliegue limpio). */
async function iniciarServidor({ db, postgres = postgresPorDefecto(), negocio, env, sesion } = {}) {
  return new Servidor(prepararCarpeta(db), { postgres, negocio, env, sesion }).iniciar();
}

/* Arranca sin esperar a que el servidor quede listo (para probar arranques que deben fallar). */
async function lanzarServidor({ db, postgres = postgresPorDefecto(), negocio, env } = {}) {
  return new Servidor(prepararCarpeta(db), { postgres, negocio, env }).arrancar();
}

/* Reinicia el proceso conservando la misma carpeta (equivale a reiniciar en un disco persistente). */
async function reiniciar(servidor) {
  await servidor.detener();
  const nuevo = new Servidor(servidor.dir, {
    postgres: servidor.postgres, negocio: servidor.negocio, env: servidor.envExtra, sesion: servidor.conSesion
  });
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

module.exports = { crearCuenta, cookieDe, iniciarServidor, lanzarServidor, reiniciar, urlBasePruebas, postgresPorDefecto, negocioNuevo, proximoDia, RAIZ, VERIFY_TOKEN };
