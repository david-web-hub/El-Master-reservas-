/* =========================================================
   EL MÁSTER RESERVAS
   SERVER.JS
========================================================= */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

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

app.use(
  express.json({
    limit: '5mb'
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: '5mb'
  })
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
   LEER BASE JSON
========================================================= */

function readDb() {

  try {

    if (
      !fs.existsSync(DB_FILE)
    ) {

      const initial =
        defaultDb();

      fs.mkdirSync(
        path.dirname(DB_FILE),
        {
          recursive: true
        }
      );

      fs.writeFileSync(
        DB_FILE,
        JSON.stringify(
          initial,
          null,
          2
        )
      );

      return initial;

    }


    const raw =
      fs.readFileSync(
        DB_FILE,
        'utf8'
      );


    const db =
      JSON.parse(raw);


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

  } catch (error) {

    console.error(
      'ERROR LEYENDO DB.JSON:',
      error
    );

    return defaultDb();

  }

}


/* =========================================================
   GUARDAR BASE JSON
========================================================= */

function writeDb(db) {

  fs.mkdirSync(
    path.dirname(DB_FILE),
    {
      recursive: true
    }
  );


  fs.writeFileSync(
    DB_FILE,
    JSON.stringify(
      db,
      null,
      2
    )
  );

}


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


initPostgres()
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


      res.json(
        db.bookings || []
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
  (req, res) => {

    try {

      const db =
        readDb();


      const booking =
        db.bookings.find(
          item =>
            String(item.id) ===
            String(req.params.id)
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


      writeDb(db);


      res.json({
        ok: true,
        booking
      });

    } catch (error) {

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
  (req, res) => {

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


      writeDb(db);


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
  (req, res) => {

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


      writeDb(db);


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
          ORDER BY name ASC
        `);


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
  image_url
)
            )
            VALUES (
              $1,
              $2,
              $3,
              $4,
              $5,
             $6,
$7,
$8
)
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
             req.body.image || req.body.imageUrl || null
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
            LIMIT 1
          `,
          [
            req.params.id
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
    req.params.id
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
      LIMIT 1
    `);


  if (
    existing.rows.length > 0
  ) {

    return existing.rows[0];

  }


  const created =
    await client.query(`
      INSERT INTO cash_sessions (
        session_date,
        status
      )
      VALUES (
        CURRENT_DATE,
        'open'
      )
      RETURNING *
    `);


  return created.rows[0];

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
            FOR UPDATE
          `,
          [
            id
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
              LIMIT 1
            `,
            [
              bookingId
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

              RETURNING stock
            `,
            [
              item.quantity,
              item.id
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

              status

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
              'paid'
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
              : null

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


            writeDb(db);

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
        `);


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
        `);


      const sessionResult =
        await pool.query(`
          SELECT *
          FROM cash_sessions
          WHERE
            session_date =
              CURRENT_DATE
          LIMIT 1
        `);


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
        `);


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
          FOR UPDATE
        `);


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

              RETURNING *
            `,
            [
              total,
              existing.rows[0]
                .id
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

                closing_total

              )

              VALUES (
                CURRENT_DATE,
                'closed',
                NOW(),
                $1
              )

              RETURNING *
            `,
            [
              total
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
          `,
          [
            from,
            to
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
          `,
          [
            from,
            to
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
          ORDER BY section ASC
        `);


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
              updated_at
            )

            VALUES (
              $1,
              $2::jsonb,
              NOW()
            )

            ON CONFLICT (
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
            )
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
      `BK-${Date.now()}`,

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
   DISPONIBILIDAD PARA LA PÁGINA WEB
========================================================= */

app.get(
  '/api/availability',
  (req, res) => {

    try {

      const {
        date,
        barberId,
        serviceId
      } = req.query;


      if (
        !date ||
        !barberId ||
        !serviceId
      ) {

        return res
          .status(400)
          .json({
            ok: false,
            error:
              'date, barberId y serviceId son obligatorios'
          });

      }


      const db =
        readDB();


      const service =
        db.services.find(
          item =>
            item.id ===
              serviceId &&
            item.active !==
              false &&
            item.bookingEnabled !==
              false
        );


      if (!service) {

        return res
          .status(404)
          .json({
            ok: false,
            error:
              'Servicio no disponible'
          });

      }


      const barber =
        db.barbers.find(
          item =>
            item.id ===
              barberId &&
            item.active !==
              false
        );


      if (!barber) {

        return res
          .status(404)
          .json({
            ok: false,
            error:
              'Barbero no disponible'
          });

      }


      const duration =
        serviceDuration(
          db,
          serviceId
        );


      const slots =
        availableStartsForDuration(
          db,
          date,
          barberId,
          duration
        );


      return res.json({

        ok: true,

        date,

        barberId,

        serviceId,

        duration,

        slots

      });

    } catch (error) {

      console.error(
        'ERROR CONSULTANDO DISPONIBILIDAD:',
        error
      );


      return res
        .status(500)
        .json({
          ok: false,
          error:
            'No se pudo consultar la disponibilidad'
        });

    }

  }
);


/* =========================================================
   CREAR RESERVA DESDE LA WEB
========================================================= */

app.post(
  '/api/bookings',
  (req, res) => {

    try {

      const {
        name,
        phone,
        serviceId,
        barberId,
        date,
        time,
        source = 'web'
      } = req.body;


      if (
        !name ||
        !phone ||
        !serviceId ||
        !barberId ||
        !date ||
        !time
      ) {

        return res
          .status(400)
          .json({
            ok: false,
            error:
              'Faltan datos obligatorios'
          });

      }


      const db =
        readDB();


      const service =
        db.services.find(
          item =>
            item.id ===
              serviceId &&
            item.active !==
              false &&
            item.bookingEnabled !==
              false
        );


      if (!service) {

        return res
          .status(400)
          .json({
            ok: false,
            error:
              'Ese servicio no está disponible para reservas'
          });

      }


      const barber =
        db.barbers.find(
          item =>
            item.id ===
              barberId &&
            item.active !==
              false
        );


      if (!barber) {

        return res
          .status(400)
          .json({
            ok: false,
            error:
              'Ese barbero no está disponible'
          });

      }


      const duration =
        serviceDuration(
          db,
          serviceId
        );


      const start =
        toMinutes(
          time
        );


      const available =
        isIntervalAvailable(
          db,
          date,
          barberId,
          start,
          duration
        );


      if (!available) {

        return res
          .status(409)
          .json({
            ok: false,
            error:
              'Ese horario acaba de ocuparse. Elige otro.'
          });

      }


      const endTime =
        toHHMM(
          start +
          duration
        );


      const booking = {

        id:
          `BK-${Date.now()}`,

        name:
          String(name)
            .trim(),

        phone:
          String(phone)
            .trim(),

        serviceId,

        barberId,

        date,

        time,

        endTime,

        cantidadPersonas:
          1,

        people: [
          {
            index: 1,
            serviceId,
            duration,
            time,
            endTime
          }
        ],

        scheduleType:
          'consecutive',

        source,

        status:
          'confirmed',

        paymentStatus:
          'pending',

        createdAt:
          new Date()
            .toISOString()

      };


      db.bookings.push(
        booking
      );


      writeDB(db);


      return res
        .status(201)
        .json({
          ok: true,
          booking
        });

    } catch (error) {

      console.error(
        'ERROR CREANDO RESERVA WEB:',
        error
      );


      return res
        .status(500)
        .json({
          ok: false,
          error:
            'No se pudo crear la reserva'
        });

    }

  }
);


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

          '❌ Listo. El proceso de reserva quedó cancelado.\n\n' +

          'No se guardó ninguna cita. Cuando quieras comenzar otra, ' +

          'escríbeme “quiero reservar”. 💈'

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

          '😊 ¡Con gusto! Fue un placer atenderte.\n\n' +

          'Cuando necesites otra cita, escríbeme “quiero reservar”. 💈'

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


        writeDB(
          fresh
        );


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

          '👋 ¡Hola! Bienvenido a El Máster 💈\n\n' +

          'Con gusto puedo ayudarte.\n' +

          'Dime cuántos turnos deseas reservar.'

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
   INICIAR SERVIDOR
========================================================= */

app.listen(
  PORT,
  () => {

    console.log(
      `Barbería: http://localhost:${PORT}`
    );

    console.log(
      'EL MÁSTER RESERVAS INICIADO'
    );

  }
);
