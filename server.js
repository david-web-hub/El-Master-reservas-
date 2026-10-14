/* =========================================================
   EL MÁSTER RESERVAS
   SERVER.JS
========================================================= */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const { AsyncLocalStorage } = require('node:async_hooks');

const app = express();

const PORT =
  process.env.PORT || 10000;

const DB_FILE =
  path.join(
    __dirname,
    'data',
    'db.json'
  );


/* =========================================================
   ALMACÉN DE LA AGENDA
   Con DATABASE_URL, reservas, barberos, servicios y horarios
   se guardan en PostgreSQL (persisten entre reinicios y
   despliegues). Sin DATABASE_URL se usa data/db.json, solo
   para desarrollo local.
========================================================= */

const {
  crearAlmacen,
  ErrorConflictoHorario,
  validarNegocio
} = require('./almacen');

const {
  crearPlataforma,
  ErrorPlataforma
} = require('./plataforma');

const {
  crearVerificador,
  clavesConfiguradas
} = require('./firma-plataforma');

const {
  archivarDemo,
  propietarioInicial
} = require('./despliegue-inicial');

const DEFAULT_BUSINESS_ID =
  validarNegocio(
    process.env.DEFAULT_BUSINESS_ID ||
    'el-master'
  );

const MODO_ALMACEN =
  process.env.DATABASE_URL
    ? 'postgres'
    : 'archivo';


/* Render define RENDER=true en sus servicios; NODE_ENV=production en otros hostings. */
function esProduccion() {

  return (
    process.env.NODE_ENV === 'production' ||
    process.env.RENDER === 'true'
  );

}


/*
  Registro de nuevas barberías: abierto en desarrollo y pruebas,
  cerrado en producción salvo que REGISTRO_ABIERTO=1.
  REGISTRO_ABIERTO=0 lo cierra en cualquier entorno.
*/
function registroAbierto() {

  if (process.env.REGISTRO_ABIERTO === '0') return false;

  /*
    En producción, además de REGISTRO_ABIERTO=1, el correo tiene que estar
    configurado: sin él nadie podría confirmar su cuenta.
  */
  if (esProduccion()) {
    return process.env.REGISTRO_ABIERTO === '1' && correoListo();
  }

  return true;

}


/* =========================================================
   POSTGRESQL
========================================================= */

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL,

  ssl:
    process.env.DATABASE_URL
      ? {
          rejectUnauthorized: false
        }
      : false
});


pool
  .connect()
  .then(client => {

    console.log(
      'POSTGRESQL CONECTADO CORRECTAMENTE'
    );

    client.release();

  })
  .catch(error => {

    console.error(
      'ERROR CONECTANDO POSTGRESQL:',
      error
    );

  });


/* =========================================================
   EXPRESS
   Se aumenta el límite porque las transferencias
   pueden incluir fotografía del comprobante.
========================================================= */

/* Render (y otros proxys) envían la IP real del cliente en X-Forwarded-For. */
app.set(
  'trust proxy',
  process.env.TRUST_PROXY
    ? Number(process.env.TRUST_PROXY)
    : (process.env.RENDER ? 1 : false)
);

app.use(
  express.json({
    limit: '5mb',
    /* Las peticiones del Panel Maestro se verifican con su cuerpo exacto (firma). */
    verify: (req, res, buf) => {
      if (req.url.startsWith('/api/plataforma/')) req.cuerpoCrudo = buf.toString('utf8');
    }
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: '5mb'
  })
);


/* =========================================================
   SEGURIDAD DE CADA PETICIÓN
   - Cabeceras de seguridad (no cambian el diseño).
   - Las peticiones que modifican datos solo se aceptan desde
     el mismo sitio (protección contra CSRF).
   - Lee la sesión (cookie HttpOnly) y la deja en req.sesion.
   - El panel (/admin.html) exige sesión: si no hay, va a la
     pantalla de acceso.
========================================================= */

const COOKIE_SESION = 'mr_sesion';

const ADMIN_SIN_CLAVE_LOCAL =
  MODO_ALMACEN === 'archivo' &&
  process.env.ADMIN_SIN_CLAVE_LOCAL === '1' &&
  !esProduccion();

function leerCookie(req, nombre) {

  for (const parte of String(req.headers.cookie || '').split(';')) {

    const i = parte.indexOf('=');

    if (i > 0 && parte.slice(0, i).trim() === nombre) {

      try {
        return decodeURIComponent(parte.slice(i + 1).trim());
      } catch (error) {
        return null;
      }

    }

  }

  return null;

}

function cookieSegura(req) {

  return (
    req.secure ||
    req.headers['x-forwarded-proto'] === 'https' ||
    process.env.COOKIE_SECURE === '1'
  );

}

function escribirCookieSesion(req, res, token, maxAgeSegundos) {

  res.append(
    'Set-Cookie',
    `${COOKIE_SESION}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; ` +
    `Max-Age=${maxAgeSegundos}` +
    (cookieSegura(req) ? '; Secure' : '')
  );

}

/* Rutas que no requieren sesión: página pública, reservas de clientes, WhatsApp y acceso. */
function esRutaPublica(req) {

  const p = req.path;
  const m = req.method;

  if (!p.startsWith('/api/')) return true;
  if (p.startsWith('/api/auth/')) return true;
  if (p.startsWith('/api/public/') && (m === 'GET' || m === 'HEAD')) return true;
  if (p === '/api/availability' && m === 'GET') return true;
  if (p === '/api/bookings' && m === 'POST') return true;
  if (p === '/api/health' && m === 'GET') return true;
  /* Panel Maestro: no usa sesión; cada petición va firmada (ver más abajo). */
  if (p.startsWith('/api/plataforma/')) return true;

  return false;

}

function origenPermitido(req) {

  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
  if (req.path.startsWith('/webhooks/')) return true;

  const origen = req.headers.origin;

  if (!origen) return true;

  try {
    return new URL(origen).host === req.headers.host;
  } catch (error) {
    return false;
  }

}

app.use(
  async (req, res, next) => {

    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'strict-origin-when-cross-origin'
    });

    if (cookieSegura(req)) {
      res.set('Strict-Transport-Security', 'max-age=15552000');
    }

    if (!origenPermitido(req)) {
      return res.status(403).json({
        ok: false,
        error: 'Solicitud no permitida desde otro sitio'
      });
    }

    req.sesion = null;

    try {

      if (ADMIN_SIN_CLAVE_LOCAL) {

        /* Solo desarrollo local sin PostgreSQL. Nunca en producción. */
        req.sesion = {
          usuario: { id: 'local', email: 'local', name: 'Local' },
          negocio: { id: DEFAULT_BUSINESS_ID, name: 'Local' },
          rol: 'owner',
          barberId: null,
          local: true
        };

      } else if (
        MODO_ALMACEN === 'postgres' &&
        almacen.info().listo
      ) {

        const token =
          leerCookie(req, COOKIE_SESION);

        if (token) {

          req.sesion =
            await autenticacion.leerSesion(token);

          req.tokenSesion = token;

        }

      }

    } catch (error) {

      console.error('ERROR LEYENDO SESIÓN:', error.message);
      req.sesion = null;

    }

    if (
      (req.path === '/admin.html' || req.path === '/admin') &&
      !req.sesion
    ) {
      res.set('Cache-Control', 'no-store');
      return res.redirect(302, '/acceso.html');
    }

    if (req.path === '/admin.html') {
      res.set('Cache-Control', 'no-store');
    }

    next();

  }
);

app.use(
  express.static(
    path.join(
      __dirname,
      'public'
    )
  )
);


/* =========================================================
   BARBERÍA DE CADA PETICIÓN
   Todas las consultas usan negocioActual().
   - Rutas de administración: la barbería de la sesión
     iniciada. Cualquier otro dato que envíe el navegador
     (cuerpo, parámetros, cabeceras) se ignora.
   - Rutas públicas: la barbería principal (la página pública
     por barbería llega en la fase 4).
========================================================= */

const contextoNegocio =
  new AsyncLocalStorage();

function negocioActual() {

  return (
    contextoNegocio.getStore()?.negocio ||
    DEFAULT_BUSINESS_ID
  );

}

function sesionActual() {

  return (
    contextoNegocio.getStore()?.sesion ||
    null
  );

}

function resolverNegocio(req) {

  if (
    !esRutaPublica(req) &&
    req.sesion
  ) {
    return req.sesion.negocio.id;
  }

  return DEFAULT_BUSINESS_ID;

}

app.use(
  async (req, res, next) => {

    try {

      const negocio =
        resolverNegocio(req);

      await almacen.cargarNegocio(
        negocio
      );

      contextoNegocio.run(
        {
          negocio,
          sesion: req.sesion,
          origen: `${req.protocol}://${req.get('host')}`
        },
        next
      );

    } catch (error) {

      next(error);

    }

  }
);


/* =========================================================
   PERMISOS POR RUTA
   Todo lo que no es público exige sesión. Cada ruta pide un
   permiso; lo que no aparece en la lista solo lo puede usar
   el propietario (se niega por defecto).
========================================================= */

const {
  crearAutenticacion,
  ErrorAuth,
  tienePermiso,
  permisosDe,
  NOMBRES_ROL
} = require('./autenticacion');

const REGLAS_PERMISO = [
  ['GET', /^\/api\/config$/, ['panel']],
  ['GET', /^\/api\/bookings$/, ['reservas', 'reservas.propias']],
  ['PATCH', /^\/api\/bookings\/[^/]+$/, ['reservas', 'reservas.propias']],
  ['POST', /^\/api\/sales$/, ['caja']],
  ['*', /^\/api\/cash\//, ['caja']],
  ['GET', /^\/api\/admin\/products$/, ['productos', 'productos.ver']],
  ['*', /^\/api\/admin\/products(\/|$)/, ['productos']],
  ['GET', /^\/api\/admin\/reports$/, ['informes']],
  ['GET', /^\/api\/admin\/backup$/, ['respaldo']],
  ['GET', /^\/api\/admin\/usuarios$/, ['usuarios.ver']],
  ['*', /^\/api\/admin\/usuarios(\/|$)/, ['usuarios']],
  ['GET', /^\/api\/admin\/invitaciones$/, ['usuarios.ver']],
  ['*', /^\/api\/admin\/invitaciones(\/|$)/, ['usuarios']],
  ['GET', /^\/api\/admin\/(services|business|barbers|settings|hours|media)$/, ['panel']],
  ['*', /^\/api\/admin\/(services|business|barbers|settings|hours|media)(\/|$)/, ['configuracion']]
];

function permisosRequeridos(req) {

  for (const [metodo, patron, permisos] of REGLAS_PERMISO) {

    if (
      (metodo === '*' || metodo === req.method) &&
      patron.test(req.path)
    ) {
      return permisos;
    }

  }

  return ['*'];

}

app.use(
  (req, res, next) => {

    if (esRutaPublica(req)) {
      return next();
    }

    if (
      MODO_ALMACEN === 'archivo' &&
      !ADMIN_SIN_CLAVE_LOCAL
    ) {
      return res.status(503).json({
        ok: false,
        error: 'La administración requiere PostgreSQL'
      });
    }

    if (!req.sesion) {
      return res.status(401).json({
        ok: false,
        error: 'Inicia sesión para continuar'
      });
    }

    const requeridos =
      permisosRequeridos(req);

    if (
      !requeridos.some(
        permiso =>
          tienePermiso(req.sesion.rol, permiso)
      )
    ) {
      return res.status(403).json({
        ok: false,
        error: 'Tu cuenta no tiene permiso para esta acción'
      });
    }

    next();

  }
);


/* Barbero con permiso solo sobre sus propias reservas. */
function soloReservasPropias() {

  const sesion =
    sesionActual();

  return Boolean(
    sesion &&
    !tienePermiso(sesion.rol, 'reservas') &&
    tienePermiso(sesion.rol, 'reservas.propias')
  );

}


/* =========================================================
   UTILIDADES
========================================================= */

function createId(prefix = 'id') {

  return (
    prefix +
    '_' +
    Date.now() +
    '_' +
    Math.random()
      .toString(36)
      .slice(2, 10)
  );

}


function safeNumber(
  value,
  fallback = 0
) {

  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;

}


function safeBoolean(
  value,
  fallback = true
) {

  if (
    value === true ||
    value === false
  ) {

    return value;

  }

  return fallback;

}


/* =========================================================
   BASE JSON ACTUAL
   Se mantiene porque Elia y las reservas actuales
   ya trabajan con esta estructura.
========================================================= */

function defaultDb() {

  return {

    business: {
      id: 'el-master',
      name: 'El Máster',
      phone: '',
      address: '',
      description: '',
      slogan:
        'TU ESTILO. NUESTRA PASIÓN.'
    },

    barbers: [
      {
        id: 'master',
        name: 'Master',
        specialty: 'Barbero',
        active: true
      }
    ],

    services: [

      {
        id: 'corte',
        name: 'Corte',
        price: 5,
        duration: 40,
        active: true,
        bookingEnabled: true,
        invoiceEnabled: true
      },

      {
        id: 'barba',
        name: 'Barba',
        price: 2,
        duration: 20,
        active: true,
        bookingEnabled: true,
        invoiceEnabled: true
      },

      {
        id: 'diseno',
        name: 'Diseño',
        price: 1.5,
        duration: 15,
        active: true,
        bookingEnabled: true,
        invoiceEnabled: true
      },

      {
        id: 'corte-barba',
        name: 'Corte + Barba',
        price: 7,
        duration: 60,
        active: true,
        bookingEnabled: true,
        invoiceEnabled: true
      },

      {
        id: 'corte-diseno',
        name: 'Corte + Diseño',
        price: 6.5,
        duration: 55,
        active: true,
        bookingEnabled: true,
        invoiceEnabled: true
      },

      {
        id: 'corte-barba-diseno',
        name:
          'Corte + Barba + Diseño',
        price: 8.5,
        duration: 75,
        active: true,
        bookingEnabled: true,
        invoiceEnabled: true
      }

    ],

    schedule: {
      open: '08:00',
      breakStart: '12:00',
      breakEnd: '13:30',
      close: '19:00',
      days: [
        1,
        2,
        3,
        4,
        5,
        6
      ]
    },

    bookings: [],

    settings: {

      paymentMethods: {
        cash: true,
        transfer: true,
        card: true
      },

      notifications: {
        bookings: true,
        lowStock: true
      },

      publicPage: {
        template: 'elegante',
        slogan:
          'TU ESTILO. NUESTRA PASIÓN.',
        published: false
      }

    }

  };

}


/* =========================================================
   NORMALIZAR DATOS DE LA AGENDA
   Completa valores que faltan (compatibilidad con datos
   creados por versiones anteriores).
========================================================= */

function normalizarDb(db) {



    const defaults =
      defaultDb();


    db.business =
      db.business ||
      defaults.business;


    db.barbers =
      Array.isArray(
        db.barbers
      )
        ? db.barbers
        : defaults.barbers;


    db.services =
      Array.isArray(
        db.services
      )
        ? db.services
        : defaults.services;


    db.bookings =
      Array.isArray(
        db.bookings
      )
        ? db.bookings
        : [];


    db.schedule =
      db.schedule ||
      defaults.schedule;


    db.settings =
      db.settings ||
      defaults.settings;


    /*
      Compatibilidad con servicios creados
      antes de la nueva administración.
    */

    db.services =
      db.services.map(
        service => ({

          ...service,

          active:
            service.active !== false,

          bookingEnabled:
            service.bookingEnabled !==
              false,

          invoiceEnabled:
            service.invoiceEnabled !==
              false

        })
      );


    return db;

}


/* =========================================================
   LEER Y GUARDAR LA AGENDA
   readDb() devuelve una copia que se puede modificar.
   writeDb() devuelve una promesa: hay que esperarla antes de
   confirmar al cliente. Si falla, no se guarda nada y la
   información anterior se conserva.
========================================================= */

const almacen =
  crearAlmacen({
    modo: MODO_ALMACEN,
    pool,
    archivo: DB_FILE,
    negocio: DEFAULT_BUSINESS_ID,
    datosIniciales: defaultDb,
    normalizar: normalizarDb,
    intervalos: (db, booking) =>
      bookingIntervals(db, booking)
  });


function readDb() {

  return almacen.leer(
    negocioActual()
  );

}


function writeDb(db) {

  return almacen.guardar(
    db,
    negocioActual()
  );

}


/* Identificadores de reserva únicos aunque lleguen dos en el mismo milisegundo. */
let ultimoIdReserva = 0;

function nuevoIdReserva() {

  ultimoIdReserva =
    Math.max(
      Date.now(),
      ultimoIdReserva + 1
    );

  return `BK-${ultimoIdReserva}`;

}


/* =========================================================
   CORREO (recuperación de contraseña e invitaciones)
   Con RESEND_API_KEY y CORREO_REMITENTE se envía de verdad.
   Sin configurar: en desarrollo se muestra en la consola; en
   producción no se envía ni se muestra el enlace.
========================================================= */

const { crearCorreo } = require('./correo');

const correo =
  crearCorreo({
    apiKey: process.env.RESEND_API_KEY || '',
    remitente: process.env.CORREO_REMITENTE || '',
    responderA: process.env.CORREO_RESPONDER_A || '',
    /* Solo para pruebas controladas: apuntar a un servidor falso en lugar de Resend. */
    apiUrl: process.env.RESEND_API_URL || 'https://api.resend.com/emails',
    produccion: esProduccion(),
    vistaPreviaDir: esProduccion() ? '' : (process.env.CORREO_VISTA_PREVIA_DIR || ''),
    timeoutMs: Number(process.env.CORREO_TIEMPO_LIMITE_MS) || 10000
  });

function enviarCorreo(mensaje) {

  return correo.enviar(mensaje);

}


/* El correo está listo para producción: credenciales y dirección pública. */
function correoListo() {

  return (
    correo.configurado &&
    Boolean(process.env.PUBLIC_BASE_URL)
  );

}


function urlPublica() {

  if (process.env.PUBLIC_BASE_URL) {
    return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  }

  /* Solo en desarrollo se usa el host de la petición (evita enlaces a dominios falsos). */
  return esProduccion()
    ? ''
    : (contextoNegocio.getStore()?.origen || '');

}


/*
  Clave para cifrar los secretos de la verificación en dos pasos.
  En producción debe definirse CLAVE_DOS_PASOS (no se inventa una);
  sin ella, la función queda desactivada. En desarrollo y pruebas
  se usa una clave local.
*/
function claveDosPasos() {

  if (process.env.CLAVE_DOS_PASOS) {
    return require('crypto')
      .createHash('sha256')
      .update(process.env.CLAVE_DOS_PASOS)
      .digest();
  }

  if (esProduccion()) return null;

  return require('crypto')
    .createHash('sha256')
    .update('solo-desarrollo-master-reservas')
    .digest();

}


const autenticacion =
  MODO_ALMACEN === 'postgres'
    ? crearAutenticacion({
        pool,
        almacen,
        enviarCorreo,
        urlBase: urlPublica,
        limiteIp:
          Number(process.env.AUTH_LIMITE_IP) || 30,
        verificarCorreo:
          process.env.VERIFICAR_CORREO !== '0',
        claveDosPasos:
          claveDosPasos(),
        catalogoPlanes:
          () => plataforma.catalogo(),
        diasPruebaPorDefecto:
          Number(process.env.DIAS_PRUEBA_POR_DEFECTO) || 7
      })
    : null;

/* Integración con el Panel Maestro (fase 6). */
const plataforma =
  MODO_ALMACEN === 'postgres'
    ? crearPlataforma({ pool })
    : null;

/* El Máster (barbería principal) y las indicadas en NEGOCIOS_PROTEGIDOS nunca se bloquean. */
const NEGOCIOS_PROTEGIDOS = [
  DEFAULT_BUSINESS_ID,
  ...String(process.env.NEGOCIOS_PROTEGIDOS || '').split(',').map(x => x.trim()).filter(Boolean)
];


/* =========================================================
   INICIALIZAR POSTGRESQL
========================================================= */

async function initPostgres() {

  /*
    VENTAS
  */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sales (

      id BIGSERIAL PRIMARY KEY,

      booking_id TEXT,

      customer_name TEXT,

      customer_phone TEXT,

      items JSONB
        NOT NULL
        DEFAULT '[]'::jsonb,

      total NUMERIC(10,2)
        NOT NULL
        DEFAULT 0,

      payment_method TEXT
        NOT NULL,

      transfer_receipt TEXT,

      note TEXT,

      status TEXT
        NOT NULL
        DEFAULT 'paid',

      sale_date DATE
        NOT NULL
        DEFAULT CURRENT_DATE,

      created_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW()

    )
  `);


  /*
    Permite actualizar instalaciones
    donde la tabla sales ya existía.
  */

  await pool.query(`
    ALTER TABLE sales
    ADD COLUMN IF NOT EXISTS
      transfer_receipt TEXT
  `);


  await pool.query(`
    ALTER TABLE sales
    ADD COLUMN IF NOT EXISTS
      note TEXT
  `);


  /*
    CAJAS DIARIAS
  */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS cash_sessions (

      id BIGSERIAL PRIMARY KEY,

      session_date DATE
        NOT NULL
        UNIQUE,

      status TEXT
        NOT NULL
        DEFAULT 'open',

      opened_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW(),

      closed_at TIMESTAMPTZ,

      closing_total
        NUMERIC(10,2)

    )
  `);


  /*
    PRODUCTOS
  */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (

      id TEXT PRIMARY KEY,

      name TEXT
        NOT NULL,

      price NUMERIC(10,2)
        NOT NULL
        DEFAULT 0,

      cost NUMERIC(10,2)
        NOT NULL
        DEFAULT 0,

      stock INTEGER
        NOT NULL
        DEFAULT 0,

      min_stock INTEGER
        NOT NULL
        DEFAULT 2,

      active BOOLEAN
        NOT NULL
        DEFAULT TRUE,

      image_url TEXT,

      created_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW(),

      updated_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW()

    )
  `);
await pool.query(`
  ALTER TABLE products
  ADD COLUMN IF NOT EXISTS image_url TEXT
`);

  /*
    CONFIGURACIÓN ADMINISTRATIVA

    Se guarda por sección para permitir
    ampliar el panel sin romper Elia.
  */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS
      admin_settings (

      section TEXT PRIMARY KEY,

      data JSONB
        NOT NULL
        DEFAULT '{}'::jsonb,

      updated_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW()

    )
  `);


  console.log(
    'TABLAS ADMINISTRATIVAS Y DE CAJA LISTAS'
  );

}


/*
  Instalación limpia (ARCHIVAR_DEMO): antes de crear o modificar cualquier
  tabla, guarda la demostración en el esquema respaldo_demo. Si no es seguro,
  el proceso se detiene y Render mantiene la versión anterior.
*/
const demoArchivada =
  MODO_ALMACEN === 'postgres'
    ? archivarDemo({ pool, confirmar: process.env.ARCHIVAR_DEMO })
        .catch(error => {
          console.error('NO SE ARRANCA:', error.message);
          process.exit(1);
        })
    : Promise.resolve();

const postgresAdministrativoListo =
  demoArchivada.then(() => initPostgres())
    .catch(error => {

      console.error(
        'ERROR INICIALIZANDO POSTGRESQL:',
        error
      );

    });


/* =========================================================
   CONFIGURACIÓN PÚBLICA
   Esta ruta ya es utilizada por el panel y por Elia.
========================================================= */

app.get(
  '/api/config',
  (req, res) => {

    try {

      const db =
        readDb();


      res.json({

        business:
          db.business,

        barbers:
          db.barbers,

        services:
          db.services,

        schedule:
          db.schedule,

        settings:
          db.settings

      });

    } catch (error) {

      console.error(
        'ERROR /api/config:',
        error
      );


      res.status(500).json({
        ok: false,
        error:
          'No se pudo cargar la configuración'
      });

    }

  }
);


/* =========================================================
   RESERVAS - LISTADO
========================================================= */

app.get(
  '/api/bookings',
  (req, res) => {

    try {

      const db =
        readDb();


      /* Un barbero solo ve sus propias reservas. */
      const lista =
        soloReservasPropias()
          ? (db.bookings || []).filter(
              item =>
                item.barberId &&
                item.barberId === sesionActual().barberId
            )
          : (db.bookings || []);


      res.json(
        lista
      );

    } catch (error) {

      console.error(
        'ERROR CONSULTANDO RESERVAS:',
        error
      );


      res.status(500).json({
        ok: false,
        error:
          'No se pudieron consultar las reservas'
      });

    }

  }
);


/* =========================================================
   ACTUALIZAR ESTADO DE RESERVA
========================================================= */

app.patch(
  '/api/bookings/:id',
  async (req, res) => {

    try {

      const db =
        readDb();


      const booking =
        db.bookings.find(
          item =>
            String(item.id) ===
            String(req.params.id) &&
            (
              !soloReservasPropias() ||
              item.barberId === sesionActual().barberId
            )
        );


      if (!booking) {

        return res
          .status(404)
          .json({
            ok: false,
            error:
              'Reserva no encontrada'
          });

      }


      const allowedStatuses = [
        'pending',
        'confirmed',
        'in_progress',
        'completed',
        'cancelled'
      ];


      if (
        req.body.status &&
        !allowedStatuses.includes(
          req.body.status
        )
      ) {

        return res
          .status(400)
          .json({
            ok: false,
            error:
              'Estado de reserva no válido'
          });

      }


      if (
        req.body.status
      ) {

        booking.status =
          req.body.status;

      }


      booking.updatedAt =
        new Date()
          .toISOString();


      await writeDb(db);


      res.json({
        ok: true,
        booking
      });

    } catch (error) {

      if (
        error instanceof
        ErrorConflictoHorario
      ) {

        return res.status(409).json({
          ok: false,
          error:
            'Ese horario ya está ocupado por otra reserva'
        });

      }


      console.error(
        'ERROR ACTUALIZANDO RESERVA:',
        error
      );


      res.status(500).json({
        ok: false,
        error:
          'No se pudo actualizar la reserva'
      });

    }

  }
);


/* =========================================================
   SERVICIOS ADMINISTRABLES
========================================================= */

app.get(
  '/api/admin/services',
  (req, res) => {

    const db =
      readDb();


    res.json({
      ok: true,
      services:
        db.services || []
    });

  }
);


/* =========================================================
   CREAR SERVICIO
========================================================= */

app.post(
  '/api/admin/services',
  async (req, res) => {

    try {

      const db =
        readDb();


      const name =
        String(
          req.body.name ||
          ''
        ).trim();


      const price =
        safeNumber(
          req.body.price,
          -1
        );


      const duration =
        safeNumber(
          req.body.duration,
          0
        );


      if (!name) {

        return res
          .status(400)
          .json({
            ok: false,
            error:
              'Escribe el nombre del servicio'
          });

      }


      if (
        price < 0
      ) {

        return res
          .status(400)
          .json({
            ok: false,
            error:
              'Precio no válido'
          });

      }


      if (
        duration <= 0
      ) {

        return res
          .status(400)
          .json({
            ok: false,
            error:
              'Duración no válida'
          });

      }


      const service = {

        id:
          createId(
            'service'
          ),

        name,

        price,

        duration,

        active:
          safeBoolean(
            req.body.active,
            true
          ),

        bookingEnabled:
          safeBoolean(
            req.body
              .bookingEnabled,
            true
          ),

        invoiceEnabled:
          safeBoolean(
            req.body
              .invoiceEnabled,
            true
          )

      };


      db.services.push(
        service
      );


      await writeDb(db);


      res.json({
        ok: true,
        service
      });

    } catch (error) {

      console.error(
        'ERROR CREANDO SERVICIO:',
        error
      );


      res.status(500).json({
        ok: false,
        error:
          'No se pudo crear el servicio'
      });

    }

  }
);


/* =========================================================
   EDITAR SERVICIO
========================================================= */

app.patch(
  '/api/admin/services/:id',
  async (req, res) => {

    try {

      const db =
        readDb();


      const service =
        db.services.find(
          item =>
            String(item.id) ===
            String(req.params.id)
        );


      if (!service) {

        return res
          .status(404)
          .json({
            ok: false,
            error:
              'Servicio no encontrado'
          });

      }


      if (
        req.body.name !==
        undefined
      ) {

        const name =
          String(
            req.body.name
          ).trim();


        if (!name) {

          return res
            .status(400)
            .json({
              ok: false,
              error:
                'Nombre no válido'
            });

        }


        service.name =
          name;

      }


      if (
        req.body.price !==
        undefined
      ) {

        const price =
          Number(
            req.body.price
          );


        if (
          !Number.isFinite(
            price
          ) ||
          price < 0
        ) {

          return res
            .status(400)
            .json({
              ok: false,
              error:
                'Precio no válido'
            });

        }


        service.price =
          price;

      }


      if (
        req.body.duration !==
        undefined
      ) {

        const duration =
          Number(
            req.body.duration
          );


        if (
          !Number.isFinite(
            duration
          ) ||
          duration <= 0
        ) {

          return res
            .status(400)
            .json({
              ok: false,
              error:
                'Duración no válida'
            });

        }


        service.duration =
          duration;

      }


      if (
        req.body.active !==
        undefined
      ) {

        service.active =
          Boolean(
            req.body.active
          );

      }


      if (
        req.body.bookingEnabled !==
        undefined
      ) {

        service.bookingEnabled =
          Boolean(
            req.body
              .bookingEnabled
          );

      }


      if (
        req.body.invoiceEnabled !==
        undefined
      ) {

        service.invoiceEnabled =
          Boolean(
            req.body
              .invoiceEnabled
          );

      }


      service.updatedAt =
        new Date()
          .toISOString();


      await writeDb(db);


      res.json({
        ok: true,
        service
      });

    } catch (error) {

      console.error(
        'ERROR EDITANDO SERVICIO:',
        error
      );


      res.status(500).json({
        ok: false,
        error:
          'No se pudo editar el servicio'
      });

    }

  }
);


/* =========================================================
   PRODUCTOS - LISTADO
========================================================= */

app.get(
  '/api/admin/products',
  async (req, res) => {

    try {

      const result =
        await pool.query(`
          SELECT
            id,
            name,
            price,
            cost,
            stock,
            min_stock,
            active,
            image_url,
            created_at,
            updated_at
          FROM products
          WHERE business_id = $1
          ORDER BY name ASC
        `, [negocioActual()]);


      const products =
        result.rows.map(
          product => ({

            id:
              product.id,

            name:
              product.name,

            price:
              Number(
                product.price
              ),

            cost:
              Number(
                product.cost
              ),

            stock:
              Number(
                product.stock
              ),

            minStock:
              Number(
                product.min_stock
              ),

            active:
              product.active,

            imageUrl:
              product.image_url,

            createdAt:
              product.created_at,

            updatedAt:
              product.updated_at

          })
        );


      res.json({
        ok: true,
        products
      });

    } catch (error) {

      console.error(
        'ERROR CONSULTANDO PRODUCTOS:',
        error
      );


      res.status(500).json({
        ok: false,
        error:
          'No se pudieron consultar los productos'
      });

    }

  }
);


/* =========================================================
   CREAR PRODUCTO
========================================================= */

app.post(
  '/api/admin/products',
  async (req, res) => {

    try {

      const name =
        String(
          req.body.name ||
          ''
        ).trim();


      const price =
        Number(
          req.body.price
        );


      const cost =
        safeNumber(
          req.body.cost,
          0
        );


      const stock =
        Math.floor(
          safeNumber(
            req.body.stock,
            0
          )
        );


      const minStock =
        Math.floor(
          safeNumber(
            req.body.minStock,
            2
          )
        );


      if (!name) {

        return res
          .status(400)
          .json({
            ok: false,
            error:
              'Escribe el nombre del producto'
          });

      }


      if (
        !Number.isFinite(
          price
        ) ||
        price < 0
      ) {

        return res
          .status(400)
          .json({
            ok: false,
            error:
              'Precio no válido'
          });

      }


      if (
        stock < 0 ||
        minStock < 0
      ) {

        return res
          .status(400)
          .json({
            ok: false,
            error:
              'Stock no válido'
          });

      }


      const id =
        createId(
          'product'
        );


      const result =
        await pool.query(
          `
        INSERT INTO products (
  id,
  name,
  price,
  cost,
  stock,
  min_stock,
  active,
  image_url,
  business_id
)
            VALUES (
              $1,
              $2,
              $3,
              $4,
              $5,
              $6,
              $7,
              $8,
              $9
            )
            RETURNING *
          `,
          [
            id,
            name,
            price,
            cost,
            stock,
            minStock,
            req.body.active !==
              false,
             req.body.image || req.body.imageUrl || null,
            negocioActual()
          ]
        );


      res.json({
        ok: true,
        product:
          result.rows[0]
      });

    } catch (error) {

      console.error(
        'ERROR CREANDO PRODUCTO:',
        error
      );


      res.status(500).json({
        ok: false,
        error:
          'No se pudo crear el producto'
      });

    }

  }
);


/* =========================================================
   EDITAR PRODUCTO
========================================================= */

app.patch(
  '/api/admin/products/:id',
  async (req, res) => {

    try {

      const existing =
        await pool.query(
          `
            SELECT *
            FROM products
            WHERE id = $1
              AND business_id = $2
            LIMIT 1
          `,
          [
            req.params.id,
            negocioActual()
          ]
        );


      if (
        existing.rows.length ===
        0
      ) {

        return res
          .status(404)
          .json({
            ok: false,
            error:
              'Producto no encontrado'
          });

      }


     const current = existing.rows[0];

const name =
  req.body.name !== undefined
    ? String(req.body.name).trim()
    : current.name;

const price =
  req.body.price !== undefined
    ? Number(req.body.price)
    : Number(current.price);

const cost =
  req.body.cost !== undefined
    ? Number(req.body.cost)
    : Number(current.cost);

const stock =
  req.body.stock !== undefined
    ? Number(req.body.stock)
    : Number(current.stock);

const minStock =
  req.body.minStock !== undefined
    ? Number(req.body.minStock)
    : Number(current.min_stock);

const active =
  req.body.active !== undefined
    ? req.body.active !== false
    : current.active;

const imageUrl =
  req.body.image !== undefined
    ? req.body.image
    : req.body.imageUrl !== undefined
      ? req.body.imageUrl
      : current.image_url;

if (!name) {
  return res.status(400).json({
    ok: false,
    error: 'Nombre de producto requerido'
  });
}

if (!Number.isFinite(price) || price < 0) {
  return res.status(400).json({
    ok: false,
    error: 'Precio inválido'
  });
}

if (!Number.isFinite(cost) || cost < 0) {
  return res.status(400).json({
    ok: false,
    error: 'Costo inválido'
  });
}

if (!Number.isFinite(stock) || stock < 0) {
  return res.status(400).json({
    ok: false,
    error: 'Stock inválido'
  });
}

if (!Number.isFinite(minStock) || minStock < 0) {
  return res.status(400).json({
    ok: false,
    error: 'Stock mínimo inválido'
  });
}

const result = await pool.query(
  `
    UPDATE products
    SET
      name = $1,
      price = $2,
      cost = $3,
      stock = $4,
      min_stock = $5,
      active = $6,
      image_url = $7,
      updated_at = NOW()
    WHERE id = $8
      AND business_id = $9
    RETURNING *
  `,
  [
    name,
    price,
    cost,
    stock,
    minStock,
    active,
    imageUrl,
    req.params.id,
    negocioActual()
  ]
);


      res.json({
        ok: true,
        product:
          result.rows[0]
      });

    } catch (error) {

      console.error(
        'ERROR EDITANDO PRODUCTO:',
        error
      );


      res.status(500).json({
        ok: false,
        error:
          'No se pudo editar el producto'
      });

    }

  }
);
/* =========================================================
   CAJA / FACTURACIÓN
========================================================= */

/*
  Obtener o crear la sesión de caja del día.
  Si la caja de hoy ya fue cerrada, no se vuelve
  a abrir automáticamente.
*/

async function getTodayCashSession(client = pool) {
  const existing =
    await client.query(`
      SELECT *
      FROM cash_sessions
      WHERE session_date = CURRENT_DATE
        AND business_id = $1
      LIMIT 1
    `, [negocioActual()]);


  if (
    existing.rows.length > 0
  ) {

    return existing.rows[0];

  }


  const created =
    await client.query(`
      INSERT INTO cash_sessions (
        session_date,
        status,
        business_id
      )
      VALUES (
        CURRENT_DATE,
        'open',
        $1
      )
      ON CONFLICT (business_id, session_date) DO NOTHING
      RETURNING *
    `, [negocioActual()]);
  if (created.rows.length) {
    return created.rows[0];
  }
  /* Otra petición la creó al mismo tiempo. */
  const again =
    await client.query(`
      SELECT *
      FROM cash_sessions
      WHERE session_date = CURRENT_DATE
        AND business_id = $1
      LIMIT 1
    `, [negocioActual()]);
  return again.rows[0];

}


/* =========================================================
   NORMALIZAR MÉTODO DE PAGO
========================================================= */

function normalizePaymentMethod(
  value
) {

  const method =
    String(
      value || ''
    )
      .trim()
      .toLowerCase();


  const allowed = [
    'cash',
    'transfer',
    'card'
  ];


  return allowed.includes(
    method
  )
    ? method
    : null;

}


/* =========================================================
   VALIDAR COMPROBANTE DE TRANSFERENCIA
========================================================= */

function validTransferReceipt(
  value
) {

  if (
    typeof value !==
    'string'
  ) {

    return false;

  }


  return (
    value.startsWith(
      'data:image/jpeg;base64,'
    ) ||
    value.startsWith(
      'data:image/png;base64,'
    ) ||
    value.startsWith(
      'data:image/webp;base64,'
    )
  );

}


/* =========================================================
   CALCULAR VENTA DESDE EL CATÁLOGO REAL
========================================================= */

async function calculateSaleItems(
  items,
  client
) {

  if (
    !Array.isArray(items) ||
    items.length === 0
  ) {

    throw new Error(
      'Agrega al menos un servicio o producto'
    );

  }


  const db =
    readDb();


  const normalized = [];

  let total = 0;


  for (
    const requestedItem
    of items
  ) {

    const type =
      String(
        requestedItem.type ||
        ''
      ).toLowerCase();


    const id =
      String(
        requestedItem.id ||
        ''
      );


    const quantity =
      Math.floor(
        Number(
          requestedItem.quantity ||
          1
        )
      );


    if (
      !id ||
      !Number.isFinite(
        quantity
      ) ||
      quantity < 1
    ) {

      throw new Error(
        'Hay un artículo no válido en la venta'
      );

    }


    /* =====================================================
       SERVICIO
    ===================================================== */

    if (
      type === 'service'
    ) {

      const service =
        db.services.find(
          item =>
            String(item.id) ===
            id
        );


      if (
        !service ||
        service.active ===
          false ||
        service.invoiceEnabled ===
          false
      ) {

        throw new Error(
          'Uno de los servicios ya no está disponible'
        );

      }


      const price =
        Number(
          service.price
        );


      const subtotal =
        Number(
          (
            price *
            quantity
          ).toFixed(2)
        );


      normalized.push({

        type:
          'service',

        id:
          service.id,

        name:
          service.name,

        price,

        quantity,

        subtotal

      });


      total +=
        subtotal;


      continue;

    }


    /* =====================================================
       PRODUCTO
    ===================================================== */

    if (
      type === 'product'
    ) {

      const result =
        await client.query(
          `
            SELECT *
            FROM products
            WHERE id = $1
              AND business_id = $2
            FOR UPDATE
          `,
          [
            id,
            negocioActual()
          ]
        );


      if (
        result.rows.length ===
        0
      ) {

        throw new Error(
          'Uno de los productos ya no existe'
        );

      }


      const product =
        result.rows[0];


      if (
        product.active !==
        true
      ) {

        throw new Error(
          `${product.name} no está disponible`
        );

      }


      if (
        Number(
          product.stock
        ) <
        quantity
      ) {

        throw new Error(
          `Stock insuficiente para ${product.name}`
        );

      }


      const price =
        Number(
          product.price
        );


      const subtotal =
        Number(
          (
            price *
            quantity
          ).toFixed(2)
        );


      normalized.push({

        type:
          'product',

        id:
          product.id,

        name:
          product.name,

        price,

        quantity,

        subtotal

      });


      total +=
        subtotal;


      continue;

    }


    throw new Error(
      'Tipo de artículo no válido'
    );

  }


  return {

    items:
      normalized,

    total:
      Number(
        total.toFixed(2)
      )

  };

}


/* =========================================================
   REGISTRAR VENTA
========================================================= */

app.post(
  '/api/sales',
  async (req, res) => {

    const client =
      await pool.connect();


    try {

      await client.query(
        'BEGIN'
      );


      const paymentMethod =
        normalizePaymentMethod(
          req.body.paymentMethod
        );


      if (
        !paymentMethod
      ) {

        await client.query(
          'ROLLBACK'
        );


        return res
          .status(400)
          .json({
            ok: false,
            error:
              'Selecciona un método de pago'
          });

      }


      const transferReceipt =
        req.body
          .transferReceipt ||
        null;


      /*
        Una transferencia no se puede registrar
        sin fotografía del comprobante.
      */

      if (
        paymentMethod ===
          'transfer' &&
        !validTransferReceipt(
          transferReceipt
        )
      ) {

        await client.query(
          'ROLLBACK'
        );


        return res
          .status(400)
          .json({
            ok: false,
            error:
              'Adjunta el comprobante de la transferencia'
          });

      }


      const cashSession =
        await getTodayCashSession(
          client
        );


      if (
        cashSession.status ===
        'closed'
      ) {

        await client.query(
          'ROLLBACK'
        );


        return res
          .status(409)
          .json({
            ok: false,
            error:
              'La caja de hoy ya está cerrada'
          });

      }


      const bookingId =
        req.body.bookingId
          ? String(
              req.body.bookingId
            )
          : null;


      /*
        Evitar cobrar dos veces la misma reserva.
      */

      if (
        bookingId
      ) {

        const duplicate =
          await client.query(
            `
              SELECT id
              FROM sales
              WHERE booking_id = $1
                AND status = 'paid'
                AND business_id = $2
              LIMIT 1
            `,
            [
              bookingId,
              negocioActual()
            ]
          );


        if (
          duplicate.rows.length >
          0
        ) {

          await client.query(
            'ROLLBACK'
          );


          return res
            .status(409)
            .json({
              ok: false,
              error:
                'Esta reserva ya fue cobrada'
            });

        }

      }


      /*
        El servidor vuelve a calcular precios
        y total usando el catálogo real.
        No confiamos únicamente en el total
        enviado por el navegador.
      */

      const calculated =
        await calculateSaleItems(
          req.body.items,
          client
        );


      /*
        Descontar inventario.
      */

      for (
        const item
        of calculated.items
      ) {

        if (
          item.type !==
          'product'
        ) {

          continue;

        }


        const updated =
          await client.query(
            `
              UPDATE products

              SET
                stock =
                  stock - $1,

                updated_at =
                  NOW()

              WHERE id = $2
                AND stock >= $1
                AND business_id = $3
              RETURNING stock
            `,
            [
              item.quantity,
              item.id,
              negocioActual()
            ]
          );


        if (
          updated.rows.length ===
          0
        ) {

          throw new Error(
            `Stock insuficiente para ${item.name}`
          );

        }

      }


      const result =
        await client.query(
          `
            INSERT INTO sales (

              booking_id,

              customer_name,

              customer_phone,

              items,

              total,

              payment_method,

              transfer_receipt,
              note,
              status,
              business_id
            )
            VALUES (
              $1,
              $2,
              $3,
              $4::jsonb,
              $5,
              $6,
              $7,
              $8,
              'paid',
              $9
            )

            RETURNING *
          `,
          [

            bookingId,

            req.body.customerName
              ? String(
                  req.body.customerName
                )
              : null,

            req.body.customerPhone
              ? String(
                  req.body.customerPhone
                )
              : null,

            JSON.stringify(
              calculated.items
            ),

            calculated.total,

            paymentMethod,

            paymentMethod ===
              'transfer'
              ? transferReceipt
              : null,

            req.body.note
              ? String(
                  req.body.note
                ).slice(
                  0,
                  1000
                )
              : null,
            negocioActual()
          ]
        );


      await client.query(
        'COMMIT'
      );


      /*
        Si la venta provino de una reserva,
        dejamos marcado el pago en la reserva
        sin afectar el funcionamiento de Elia.
      */

      if (
        bookingId
      ) {

        try {

          const db =
            readDb();


          const booking =
            db.bookings.find(
              item =>
                String(item.id) ===
                bookingId
            );


          if (
            booking
          ) {

            booking.status =
              'completed';

            booking.paymentStatus =
              'paid';

            booking.saleId =
              String(
                result.rows[0].id
              );

            booking.paidAt =
              new Date()
                .toISOString();


            await writeDb(db);

          }

        } catch (
          bookingError
        ) {

          console.error(
            'VENTA GUARDADA, PERO NO SE PUDO ACTUALIZAR LA RESERVA:',
            bookingError
          );

        }

      }


      return res.json({

        ok: true,

        message:
          'Venta registrada correctamente',

        sale: {

          ...result.rows[0],

          total:
            Number(
              result.rows[0]
                .total
            )

        }

      });

    } catch (error) {

      try {

        await client.query(
          'ROLLBACK'
        );

      } catch (_) {}


      console.error(
        'ERROR REGISTRANDO VENTA:',
        error
      );


      return res
        .status(500)
        .json({
          ok: false,
          error:
            error.message ||
            'No se pudo registrar la venta'
        });

    } finally {

      client.release();

    }

  }
);


/* =========================================================
   RESUMEN DE CAJA DEL DÍA
========================================================= */

app.get(
  '/api/cash/today',
  async (req, res) => {

    try {

      const result =
        await pool.query(`
          SELECT

            COUNT(*)::int
              AS total_sales,

            COALESCE(
              SUM(total),
              0
            )::numeric
              AS total_income,

            COALESCE(
              SUM(total)
              FILTER (
                WHERE
                  payment_method =
                  'cash'
              ),
              0
            )::numeric
              AS cash,

            COALESCE(
              SUM(total)
              FILTER (
                WHERE
                  payment_method =
                  'transfer'
              ),
              0
            )::numeric
              AS transfer,

            COALESCE(
              SUM(total)
              FILTER (
                WHERE
                  payment_method =
                  'card'
              ),
              0
            )::numeric
              AS card

          FROM sales
          WHERE
            sale_date =
              CURRENT_DATE
            AND status =
              'paid'
            AND business_id = $1
        `, [negocioActual()]);


      const productResult =
        await pool.query(`
          SELECT
            COALESCE(
              SUM(
                CASE
                  WHEN item->>'type' =
                    'product'
                  THEN
                    COALESCE(
                      (
                        item->>'quantity'
                      )::int,
                      0
                    )
                  ELSE 0
                END
              ),
              0
            )::int
              AS products_sold

          FROM sales

          CROSS JOIN LATERAL
            jsonb_array_elements(
              items
            ) AS item
          WHERE
            sale_date =
              CURRENT_DATE
            AND status =
              'paid'
            AND business_id = $1
        `, [negocioActual()]);


      const sessionResult =
        await pool.query(`
          SELECT *
          FROM cash_sessions
          WHERE
            session_date =
              CURRENT_DATE
            AND business_id = $1
          LIMIT 1
        `, [negocioActual()]);


      const row =
        result.rows[0];


      const summary = {

        total_sales:
          Number(
            row.total_sales ||
            0
          ),

        total_income:
          Number(
            row.total_income ||
            0
          ),

        cash:
          Number(
            row.cash ||
            0
          ),

        transfer:
          Number(
            row.transfer ||
            0
          ),

        card:
          Number(
            row.card ||
            0
          ),

        products_sold:
          Number(
            productResult
              .rows[0]
              ?.products_sold ||
            0
          ),

        session_status:
          sessionResult
            .rows[0]
            ?.status ||
          'open',

        closed_at:
          sessionResult
            .rows[0]
            ?.closed_at ||
          null

      };


      res.json({
        ok: true,
        summary
      });

    } catch (error) {

      console.error(
        'ERROR CONSULTANDO CAJA:',
        error
      );


      res.status(500).json({
        ok: false,
        error:
          'No se pudo consultar la caja'
      });

    }

  }
);


/* =========================================================
   CERRAR CAJA
========================================================= */

app.post(
  '/api/cash/close',
  async (req, res) => {

    const client =
      await pool.connect();


    try {

      await client.query(
        'BEGIN'
      );


      const totalResult =
        await client.query(`
          SELECT
            COALESCE(
              SUM(total),
              0
            )::numeric
              AS total

          FROM sales
          WHERE
            sale_date =
              CURRENT_DATE
            AND status =
              'paid'
            AND business_id = $1
        `, [negocioActual()]);


      const total =
        Number(
          totalResult
            .rows[0]
            .total ||
          0
        );


      const existing =
        await client.query(`
          SELECT *
          FROM cash_sessions
          WHERE
            session_date =
              CURRENT_DATE
            AND business_id = $1
          FOR UPDATE
        `, [negocioActual()]);


      let session;


      if (
        existing.rows.length >
        0
      ) {

        if (
          existing.rows[0]
            .status ===
          'closed'
        ) {

          await client.query(
            'ROLLBACK'
          );


          return res
            .status(409)
            .json({
              ok: false,
              error:
                'La caja de hoy ya fue cerrada'
            });

        }


        const result =
          await client.query(
            `
              UPDATE cash_sessions

              SET
                status =
                  'closed',

                closed_at =
                  NOW(),

                closing_total =
                  $1
              WHERE id =
                $2
                AND business_id = $3
              RETURNING *
            `,
            [
              total,
              existing.rows[0]
                .id,
              negocioActual()
            ]
          );


        session =
          result.rows[0];

      } else {

        const result =
          await client.query(
            `
              INSERT INTO cash_sessions (
                session_date,
                status,
                closed_at,
                closing_total,
                business_id
              )
              VALUES (
                CURRENT_DATE,
                'closed',
                NOW(),
                $1,
                $2
              )
              RETURNING *
            `,
            [
              total,
              negocioActual()
            ]
          );


        session =
          result.rows[0];

      }


      await client.query(
        'COMMIT'
      );


      res.json({

        ok: true,

        message:
          'Caja cerrada correctamente',

        total,

        session

      });

    } catch (error) {

      try {

        await client.query(
          'ROLLBACK'
        );

      } catch (_) {}


      console.error(
        'ERROR CERRANDO CAJA:',
        error
      );


      res.status(500).json({
        ok: false,
        error:
          'No se pudo cerrar la caja'
      });

    } finally {

      client.release();

    }

  }
);


/* =========================================================
   INFORMES
========================================================= */

app.get(
  '/api/admin/reports',
  async (req, res) => {

    try {

      const from =
        String(
          req.query.from ||
          ''
        );


      const to =
        String(
          req.query.to ||
          ''
        );


      const validDate =
        /^\d{4}-\d{2}-\d{2}$/;


      if (
        !validDate.test(from) ||
        !validDate.test(to)
      ) {

        return res
          .status(400)
          .json({
            ok: false,
            error:
              'Selecciona un rango de fechas válido'
          });

      }


      const totals =
        await pool.query(
          `
            SELECT

              COUNT(*)::int
                AS sales,

              COALESCE(
                SUM(total),
                0
              )::numeric
                AS total_income,

              COALESCE(
                SUM(total)
                FILTER (
                  WHERE
                    payment_method =
                    'cash'
                ),
                0
              )::numeric
                AS cash,

              COALESCE(
                SUM(total)
                FILTER (
                  WHERE
                    payment_method =
                    'transfer'
                ),
                0
              )::numeric
                AS transfer,

              COALESCE(
                SUM(total)
                FILTER (
                  WHERE
                    payment_method =
                    'card'
                ),
                0
              )::numeric
                AS card

            FROM sales

            WHERE
              sale_date
                BETWEEN $1
                AND $2
              AND status =
                'paid'
              AND business_id = $3
          `,
          [
            from,
            to,
            negocioActual()
          ]
        );


      const itemTotals =
        await pool.query(
          `
            SELECT

              COALESCE(
                SUM(
                  CASE
                    WHEN item->>'type' =
                      'service'
                    THEN
                      COALESCE(
                        (
                          item->>'quantity'
                        )::int,
                        0
                      )
                    ELSE 0
                  END
                ),
                0
              )::int
                AS services,

              COALESCE(
                SUM(
                  CASE
                    WHEN item->>'type' =
                      'product'
                    THEN
                      COALESCE(
                        (
                          item->>'quantity'
                        )::int,
                        0
                      )
                    ELSE 0
                  END
                ),
                0
              )::int
                AS products

            FROM sales

            CROSS JOIN LATERAL
              jsonb_array_elements(
                items
              ) AS item

            WHERE
              sale_date
                BETWEEN $1
                AND $2
              AND status =
                'paid'
              AND business_id = $3
          `,
          [
            from,
            to,
            negocioActual()
          ]
        );


      const totalsRow =
        totals.rows[0];


      const itemsRow =
        itemTotals.rows[0];


      res.json({

        ok: true,

        summary: {

          totalIncome:
            Number(
              totalsRow
                .total_income ||
              0
            ),

          sales:
            Number(
              totalsRow.sales ||
              0
            ),

          services:
            Number(
              itemsRow.services ||
              0
            ),

          products:
            Number(
              itemsRow.products ||
              0
            ),

          cash:
            Number(
              totalsRow.cash ||
              0
            ),

          transfer:
            Number(
              totalsRow.transfer ||
              0
            ),

          card:
            Number(
              totalsRow.card ||
              0
            )

        }

      });

    } catch (error) {

      console.error(
        'ERROR GENERANDO INFORME:',
        error
      );


      res.status(500).json({
        ok: false,
        error:
          'No se pudo generar el informe'
      });

    }

  }
);


/* =========================================================
   INFORMACIÓN DEL NEGOCIO
========================================================= */

app.get(
  '/api/admin/business',
  (req, res) => {

    const db =
      readDb();


    res.json({
      ok: true,
      business:
        db.business
    });

  }
);


/* =========================================================
   BARBEROS
========================================================= */

app.get(
  '/api/admin/barbers',
  (req, res) => {

    const db =
      readDb();


    res.json({
      ok: true,
      barbers:
        db.barbers || []
    });

  }
);


/* =========================================================
   CONFIGURACIÓN ADMINISTRATIVA
========================================================= */

app.get(
  '/api/admin/settings',
  async (req, res) => {

    try {

      const result =
        await pool.query(`
          SELECT
            section,
            data,
            updated_at
          FROM admin_settings
          WHERE business_id = $1
          ORDER BY section ASC
        `, [negocioActual()]);


      const settings = {};


      for (
        const row
        of result.rows
      ) {

        settings[
          row.section
        ] =
          row.data;

      }


      res.json({
        ok: true,
        settings
      });

    } catch (error) {

      console.error(
        'ERROR CONSULTANDO CONFIGURACIÓN:',
        error
      );


      res.status(500).json({
        ok: false,
        error:
          'No se pudo consultar la configuración'
      });

    }

  }
);


/* =========================================================
   GUARDAR CONFIGURACIÓN POR SECCIÓN
========================================================= */

app.post(
  '/api/admin/settings',
  async (req, res) => {

    try {

      const section =
        String(
          req.body.section ||
          ''
        )
          .trim()
          .toLowerCase();


      if (!section) {

        return res
          .status(400)
          .json({
            ok: false,
            error:
              'Falta la sección de configuración'
          });

      }


      /*
        El panel actual puede enviar solamente
        { section: "..." } en algunas secciones.

        Dejamos preparado el servidor para recibir
        data cuando implementemos cada pantalla.
      */

      const data =
        req.body.data &&
        typeof req.body.data ===
          'object' &&
        !Array.isArray(
          req.body.data
        )
          ? req.body.data
          : {};


      const result =
        await pool.query(
          `
            INSERT INTO admin_settings (
              section,
              data,
              updated_at,
              business_id
            )
            VALUES (
              $1,
              $2::jsonb,
              NOW(),
              $3
            )
            ON CONFLICT (
              business_id,
              section
            )
            DO UPDATE SET
              data =
                EXCLUDED.data,
              updated_at =
                NOW()
            RETURNING *
          `,
          [
            section,
            JSON.stringify(
              data
            ),
            negocioActual()
          ]
        );


      res.json({
        ok: true,
        setting:
          result.rows[0]
      });

    } catch (error) {

      console.error(
        'ERROR GUARDANDO CONFIGURACIÓN:',
        error
      );


      res.status(500).json({
        ok: false,
        error:
          'No se pudo guardar la configuración'
      });

    }

  }
);
/* =========================================================
   BLOQUE 3
   MOTOR DE RESERVAS + ELIA
========================================================= */

const TZ = 'America/Guayaquil';

/*
  Compatibilidad con el código original de Elia.
  El nuevo servidor usa readDb/writeDb.
*/
function readDB() {
  return readDb();
}

function writeDB(data) {
  return writeDb(data);
}


/* =========================================================
   UTILIDADES GENERALES
========================================================= */

function normalizar(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}


function parseDateLocal(dateStr) {
  const [y, m, d] =
    String(dateStr)
      .split('-')
      .map(Number);

  return new Date(
    Date.UTC(
      y,
      m - 1,
      d,
      12,
      0,
      0
    )
  );
}


function toMinutes(hhmm) {
  const [h, m] =
    String(hhmm)
      .split(':')
      .map(Number);

  return (
    h * 60 +
    m
  );
}


function toHHMM(total) {
  return (
    String(
      Math.floor(
        total / 60
      )
    ).padStart(2, '0') +
    ':' +
    String(
      total % 60
    ).padStart(2, '0')
  );
}


function formatHora(hhmm) {

  if (!hhmm) {
    return '';
  }

  const [hh, mm] =
    String(hhmm)
      .split(':')
      .map(Number);

  const ap =
    hh >= 12
      ? 'PM'
      : 'AM';

  let h =
    hh % 12;

  if (
    h === 0
  ) {
    h = 12;
  }

  return (
    `${h}:` +
    `${String(mm).padStart(2, '0')} ` +
    ap
  );
}


/* =========================================================
   FECHAS
========================================================= */

function localDateParts(
  offsetDays = 0
) {

  const now =
    new Date();


  const parts =
    new Intl.DateTimeFormat(
      'en-CA',
      {
        timeZone: TZ,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }
    ).formatToParts(now);


  const y =
    Number(
      parts.find(
        item =>
          item.type ===
          'year'
      ).value
    );


  const m =
    Number(
      parts.find(
        item =>
          item.type ===
          'month'
      ).value
    );


  const d =
    Number(
      parts.find(
        item =>
          item.type ===
          'day'
      ).value
    );


  const utc =
    new Date(
      Date.UTC(
        y,
        m - 1,
        d + offsetDays,
        12,
        0,
        0
      )
    );


  return utc
    .toISOString()
    .slice(
      0,
      10
    );
}


function dateFromSpanish(text) {

  const t =
    normalizar(text);


  if (
    /\bpasado manana\b/.test(
      t
    )
  ) {

    return localDateParts(2);

  }


  if (
    /\bmanana\b/.test(
      t
    )
  ) {

    return localDateParts(1);

  }


  if (
    /\bhoy\b/.test(
      t
    )
  ) {

    return localDateParts(0);

  }


  const iso =
    t.match(
      /\b(20\d{2})-(\d{2})-(\d{2})\b/
    );


  if (iso) {
    return iso[0];
  }


  const dm =
    t.match(
      /\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](20\d{2}))?\b/
    );


  if (dm) {

    const year =
      dm[3] ||
      localDateParts()
        .slice(
          0,
          4
        );


    return (
      `${year}-` +
      `${String(dm[2]).padStart(2, '0')}-` +
      `${String(dm[1]).padStart(2, '0')}`
    );

  }


  const weekdays = {

    domingo: 0,

    lunes: 1,

    martes: 2,

    miercoles: 3,

    jueves: 4,

    viernes: 5,

    sabado: 6

  };


  for (
    const [
      name,
      target
    ]
    of Object.entries(
      weekdays
    )
  ) {

    if (
      new RegExp(
        `\\b${name}\\b`
      ).test(t)
    ) {

      const base =
        new Date(
          localDateParts() +
          'T12:00:00-05:00'
        );


      const current =
        base.getDay();


      let add =
        (
          target -
          current +
          7
        ) % 7;


      if (
        add === 0
      ) {
        add = 7;
      }


      return localDateParts(
        add
      );

    }

  }


  return null;
}


/* =========================================================
   NÚMEROS
========================================================= */

const NUMEROS = {

  un: 1,

  uno: 1,

  una: 1,

  dos: 2,

  tres: 3,

  cuatro: 4,

  cinco: 5,

  seis: 6,

  siete: 7,

  ocho: 8,

  nueve: 9,

  diez: 10

};


function numeroNatural(value) {

  const t =
    normalizar(
      value
    ).trim();


  if (
    /^\d+$/.test(t)
  ) {

    return Number(t);

  }


  return (
    NUMEROS[t] ||
    null
  );

}


function extraerCantidadPersonas(
  text,
  allowBareNumber = false
) {

  const t =
    normalizar(
      text
    ).trim();


  const numero =
    '(\\d+|un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)';


  const patterns = [

    new RegExp(
      `\\b${numero}\\s+(?:personas?|turnos?|citas?)\\b`
    ),

    new RegExp(
      `\\b(?:somos|seremos|para|necesito|quiero|deseo)\\s+${numero}\\s*(?:personas?|turnos?|citas?)?\\b`
    )

  ];


  for (
    const re
    of patterns
  ) {

    const match =
      t.match(re);


    if (match) {

      const n =
        numeroNatural(
          match[1]
        );


      if (n) {

        return Math.min(
          10,
          Math.max(
            1,
            n
          )
        );

      }

    }

  }


  if (
    allowBareNumber
  ) {

    const n =
      numeroNatural(t);


    if (n) {

      return Math.min(
        10,
        Math.max(
          1,
          n
        )
      );

    }

  }


  return null;
}


/* =========================================================
   SERVICIOS
========================================================= */

function bookingServices(db) {

  return (
    db.services || []
  ).filter(
    service =>
      service.active !== false &&
      service.bookingEnabled !== false
  );

}


function findServiceFromText(
  text,
  db
) {

  const t =
    normalizar(text);


  /*
    Primero buscamos servicios dinámicos
    creados desde Configuración.
  */

  const dynamic =
    bookingServices(db)
      .find(
        service =>
          t.includes(
            normalizar(
              service.name
            )
          )
      );


  if (dynamic) {
    return dynamic;
  }


  /*
    Compatibilidad con los servicios
    originales de El Máster.
  */

  if (
    /corte.*barba.*disen|corte.*disen.*barba|barba.*corte.*disen/.test(
      t
    )
  ) {

    return db.services.find(
      service =>
        service.id ===
        'corte-barba-diseno'
    );

  }


  if (
    /corte.*barba|barba.*corte/.test(
      t
    )
  ) {

    return db.services.find(
      service =>
        service.id ===
        'corte-barba'
    );

  }


  if (
    /corte.*disen|disen.*corte/.test(
      t
    )
  ) {

    return db.services.find(
      service =>
        service.id ===
        'corte-diseno'
    );

  }


  if (
    /\bbarba\b/.test(t)
  ) {

    return db.services.find(
      service =>
        service.id ===
        'barba'
    );

  }


  if (
    /\bdisen/.test(t)
  ) {

    return db.services.find(
      service =>
        service.id ===
        'diseno'
    );

  }


  if (
    /\bcorte\b/.test(t)
  ) {

    return db.services.find(
      service =>
        service.id ===
        'corte'
    );

  }


  return null;
}


function findBarberFromText(
  text,
  db
) {

  const t =
    normalizar(text);


  return (
    db.barbers || []
  ).find(
    barber =>
      t.includes(
        normalizar(
          barber.name
        )
      )
  );

}


function serviceDuration(
  db,
  serviceId
) {

  return (
    db.services.find(
      service =>
        service.id ===
        serviceId
    )?.duration ||
    40
  );

}


/* =========================================================
   PERSONAS / TURNOS
========================================================= */

function crearPersonas(
  cantidad
) {

  const personas = [];


  for (
    let i = 0;
    i < cantidad;
    i++
  ) {

    personas.push({

      index:
        i + 1,

      serviceId:
        null,

      duration:
        null,

      time:
        null,

      endTime:
        null

    });

  }


  return personas;
}


function actualizarDuracionPersona(
  db,
  persona
) {

  if (
    !persona ||
    !persona.serviceId
  ) {

    return persona;

  }


  persona.duration =
    serviceDuration(
      db,
      persona.serviceId
    );


  return persona;
}


function todasPersonasConServicio(
  personas = []
) {

  return (

    personas.length > 0 &&

    personas.every(
      persona =>
        persona.serviceId &&
        Number(
          persona.duration
        ) > 0
    )

  );

}


function duracionTotalPersonas(
  personas = []
) {

  return personas.reduce(
    (
      total,
      persona
    ) =>
      total +
      (
        Number(
          persona.duration
        ) ||
        0
      ),
    0
  );

}


/* =========================================================
   DETECTAR HORA SOLICITADA
========================================================= */

function extractRequestedTime(
  text
) {

  const t =
    normalizar(
      text
    ).trim();


  const match =
    t.match(
      /\b(?:a\s+las?\s+|para\s+las?\s+|desde\s+las?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.?\s*m\.?|p\.?\s*m\.?|de la manana|de la tarde|de la noche)?\b/i
    );


  if (!match) {
    return null;
  }


  let hour =
    Number(
      match[1]
    );


  const minutes =
    Number(
      match[2] ||
      0
    );


  const period =
    normalizar(
      match[3] ||
      ''
    );


  if (
    (
      period.includes(
        'pm'
      ) ||
      period.includes(
        'p.'
      ) ||
      period.includes(
        'tarde'
      ) ||
      period.includes(
        'noche'
      )
    ) &&
    hour < 12
  ) {

    hour += 12;

  }


  if (
    (
      period.includes(
        'am'
      ) ||
      period.includes(
        'a.'
      ) ||
      period.includes(
        'manana'
      )
    ) &&
    hour === 12
  ) {

    hour = 0;

  }


  /*
    En el contexto de la barbería,
    "a las 3" o "a las 4"
    normalmente significa PM.
  */

  if (
    !period &&
    hour >= 1 &&
    hour <= 7
  ) {

    hour += 12;

  }


  if (
    hour > 23 ||
    minutes > 59
  ) {

    return null;

  }


  return (
    `${String(hour).padStart(2, '0')}:` +
    `${String(minutes).padStart(2, '0')}`
  );

}


/* =========================================================
   DURACIÓN DE RESERVAS
========================================================= */

function reservationDuration(
  db,
  serviceId,
  cantidadPersonas = 1
) {

  return (
    serviceDuration(
      db,
      serviceId
    ) *
    Math.max(
      1,
      Number(
        cantidadPersonas
      ) ||
      1
    )
  );

}


function bookingDuration(
  db,
  booking
) {

  if (
    booking.endTime &&
    booking.time
  ) {

    const duration =
      toMinutes(
        booking.endTime
      ) -
      toMinutes(
        booking.time
      );


    if (
      duration > 0
    ) {

      return duration;

    }

  }


  if (
    Array.isArray(
      booking.people
    ) &&
    booking.people.length
  ) {

    return duracionTotalPersonas(
      booking.people
    );

  }


  return reservationDuration(

    db,

    booking.serviceId,

    booking.cantidadPersonas ||
      1

  );

}


/* =========================================================
   OCUPACIÓN DE AGENDA
========================================================= */

function getBookingsForDay(
  db,
  date,
  barberId
) {

  return (
    db.bookings || []
  ).filter(
    booking =>
      booking.date ===
        date &&
      booking.barberId ===
        barberId &&
      booking.status !==
        'cancelled'
  );

}


function bookingIntervals(
  db,
  booking
) {

  if (
    Array.isArray(
      booking.people
    ) &&
    booking.people.length
  ) {

    const intervals =
      booking.people

        .filter(
          person =>
            person.time &&
            person.endTime
        )

        .map(
          person => ({

            start:
              toMinutes(
                person.time
              ),

            end:
              toMinutes(
                person.endTime
              )

          })
        );


    if (
      intervals.length
    ) {

      return intervals;

    }

  }


  if (
    booking.time
  ) {

    const start =
      toMinutes(
        booking.time
      );


    const duration =
      bookingDuration(
        db,
        booking
      );


    return [
      {
        start,
        end:
          start +
          duration
      }
    ];

  }


  return [];
}


function occupiedIntervals(
  db,
  date,
  barberId
) {

  const bookings =
    getBookingsForDay(
      db,
      date,
      barberId
    );


  const intervals = [];


  for (
    const booking
    of bookings
  ) {

    intervals.push(
      ...bookingIntervals(
        db,
        booking
      )
    );

  }


  return intervals;
}


function overlapsAny(
  start,
  end,
  intervals = []
) {

  return intervals.some(
    interval =>
      start <
        interval.end &&
      end >
        interval.start
  );

}


/* =========================================================
   HORARIO DEL BARBERO
========================================================= */

function getSchedulePeriods(
  db,
  date,
  barberId
) {

  const barber =
    (
      db.barbers ||
      []
    ).find(
      item =>
        item.id ===
          barberId &&
        item.active !==
          false
    );


  if (!barber) {
    return [];
  }


  const jsDay =
    parseDateLocal(
      date
    ).getUTCDay();


  /* Un barbero que no acepta reservas no ofrece horarios (web y Elia). */
  if (barber.acceptsBookings === false) {
    return [];
  }


  /*
    Horario configurado desde Configuración → Horarios.
    Si todavía no se ha configurado, todo sigue como antes.
  */
  const configured =
    db.hours?.[
      String(jsDay)
    ];

  if (
    Array.isArray(configured) &&
    barber.scheduleCustom !== true
  ) {
    return configured;
  }


  /*
    Primero usamos el horario individual
    del barbero, que es como funcionaba Elia.
  */

  const individual =
    barber.schedule?.[
      String(jsDay)
    ];


  if (
    Array.isArray(
      individual
    )
  ) {

    return individual;

  }


  /*
    Respaldo para la configuración general
    08:00-12:00 / 13:30-19:00.
  */

  const globalSchedule =
    db.schedule;


  if (
    globalSchedule &&
    Array.isArray(
      globalSchedule.days
    ) &&
    globalSchedule.days.includes(
      jsDay
    )
  ) {

    return [

      [
        globalSchedule.open ||
          '08:00',

        globalSchedule.breakStart ||
          '12:00'
      ],

      [
        globalSchedule.breakEnd ||
          '13:30',

        globalSchedule.close ||
          '19:00'
      ]

    ];

  }


  return [];
}


function intervalInsideSchedule(
  periods,
  start,
  end
) {

  return periods.some(
    ([from, to]) => {

      const periodStart =
        toMinutes(from);


      const periodEnd =
        toMinutes(to);


      return (
        start >=
          periodStart &&
        end <=
          periodEnd
      );

    }
  );

}


/* =========================================================
   DISPONIBILIDAD
========================================================= */

function isIntervalAvailable(
  db,
  date,
  barberId,
  start,
  duration,
  extraIntervals = []
) {

  const periods =
    getSchedulePeriods(
      db,
      date,
      barberId
    );


  const end =
    start +
    duration;


  if (
    !intervalInsideSchedule(
      periods,
      start,
      end
    )
  ) {

    return false;

  }


  const occupied = [

    ...occupiedIntervals(
      db,
      date,
      barberId
    ),

    ...extraIntervals

  ];


  return !overlapsAny(
    start,
    end,
    occupied
  );

}


function availableStartsForDuration(
  db,
  date,
  barberId,
  duration
) {

  const periods =
    getSchedulePeriods(
      db,
      date,
      barberId
    );


  const occupied =
    occupiedIntervals(
      db,
      date,
      barberId
    );


  const results = [];

  const step = 5;


  for (
    const [from, to]
    of periods
  ) {

    const start =
      toMinutes(from);


    const finish =
      toMinutes(to);


    for (
      let minute = start;
      minute + duration <=
        finish;
      minute += step
    ) {

      if (
        !overlapsAny(
          minute,
          minute +
            duration,
          occupied
        )
      ) {

        results.push(
          toHHMM(
            minute
          )
        );

      }

    }

  }


  return results;
}


/* =========================================================
   TURNOS CONSECUTIVOS
========================================================= */

function buildConsecutivePlan(
  db,
  date,
  barberId,
  people,
  requestedStart
) {

  if (
    !Array.isArray(
      people
    ) ||
    !people.length ||
    !requestedStart
  ) {

    return null;

  }


  let cursor =
    toMinutes(
      requestedStart
    );


  const plan = [];

  const tentativeIntervals =
    [];


  for (
    const originalPerson
    of people
  ) {

    const person = {
      ...originalPerson
    };


    const duration =
      Number(
        person.duration
      ) ||
      serviceDuration(
        db,
        person.serviceId
      );


    const start =
      cursor;


    const end =
      start +
      duration;


    if (
      !isIntervalAvailable(
        db,
        date,
        barberId,
        start,
        duration,
        tentativeIntervals
      )
    ) {

      return null;

    }


    person.duration =
      duration;


    person.time =
      toHHMM(start);


    person.endTime =
      toHHMM(end);


    plan.push(
      person
    );


    tentativeIntervals.push({
      start,
      end
    });


    cursor =
      end;

  }


  return plan;
}


function findConsecutiveStarts(
  db,
  date,
  barberId,
  people
) {

  if (
    !Array.isArray(
      people
    ) ||
    !people.length
  ) {

    return [];

  }


  const periods =
    getSchedulePeriods(
      db,
      date,
      barberId
    );


  const totalDuration =
    duracionTotalPersonas(
      people
    );


  const results = [];

  const step = 5;


  for (
    const [from, to]
    of periods
  ) {

    const periodStart =
      toMinutes(from);


    const periodEnd =
      toMinutes(to);


    for (
      let minute =
        periodStart;

      minute +
        totalDuration <=
        periodEnd;

      minute +=
        step
    ) {

      const start =
        toHHMM(
          minute
        );


      const plan =
        buildConsecutivePlan(
          db,
          date,
          barberId,
          people,
          start
        );


      if (plan) {

        results.push(
          start
        );

      }

    }

  }


  return results;
}


/* =========================================================
   TURNOS SEPARADOS
========================================================= */

function buildSeparatedPlan(
  db,
  date,
  barberId,
  people,
  preferredStart = null
) {

  if (
    !Array.isArray(
      people
    ) ||
    !people.length
  ) {

    return null;

  }


  const plan = [];

  const tentativeIntervals =
    [];


  let preferredMinutes =
    preferredStart
      ? toMinutes(
          preferredStart
        )
      : null;


  for (
    const originalPerson
    of people
  ) {

    const person = {
      ...originalPerson
    };


    const duration =
      Number(
        person.duration
      ) ||
      serviceDuration(
        db,
        person.serviceId
      );


    const periods =
      getSchedulePeriods(
        db,
        date,
        barberId
      );


    const candidates = [];

    const step = 5;


    for (
      const [from, to]
      of periods
    ) {

      const periodStart =
        toMinutes(from);


      const periodEnd =
        toMinutes(to);


      for (
        let minute =
          periodStart;

        minute +
          duration <=
          periodEnd;

        minute +=
          step
      ) {

        if (
          isIntervalAvailable(
            db,
            date,
            barberId,
            minute,
            duration,
            tentativeIntervals
          )
        ) {

          candidates.push(
            minute
          );

        }

      }

    }


    if (
      !candidates.length
    ) {

      return null;

    }


    if (
      preferredMinutes !==
      null
    ) {

      candidates.sort(
        (a, b) =>
          Math.abs(
            a -
            preferredMinutes
          ) -
          Math.abs(
            b -
            preferredMinutes
          )
      );

    }


    const selected =
      candidates[0];


    const end =
      selected +
      duration;


    person.duration =
      duration;


    person.time =
      toHHMM(
        selected
      );


    person.endTime =
      toHHMM(
        end
      );


    plan.push(
      person
    );


    tentativeIntervals.push({

      start:
        selected,

      end

    });


    preferredMinutes =
      end;

  }


  return plan;
}


/* =========================================================
   HORARIOS CERCANOS
========================================================= */

function nearestSlots(
  slots,
  requested,
  limit = 4
) {

  if (
    !Array.isArray(
      slots
    )
  ) {

    return [];

  }


  if (
    !requested
  ) {

    return slots.slice(
      0,
      limit
    );

  }


  const target =
    toMinutes(
      requested
    );


  return [
    ...slots
  ]
    .sort(
      (a, b) => {

        const distanceA =
          Math.abs(
            toMinutes(a) -
            target
          );


        const distanceB =
          Math.abs(
            toMinutes(b) -
            target
          );


        if (
          distanceA !==
          distanceB
        ) {

          return (
            distanceA -
            distanceB
          );

        }


        return (
          toMinutes(a) -
          toMinutes(b)
        );

      }
    )
    .slice(
      0,
      limit
    );

}


/* =========================================================
   LISTADO DE SERVICIOS
========================================================= */

function formatServiceList(
  db
) {

  return bookingServices(
    db
  )
    .map(
      (
        service,
        index
      ) =>
        `${index + 1}. ` +
        `${service.name} · ` +
        `$${service.price}`
    )
    .join('\n');

}


function serviceByOption(
  text,
  db
) {

  const value =
    String(
      text || ''
    ).trim();


  if (
    !/^\d+$/.test(
      value
    )
  ) {

    return null;

  }


  const services =
    bookingServices(
      db
    );


  const index =
    Number(value) -
    1;


  if (
    index < 0 ||
    index >=
      services.length
  ) {

    return null;

  }


  return services[
    index
  ];
}


function detectarServicioPersona(
  text,
  db
) {

  return (
    serviceByOption(
      text,
      db
    ) ||
    findServiceFromText(
      text,
      db
    )
  );

}


/* =========================================================
   SERVICIOS POR PERSONA
========================================================= */

function numeroOrdinal(text) {

  const t =
    normalizar(text);


  const values = {

    primero: 1,
    primera: 1,
    uno: 1,

    segundo: 2,
    segunda: 2,
    dos: 2,

    tercero: 3,
    tercera: 3,
    tres: 3,

    cuarto: 4,
    cuarta: 4,
    cuatro: 4,

    quinto: 5,
    quinta: 5,
    cinco: 5,

    sexto: 6,
    sexta: 6,
    seis: 6,

    septimo: 7,
    septima: 7,
    siete: 7,

    octavo: 8,
    octava: 8,
    ocho: 8,

    noveno: 9,
    novena: 9,
    nueve: 9,

    decimo: 10,
    decima: 10,
    diez: 10

  };


  for (
    const [
      word,
      value
    ]
    of Object.entries(
      values
    )
  ) {

    if (
      new RegExp(
        `\\b${word}\\b`
      ).test(t)
    ) {

      return value;

    }

  }


  const numeric =
    t.match(
      /\b(?:persona|turno)\s*(\d{1,2})\b/
    );


  if (numeric) {

    return Number(
      numeric[1]
    );

  }


  return null;
}


function splitPersonAssignments(
  text
) {

  const t =
    normalizar(text)
      .replace(
        /\s+/g,
        ' '
      )
      .trim();


  const marker =
    /\b(?:el|la)?\s*(primero|primera|segundo|segunda|tercero|tercera|cuarto|cuarta|quinto|quinta|sexto|sexta|septimo|septima|octavo|octava|noveno|novena|decimo|decima|persona\s*\d+|turno\s*\d+)\b/g;


  const matches = [
    ...t.matchAll(
      marker
    )
  ];


  if (
    !matches.length
  ) {

    return [];

  }


  const pieces = [];


  for (
    let i = 0;
    i <
      matches.length;
    i++
  ) {

    const current =
      matches[i];


    const start =
      current.index;


    const end =
      i + 1 <
        matches.length
        ? matches[
            i + 1
          ].index
        : t.length;


    pieces.push(
      t
        .slice(
          start,
          end
        )
        .trim()
    );

  }


  return pieces;
}


function parsePersonAssignments(
  text,
  db,
  cantidad
) {

  const pieces =
    splitPersonAssignments(
      text
    );


  if (
    !pieces.length
  ) {

    return null;

  }


  const assignments = [];


  for (
    const piece
    of pieces
  ) {

    const index =
      numeroOrdinal(
        piece
      );


    const service =
      findServiceFromText(
        piece,
        db
      );


    if (
      !index ||
      !service ||
      index < 1 ||
      index >
        cantidad
    ) {

      return null;

    }


    assignments.push({

      index,

      serviceId:
        service.id,

      duration:
        serviceDuration(
          db,
          service.id
        )

    });

  }


  const unique =
    new Map();


  for (
    const assignment
    of assignments
  ) {

    unique.set(
      assignment.index,
      assignment
    );

  }


  if (
    unique.size !==
    cantidad
  ) {

    return null;

  }


  const result = [];


  for (
    let index = 1;
    index <=
      cantidad;
    index++
  ) {

    const assignment =
      unique.get(
        index
      );


    if (
      !assignment
    ) {

      return null;

    }


    result.push({

      index,

      serviceId:
        assignment.serviceId,

      duration:
        assignment.duration,

      time:
        null,

      endTime:
        null

    });

  }


  return result;
}


function hasMultipleDifferentServices(
  text,
  db
) {

  const t =
    normalizar(text);


  const found = [];


  if (
    /\bcorte\b/.test(t)
  ) {

    found.push(
      'corte'
    );

  }


  if (
    /\bbarba\b/.test(t)
  ) {

    found.push(
      'barba'
    );

  }


  if (
    /\bdisen/.test(t)
  ) {

    found.push(
      'diseno'
    );

  }


  return (
    found.length > 1
  );
}


function aplicarServiciosAUnaPersona(
  db,
  personas,
  personIndex,
  service
) {

  const person =
    personas.find(
      item =>
        item.index ===
        personIndex
    );


  if (
    !person ||
    !service
  ) {

    return false;

  }


  person.serviceId =
    service.id;


  person.duration =
    serviceDuration(
      db,
      service.id
    );


  person.time =
    null;


  person.endTime =
    null;


  return true;
}


/* =========================================================
   DESCRIPCIÓN DE PERSONAS
========================================================= */

function nombreServicio(
  db,
  serviceId
) {

  return (
    db.services.find(
      service =>
        service.id ===
        serviceId
    )?.name ||
    'Servicio'
  );

}


function descripcionPersonas(
  db,
  people = [],
  includeTimes = false
) {

  return people

    .map(
      person => {

        const serviceName =
          nombreServicio(
            db,
            person.serviceId
          );


        let line =
          `👤 Turno ${person.index}: ${serviceName}`;


        if (
          person.duration
        ) {

          line +=
            ` · ${person.duration} min`;

        }


        if (
          includeTimes &&
          person.time &&
          person.endTime
        ) {

          line +=
            ` · ${formatHora(person.time)}` +
            ` – ${formatHora(person.endTime)}`;

        }


        return line;

      }
    )

    .join('\n');

}


/* =========================================================
   PLANES DE HORARIOS
========================================================= */

function planStart(
  plan = []
) {

  if (
    !plan.length
  ) {

    return null;

  }


  return (
    plan[0].time ||
    null
  );

}


function planEnd(
  plan = []
) {

  if (
    !plan.length
  ) {

    return null;

  }


  return (
    plan[
      plan.length -
      1
    ].endTime ||
    null
  );

}


function planIsConsecutive(
  plan = []
) {

  if (
    plan.length <=
    1
  ) {

    return true;

  }


  for (
    let i = 1;
    i <
      plan.length;
    i++
  ) {

    if (
      plan[
        i - 1
      ].endTime !==
      plan[i].time
    ) {

      return false;

    }

  }


  return true;
}


function clonePlan(
  plan = []
) {

  return plan.map(
    person => ({
      ...person
    })
  );

}


function samePlan(
  a = [],
  b = []
) {

  if (
    a.length !==
    b.length
  ) {

    return false;

  }


  return a.every(
    (
      person,
      index
    ) =>
      person.time ===
        b[index]?.time &&

      person.endTime ===
        b[index]?.endTime &&

      person.serviceId ===
        b[index]?.serviceId
  );

}


function formatPlanOption(
  db,
  plan,
  label = null
) {

  const lines = [];


  if (label) {

    lines.push(
      label
    );

  }


  for (
    const person
    of plan
  ) {

    lines.push(

      `Turno ${person.index}: ` +

      `${nombreServicio(
        db,
        person.serviceId
      )} · ` +

      `${formatHora(
        person.time
      )} – ` +

      `${formatHora(
        person.endTime
      )}`

    );

  }


  return lines.join(
    '\n'
  );
}


/* =========================================================
   GENERAR OPCIONES PARA VARIOS TURNOS
========================================================= */

function generateGroupOptions(
  db,
  date,
  barberId,
  people,
  requestedTime
) {

  const options = [];


  if (
    requestedTime
  ) {

    const exact =
      buildConsecutivePlan(
        db,
        date,
        barberId,
        people,
        requestedTime
      );


    if (exact) {

      options.push({

        type:
          'consecutive',

        plan:
          exact

      });

    }

  }


  const consecutiveStarts =
    findConsecutiveStarts(
      db,
      date,
      barberId,
      people
    );


  const nearby =
    nearestSlots(
      consecutiveStarts,
      requestedTime,
      4
    );


  for (
    const start
    of nearby
  ) {

    const plan =
      buildConsecutivePlan(
        db,
        date,
        barberId,
        people,
        start
      );


    if (!plan) {
      continue;
    }


    if (
      !options.some(
        option =>
          samePlan(
            option.plan,
            plan
          )
      )
    ) {

      options.push({

        type:
          'consecutive',

        plan

      });

    }

  }


  const separated =
    buildSeparatedPlan(
      db,
      date,
      barberId,
      people,
      requestedTime
    );


  if (
    separated &&
    !options.some(
      option =>
        samePlan(
          option.plan,
          separated
        )
    )
  ) {

    options.push({

      type:
        planIsConsecutive(
          separated
        )
          ? 'consecutive'
          : 'separated',

      plan:
        separated

    });

  }


  return options.slice(
    0,
    4
  );
}


function groupOptionsMessage(
  db,
  options
) {

  if (
    !options.length
  ) {

    return '';

  }


  return options

    .map(
      (
        option,
        index
      ) => {

        const title =
          option.type ===
            'separated'

            ? `*${index + 1}. TURNOS SEPARADOS*`

            : `*${index + 1}. TURNOS SEGUIDOS*`;


        return formatPlanOption(
          db,
          option.plan,
          title
        );

      }
    )

    .join(
      '\n\n'
    );

}


/* =========================================================
   CANCELACIÓN Y CIERRE
========================================================= */

function esCancelarGlobal(
  text
) {

  const t =
    normalizar(text);


  return (

    /\b(cancelar|cancela|cancelalo|cancelarla|cancelar reserva|cancelar cita|cancelar turno|salir)\b/.test(
      t
    ) ||

    /\bya no quiero reservar\b/.test(
      t
    ) ||

    /\bno quiero reservar\b/.test(
      t
    )

  );

}


function esCierreSocial(
  text
) {

  const t =
    normalizar(text);


  return (
    /\b(gracias|muchas gracias|eso es todo|nada mas|ya no necesito|no necesito mas|hasta luego|chao|adios|buen dia)\b/.test(
      t
    )
  );

}


function esConfirmar(
  text
) {

  return (
    normalizar(
      text
    ).trim() ===
    'confirmar'
  );

}


function esEditar(
  text
) {

  const t =
    normalizar(text);


  return (
    /\b(editar|modificar|cambiar)\b/.test(
      t
    )
  );

}


/* =========================================================
   SESIONES DE WHATSAPP
========================================================= */

const waSessions =
  new Map();


function resetSession(
  from
) {

  waSessions.delete(
    from
  );

}


function getSession(
  from
) {

  return (
    waSessions.get(
      from
    ) ||
    {
      step:
        'idle',

      data: {}
    }
  );

}


function saveSession(
  from,
  session
) {

  waSessions.set(
    from,
    session
  );

}


function ensureBarber(
  session,
  db
) {

  const active =
    (
      db.barbers ||
      []
    ).filter(
      barber =>
        barber.active !==
        false
    );


  if (
    !session.data.barberId &&
    active.length ===
      1
  ) {

    session.data.barberId =
      active[0].id;

  }


  return session;
}


/* =========================================================
   PERSONAS DE LA SESIÓN
========================================================= */

function ensurePeople(
  session,
  db
) {

  const cantidad =
    Math.max(
      1,
      Number(
        session.data
          .cantidadPersonas
      ) ||
      1
    );


  if (
    !Array.isArray(
      session.data.people
    ) ||
    session.data.people
      .length !==
      cantidad
  ) {

    session.data.people =
      crearPersonas(
        cantidad
      );

  }


  if (
    cantidad === 1 &&
    session.data.serviceId
  ) {

    const person =
      session.data
        .people[0];


    person.serviceId =
      session.data
        .serviceId;


    actualizarDuracionPersona(
      db,
      person
    );

  }


  return session.data.people;
}


function nextPersonWithoutService(
  people = []
) {

  return (
    people.find(
      person =>
        !person.serviceId
    ) ||
    null
  );

}


/* =========================================================
   MENSAJES DEL FLUJO
========================================================= */

function pedirCantidad(
  from,
  session
) {

  session.step =
    'people';


  saveSession(
    from,
    session
  );


  return sendWhatsApp(
    from,
    '👥 ¿Cuántos turnos necesitas reservar?'
  );

}


function pedirServicioPersona(
  from,
  db,
  session
) {

  const people =
    ensurePeople(
      session,
      db
    );


  const person =
    nextPersonWithoutService(
      people
    );


  if (!person) {

    return pedirSiguienteDato(
      from,
      db,
      session
    );

  }


  session.step =
    'person_service';


  session.data
    .currentPersonIndex =
    person.index;


  saveSession(
    from,
    session
  );


  const cantidad =
    session.data
      .cantidadPersonas ||
    1;


  const intro =
    cantidad === 1

      ? '✂️ ¿Qué servicio necesitas?\n\n'

      : `✂️ ¿Qué servicio necesita la persona ${person.index} de ${cantidad}?\n\n`;


  return sendWhatsApp(

    from,

    intro +
    formatServiceList(
      db
    )

  );

}


function pedirFecha(
  from,
  session
) {

  session.step =
    'date';


  saveSession(
    from,
    session
  );


  return sendWhatsApp(
    from,
    '📅 ¿Para qué día necesitas la reserva?'
  );

}


function pedirBarbero(
  from,
  db,
  session
) {

  const active =
    (
      db.barbers ||
      []
    ).filter(
      barber =>
        barber.active !==
        false
    );


  session.step =
    'barber';


  saveSession(
    from,
    session
  );


  return sendWhatsApp(

    from,

    '💈 ¿Con qué barbero deseas reservar?\n\n' +

    active
      .map(
        (
          barber,
          index
        ) =>
          `${index + 1}. ${barber.name}`
      )
      .join('\n')

  );

}


function pedirHora(
  from,
  session
) {

  session.step =
    'time';


  delete session.data
    .lastGroupOptions;


  saveSession(
    from,
    session
  );


  return sendWhatsApp(
    from,
    '🕐 ¿A qué hora te gustaría comenzar?'
  );

}


function pedirNombre(
  from,
  session
) {

  session.step =
    'name';


  saveSession(
    from,
    session
  );


  return sendWhatsApp(

    from,

    'Perfecto 👌 ¿A nombre de quién registro la reserva?'

  );

}


/* =========================================================
   APLICAR PLAN
========================================================= */

function aplicarPlan(
  session,
  plan
) {

  session.data.people =
    clonePlan(
      plan
    );


  session.data.time =
    planStart(
      plan
    );


  session.data.endTime =
    planEnd(
      plan
    );


  session.data.scheduleType =
    planIsConsecutive(
      plan
    )
      ? 'consecutive'
      : 'separated';


  delete session.data
    .lastGroupOptions;


  return session;
}


/* =========================================================
   PROCESAR HORA SOLICITADA
========================================================= */

async function procesarHoraSolicitada(
  from,
  db,
  session,
  requestedTime
) {

  const people =
    ensurePeople(
      session,
      db
    );


  if (
    !todasPersonasConServicio(
      people
    )
  ) {

    return pedirServicioPersona(
      from,
      db,
      session
    );

  }


  const options =
    generateGroupOptions(
      db,
      session.data.date,
      session.data.barberId,
      people,
      requestedTime
    );


  if (
    !options.length
  ) {

    session.step =
      'time';


    session.data.requestedTime =
      requestedTime;


    saveSession(
      from,
      session
    );


    return sendWhatsApp(

      from,

      '😕 No encontré horarios suficientes para completar todos los turnos ese día.\n\n' +

      'Puedes decirme otra hora o escribir “cambiar día”.'

    );

  }


  const exact =
    options.find(
      option =>
        option.type ===
          'consecutive' &&
        planStart(
          option.plan
        ) ===
          requestedTime
    );


  if (exact) {

    aplicarPlan(
      session,
      exact.plan
    );


    session.step =
      'flow';


    saveSession(
      from,
      session
    );


    return pedirSiguienteDato(
      from,
      db,
      session
    );

  }


  session.step =
    'group_options';


  session.data.requestedTime =
    requestedTime;


  session.data.lastGroupOptions =
    options;


  saveSession(
    from,
    session
  );


  return sendWhatsApp(

    from,

    `A las ${formatHora(requestedTime)} no puedo completar todos los turnos exactamente como los pediste.\n\n` +

    'Estas son las mejores opciones disponibles:\n\n' +

    groupOptionsMessage(
      db,
      options
    ) +

    '\n\nResponde con el número de la opción que prefieras.'

  );

}


/* =========================================================
   SIGUIENTE DATO
========================================================= */

async function pedirSiguienteDato(
  from,
  db,
  session
) {

  const cantidad =
    Number(
      session.data
        .cantidadPersonas
    ) ||
    0;


  if (
    !cantidad
  ) {

    return pedirCantidad(
      from,
      session
    );

  }


  ensurePeople(
    session,
    db
  );


  if (
    !todasPersonasConServicio(
      session.data.people
    )
  ) {

    return pedirServicioPersona(
      from,
      db,
      session
    );

  }


  if (
    !session.data.date
  ) {

    return pedirFecha(
      from,
      session
    );

  }


  ensureBarber(
    session,
    db
  );


  if (
    !session.data.barberId
  ) {

    return pedirBarbero(
      from,
      db,
      session
    );

  }


  const peopleHaveTimes =
    session.data.people.every(
      person =>
        person.time &&
        person.endTime
    );


  if (
    !peopleHaveTimes
  ) {

    if (
      session.data
        .requestedTime
    ) {

      return procesarHoraSolicitada(

        from,

        db,

        session,

        session.data
          .requestedTime

      );

    }


    return pedirHora(
      from,
      session
    );

  }


  if (
    !session.data.name
  ) {

    return pedirNombre(
      from,
      session
    );

  }


  return mostrarResumen(
    from,
    db,
    session
  );

}


/* =========================================================
   RESUMEN FINAL
========================================================= */

function mostrarResumen(
  from,
  db,
  session
) {

  const barberName =
    db.barbers.find(
      barber =>
        barber.id ===
        session.data
          .barberId
    )?.name ||
    'Master';


  const people =
    session.data.people ||
    [];


  const scheduleLabel =
    planIsConsecutive(
      people
    )
      ? 'Turnos seguidos'
      : 'Turnos separados';


  session.step =
    'confirm';


  saveSession(
    from,
    session
  );


  return sendWhatsApp(

    from,

    '📋 *Resumen de tu reserva*\n\n' +

    `👤 Nombre: ${session.data.name}\n` +

    `👥 Turnos: ${people.length}\n` +

    `💈 Barbero: ${barberName}\n` +

    `📅 Fecha: ${session.data.date}\n` +

    `🗓️ Modalidad: ${scheduleLabel}\n\n` +

    descripcionPersonas(
      db,
      people,
      true
    ) +

    '\n\n¿Qué deseas hacer?\n' +

    '✅ *CONFIRMAR* — guardar la reserva\n' +

    '✏️ *EDITAR* — modificarla\n' +

    '❌ *CANCELAR* — cancelar el proceso'

  );

}


/* =========================================================
   REVALIDAR DISPONIBILIDAD
========================================================= */

function planStillAvailable(
  db,
  date,
  barberId,
  people
) {

  const tentative = [];


  for (
    const person
    of people
  ) {

    if (
      !person.time ||
      !person.endTime ||
      !person.serviceId
    ) {

      return false;

    }


    const start =
      toMinutes(
        person.time
      );


    const duration =
      Number(
        person.duration
      ) ||
      serviceDuration(
        db,
        person.serviceId
      );


    if (
      !isIntervalAvailable(
        db,
        date,
        barberId,
        start,
        duration,
        tentative
      )
    ) {

      return false;

    }


    tentative.push({

      start,

      end:
        start +
        duration

    });

  }


  return true;
}


/* =========================================================
   CREAR RESERVA DESDE ELIA
========================================================= */

function crearBookingDesdeSesion(
  db,
  from,
  session
) {

  const people =
    clonePlan(
      session.data.people ||
      []
    );


  const first =
    people[0];


  return {

    id:
      nuevoIdReserva(),

    name:
      session.data.name,

    phone:
      from,

    serviceId:
      first?.serviceId ||
      null,

    cantidadPersonas:
      people.length ||
      1,

    barberId:
      session.data
        .barberId,

    date:
      session.data.date,

    time:
      first?.time ||
      null,

    endTime:
      planEnd(
        people
      ),

    people,

    scheduleType:
      planIsConsecutive(
        people
      )
        ? 'consecutive'
        : 'separated',

    source:
      'whatsapp',

    status:
      'confirmed',

    paymentStatus:
      'pending',

    createdAt:
      new Date()
        .toISOString()

  };

}


/* =========================================================
   MENSAJE DE CONFIRMACIÓN
========================================================= */

function confirmacionBooking(
  db,
  booking
) {

  const barberName =
    db.barbers.find(
      barber =>
        barber.id ===
        booking.barberId
    )?.name ||
    'Master';


  const modalidad =
    booking.scheduleType ===
      'separated'
      ? 'Turnos separados'
      : 'Turnos seguidos';


  return (

    '✅ *¡Reserva confirmada!*\n\n' +

    `👤 ${booking.name}\n` +

    `👥 ${booking.people.length} turno${
      booking.people.length === 1
        ? ''
        : 's'
    }\n` +

    `💈 ${barberName}\n` +

    `📅 ${booking.date}\n` +

    `🗓️ ${modalidad}\n\n` +

    descripcionPersonas(
      db,
      booking.people,
      true
    ) +

    '\n\n' +

    `Código: ${booking.id}\n\n` +

    'Cuando necesites otra reserva, escríbeme “quiero reservar”. 💈'

  );

}


/* =========================================================
   EDICIÓN
========================================================= */

function campoEditar(
  text
) {

  const t =
    normalizar(text);


  if (
    /\b(dia|fecha)\b/.test(
      t
    )
  ) {

    return 'date';

  }


  if (
    /\b(hora|horario)\b/.test(
      t
    )
  ) {

    return 'time';

  }


  if (
    /\b(servicio|servicios|corte|barba|diseno)\b/.test(
      t
    )
  ) {

    return 'service';

  }


  if (
    /\b(persona|personas|turno|turnos|cantidad)\b/.test(
      t
    )
  ) {

    return 'people';

  }


  if (
    /\b(barbero|barbera)\b/.test(
      t
    )
  ) {

    return 'barber';

  }


  if (
    /\bnombre\b/.test(
      t
    )
  ) {

    return 'name';

  }


  return null;
}


function limpiarHorarios(
  session
) {

  if (
    Array.isArray(
      session.data.people
    )
  ) {

    for (
      const person
      of session.data.people
    ) {

      person.time =
        null;

      person.endTime =
        null;

    }

  }


  session.data.time =
    null;


  session.data.endTime =
    null;


  delete session.data
    .lastGroupOptions;


  return session;
}
/* =========================================================
   BLOQUE 4
   RESERVAS WEB + WHATSAPP / ELIA
========================================================= */


/* =========================================================
   ETAPA 3 — CONFIGURACIÓN DEL NEGOCIO + PÁGINA PÚBLICA
   (se registra ANTES de las rutas antiguas de disponibilidad
   y de creación de reservas web, que quedan como respaldo
   sin uso porque estas versiones aceptan los mismos datos)
========================================================= */

const MEDIA_KINDS = ['logo', 'cover', 'local', 'gallery', 'barber', 'service'];
const FONT_KEYS = ['system', 'moderna', 'elegante', 'clasica'];
let mediaTableReady = false;

async function ensureMediaTable() {
  if (mediaTableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS media_assets (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  mediaTableReady = true;
}

function cleanText(value, max = 200) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanColor(value, fallback) {
  return /^#[0-9a-fA-F]{6}$/.test(String(value || '')) ? String(value) : fallback;
}

function cleanUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch (error) {
    return '';
  }
}

function validImageData(value) {
  const match = /^data:image\/(jpeg|png|webp);base64,/.exec(value || '');
  if (!match || value.length > 2500000) return false;
  return /^[A-Za-z0-9+/=]+$/.test(value.slice(match[0].length));
}

async function readSettingsMap() {
  const result = await pool.query(
    'SELECT section, data FROM admin_settings WHERE business_id = $1', [negocioActual()]);
  const map = {};
  for (const row of result.rows) map[row.section] = row.data || {};
  return map;
}

async function saveSettingSection(section, data) {
  await pool.query(
    `INSERT INTO admin_settings (section, data, updated_at, business_id)
     VALUES ($1, $2::jsonb, NOW(), $3)
     ON CONFLICT (business_id, section) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [section, JSON.stringify(data), negocioActual()]
  );
}

function nowMinutesLocal() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date());
  const h = Number(parts.find(p => p.type === 'hour').value) % 24;
  const m = Number(parts.find(p => p.type === 'minute').value);
  return h * 60 + m;
}

function isRealDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const d = new Date(value + 'T12:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function parseServiceIds(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(list.map(item => String(item).trim()).filter(Boolean))].slice(0, 8);
}

function barberDoesService(barber, serviceId) {
  return !Array.isArray(barber.serviceIds) ||
    barber.serviceIds.length === 0 ||
    barber.serviceIds.includes(serviceId);
}

/* Fuente única para web: valida barbero + servicios y suma duración. */
function resolveBookingServices(db, barberId, ids) {
  if (!ids.length) return { status: 400, error: 'Selecciona al menos un servicio' };

  const barber = db.barbers.find(item => item.id === barberId && item.active !== false);
  if (!barber || barber.acceptsBookings === false) {
    return { status: 404, error: 'Barbero no disponible' };
  }

  const services = [];
  for (const id of ids) {
    const service = db.services.find(item =>
      item.id === id && item.active !== false && item.bookingEnabled !== false);
    if (!service) return { status: 404, error: 'Servicio no disponible' };
    if (!barberDoesService(barber, id)) {
      return { status: 400, error: `${service.name} no lo realiza este barbero` };
    }
    services.push(service);
  }

  const total = services.reduce((sum, s) => sum + Number(s.duration || 0), 0);
  if (!(total > 0)) return { status: 400, error: 'Duración no válida' };
  return { barber, services, total };
}

/* Horario semanal configurable (0=domingo … 6=sábado). */
function weeklyHours(db) {
  const out = {};
  const barber = (db.barbers || []).find(b => b.active !== false);

  for (let day = 0; day < 7; day++) {
    const key = String(day);
    const saved = db.hoursConfig?.[key];
    if (saved) { out[key] = saved; continue; }

    let periods = Array.isArray(barber?.schedule?.[key]) ? barber.schedule[key] : null;
    if (!periods && db.schedule && Array.isArray(db.schedule.days)) {
      periods = db.schedule.days.includes(day)
        ? [[db.schedule.open || '08:00', db.schedule.breakStart || '12:00'],
           [db.schedule.breakEnd || '13:30', db.schedule.close || '19:00']]
        : [];
    }
    periods = periods || [];

    out[key] = periods.length === 0
      ? { open: false, from: '08:00', to: '19:00', breakFrom: '', breakTo: '' }
      : {
          open: true,
          from: periods[0][0],
          to: periods[periods.length - 1][1],
          breakFrom: periods.length > 1 ? periods[0][1] : '',
          breakTo: periods.length > 1 ? periods[1][0] : ''
        };
  }
  return out;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

app.get('/api/admin/hours', (req, res) => {
  res.json({ ok: true, hours: weeklyHours(readDb()), custom: Boolean(readDb().hours) });
});

app.put('/api/admin/hours', async (req, res) => {
  try {
    const input = req.body?.hours;
    if (!input || typeof input !== 'object') {
      return res.status(400).json({ ok: false, error: 'Faltan los horarios' });
    }

    const config = {};
    const periods = {};

    for (let day = 0; day < 7; day++) {
      const key = String(day);
      const d = input[key] || {};
      const open = d.open === true;
      const entry = {
        open,
        from: String(d.from || '08:00'),
        to: String(d.to || '19:00'),
        breakFrom: String(d.breakFrom || ''),
        breakTo: String(d.breakTo || '')
      };

      if (open) {
        if (!HHMM.test(entry.from) || !HHMM.test(entry.to) || toMinutes(entry.from) >= toMinutes(entry.to)) {
          return res.status(400).json({ ok: false, error: `Horario no válido (día ${day})` });
        }
        const hasBreak = entry.breakFrom || entry.breakTo;
        if (hasBreak) {
          if (!HHMM.test(entry.breakFrom) || !HHMM.test(entry.breakTo) ||
              !(toMinutes(entry.from) < toMinutes(entry.breakFrom) &&
                toMinutes(entry.breakFrom) < toMinutes(entry.breakTo) &&
                toMinutes(entry.breakTo) < toMinutes(entry.to))) {
            return res.status(400).json({ ok: false, error: `Descanso no válido (día ${day})` });
          }
          periods[key] = [[entry.from, entry.breakFrom], [entry.breakTo, entry.to]];
        } else {
          entry.breakFrom = ''; entry.breakTo = '';
          periods[key] = [[entry.from, entry.to]];
        }
      } else {
        periods[key] = [];
      }
      config[key] = entry;
    }

    const db = readDb();
    db.hoursConfig = config;
    db.hours = periods;
    await writeDb(db);
    res.json({ ok: true, hours: config });
  } catch (error) {
    console.error('ERROR GUARDANDO HORARIOS:', error);
    res.status(500).json({ ok: false, error: 'No se pudieron guardar los horarios' });
  }
});

/* ---------------- NEGOCIO ---------------- */

app.put('/api/admin/business', async (req, res) => {
  try {
    const b = req.body || {};
    const data = {
      name: cleanText(b.name, 80),
      phone: cleanText(b.phone, 30),
      email: cleanText(b.email, 120),
      address: cleanText(b.address, 200),
      description: cleanText(b.description, 500),
      mapQuery: cleanText(b.mapQuery, 200),
      mapUrl: cleanUrl(b.mapUrl),
      instagram: cleanUrl(b.instagram),
      tiktok: cleanUrl(b.tiktok),
      facebook: cleanUrl(b.facebook)
    };
    if (!data.name) {
      return res.status(400).json({ ok: false, error: 'Escribe el nombre del negocio' });
    }
    if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
      return res.status(400).json({ ok: false, error: 'Correo no válido' });
    }

    await saveSettingSection('negocio', data);

    const db = readDb();
    db.business = { ...db.business, name: data.name, phone: data.phone,
      email: data.email, address: data.address, description: data.description };
    await writeDb(db);

    res.json({ ok: true, business: data });
  } catch (error) {
    console.error('ERROR GUARDANDO NEGOCIO:', error);
    res.status(500).json({ ok: false, error: 'No se pudo guardar la información' });
  }
});

/* ---------------- BARBEROS (nunca se borran) ---------------- */

function applyBarberFields(db, barber, body, isNew) {
  if (body.name !== undefined || isNew) {
    const name = cleanText(body.name, 60);
    if (!name) return 'Escribe el nombre del barbero';
    barber.name = name;
  }
  if (body.phone !== undefined) barber.phone = cleanText(body.phone, 30);
  if (body.description !== undefined) barber.description = cleanText(body.description, 300);
  if (body.acceptsBookings !== undefined) barber.acceptsBookings = body.acceptsBookings === true;
  if (body.active !== undefined) barber.active = body.active === true;
  if (body.serviceIds !== undefined) {
    if (!Array.isArray(body.serviceIds)) return 'Servicios no válidos';
    const known = new Set(db.services.map(s => s.id));
    const ids = [...new Set(body.serviceIds.map(String))];
    if (ids.some(id => !known.has(id))) return 'Hay servicios que no existen';
    barber.serviceIds = ids;
  }
  return null;
}

app.post('/api/admin/barbers', async (req, res) => {
  try {
    const db = readDb();
    const barber = { id: createId('barber'), active: true, acceptsBookings: true, serviceIds: [] };
    const error = applyBarberFields(db, barber, req.body || {}, true);
    if (error) return res.status(400).json({ ok: false, error });
    db.barbers.push(barber);
    await writeDb(db);
    res.status(201).json({ ok: true, barber });
  } catch (error) {
    console.error('ERROR CREANDO BARBERO:', error);
    res.status(500).json({ ok: false, error: 'No se pudo crear el barbero' });
  }
});

app.patch('/api/admin/barbers/:id', async (req, res) => {
  try {
    const db = readDb();
    const barber = db.barbers.find(b => String(b.id) === String(req.params.id));
    if (!barber) return res.status(404).json({ ok: false, error: 'Barbero no encontrado' });

    const error = applyBarberFields(db, barber, req.body || {}, false);
    if (error) return res.status(400).json({ ok: false, error });

    const today = localDateParts(0);
    const upcoming = db.bookings.filter(b =>
      b.barberId === barber.id && b.status !== 'cancelled' &&
      b.status !== 'completed' && String(b.date) >= today).length;

    await writeDb(db);
    res.json({ ok: true, barber, upcomingBookings: upcoming });
  } catch (error) {
    console.error('ERROR EDITANDO BARBERO:', error);
    res.status(500).json({ ok: false, error: 'No se pudo editar el barbero' });
  }
});

/* ---------------- IMÁGENES (PostgreSQL) ---------------- */

app.get('/api/admin/media', async (req, res) => {
  try {
    await ensureMediaTable();
    const r = await pool.query(
      'SELECT id, kind, created_at, updated_at FROM media_assets WHERE business_id = $1 ORDER BY created_at ASC',
      [negocioActual()]);
    res.json({ ok: true, media: r.rows });
  } catch (error) {
    console.error('ERROR LISTANDO MEDIA:', error);
    res.status(500).json({ ok: false, error: 'No se pudieron consultar las imágenes' });
  }
});

app.post('/api/admin/media', async (req, res) => {
  try {
    const kind = String(req.body?.kind || '');
    const image = String(req.body?.image || '');
    const ref = String(req.body?.ref || '').replace(/[^A-Za-z0-9_-]/g, '');

    if (!MEDIA_KINDS.includes(kind)) {
      return res.status(400).json({ ok: false, error: 'Tipo de imagen no válido' });
    }
    if (!validImageData(image)) {
      return res.status(400).json({ ok: false, error: 'Imagen no válida o demasiado grande' });
    }

    let id = kind;
    if (kind === 'gallery') {
      id = createId('gallery');
    } else if (kind === 'barber' || kind === 'service') {
      const db = readDb();
      const list = kind === 'barber' ? db.barbers : db.services;
      if (!ref || !list.some(item => item.id === ref)) {
        return res.status(404).json({ ok: false, error: 'Elemento no encontrado' });
      }
      id = `${kind}_${ref}`;
    }

    await ensureMediaTable();
    await pool.query(
      `INSERT INTO media_assets (id, kind, data, created_at, updated_at, business_id)
       VALUES ($1, $2, $3, NOW(), NOW(), $4)
       ON CONFLICT (business_id, id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [id, kind, image, negocioActual()]
    );
    res.json({ ok: true, id, kind });
  } catch (error) {
    console.error('ERROR GUARDANDO IMAGEN:', error);
    res.status(500).json({ ok: false, error: 'No se pudo guardar la imagen' });
  }
});

/* Solo elimina la imagen; nunca borra barberos, servicios ni reservas. */
app.delete('/api/admin/media/:id', async (req, res) => {
  try {
    await ensureMediaTable();
    const id = String(req.params.id).replace(/[^A-Za-z0-9_-]/g, '');
    const r = await pool.query('DELETE FROM media_assets WHERE id = $1 AND business_id = $2', [id, negocioActual()]);
    res.json({ ok: true, deleted: r.rowCount || 0 });
  } catch (error) {
    console.error('ERROR ELIMINANDO IMAGEN:', error);
    res.status(500).json({ ok: false, error: 'No se pudo eliminar la imagen' });
  }
});

app.get('/api/public/media/:id', async (req, res) => {
  try {
    await ensureMediaTable();
    const id = String(req.params.id).replace(/[^A-Za-z0-9_-]/g, '');
    const r = await pool.query('SELECT data FROM media_assets WHERE id = $1 AND business_id = $2', [id, negocioActual()]);
    if (!r.rows.length) return res.status(404).end();
    const data = r.rows[0].data;
    const match = /^data:(image\/(?:jpeg|png|webp));base64,/.exec(data);
    if (!match) return res.status(404).end();
    res.set({
      'Content-Type': match[1],
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff'
    });
    res.send(Buffer.from(data.slice(match[0].length), 'base64'));
  } catch (error) {
    console.error('ERROR SIRVIENDO IMAGEN:', error);
    res.status(500).end();
  }
});

/* ---------------- RESPALDO ADMINISTRATIVO ---------------- */
app.get('/api/admin/backup', async (req, res) => {
  try {
    const db = readDb();
    let settings = {};
    try { settings = await readSettingsMap(); } catch (error) { console.error('ERROR LEYENDO SETTINGS PARA RESPALDO:', error); }
    const backup = { version: 1, generatedAt: new Date().toISOString(), business: db.business || {}, barbers: db.barbers || [], services: db.services || [], schedule: db.schedule || {}, hoursConfig: db.hoursConfig || {}, hours: db.hours || {}, agendaSettings: db.settings || {}, bookings: db.bookings || [], settings };
    const stamp = localDateParts(0);
    res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="el-master-respaldo-${stamp}.json"`, 'Cache-Control': 'no-store' });
    res.send(JSON.stringify(backup, null, 2));
  } catch (error) {
    console.error('ERROR GENERANDO RESPALDO:', error);
    res.status(500).json({ ok: false, error: 'No se pudo generar el respaldo' });
  }
});

/* ---------------- DATOS PÚBLICOS (sin secretos) ---------------- */

app.get('/api/public/site', async (req, res) => {
  const db = readDb();
  let s = {};
  let media = [];

  try {
    await ensureMediaTable();
    s = await readSettingsMap();
    media = (await pool.query(
      'SELECT id, kind, updated_at FROM media_assets WHERE business_id = $1 ORDER BY created_at ASC',
      [negocioActual()])).rows;
  } catch (error) {
    console.error('ERROR /api/public/site (PostgreSQL):', error);
  }

  const has = new Map(media.map(m => [m.id, m]));
  const url = id => has.has(id)
    ? `/api/public/media/${id}?v=${new Date(has.get(id).updated_at).getTime()}`
    : null;

  const neg = s.negocio || {};
  const pag = s.pagina || {};
  const apa = s.apariencia || {};
  const mul = s.multimedia || {};
  const adv = s.avanzada || {};
  const b = db.business || {};

  const services = db.services
    .filter(x => x.active !== false && x.bookingEnabled !== false)
    .map(x => ({
      id: x.id, name: cleanText(x.name, 80),
      price: Number(x.price) || 0, duration: Number(x.duration) || 0,
      image: url('service_' + x.id)
    }));
  const bookable = services.map(x => x.id);

  const barbers = db.barbers.filter(x => x.active !== false).map(x => ({
    id: x.id, name: cleanText(x.name, 60),
    description: cleanText(x.description, 300),
    acceptsBookings: x.acceptsBookings !== false,
    photo: url('barber_' + x.id),
    serviceIds: (Array.isArray(x.serviceIds) && x.serviceIds.length ? x.serviceIds : bookable)
      .filter(id => bookable.includes(id))
  }));

  const videos = (Array.isArray(mul.videos) ? mul.videos : []).slice(0, 12)
    .map(v => ({ title: cleanText(v.title, 80), url: cleanUrl(v.url) }))
    .filter(v => v.url);

  res.json({
    ok: true,
    business: {
      name: cleanText(neg.name || b.name, 80),
      phone: cleanText(neg.phone ?? b.phone, 30),
      email: cleanText(neg.email ?? b.email, 120),
      address: cleanText(neg.address ?? b.address, 200),
      description: cleanText(neg.description ?? b.description, 500),
      mapQuery: cleanText(neg.mapQuery, 200),
      mapUrl: cleanUrl(neg.mapUrl),
      instagram: cleanUrl(neg.instagram),
      tiktok: cleanUrl(neg.tiktok),
      facebook: cleanUrl(neg.facebook)
    },
    page: {
      title: cleanText(pag.title, 80),
      slogan: cleanText(pag.slogan, 120),
      description: cleanText(pag.description, 300),
      welcome: cleanText(pag.welcome, 300),
      ctaText: cleanText(pag.ctaText, 30) || 'Reservar ahora',
      template: ['elegante', 'moderna', 'minimalista'].includes(pag.template) ? pag.template : 'elegante'
    },
    theme: {
      primary: cleanColor(apa.primary, '#d4af37'),
      secondary: cleanColor(apa.secondary, '#1a1a1a'),
      background: cleanColor(apa.background, '#080808'),
      text: cleanColor(apa.text, '#ffffff'),
      font: FONT_KEYS.includes(apa.font) ? apa.font : 'system'
    },
    media: {
      logo: url('logo'), cover: url('cover'), local: url('local'),
      gallery: media.filter(m => m.kind === 'gallery').map(m => url(m.id))
    },
    advanced: { footerText: cleanText(adv.footerText, 120), radius: Math.max(0, Math.min(40, Number(adv.radius) || 16)), showGallery: adv.showGallery !== false, showVideos: adv.showVideos !== false, showSocial: adv.showSocial !== false },
    videos,
    services,
    barbers,
    hours: weeklyHours(db)
  });
});

/* ---------------- DISPONIBILIDAD (web y Elia comparten motor) ---------------- */

app.get('/api/availability', (req, res) => {
  try {
    const { date, barberId } = req.query;
    const ids = parseServiceIds(req.query.serviceIds ?? req.query.serviceId);

    if (!date || !barberId || !ids.length) {
      return res.status(400).json({ ok: false, error: 'date, barberId y serviceIds son obligatorios' });
    }
    if (!isRealDate(date)) {
      return res.status(400).json({ ok: false, error: 'Fecha no válida' });
    }

    const db = readDb();
    const resolved = resolveBookingServices(db, String(barberId), ids);
    if (resolved.error) {
      return res.status(resolved.status).json({ ok: false, error: resolved.error });
    }

    const today = localDateParts(0);
    let slots = date < today
      ? []
      : availableStartsForDuration(db, date, String(barberId), resolved.total);

    if (date === today) {
      const now = nowMinutesLocal();
      slots = slots.filter(time => toMinutes(time) > now);
    }

    res.json({
      ok: true, date, barberId, serviceId: ids[0], serviceIds: ids,
      duration: resolved.total, slots
    });
  } catch (error) {
    console.error('ERROR CONSULTANDO DISPONIBILIDAD:', error);
    res.status(500).json({ ok: false, error: 'No se pudo consultar la disponibilidad' });
  }
});

/* ---------------- CREAR RESERVA WEB (uno o varios servicios) ---------------- */

app.post('/api/bookings', async (req, res) => {
  try {
    /* Suscripción vencida o suspendida: se conservan los datos y las reservas, pero no se aceptan nuevas. */
    if (plataforma) {
      const sus = await plataforma.suscripcion(negocioActual());
      if (sus && !sus.canBook) {
        return res.status(403).json({
          ok: false,
          code: 'SUSCRIPCION_VENCIDA',
          error: 'Esta barbería no está recibiendo reservas en línea en este momento.'
        });
      }
    }

    const { name, phone, barberId, date, time } = req.body || {};
    const ids = parseServiceIds(req.body?.serviceIds ?? req.body?.serviceId);

    const cleanName = cleanText(name, 80);
    const cleanPhone = cleanText(phone, 30);

    if (cleanName.length < 2 || !cleanPhone || !barberId || !date || !time) {
      return res.status(400).json({ ok: false, error: 'Faltan datos obligatorios' });
    }
    if (!/^\+?[\d\s()-]{7,20}$/.test(cleanPhone)) {
      return res.status(400).json({ ok: false, error: 'Teléfono no válido' });
    }
    if (!isRealDate(date) || !HHMM.test(String(time))) {
      return res.status(400).json({ ok: false, error: 'Fecha u hora no válidas' });
    }

    const db = readDb();
    const resolved = resolveBookingServices(db, String(barberId), ids);
    if (resolved.error) {
      return res.status(resolved.status === 404 ? 400 : resolved.status)
        .json({ ok: false, error: resolved.error });
    }

    const today = localDateParts(0);
    const start = toMinutes(time);
    if (date < today || (date === today && start <= nowMinutesLocal())) {
      return res.status(400).json({ ok: false, error: 'Esa hora ya pasó. Elige otra.' });
    }

    if (!isIntervalAvailable(db, date, String(barberId), start, resolved.total)) {
      return res.status(409).json({ ok: false, error: 'Ese horario acaba de ocuparse. Elige otro.' });
    }

    let cursor = start;
    const people = resolved.services.map(service => {
      const duration = Number(service.duration);
      const entry = {
        index: 1, serviceId: service.id, duration,
        time: toHHMM(cursor), endTime: toHHMM(cursor + duration)
      };
      cursor += duration;
      return entry;
    });

    const booking = {
      id: nuevoIdReserva(),
      name: cleanName,
      phone: cleanPhone,
      serviceId: ids[0],
      serviceIds: ids,
      barberId: String(barberId),
      date,
      time: toHHMM(start),
      endTime: toHHMM(start + resolved.total),
      totalDuration: resolved.total,
      cantidadPersonas: 1,
      people,
      scheduleType: 'consecutive',
      source: 'web',
      status: 'confirmed',
      paymentStatus: 'pending',
      createdAt: new Date().toISOString()
    };

    db.bookings.push(booking);
    await writeDb(db);
    res.status(201).json({ ok: true, booking });
  } catch (error) {
    if (error instanceof ErrorConflictoHorario) {
      return res.status(409).json({ ok: false, error: 'Ese horario acaba de ocuparse. Elige otro.' });
    }
    console.error('ERROR CREANDO RESERVA WEB:', error);
    res.status(500).json({ ok: false, error: 'No se pudo crear la reserva' });
  }
});


/* =========================================================
   VERIFICACIÓN DEL WEBHOOK DE WHATSAPP
========================================================= */

app.get(
  '/webhooks/whatsapp',
  (req, res) => {

    const mode =
      req.query[
        'hub.mode'
      ];


    const token =
      req.query[
        'hub.verify_token'
      ];


    const challenge =
      req.query[
        'hub.challenge'
      ];


    if (
      mode ===
        'subscribe' &&
      token ===
        process.env
          .WHATSAPP_VERIFY_TOKEN
    ) {

      console.log(
        'WEBHOOK WHATSAPP VERIFICADO'
      );


      return res
        .status(200)
        .send(
          challenge
        );

    }


    return res
      .sendStatus(403);

  }
);


/* =========================================================
   ENVIAR MENSAJE POR WHATSAPP
========================================================= */

async function sendWhatsApp(
  to,
  body
) {

  const token =
    process.env
      .WHATSAPP_TOKEN;


  const phoneId =
    process.env
      .WHATSAPP_PHONE_NUMBER_ID;


  const version =
    process.env
      .WHATSAPP_GRAPH_VERSION ||
    'v23.0';


  if (
    !token ||
    !phoneId
  ) {

    console.log(
      '[DEMO WhatsApp]',
      to,
      body
    );


    return;

  }


  try {

    const response =
      await fetch(

        `https://graph.facebook.com/${version}/${phoneId}/messages`,

        {

          method:
            'POST',

          headers: {

            Authorization:
              `Bearer ${token}`,

            'Content-Type':
              'application/json'

          },

          body:
            JSON.stringify({

              messaging_product:
                'whatsapp',

              to,

              type:
                'text',

              text: {
                body
              }

            })

        }

      );


    if (
      !response.ok
    ) {

      const errorText =
        await response.text();


      console.error(
        'ERROR ENVIANDO WHATSAPP:',
        response.status,
        errorText
      );

    }

  } catch (error) {

    console.error(
      'ERROR DE CONEXIÓN CON WHATSAPP:',
      error
    );

  }

}


/* =========================================================
   FUNCIONES PARA EDICIÓN DE RESERVA
========================================================= */

async function pedirCampoEdicion(
  from,
  db,
  session,
  field
) {

  if (
    field ===
    'date'
  ) {

    return sendWhatsApp(
      from,
      '📅 ¿Para qué nuevo día deseas la reserva?'
    );

  }


  if (
    field ===
    'time'
  ) {

    return sendWhatsApp(
      from,
      '🕐 ¿A qué nueva hora te gustaría comenzar?'
    );

  }


  if (
    field ===
    'service'
  ) {

    const people =
      ensurePeople(
        session,
        db
      );


    if (
      people.length ===
      1
    ) {

      return sendWhatsApp(

        from,

        '✂️ ¿Qué nuevo servicio deseas?\n\n' +

        formatServiceList(
          db
        )

      );

    }


    return sendWhatsApp(

      from,

      '✂️ Indícame qué turno deseas cambiar y el nuevo servicio.\n\n' +

      'Ejemplo: “turno 2 barba”.\n\n' +

      formatServiceList(
        db
      )

    );

  }


  if (
    field ===
    'people'
  ) {

    return sendWhatsApp(
      from,
      '👥 ¿Cuántos turnos deseas reservar ahora?'
    );

  }


  if (
    field ===
    'barber'
  ) {

    const active =
      (
        db.barbers ||
        []
      ).filter(
        barber =>
          barber.active !==
          false
      );


    return sendWhatsApp(

      from,

      '💈 Elige el nuevo barbero:\n\n' +

      active
        .map(
          (
            barber,
            index
          ) =>
            `${index + 1}. ${barber.name}`
        )
        .join('\n')

    );

  }


  if (
    field ===
    'name'
  ) {

    return sendWhatsApp(
      from,
      '👤 ¿A qué nombre deseas cambiar la reserva?'
    );

  }


  return sendWhatsApp(
    from,
    'Dime qué deseas cambiar: día, hora, servicio, personas, barbero o nombre.'
  );

}


/* =========================================================
   PROCESAR EDICIÓN
========================================================= */

async function procesarEdicion(
  from,
  db,
  session,
  text
) {

  const field =
    session.data
      .editField;


  if (
    field ===
    'date'
  ) {

    const date =
      dateFromSpanish(
        text
      );


    if (!date) {

      return sendWhatsApp(
        from,
        'No pude reconocer el día. Puedes escribir, por ejemplo: “mañana”, “viernes” o “10/10”.'
      );

    }


    session.data.date =
      date;


    limpiarHorarios(
      session
    );


    delete session.data
      .editField;


    session.step =
      'flow';


    saveSession(
      from,
      session
    );


    return pedirSiguienteDato(
      from,
      db,
      session
    );

  }


  if (
    field ===
    'time'
  ) {

    const requestedTime =
      extractRequestedTime(
        text
      );


    if (!requestedTime) {

      return sendWhatsApp(
        from,
        'No pude reconocer la hora. Por ejemplo: “3 pm”, “15:00” o “4:30 pm”.'
      );

    }


    limpiarHorarios(
      session
    );


    session.data
      .requestedTime =
      requestedTime;


    delete session.data
      .editField;


    session.step =
      'flow';


    saveSession(
      from,
      session
    );


    return procesarHoraSolicitada(
      from,
      db,
      session,
      requestedTime
    );

  }


  if (
    field ===
    'service'
  ) {

    const people =
      ensurePeople(
        session,
        db
      );


    if (
      people.length ===
      1
    ) {

      const service =
        detectarServicioPersona(
          text,
          db
        );


      if (!service) {

        return sendWhatsApp(

          from,

          'No pude reconocer el servicio.\n\n' +

          formatServiceList(
            db
          )

        );

      }


      aplicarServiciosAUnaPersona(
        db,
        people,
        1,
        service
      );


      session.data
        .serviceId =
        service.id;


      limpiarHorarios(
        session
      );


      delete session.data
        .editField;


      session.step =
        'flow';


      saveSession(
        from,
        session
      );


      return pedirSiguienteDato(
        from,
        db,
        session
      );

    }


    const personIndex =
      numeroOrdinal(
        text
      );


    const service =
      findServiceFromText(
        text,
        db
      );


    if (
      !personIndex ||
      !service ||
      personIndex >
        people.length
    ) {

      return sendWhatsApp(
        from,
        'Indícame el turno y el servicio. Ejemplo: “turno 2 barba”.'
      );

    }


    aplicarServiciosAUnaPersona(
      db,
      people,
      personIndex,
      service
    );


    limpiarHorarios(
      session
    );


    delete session.data
      .editField;


    session.step =
      'flow';


    saveSession(
      from,
      session
    );


    return pedirSiguienteDato(
      from,
      db,
      session
    );

  }


  if (
    field ===
    'people'
  ) {

    const cantidad =
      extraerCantidadPersonas(
        text,
        true
      );


    if (
      !cantidad ||
      cantidad < 1 ||
      cantidad > 10
    ) {

      return sendWhatsApp(
        from,
        'Indícame una cantidad entre 1 y 10 turnos.'
      );

    }


    session.data
      .cantidadPersonas =
      cantidad;


    session.data.people =
      crearPersonas(
        cantidad
      );


    delete session.data
      .serviceId;


    limpiarHorarios(
      session
    );


    delete session.data
      .editField;


    session.step =
      'flow';


    saveSession(
      from,
      session
    );


    return pedirSiguienteDato(
      from,
      db,
      session
    );

  }


  if (
    field ===
    'barber'
  ) {

    const active =
      (
        db.barbers ||
        []
      ).filter(
        barber =>
          barber.active !==
          false
      );


    let barber =
      findBarberFromText(
        text,
        db
      );


    const numeric =
      numeroNatural(
        String(text)
          .trim()
      );


    if (
      !barber &&
      numeric &&
      active[
        numeric - 1
      ]
    ) {

      barber =
        active[
          numeric - 1
        ];

    }


    if (!barber) {

      return pedirCampoEdicion(
        from,
        db,
        session,
        'barber'
      );

    }


    session.data
      .barberId =
      barber.id;


    limpiarHorarios(
      session
    );


    delete session.data
      .editField;


    session.step =
      'flow';


    saveSession(
      from,
      session
    );


    return pedirSiguienteDato(
      from,
      db,
      session
    );

  }


  if (
    field ===
    'name'
  ) {

    const name =
      String(text)
        .trim();


    if (
      name.length <
      2
    ) {

      return sendWhatsApp(
        from,
        'Escríbeme el nombre con el que deseas registrar la reserva.'
      );

    }


    session.data.name =
      name;


    delete session.data
      .editField;


    session.step =
      'flow';


    saveSession(
      from,
      session
    );


    return pedirSiguienteDato(
      from,
      db,
      session
    );

  }


  delete session.data
    .editField;


  session.step =
    'flow';


  saveSession(
    from,
    session
  );


  return pedirSiguienteDato(
    from,
    db,
    session
  );

}


/* =========================================================
   WEBHOOK PRINCIPAL DE WHATSAPP
========================================================= */

app.post(
  '/webhooks/whatsapp',
  async (req, res) => {

    console.log(
      'WEBHOOK WHATSAPP RECIBIDO'
    );


    /*
      Respondemos inmediatamente a Meta.
      Así evitamos que Meta reenvíe el mismo
      mensaje mientras Elia lo procesa.
    */

    res.sendStatus(200);


    try {

      const value =
        req.body?.entry?.[0]
          ?.changes?.[0]
          ?.value;


      const msg =
        value?.messages?.[0];


      if (!msg) {
        return;
      }


      const from =
        msg.from;


      const text =
        (
          msg.text?.body ||
          ''
        ).trim();


      if (!text) {

        return sendWhatsApp(

          from,

          'Por ahora puedo ayudarte por texto. ' +

          'Escríbeme qué necesitas reservar. 💈'

        );

      }


      const lower =
        normalizar(
          text
        );


      const db =
        readDB();

      let eliaSettings = {};
      try {
        const allSettings = await readSettingsMap();
        eliaSettings = allSettings.mensajes || {};
      } catch (error) {
        console.error('ERROR CARGANDO CONFIGURACIÓN DE ELIA:', error);
      }

      if (eliaSettings.enabled === false) {
        return;
      }

      let session =
        getSession(
          from
        );


      /* =====================================================
         CANCELAR DESDE CUALQUIER PUNTO
      ===================================================== */

      if (
        esCancelarGlobal(
          text
        )
      ) {

        resetSession(
          from
        );


        return sendWhatsApp(

          from,

          eliaSettings.cancel || (
            '❌ Listo. El proceso de reserva quedó cancelado.\n\n' +
            'No se guardó ninguna cita. Cuando quieras comenzar otra, ' +
            'escríbeme “quiero reservar”. 💈'
          )

        );

      }


      /* =====================================================
         CIERRE SOCIAL
      ===================================================== */

      if (
        esCierreSocial(
          text
        ) &&
        session.step !==
          'confirm'
      ) {

        resetSession(
          from
        );


        return sendWhatsApp(

          from,

          eliaSettings.closing || (
            '😊 ¡Con gusto! Fue un placer atenderte.\n\n' +
            'Cuando necesites otra cita, escríbeme “quiero reservar”. 💈'
          )

        );

      }


      /* =====================================================
         CONFIRMACIÓN FINAL
      ===================================================== */

      if (
        session.step ===
        'confirm'
      ) {

        if (
          esEditar(
            text
          )
        ) {

          session.step =
            'edit';


          delete session.data
            .editField;


          saveSession(
            from,
            session
          );


          const directField =
            campoEditar(
              text
            );


          if (
            directField
          ) {

            session.data
              .editField =
              directField;


            saveSession(
              from,
              session
            );


            return pedirCampoEdicion(

              from,

              db,

              session,

              directField

            );

          }


          return sendWhatsApp(

            from,

            '✏️ Claro. ¿Qué deseas editar?\n\n' +

            'Puedes escribir:\n' +

            '• día\n' +

            '• hora\n' +

            '• servicio\n' +

            '• personas\n' +

            '• barbero\n' +

            '• nombre'

          );

        }


        if (
          !esConfirmar(
            text
          )
        ) {

          return sendWhatsApp(

            from,

            'Responde *CONFIRMAR*, *EDITAR* o *CANCELAR* para continuar.'

          );

        }


        /*
          Releer la agenda justo antes de guardar
          evita que dos clientes ocupen el mismo
          horario mientras conversan con Elia.
        */

        const fresh =
          readDB();


        const people =
          session.data.people ||
          [];


        if (
          !planStillAvailable(

            fresh,

            session.data.date,

            session.data
              .barberId,

            people

          )
        ) {

          limpiarHorarios(
            session
          );


          session.data
            .requestedTime =
            null;


          session.step =
            'time';


          saveSession(
            from,
            session
          );


          return sendWhatsApp(

            from,

            '⚠️ Uno de esos horarios acaba de ocuparse antes de confirmar.\n\n' +

            'Dime otra hora y buscaré nuevamente opciones para todos los turnos.'

          );

        }


        const booking =
          crearBookingDesdeSesion(

            fresh,

            from,

            session

          );


        fresh.bookings.push(
          booking
        );


        /*
          La reserva solo se confirma al cliente cuando quedó
          guardada. Si otro cliente tomó el horario en ese
          instante, se piden otras opciones como antes.
        */
        try {

          await writeDB(
            fresh
          );

        } catch (saveError) {

          if (
            saveError instanceof
            ErrorConflictoHorario
          ) {

            limpiarHorarios(
              session
            );

            session.data
              .requestedTime =
              null;

            session.step =
              'time';

            saveSession(
              from,
              session
            );

            return sendWhatsApp(

              from,

              '⚠️ Uno de esos horarios acaba de ocuparse antes de confirmar.\n\n' +

              'Dime otra hora y buscaré nuevamente opciones para todos los turnos.'

            );

          }

          console.error(
            'ERROR GUARDANDO RESERVA DE ELIA:',
            saveError
          );

          return sendWhatsApp(

            from,

            '⚠️ No pude guardar tu reserva por un problema técnico.\n\n' +

            'Escribe *CONFIRMAR* en unos minutos para intentarlo de nuevo.'

          );

        }


        resetSession(
          from
        );


        return sendWhatsApp(

          from,

          confirmacionBooking(
            fresh,
            booking
          )

        );

      }


      /* =====================================================
         EDICIÓN
      ===================================================== */

      if (
        session.step ===
        'edit'
      ) {

        if (
          !session.data
            .editField
        ) {

          const field =
            campoEditar(
              text
            );


          if (!field) {

            return sendWhatsApp(

              from,

              'Dime qué deseas cambiar: ' +

              '*día*, *hora*, *servicio*, *personas*, *barbero* o *nombre*.'

            );

          }


          session.data
            .editField =
            field;


          saveSession(
            from,
            session
          );


          return pedirCampoEdicion(

            from,

            db,

            session,

            field

          );

        }


        return procesarEdicion(

          from,

          db,

          session,

          text

        );

      }


      /* =====================================================
         SALUDO
      ===================================================== */

      const greeting =
        /^(hola|buenas|buenos dias|buenas tardes|buenas noches|hey|ola)\b/.test(
          lower
        );


      const reservationIntent =
        /\b(reserv|agend|cita|turno|corte|barba|diseno)\b/.test(
          lower
        );


      if (
        greeting &&
        session.step ===
          'idle' &&
        !reservationIntent
      ) {

        return sendWhatsApp(

          from,

          eliaSettings.welcome || (
            '👋 ¡Hola! Bienvenido a El Máster 💈\n\n' +
            'Con gusto puedo ayudarte.\n' +
            'Dime cuántos turnos deseas reservar.'
          )

        );

      }


      /* =====================================================
         NUEVA RESERVA
      ===================================================== */

      if (
        session.step ===
          'idle' &&
        (
          reservationIntent ||

          /\b(quiero|necesito|deseo).*(reserv|cita|turno)\b/.test(
            lower
          )
        )
      ) {

        session = {

          step:
            'flow',

          data: {}

        };


        saveSession(
          from,
          session
        );

      }


      /*
        Si llega otro mensaje con Elia en reposo,
        iniciamos el flujo para no dejar al cliente
        sin respuesta.
      */

      if (
        session.step ===
        'idle'
      ) {

        session = {

          step:
            'flow',

          data: {}

        };


        saveSession(
          from,
          session
        );

      }
            /* =====================================================
         CANTIDAD DE PERSONAS
      ===================================================== */

      if (
        session.step ===
        'people'
      ) {

        const cantidad =
          extraerCantidadPersonas(
            text,
            true
          );


        if (
          !cantidad ||
          cantidad < 1 ||
          cantidad > 10
        ) {

          return sendWhatsApp(
            from,
            '👥 Indícame cuántos turnos necesitas, entre 1 y 10.'
          );

        }


        session.data
          .cantidadPersonas =
          cantidad;


        session.data.people =
          crearPersonas(
            cantidad
          );


        delete session.data
          .serviceId;


        limpiarHorarios(
          session
        );


        session.step =
          'flow';


        saveSession(
          from,
          session
        );


        return pedirSiguienteDato(
          from,
          db,
          session
        );

      }


      /* =====================================================
         SERVICIO DE CADA PERSONA
      ===================================================== */

      if (
        session.step ===
        'person_service'
      ) {

        const people =
          ensurePeople(
            session,
            db
          );


        const currentIndex =
          session.data
            .currentPersonIndex ||

          nextPersonWithoutService(
            people
          )?.index;


        /*
          Si son varias personas, primero intentamos
          reconocer una frase completa como:

          "el primero corte y barba
           y el segundo solo corte"
        */

        if (
          session.data
            .cantidadPersonas >
          1
        ) {

          const assignments =
            parsePersonAssignments(

              text,

              db,

              session.data
                .cantidadPersonas

            );


          if (
            assignments
          ) {

            session.data.people =
              assignments;


            delete session.data
              .currentPersonIndex;


            limpiarHorarios(
              session
            );


            session.step =
              'flow';


            saveSession(
              from,
              session
            );


            return pedirSiguienteDato(

              from,

              db,

              session

            );

          }


          /*
            Si el cliente escribe una frase ambigua
            como "un corte y una barba",
            no adivinamos qué servicio corresponde
            a cada persona.
          */

          if (
            hasMultipleDifferentServices(
              text,
              db
            ) &&
            !numeroOrdinal(
              text
            )
          ) {

            return sendWhatsApp(

              from,

              'Para no equivocarme necesito saber qué servicio corresponde a cada persona. 👍\n\n' +

              'Por ejemplo:\n' +

              '“El primero corte y el segundo barba”\n\n' +

              'o dime ahora solamente el servicio de la persona ' +

              `${currentIndex}.`

            );

          }

        }


        const service =
          detectarServicioPersona(
            text,
            db
          );


        if (
          !service
        ) {

          return sendWhatsApp(

            from,

            '✂️ No pude reconocer ese servicio.\n\n' +

            formatServiceList(
              db
            ) +

            '\n\nResponde con el número o escribe el servicio.'

          );

        }


        aplicarServiciosAUnaPersona(

          db,

          people,

          currentIndex,

          service

        );


        /*
          Compatibilidad con reservas
          individuales.
        */

        if (
          people.length ===
          1
        ) {

          session.data
            .serviceId =
            service.id;

        }


        delete session.data
          .currentPersonIndex;


        limpiarHorarios(
          session
        );


        session.step =
          'flow';


        saveSession(
          from,
          session
        );


        return pedirSiguienteDato(

          from,

          db,

          session

        );

      }


      /* =====================================================
         FECHA
      ===================================================== */

      if (
        session.step ===
        'date'
      ) {

        const date =
          dateFromSpanish(
            text
          );


        if (
          !date
        ) {

          return sendWhatsApp(

            from,

            '📅 No pude reconocer esa fecha.\n\n' +

            'Puedes decir “mañana”, “viernes” o escribir una fecha.'

          );

        }


        session.data.date =
          date;


        limpiarHorarios(
          session
        );


        session.step =
          'flow';


        saveSession(
          from,
          session
        );


        return pedirSiguienteDato(

          from,

          db,

          session

        );

      }


      /* =====================================================
         BARBERO
      ===================================================== */

      if (
        session.step ===
        'barber'
      ) {

        const active =
          db.barbers.filter(
            barber =>
              barber.active !==
              false
          );


        let chosen =
          null;


        if (
          /^\d+$/.test(
            text.trim()
          )
        ) {

          chosen =
            active[
              Number(
                text.trim()
              ) - 1
            ];

        }


        if (
          !chosen
        ) {

          chosen =
            findBarberFromText(
              text,
              db
            );

        }


        if (
          !chosen
        ) {

          return pedirBarbero(

            from,

            db,

            session

          );

        }


        session.data
          .barberId =
          chosen.id;


        limpiarHorarios(
          session
        );


        session.step =
          'flow';


        saveSession(
          from,
          session
        );


        return pedirSiguienteDato(

          from,

          db,

          session

        );

      }


      /* =====================================================
         HORA
      ===================================================== */

      if (
        session.step ===
        'time'
      ) {

        /*
          Permitir cambiar el día directamente
          mientras estamos escogiendo horario.
        */

        if (
          /\b(cambiar|otro).*(dia|fecha)\b/.test(
            lower
          )
        ) {

          session.data.date =
            null;


          session.data
            .requestedTime =
            null;


          limpiarHorarios(
            session
          );


          return pedirFecha(
            from,
            session
          );

        }


        const requested =
          extractRequestedTime(
            text
          );


        if (
          !requested
        ) {

          return sendWhatsApp(

            from,

            '🕐 Dime una hora, por ejemplo “3 PM”, “4:10” o “a las 5 de la tarde”.'

          );

        }


        session.data
          .requestedTime =
          requested;


        saveSession(
          from,
          session
        );


        return procesarHoraSolicitada(

          from,

          db,

          session,

          requested

        );

      }


      /* =====================================================
         ELEGIR OPCIÓN DE HORARIOS
      ===================================================== */

      if (
        session.step ===
        'group_options'
      ) {

        const options =
          session.data
            .lastGroupOptions ||
          [];


        const selectedNumber =
          /^\d+$/.test(
            text.trim()
          )

            ? Number(
                text.trim()
              )

            : null;


        if (
          !selectedNumber ||
          selectedNumber < 1 ||
          selectedNumber >
            options.length
        ) {

          /*
            También puede escribir otra hora
            sin seleccionar una de las opciones.
          */

          const anotherTime =
            extractRequestedTime(
              text
            );


          if (
            anotherTime
          ) {

            session.data
              .requestedTime =
              anotherTime;


            return procesarHoraSolicitada(

              from,

              db,

              session,

              anotherTime

            );

          }


          return sendWhatsApp(

            from,

            'Responde con el número de la opción que prefieras, o dime otra hora.'

          );

        }


        const selected =
          options[
            selectedNumber -
            1
          ];


        aplicarPlan(

          session,

          selected.plan

        );


        session.step =
          'flow';


        saveSession(
          from,
          session
        );


        return pedirSiguienteDato(

          from,

          db,

          session

        );

      }


      /* =====================================================
         NOMBRE
      ===================================================== */

      if (
        session.step ===
        'name'
      ) {

        if (
          text.trim()
            .length <
          2
        ) {

          return sendWhatsApp(

            from,

            'Dime el nombre con el que deseas registrar la reserva.'

          );

        }


        session.data.name =
          text.trim();


        session.step =
          'flow';


        saveSession(
          from,
          session
        );


        return pedirSiguienteDato(

          from,

          db,

          session

        );

      }


      /* =====================================================
         FLUJO GENERAL
      ===================================================== */

      return pedirSiguienteDato(

        from,

        db,

        session

      );


    } catch (
      error
    ) {

      console.error(

        'WHATSAPP WEBHOOK ERROR:',

        error

      );

    }

  }
);


/* =========================================================
   RUTA DE ESTADO
========================================================= */

app.get(
  '/api/health',
  async (req, res) => {

    try {

      await pool.query(
        'SELECT 1'
      );


      res.json({

        ok: true,

        app:
          'El Master Reservas',

        database:
          'connected',

        storage:
          almacen.info().modo,

        businessId:
          almacen.info().negocio,

        overlapConstraint:
          almacen.info().restriccionSolapes,

        timestamp:
          new Date()
            .toISOString()

      });

    } catch (
      error
    ) {

      res.status(500)
        .json({

          ok: false,

          database:
            'error'

        });

    }

  }
);


/* =========================================================
   CUENTAS: REGISTRO, ACCESO Y RECUPERACIÓN
   Las respuestas nunca incluyen el identificador de sesión
   (va solo en la cookie HttpOnly) ni revelan si un correo
   está registrado.
========================================================= */

function datosCliente(req) {

  return {
    ip: req.ip,
    userAgent: req.headers['user-agent']
  };

}

function responderErrorAuth(res, error, contexto) {

  if (error instanceof ErrorAuth) {

    const cuerpo = {
      ok: false,
      error: error.message,
      code: error.code
    };

    if (error.negocios) cuerpo.businesses = error.negocios;

    return res.status(error.status).json(cuerpo);

  }

  console.error(`ERROR ${contexto}:`, error);

  return res.status(500).json({
    ok: false,
    error: 'No se pudo completar la operación'
  });

}

function requiereAutenticacion(res) {

  if (!autenticacion) {

    res.status(503).json({
      ok: false,
      error: 'Las cuentas requieren PostgreSQL'
    });

    return false;

  }

  return true;

}

function descripcionSesion(sesion) {

  return {
    ok: true,
    user: sesion.usuario,
    business: sesion.negocio,
    role: sesion.rol,
    roleName: NOMBRES_ROL[sesion.rol] || sesion.rol,
    barberId: sesion.barberId || null,
    twoFactor: Boolean(sesion.dosPasos),
    permissions: [...permisosDe(sesion.rol)]
  };

}

const SEGUNDOS_SESION = 14 * 24 * 3600;

app.post('/api/auth/registro', async (req, res) => {

  if (!requiereAutenticacion(res)) return;

  if (!registroAbierto()) {
    return res.status(403).json({ ok: false, error: 'El registro de nuevas barberías no está disponible' });
  }

  try {

    const r =
      await autenticacion.registrar(req.body || {}, datosCliente(req));

    if (r.token) {
      escribirCookieSesion(req, res, r.token, SEGUNDOS_SESION);
    }

    res.status(201).json({
      ok: true,
      verificationRequired: r.verificacionPendiente,
      emailSent: r.correoEnviado,
      user: r.usuario,
      business: r.negocio,
      role: r.rol
    });

  } catch (error) {

    responderErrorAuth(res, error, 'REGISTRANDO CUENTA');

  }

});

app.post('/api/auth/login', async (req, res) => {

  if (!requiereAutenticacion(res)) return;

  try {

    const b = req.body || {};

    const r =
      await autenticacion.iniciarSesion(
        { email: b.email, password: b.password, businessId: b.businessId },
        datosCliente(req)
      );

    /* Falta el segundo paso: el desafío va en una cookie HttpOnly de 5 minutos. */
    if (r.requiereDosPasos) {
      res.append(
        'Set-Cookie',
        `${COOKIE_DOS_PASOS}=${encodeURIComponent(r.desafio)}; Path=/api/auth; HttpOnly; SameSite=Strict; Max-Age=300` +
        (cookieSegura(req) ? '; Secure' : '')
      );
      return res.status(202).json({ ok: true, twoFactorRequired: true });
    }

    /* Una sesión anterior en este navegador se cierra. */
    if (req.tokenSesion) {
      await autenticacion.cerrarSesion(req.tokenSesion).catch(() => {});
    }

    escribirCookieSesion(req, res, r.token, SEGUNDOS_SESION);

    res.json({
      ok: true,
      user: r.usuario,
      business: r.negocio,
      role: r.rol
    });

  } catch (error) {

    responderErrorAuth(res, error, 'INICIANDO SESIÓN');

  }

});

app.post('/api/auth/logout', async (req, res) => {

  try {

    if (autenticacion && req.tokenSesion) {
      await autenticacion.cerrarSesion(req.tokenSesion, datosCliente(req));
    }

  } catch (error) {

    console.error('ERROR CERRANDO SESIÓN:', error.message);

  }

  escribirCookieSesion(req, res, '', 0);

  res.json({ ok: true });

});

app.get('/api/auth/sesion', async (req, res) => {

  res.set('Cache-Control', 'no-store');

  if (!req.sesion) {
    return res.status(401).json({ ok: false, error: 'No has iniciado sesión' });
  }

  const descripcion = descripcionSesion(req.sesion);

  /* Estado de la suscripción para el aviso de renovación del panel. */
  if (plataforma && !req.sesion.local) {
    try {
      descripcion.subscription = await plataforma.suscripcion(req.sesion.negocio.id);
    } catch (error) {
      console.error('ERROR LEYENDO SUSCRIPCIÓN:', error.message);
    }
  }

  res.json(descripcion);

});

app.post('/api/auth/recuperar', async (req, res) => {

  if (!requiereAutenticacion(res)) return;

  try {

    await autenticacion.solicitarRecuperacion(req.body?.email, datosCliente(req));

  } catch (error) {

    if (error instanceof ErrorAuth && error.status === 429) {
      return responderErrorAuth(res, error, 'RECUPERANDO');
    }

    console.error('ERROR SOLICITANDO RECUPERACIÓN:', error.message);

  }

  res.json({
    ok: true,
    message: 'Si el correo está registrado, recibirás un enlace para crear una nueva contraseña.'
  });

});

app.post('/api/auth/restablecer', async (req, res) => {

  if (!requiereAutenticacion(res)) return;

  try {

    await autenticacion.restablecerClave(req.body?.token, req.body?.password, datosCliente(req));

    res.json({ ok: true, message: 'Contraseña actualizada. Ya puedes iniciar sesión.' });

  } catch (error) {

    responderErrorAuth(res, error, 'RESTABLECIENDO CONTRASEÑA');

  }

});

app.post('/api/auth/cambiar-clave', async (req, res) => {

  if (!requiereAutenticacion(res)) return;

  if (!req.sesion || req.sesion.local) {
    return res.status(401).json({ ok: false, error: 'Inicia sesión para continuar' });
  }

  try {

    await autenticacion.cambiarClave(
      req.sesion, req.body?.currentPassword, req.body?.newPassword, req.tokenSesion, datosCliente(req));

    res.json({ ok: true, message: 'Contraseña actualizada. Las demás sesiones se cerraron.' });

  } catch (error) {

    responderErrorAuth(res, error, 'CAMBIANDO CONTRASEÑA');

  }

});


const COOKIE_DOS_PASOS = 'mr_dos_pasos';

/* Qué ofrece la pantalla de acceso (sin datos sensibles). */
app.get('/api/auth/config', (req, res) => {

  res.set('Cache-Control', 'no-store');

  res.json({
    ok: true,
    accounts: Boolean(autenticacion),
    registrationOpen: Boolean(autenticacion) && registroAbierto(),
    emailVerification: process.env.VERIFICAR_CORREO !== '0',
    twoFactorAvailable: Boolean(autenticacion && autenticacion.disponibleDosPasos())
  });

});

app.post('/api/auth/verificar', async (req, res) => {

  if (!requiereAutenticacion(res)) return;

  try {

    await autenticacion.confirmarCorreo(req.body?.token, datosCliente(req));

    res.json({ ok: true, message: 'Correo confirmado. Ya puedes iniciar sesión.' });

  } catch (error) {

    responderErrorAuth(res, error, 'VERIFICANDO CORREO');

  }

});

app.post('/api/auth/verificacion/reenviar', async (req, res) => {

  if (!requiereAutenticacion(res)) return;

  try {

    await autenticacion.reenviarVerificacion(req.body?.email, datosCliente(req));

  } catch (error) {

    if (error instanceof ErrorAuth && error.status === 429) {
      return responderErrorAuth(res, error, 'REENVIANDO VERIFICACIÓN');
    }

    console.error('ERROR REENVIANDO VERIFICACIÓN:', error.message);

  }

  res.json({
    ok: true,
    message: 'Si la cuenta está pendiente de confirmar, enviamos un nuevo enlace a ese correo.'
  });

});

app.post('/api/auth/2fa/verificar', async (req, res) => {

  if (!requiereAutenticacion(res)) return;

  try {

    const r =
      await autenticacion.completarDosPasos(
        leerCookie(req, COOKIE_DOS_PASOS), req.body?.code, datosCliente(req));

    res.append('Set-Cookie', `${COOKIE_DOS_PASOS}=; Path=/api/auth; HttpOnly; SameSite=Strict; Max-Age=0`);

    if (req.tokenSesion) {
      await autenticacion.cerrarSesion(req.tokenSesion).catch(() => {});
    }

    escribirCookieSesion(req, res, r.token, SEGUNDOS_SESION);

    res.json({ ok: true, user: r.usuario, business: r.negocio, role: r.rol });

  } catch (error) {

    responderErrorAuth(res, error, 'VERIFICANDO SEGUNDO PASO');

  }

});

/* Gestión de la verificación en dos pasos de la propia cuenta. */
function sesionPropia(req, res) {

  if (!requiereAutenticacion(res)) return null;

  if (!req.sesion || req.sesion.local) {
    res.status(401).json({ ok: false, error: 'Inicia sesión para continuar' });
    return null;
  }

  return req.sesion;

}

app.get('/api/auth/2fa', async (req, res) => {

  const sesion = sesionPropia(req, res);
  if (!sesion) return;

  try {
    res.json({ ok: true, ...(await autenticacion.estadoDosPasos(sesion)) });
  } catch (error) {
    responderErrorAuth(res, error, 'CONSULTANDO DOS PASOS');
  }

});

app.post('/api/auth/2fa/iniciar', async (req, res) => {

  const sesion = sesionPropia(req, res);
  if (!sesion) return;

  try {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, ...(await autenticacion.iniciarDosPasos(sesion, datosCliente(req))) });
  } catch (error) {
    responderErrorAuth(res, error, 'INICIANDO DOS PASOS');
  }

});

app.post('/api/auth/2fa/activar', async (req, res) => {

  const sesion = sesionPropia(req, res);
  if (!sesion) return;

  try {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, ...(await autenticacion.activarDosPasos(sesion, req.body?.code, datosCliente(req))) });
  } catch (error) {
    responderErrorAuth(res, error, 'ACTIVANDO DOS PASOS');
  }

});

app.post('/api/auth/2fa/desactivar', async (req, res) => {

  const sesion = sesionPropia(req, res);
  if (!sesion) return;

  try {
    await autenticacion.desactivarDosPasos(sesion, req.body?.password, req.body?.code, datosCliente(req));
    res.json({ ok: true });
  } catch (error) {
    responderErrorAuth(res, error, 'DESACTIVANDO DOS PASOS');
  }

});


/* ---------------- USUARIOS DE LA BARBERÍA ---------------- */

app.get('/api/admin/usuarios', async (req, res) => {

  if (!requiereAutenticacion(res)) return;

  try {

    res.json({ ok: true, users: await autenticacion.listarUsuarios(negocioActual()) });

  } catch (error) {

    responderErrorAuth(res, error, 'LISTANDO USUARIOS');

  }

});

app.post('/api/admin/usuarios', async (req, res) => {

  if (!requiereAutenticacion(res)) return;

  try {

    const r =
      await autenticacion.invitarUsuario(sesionActual(), req.body || {}, readDb(), datosCliente(req));

    res.status(201).json({ ok: true, invitation: r.invitacion, emailSent: r.correoEnviado });

  } catch (error) {

    responderErrorAuth(res, error, 'AGREGANDO USUARIO');

  }

});

app.get('/api/admin/invitaciones', async (req, res) => {

  if (!requiereAutenticacion(res)) return;

  try {
    res.json({ ok: true, invitations: await autenticacion.listarInvitaciones(negocioActual()) });
  } catch (error) {
    responderErrorAuth(res, error, 'LISTANDO INVITACIONES');
  }

});

app.post('/api/admin/invitaciones/:id/reenviar', async (req, res) => {

  if (!requiereAutenticacion(res)) return;

  try {
    const r = await autenticacion.reenviarInvitacion(sesionActual(), req.params.id, datosCliente(req));
    res.json({ ok: true, invitation: r.invitacion, emailSent: r.correoEnviado });
  } catch (error) {
    responderErrorAuth(res, error, 'REENVIANDO INVITACIÓN');
  }

});

app.post('/api/admin/invitaciones/:id/revocar', async (req, res) => {

  if (!requiereAutenticacion(res)) return;

  try {
    await autenticacion.revocarInvitacion(sesionActual(), req.params.id, datosCliente(req));
    res.json({ ok: true });
  } catch (error) {
    responderErrorAuth(res, error, 'REVOCANDO INVITACIÓN');
  }

});


/* ---------------- INVITACIONES (persona invitada) ---------------- */

app.post('/api/auth/invitacion/consultar', async (req, res) => {

  if (!requiereAutenticacion(res)) return;

  try {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, invitation: await autenticacion.consultarInvitacion(req.body?.token, datosCliente(req)) });
  } catch (error) {
    responderErrorAuth(res, error, 'CONSULTANDO INVITACIÓN');
  }

});

app.post('/api/auth/invitacion/aceptar', async (req, res) => {

  if (!requiereAutenticacion(res)) return;

  try {
    const b = req.body || {};
    const r = await autenticacion.aceptarInvitacion(
      b.token, { name: b.name, password: b.password, code: b.code }, datosCliente(req));

    if (req.tokenSesion) {
      await autenticacion.cerrarSesion(req.tokenSesion).catch(() => {});
    }

    escribirCookieSesion(req, res, r.token, SEGUNDOS_SESION);
    res.json({ ok: true, user: r.usuario, business: r.negocio, role: r.rol });
  } catch (error) {
    responderErrorAuth(res, error, 'ACEPTANDO INVITACIÓN');
  }

});

app.post('/api/auth/invitacion/rechazar', async (req, res) => {

  if (!requiereAutenticacion(res)) return;

  try {
    await autenticacion.rechazarInvitacion(req.body?.token, datosCliente(req));
    res.json({ ok: true });
  } catch (error) {
    responderErrorAuth(res, error, 'RECHAZANDO INVITACIÓN');
  }

});

app.get('/api/auth/invitaciones', async (req, res) => {

  const sesion = sesionPropia(req, res);
  if (!sesion) return;

  try {
    res.json({ ok: true, invitations: await autenticacion.misInvitaciones(sesion) });
  } catch (error) {
    responderErrorAuth(res, error, 'LISTANDO MIS INVITACIONES');
  }

});

app.post('/api/auth/invitaciones/:id/:accion', async (req, res) => {

  const sesion = sesionPropia(req, res);
  if (!sesion) return;

  if (!['aceptar', 'rechazar'].includes(req.params.accion)) {
    return res.status(404).json({ ok: false, error: 'Ruta API no encontrada' });
  }

  try {
    const r = await autenticacion.responderMiInvitacion(
      sesion, req.params.id, req.params.accion === 'aceptar', datosCliente(req));
    res.json({ ok: true, business: { id: r.businessId, name: r.businessName } });
  } catch (error) {
    responderErrorAuth(res, error, 'RESPONDIENDO INVITACIÓN');
  }

});

/* Barberías de la sesión y cambio entre ellas (misma persona). */
app.get('/api/auth/barberias', async (req, res) => {

  const sesion = sesionPropia(req, res);
  if (!sesion) return;

  try {
    const lista = await autenticacion.negociosDeUsuario(sesion.usuario.id);
    res.json({ ok: true, businesses: lista.map(n => ({ id: n.id, name: n.name, role: n.role, current: n.id === sesion.negocio.id })) });
  } catch (error) {
    responderErrorAuth(res, error, 'LISTANDO BARBERÍAS');
  }

});

app.post('/api/auth/cambiar-barberia', async (req, res) => {

  const sesion = sesionPropia(req, res);
  if (!sesion) return;

  try {
    const r = await autenticacion.cambiarNegocio(sesion, req.tokenSesion, req.body?.businessId, datosCliente(req));
    escribirCookieSesion(req, res, r.token, SEGUNDOS_SESION);
    res.json({ ok: true, business: r.negocio, role: r.rol });
  } catch (error) {
    responderErrorAuth(res, error, 'CAMBIANDO DE BARBERÍA');
  }

});

app.patch('/api/admin/usuarios/:id', async (req, res) => {

  if (!requiereAutenticacion(res)) return;

  try {

    const usuario =
      await autenticacion.modificarUsuario(sesionActual(), req.params.id, req.body || {}, readDb(), datosCliente(req));

    res.json({ ok: true, user: usuario });

  } catch (error) {

    responderErrorAuth(res, error, 'MODIFICANDO USUARIO');

  }

});


/* =========================================================
   PANEL MAESTRO (fase 6)
   Comunicación entre servidores. Sin sesión ni cookies: cada
   petición lleva una firma HMAC con la clave PLATAFORMA_CLAVE
   (ver firma-plataforma.js), fecha (±5 min) y un nonce de un
   solo uso. Sin clave configurada, estas rutas no funcionan.
   El Panel solo recibe datos administrativos y cifras.
========================================================= */

const verificarFirma =
  crearVerificador({ claves: () => clavesConfiguradas() });

const fallosPlataforma = new Map();

app.use('/api/plataforma', (req, res, next) => {

  res.set('Cache-Control', 'no-store');

  if (!plataforma) {
    return res.status(503).json({ ok: false, code: 'SIN_POSTGRES', error: 'Requiere PostgreSQL' });
  }

  const ip = req.ip || 'desconocida';
  const ahora = Date.now();
  const fallos = fallosPlataforma.get(ip);

  if (fallos && ahora - fallos.desde > 15 * 60 * 1000) fallosPlataforma.delete(ip);
  else if (fallos && fallos.n >= 20) {
    return res.status(429).json({ ok: false, code: 'DEMASIADOS_INTENTOS', error: 'Demasiadas firmas no válidas. Espera 15 minutos.' });
  }

  const r = verificarFirma({
    metodo: req.method,
    ruta: req.originalUrl,
    cuerpo: req.cuerpoCrudo || '',
    cabeceras: req.headers
  });

  if (!r.ok) {

    if (r.motivo === 'NO_CONFIGURADA') {
      return res.status(503).json({ ok: false, code: 'PLATAFORMA_NO_CONFIGURADA', error: 'La conexión con el Panel Maestro no está configurada' });
    }

    const f = fallosPlataforma.get(ip) || { n: 0, desde: ahora };
    f.n++;
    fallosPlataforma.set(ip, f);
    if (fallosPlataforma.size > 10000) fallosPlataforma.clear();

    console.warn(`PLATAFORMA: petición rechazada (${r.motivo}) desde ${ip}`);
    return res.status(401).json({ ok: false, code: 'FIRMA_INVALIDA', error: 'Petición no autorizada' });

  }

  next();

});

function responderErrorPlataforma(res, error, contexto) {

  if (error instanceof ErrorPlataforma) {
    return res.status(error.status).json({ ok: false, code: error.code, error: error.message });
  }

  console.error(`ERROR PLATAFORMA (${contexto}):`, error.message);
  return res.status(500).json({ ok: false, error: 'No se pudo completar la operación' });

}

app.get('/api/plataforma/estado', async (req, res) => {
  try {
    const lista = await plataforma.listarNegocios();
    res.json({ ok: true, version: 1, businesses: lista.length });
  } catch (error) {
    responderErrorPlataforma(res, error, 'ESTADO');
  }
});

app.get('/api/plataforma/negocios', async (req, res) => {
  try {
    res.json({ ok: true, businesses: await plataforma.listarNegocios() });
  } catch (error) {
    responderErrorPlataforma(res, error, 'NEGOCIOS');
  }
});

app.get('/api/plataforma/negocios/:id', async (req, res) => {
  try {
    res.json({ ok: true, business: await plataforma.negocio(req.params.id) });
  } catch (error) {
    responderErrorPlataforma(res, error, 'NEGOCIO');
  }
});

app.put('/api/plataforma/negocios/:id/suscripcion', async (req, res) => {
  try {
    const sus = await plataforma.aplicarSuscripcion(req.params.id, req.body || {});
    console.log(`PLATAFORMA: suscripción de ${req.params.id} → ${sus.storedStatus} (versión ${sus.version})`);
    res.json({ ok: true, subscription: sus });
  } catch (error) {
    responderErrorPlataforma(res, error, 'SUSCRIPCIÓN');
  }
});

app.put('/api/plataforma/planes', async (req, res) => {
  try {
    res.json({ ok: true, plans: await plataforma.sincronizarPlanes(req.body?.plans) });
  } catch (error) {
    responderErrorPlataforma(res, error, 'PLANES');
  }
});

app.get('/api/plataforma/eventos', async (req, res) => {
  try {
    res.json({ ok: true, events: await plataforma.eventosPendientes(req.query.limite) });
  } catch (error) {
    responderErrorPlataforma(res, error, 'EVENTOS');
  }
});

app.post('/api/plataforma/eventos/confirmar', async (req, res) => {
  try {
    res.json({ ok: true, confirmed: await plataforma.confirmarEventos(req.body?.ids) });
  } catch (error) {
    responderErrorPlataforma(res, error, 'CONFIRMAR EVENTOS');
  }
});

/* Planes disponibles para la pantalla de registro (solo nombre, precio y días de prueba). */
app.get('/api/public/planes', async (req, res) => {
  try {
    const planes = plataforma ? (await plataforma.catalogo()).filter(p => p.active) : [];
    res.json({ ok: true, plans: planes.map(p => ({ name: p.name, price: p.price, trialDays: p.trialDays })) });
  } catch (error) {
    responderErrorPlataforma(res, error, 'PLANES PÚBLICOS');
  }
});


/* =========================================================
   MANEJO DE RUTAS API NO ENCONTRADAS
========================================================= */

app.use(
  '/api',
  (
    req,
    res
  ) => {

    res.status(404)
      .json({

        ok: false,

        error:
          'Ruta API no encontrada'

      });

  }
);


/* =========================================================
   MANEJO GENERAL DE ERRORES
========================================================= */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {

    console.error(
      'ERROR GENERAL DEL SERVIDOR:',
      error
    );


    if (
      res.headersSent
    ) {

      return next(
        error
      );

    }


    res.status(500)
      .json({

        ok: false,

        error:
          'Error interno del servidor'

      });

  }
);


/* =========================================================
   PREPARAR TABLAS ADMINISTRATIVAS PARA VARIAS BARBERÍAS
   - Agrega business_id con el valor de la barbería actual.
   - Cambia las claves únicas para que sean por barbería:
     caja por (barbería, fecha), configuración por
     (barbería, sección), imágenes por (barbería, id).
   No modifica ni borra filas. Es idempotente: se puede
   ejecutar en cada arranque.
========================================================= */

async function columnasDeRestriccion(client, tabla, tipo) {

  const r =
    await client.query(
      `SELECT c.conname,
              array_agg(a.attname::text ORDER BY k.ord) AS columnas
       FROM pg_constraint c
       CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
       JOIN pg_attribute a
         ON a.attrelid = c.conrelid AND a.attnum = k.attnum
       WHERE c.conrelid = to_regclass($1)
         AND c.contype = $2
       GROUP BY c.conname`,
      [tabla, tipo]
    );

  return r.rows;

}


async function prepararTablasMultiempresa() {

  await ensureMediaTable();

  for (const tabla of [
    'sales',
    'cash_sessions',
    'products',
    'admin_settings',
    'media_assets'
  ]) {

    await pool.query(
      `ALTER TABLE IF EXISTS ${tabla}
         ADD COLUMN IF NOT EXISTS business_id TEXT NOT NULL
         DEFAULT '${DEFAULT_BUSINESS_ID}'`
    );

    await pool.query(
      `CREATE INDEX IF NOT EXISTS ${tabla}_business_idx
         ON ${tabla} (business_id)`
    );

  }


  const client =
    await pool.connect();

  try {

    await client.query('BEGIN');

    /* Una sola instancia cambia las claves a la vez. */
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      ['master-reservas:claves-multiempresa']
    );


    /* Caja: una por barbería y día. */
    if (await client.query(`SELECT to_regclass('cash_sessions') AS t`).then(r => r.rows[0].t)) {

      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS cash_sessions_business_date_key
           ON cash_sessions (business_id, session_date)`
      );

      for (const u of await columnasDeRestriccion(client, 'cash_sessions', 'u')) {

        if (u.columnas.join(',') === 'session_date') {

          await client.query(
            `ALTER TABLE cash_sessions DROP CONSTRAINT ${client.escapeIdentifier(u.conname)}`
          );

        }

      }

    }


    /* Configuración e imágenes: clave primaria por barbería. */
    for (const [tabla, columna] of [
      ['admin_settings', 'section'],
      ['media_assets', 'id']
    ]) {

      const [pk] =
        await columnasDeRestriccion(client, tabla, 'p');

      if (pk && pk.columnas.join(',') === columna) {

        await client.query(
          `ALTER TABLE ${tabla}
             DROP CONSTRAINT ${client.escapeIdentifier(pk.conname)},
             ADD CONSTRAINT ${tabla}_pkey PRIMARY KEY (business_id, ${columna})`
        );

      }

    }


    if (await client.query(`SELECT to_regclass('sales') AS t`).then(r => r.rows[0].t)) {

      await client.query(
        `CREATE INDEX IF NOT EXISTS sales_business_date_idx
           ON sales (business_id, sale_date)`
      );

      await client.query(
        `CREATE INDEX IF NOT EXISTS sales_business_booking_idx
           ON sales (business_id, booking_id)`
      );

    }

    await client.query('COMMIT');

  } catch (error) {

    await client.query('ROLLBACK').catch(() => {});

    throw error;

  } finally {

    client.release();

  }

}


/* =========================================================
   INICIAR SERVIDOR
   Con PostgreSQL, el servidor solo empieza a atender cuando
   la agenda está cargada desde la base. Si la base no
   responde, reintenta: nunca atiende con datos vacíos.
========================================================= */

async function prepararAlmacen() {

  if (MODO_ALMACEN === 'archivo') {

    console.warn(
      'AVISO: sin DATABASE_URL la agenda se guarda en data/db.json. ' +
      'Usa PostgreSQL en producción para no perder información.'
    );

    return almacen.iniciar();

  }


  await postgresAdministrativoListo;


  for (let intento = 1; ; intento++) {

    try {

      await prepararTablasMultiempresa();

      const estado =
        await almacen.iniciar();

      await plataforma.protegerNegocios(NEGOCIOS_PROTEGIDOS);

      console.log(
        `AGENDA EN POSTGRESQL LISTA (barbería: ${DEFAULT_BUSINESS_ID}, ` +
        `restricción de solapes: ${estado.restriccionSolapes})`
      );

      return estado;

    } catch (error) {

      if (
        error.code === 'IMPORTACION' ||
        error.code === 'NEGOCIO_INVALIDO'
      ) {
        throw error;
      }

      const espera =
        Math.min(
          30000,
          1000 * 2 ** Math.min(intento, 5)
        );

      console.error(
        `ERROR PREPARANDO LA AGENDA EN POSTGRESQL (intento ${intento}); ` +
        `reintento en ${espera / 1000} s:`,
        error.message
      );

      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            espera
          )
      );

    }

  }

}


/* Un error no controlado se registra en lugar de detener el servidor. */
process.on(
  'unhandledRejection',
  error => {

    console.error(
      'ERROR NO CONTROLADO:',
      error
    );

  }
);


prepararAlmacen()
  .then(() =>
    /* Cuenta del propietario de la barbería principal (solo si aún no tiene). */
    plataforma
      ? propietarioInicial({
          pool,
          autenticacion,
          negocio: DEFAULT_BUSINESS_ID,
          email: process.env.PROPIETARIO_INICIAL_EMAIL,
          clave: process.env.PROPIETARIO_INICIAL_CLAVE,
          nombre: process.env.PROPIETARIO_INICIAL_NOMBRE || ''
        })
      : null
  )
  .then(() => {

    app.listen(
      PORT,
      () => {

        console.log(
          `Barbería: http://localhost:${PORT}`
        );

        if (
          esProduccion() &&
          process.env.REGISTRO_ABIERTO === '1' &&
          !correoListo()
        ) {
          console.warn(
            'AVISO: REGISTRO_ABIERTO=1 pero el correo no está configurado ' +
            '(RESEND_API_KEY, CORREO_REMITENTE, PUBLIC_BASE_URL): el registro sigue cerrado.'
          );
        }

        console.log(
          'EL MÁSTER RESERVAS INICIADO'
        );

      }
    );

  })
  .catch(error => {

    console.error(
      'NO SE PUDO INICIAR LA AGENDA:',
      error.message
    );

    process.exit(1);

  });
