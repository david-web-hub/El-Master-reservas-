require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB = path.join(__dirname, 'data', 'db.json');
const TZ = 'America/Guayaquil';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));


/* =========================================================
   BASE DE DATOS
========================================================= */

function readDB() {
  return JSON.parse(fs.readFileSync(DB, 'utf8'));
}

function writeDB(data) {
  fs.writeFileSync(
    DB,
    JSON.stringify(data, null, 2),
    'utf8'
  );
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
  const [y, m, d] = dateStr.split('-').map(Number);

  return new Date(
    Date.UTC(y, m - 1, d, 12, 0, 0)
  );
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);

  return (h * 60) + m;
}

function toHHMM(total) {
  const h = Math.floor(total / 60);
  const m = total % 60;

  return (
    String(h).padStart(2, '0') +
    ':' +
    String(m).padStart(2, '0')
  );
}


/* =========================================================
   FECHAS
========================================================= */

function localDateParts(offsetDays = 0) {

  const now = new Date();

  const parts = new Intl.DateTimeFormat(
    'en-CA',
    {
      timeZone: TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }
  ).formatToParts(now);

  const y = Number(
    parts.find(x => x.type === 'year').value
  );

  const m = Number(
    parts.find(x => x.type === 'month').value
  );

  const d = Number(
    parts.find(x => x.type === 'day').value
  );

  const utc = new Date(
    Date.UTC(
      y,
      m - 1,
      d + offsetDays,
      12,
      0,
      0
    )
  );

  return utc.toISOString().slice(0, 10);
}


function dateFromSpanish(text) {

  const t = normalizar(text);

  // IMPORTANTE:
  // "pasado mañana" debe comprobarse antes de "mañana".
  if (/\bpasado manana\b/.test(t)) {
    return localDateParts(2);
  }

  if (/\bmanana\b/.test(t)) {
    return localDateParts(1);
  }

  if (/\bhoy\b/.test(t)) {
    return localDateParts(0);
  }


  // Formato: 2026-10-02
  const iso = t.match(
    /\b(20\d{2})-(\d{2})-(\d{2})\b/
  );

  if (iso) {
    return iso[0];
  }


  // Formatos: 2/10, 02/10/2026, 2-10-2026
  const dm = t.match(
    /\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](20\d{2}))?\b/
  );

  if (dm) {

    const year =
      dm[3] ||
      localDateParts().slice(0, 4);

    return (
      `${year}-` +
      `${String(dm[2]).padStart(2, '0')}-` +
      `${String(dm[1]).padStart(2, '0')}`
    );
  }


  // Días de la semana
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
    const [name, target]
    of Object.entries(weekdays)
  ) {

    if (
      new RegExp(`\\b${name}\\b`).test(t)
    ) {

      const base = new Date(
        localDateParts() +
        'T12:00:00-05:00'
      );

      const currentDay = base.getDay();

      let add =
        (target - currentDay + 7) % 7;

      if (add === 0) {
        add = 7;
      }

      return localDateParts(add);
    }
  }

  return null;
}


/* =========================================================
   CANTIDAD DE TURNOS / PERSONAS
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
    normalizar(value).trim();

  if (/^\d+$/.test(t)) {
    return Number(t);
  }

  return NUMEROS[t] || null;
}


function extraerCantidadPersonas(
  text,
  allowBareNumber = false
) {

  const t =
    normalizar(text).trim();

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


  for (const re of patterns) {

    const match = t.match(re);

    if (match) {

      const cantidad =
        numeroNatural(match[1]);

      if (cantidad) {

        return Math.min(
          10,
          Math.max(1, cantidad)
        );
      }
    }
  }


  /*
    Solamente aceptamos "2", "3", etc.
    como cantidad cuando el bot está
    específicamente preguntando
    cuántos turnos necesita.

    Esto evita el problema anterior
    donde "2" podía convertirse en
    el segundo horario disponible.
  */
  if (allowBareNumber) {

    const cantidad =
      numeroNatural(t);

    if (cantidad) {

      return Math.min(
        10,
        Math.max(1, cantidad)
      );
    }
  }


  return null;
}


/* =========================================================
   SERVICIOS
========================================================= */

function findServiceFromText(text, db) {

  const t = normalizar(text);


  if (
    /corte.*barba.*disen|corte.*disen.*barba|barba.*corte.*disen/.test(t)
  ) {

    return db.services.find(
      s => s.id === 'corte-barba-diseno'
    );
  }


  if (
    /corte.*barba|barba.*corte/.test(t)
  ) {

    return db.services.find(
      s => s.id === 'corte-barba'
    );
  }


  if (
    /corte.*disen|disen.*corte/.test(t)
  ) {

    return db.services.find(
      s => s.id === 'corte-diseno'
    );
  }


  if (/\bbarba\b/.test(t)) {

    return db.services.find(
      s => s.id === 'barba'
    );
  }


  if (/\bdisen/.test(t)) {

    return db.services.find(
      s => s.id === 'diseno'
    );
  }


  if (/\bcorte\b/.test(t)) {

    return db.services.find(
      s => s.id === 'corte'
    );
  }


  return null;
}


function findBarberFromText(text, db) {

  const t = normalizar(text);

  return db.barbers.find(
    barber =>
      t.includes(
        normalizar(barber.name)
      )
  );
}

/* =========================================================
   INTERPRETACIÓN DE HORAS
========================================================= */

function extractRequestedTime(text) {

  const t = normalizar(text).trim();

  const match = t.match(
    /\b(?:a\s+las?\s+|para\s+las?\s+|desde\s+las?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.?\s*m\.?|p\.?\s*m\.?|de la manana|de la tarde|de la noche)?\b/i
  );

  if (!match) {
    return null;
  }

  let hour = Number(match[1]);
  const minutes = Number(match[2] || 0);

  const period =
    normalizar(match[3] || '');


  // PM / tarde / noche
  if (
    (
      period.includes('pm') ||
      period.includes('p.') ||
      period.includes('tarde') ||
      period.includes('noche')
    ) &&
    hour < 12
  ) {
    hour += 12;
  }


  // AM / mañana
  if (
    (
      period.includes('am') ||
      period.includes('a.') ||
      period.includes('manana')
    ) &&
    hour === 12
  ) {
    hour = 0;
  }


  /*
    Si el cliente escribe solamente:

    "2"
    "3"
    "4:30"

    durante la selección de hora,
    interpretamos 1–7 como horario
    de la tarde.

    Ejemplo:
    2  -> 14:00
    3  -> 15:00
    4:30 -> 16:30

    Esto elimina el problema anterior
    donde "2" significaba el segundo
    horario de la lista.
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
    String(hour).padStart(2, '0') +
    ':' +
    String(minutes).padStart(2, '0')
  );
}


/* =========================================================
   DURACIÓN DE SERVICIOS Y RESERVAS
========================================================= */

function serviceDuration(db, serviceId) {

  const service =
    db.services.find(
      s => s.id === serviceId
    );

  return service?.duration || 40;
}


function reservationDuration(
  db,
  serviceId,
  cantidadPersonas = 1
) {

  const cantidad =
    Math.max(
      1,
      Number(cantidadPersonas) || 1
    );

  return (
    serviceDuration(db, serviceId) *
    cantidad
  );
}


/*
  Calcula cuánto ocupa una reserva
  que ya existe en la base de datos.
*/
function bookingDuration(db, booking) {

  if (
    booking.endTime &&
    booking.time
  ) {

    const duration =
      toMinutes(booking.endTime) -
      toMinutes(booking.time);

    if (duration > 0) {
      return duration;
    }
  }


  return reservationDuration(
    db,
    booking.serviceId,
    booking.cantidadPersonas || 1
  );
}


/* =========================================================
   HORARIOS DISPONIBLES
========================================================= */

function slotsFor(
  date,
  barberId,
  serviceId = null,
  cantidadPersonas = 1
) {

  const db = readDB();


  const barber =
    db.barbers.find(
      b =>
        b.id === barberId &&
        b.active !== false
    );


  if (!barber) {
    return [];
  }


  /*
    Obtenemos el día de la semana.
    Domingo = 0
    Lunes = 1
    ...
    Sábado = 6
  */
  const jsDay =
    parseDateLocal(date).getUTCDay();


  const periods =
    barber.schedule?.[
      String(jsDay)
    ] || [];


  if (!periods.length) {
    return [];
  }


  /*
    Duración TOTAL necesaria.

    Ejemplo:

    Corte = 40 minutos
    3 personas = 120 minutos

    El sistema solamente mostrará
    una hora si esos 120 minutos
    completos están libres.
  */
  const duration =
    reservationDuration(
      db,
      serviceId,
      cantidadPersonas
    );


  /*
    Reservas existentes para
    ese barbero y ese día.
  */
  const bookings =
    db.bookings.filter(
      booking =>
        booking.date === date &&
        booking.barberId === barberId &&
        booking.status !== 'cancelled'
    );


  /*
    Comprueba si el bloque que
    queremos usar choca con
    alguna reserva existente.
  */
  const overlaps =
    (start, end) => {

      return bookings.some(
        booking => {

          const bookingStart =
            toMinutes(
              booking.time
            );

          const bookingEnd =
            bookingStart +
            bookingDuration(
              db,
              booking
            );


          return (
            start < bookingEnd &&
            end > bookingStart
          );
        }
      );
    };


  const available = [];

  /*
    Revisamos cada 5 minutos.

    Así podremos encontrar opciones
    cercanas como:

    14:45
    14:50
    15:10
    etc.
  */
  const step = 5;


  for (
    const [from, to]
    of periods
  ) {

    const start =
      toMinutes(from);

    const end =
      toMinutes(to);


    for (
      let current = start;
      current + duration <= end;
      current += step
    ) {

      if (
        !overlaps(
          current,
          current + duration
        )
      ) {

        available.push(
          toHHMM(current)
        );
      }
    }
  }


  return available;
}


/* =========================================================
   HORARIOS MÁS CERCANOS
========================================================= */

function nearestSlots(
  slots,
  requested,
  limit = 4
) {

  const target =
    toMinutes(requested);


  return [...slots]

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


        /*
          Primero elegimos el horario
          con menor diferencia.
        */
        if (
          distanceA !== distanceB
        ) {
          return (
            distanceA -
            distanceB
          );
        }


        /*
          Si dos horarios están
          exactamente a la misma
          distancia, mostramos primero
          el más temprano.
        */
        return (
          toMinutes(a) -
          toMinutes(b)
        );
      }
    )

    .slice(0, limit);
}


/* =========================================================
   HORA DE FINALIZACIÓN
========================================================= */

function calculateEndTime(
  db,
  start,
  serviceId,
  cantidadPersonas
) {

  const duration =
    reservationDuration(
      db,
      serviceId,
      cantidadPersonas
    );


  return toHHMM(
    toMinutes(start) +
    duration
  );
}


/* =========================================================
   LISTA DE SERVICIOS
========================================================= */

function formatServiceList(db) {

  return db.services
    .map(
      (service, index) =>
        `${index + 1}. ${service.name} · $${service.price}`
    )
    .join('\n');
}

/* =========================================================
   API - CONFIGURACIÓN
========================================================= */

app.get('/api/config', (req, res) => {

  const db = readDB();

  res.json({
    services: db.services,
    barbers: db.barbers,
    gallery: db.gallery
  });
});


/* =========================================================
   API - DISPONIBILIDAD
========================================================= */

app.get('/api/availability', (req, res) => {

  const {
    date,
    barberId,
    serviceId
  } = req.query;


  if (!date || !barberId) {

    return res.status(400).json({
      error:
        'date y barberId son obligatorios'
    });
  }


  const slots = slotsFor(
    date,
    barberId,
    serviceId || null
  );


  res.json({
    date,
    barberId,
    serviceId: serviceId || null,
    slots
  });
});


/* =========================================================
   API - VER RESERVAS
========================================================= */

app.get('/api/bookings', (req, res) => {

  const db = readDB();

  res.json(db.bookings);
});


/* =========================================================
   API - CREAR RESERVA DESDE LA WEB
========================================================= */

app.post('/api/bookings', (req, res) => {

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

    return res.status(400).json({
      error:
        'Faltan datos obligatorios'
    });
  }


  /*
    Antes de guardar comprobamos
    nuevamente que la hora siga libre.
  */
  const available = slotsFor(
    date,
    barberId,
    serviceId,
    1
  );


  if (!available.includes(time)) {

    return res.status(409).json({
      error:
        'Ese horario acaba de ocuparse. Elige otro.'
    });
  }


  const db = readDB();


  const booking = {

    id: `BK-${Date.now()}`,

    name,

    phone,

    serviceId,

    barberId,

    date,

    time,

    cantidadPersonas: 1,

    endTime:
      calculateEndTime(
        db,
        time,
        serviceId,
        1
      ),

    source,

    status: 'confirmed',

    createdAt:
      new Date().toISOString()
  };


  db.bookings.push(booking);

  writeDB(db);


  res.status(201).json(
    booking
  );
});


/* =========================================================
   API - ACTUALIZAR RESERVA
========================================================= */

app.patch(
  '/api/bookings/:id',
  (req, res) => {

    const db = readDB();

    const booking =
      db.bookings.find(
        item =>
          item.id === req.params.id
      );


    if (!booking) {

      return res.status(404).json({
        error:
          'Reserva no encontrada'
      });
    }


    Object.assign(
      booking,
      req.body
    );


    writeDB(db);


    res.json(
      booking
    );
  }
);


/* =========================================================
   WHATSAPP - VERIFICACIÓN DEL WEBHOOK
========================================================= */

app.get(
  '/webhooks/whatsapp',
  (req, res) => {

    const mode =
      req.query['hub.mode'];

    const token =
      req.query[
        'hub.verify_token'
      ];

    const challenge =
      req.query[
        'hub.challenge'
      ];


    if (
      mode === 'subscribe' &&
      token ===
        process.env.WHATSAPP_VERIFY_TOKEN
    ) {

      return res
        .status(200)
        .send(challenge);
    }


    res.sendStatus(403);
  }
);


/* =========================================================
   WHATSAPP - ENVIAR MENSAJES
========================================================= */

async function sendWhatsApp(
  to,
  body
) {

  const token =
    process.env.WHATSAPP_TOKEN;

  const phoneId =
    process.env
      .WHATSAPP_PHONE_NUMBER_ID;

  const version =
    process.env
      .WHATSAPP_GRAPH_VERSION ||
    'v23.0';


  /*
    Si las variables no existen,
    dejamos registro en consola
    para facilitar pruebas.
  */
  if (!token || !phoneId) {

    console.log(
      '[DEMO WhatsApp]',
      to,
      body
    );

    return;
  }


  const response =
    await fetch(
      `https://graph.facebook.com/${version}/${phoneId}/messages`,
      {

        method: 'POST',

        headers: {

          Authorization:
            `Bearer ${token}`,

          'Content-Type':
            'application/json'
        },

        body: JSON.stringify({

          messaging_product:
            'whatsapp',

          to,

          type: 'text',

          text: {
            body
          }
        })
      }
    );


  if (!response.ok) {

    console.error(
      'WhatsApp send error:',
      response.status,
      await response.text()
    );
  }
}


/* =========================================================
   SESIONES DE CONVERSACIÓN
========================================================= */

const waSessions =
  new Map();


function resetSession(from) {

  waSessions.set(
    from,
    {
      step: 'idle',
      data: {}
    }
  );
}


/*
  Si solamente existe un barbero
  activo, lo seleccionamos
  automáticamente.
*/
function ensureBarber(
  session,
  db
) {

  const activeBarbers =
    db.barbers.filter(
      barber =>
        barber.active !== false
    );


  if (
    !session.data.barberId &&
    activeBarbers.length === 1
  ) {

    session.data.barberId =
      activeBarbers[0].id;
  }
}


/* =========================================================
   MENSAJE PARA ELEGIR SERVICIO
========================================================= */

function askServices(
  from,
  db,
  cantidad
) {

  return sendWhatsApp(

    from,

    `Perfecto 👌 Entendí que necesitas ${cantidad} ${
      cantidad === 1
        ? 'turno'
        : 'turnos'
    }.\n\n` +

    `✂️ ¿Qué servicio necesitan?\n\n` +

    formatServiceList(db)
  );
}

/* =========================================================
   WHATSAPP - RECIBIR MENSAJES
========================================================= */

app.post(
  '/webhooks/whatsapp',
  async (req, res) => {

    console.log(
      'WEBHOOK WHATSAPP RECIBIDO'
    );

    /*
      Respondemos inmediatamente a Meta
      para evitar reintentos del webhook.
    */
    res.sendStatus(200);


    try {

      const value =
        req.body
          ?.entry?.[0]
          ?.changes?.[0]
          ?.value;


      const message =
        value
          ?.messages?.[0];


      /*
        Si el webhook recibido no contiene
        un mensaje del cliente, terminamos.
      */
      if (!message) {
        return;
      }


      const from =
        message.from;


      const text =
        (
          message.text?.body ||
          ''
        ).trim();


      /*
        Por ahora trabajamos con mensajes
        escritos.
      */
      if (!text) {

        return sendWhatsApp(
          from,
          'Por ahora puedo ayudarte por texto. 💈'
        );
      }


      const lower =
        normalizar(text);


      const db =
        readDB();


      let session =
        waSessions.get(from) ||
        {
          step: 'idle',
          data: {}
        };


      /* =====================================================
         FINALIZAR CONVERSACIÓN
      ===================================================== */

      const closingIntent =
        /(gracias|muchas gracias|eso es todo|nada mas|ya no necesito|no necesito mas|hasta luego|chao|adios|buen dia)/i;


      if (
        closingIntent.test(lower)
      ) {

        resetSession(from);


        return sendWhatsApp(
          from,

          '😊 ¡Con gusto! Fue un placer atenderte.\n\n' +
          'Cuando necesites otra cita, escríbeme “quiero reservar”. 💈'
        );
      }


      /* =====================================================
         PASO: CONFIRMAR RESERVA
      ===================================================== */

      if (
        session.step === 'confirm'
      ) {

        const answer =
          lower.trim();


        /* -----------------------------
           CANCELAR
        ----------------------------- */

        if (
          answer === 'cancelar'
        ) {

          resetSession(from);


          return sendWhatsApp(
            from,

            '❌ Reserva cancelada. No se ha guardado ninguna cita.'
          );
        }


        /* -----------------------------
           EDITAR HORA
        ----------------------------- */

        if (
          answer === 'editar' ||
          answer.includes(
            'editar la hora'
          ) ||
          answer.includes(
            'cambiar hora'
          )
        ) {

          session.step =
            'time';

          session.data.time =
            null;

          session.data.endTime =
            null;


          waSessions.set(
            from,
            session
          );


          return sendWhatsApp(
            from,

            '✏️ Perfecto. ¿A qué hora aproximadamente deseas comenzar?'
          );
        }


        /*
          Si no escribió ninguna
          de las tres opciones.
        */
        if (
          answer !== 'confirmar'
        ) {

          return sendWhatsApp(
            from,

            'Elige una opción:\n\n' +

            '✅ *CONFIRMAR*\n' +
            '✏️ *EDITAR*\n' +
            '❌ *CANCELAR*'
          );
        }


        /* -----------------------------
           VERIFICAR DISPONIBILIDAD
           UNA ÚLTIMA VEZ
        ----------------------------- */

        const available =
          slotsFor(

            session.data.date,

            session.data.barberId,

            session.data.serviceId,

            session.data
              .cantidadPersonas
          );


        /*
          Puede ocurrir que otra persona
          reserve mientras el cliente
          estaba confirmando.

          Por eso verificamos nuevamente.
        */
        if (
          !available.includes(
            session.data.time
          )
        ) {

          const nearby =
            nearestSlots(

              available,

              session.data.time,

              4
            );


          session.step =
            'time';

          session.data.time =
            null;

          session.data.endTime =
            null;


          waSessions.set(
            from,
            session
          );


          if (
            nearby.length
          ) {

            return sendWhatsApp(
              from,

              '⚠️ Ese horario acaba de ocuparse.\n\n' +

              'Los horarios disponibles más cercanos son:\n' +

              nearby
                .map(
                  (slot, index) =>
                    `${index + 1}. ${slot}`
                )
                .join('\n') +

              '\n\nEscribe la hora que prefieras.'
            );
          }


          return sendWhatsApp(
            from,

            '⚠️ Ya no tengo un bloque suficiente ese día. ¿Quieres probar con otra fecha?'
          );
        }


        /* -----------------------------
           GUARDAR RESERVA
        ----------------------------- */

        const freshDB =
          readDB();


        const booking = {

          id:
            `BK-${Date.now()}`,

          name:
            session.data.name,

          phone:
            from,

          serviceId:
            session.data.serviceId,

          cantidadPersonas:
            session.data
              .cantidadPersonas,

          barberId:
            session.data.barberId,

          date:
            session.data.date,

          time:
            session.data.time,

          endTime:
            session.data.endTime,

          source:
            'whatsapp',

          status:
            'confirmed',

          createdAt:
            new Date()
              .toISOString()
        };


        freshDB.bookings.push(
          booking
        );


        writeDB(
          freshDB
        );


        const serviceName =
          freshDB.services.find(
            service =>
              service.id ===
              booking.serviceId
          )?.name ||
          'Servicio';


        const barberName =
          freshDB.barbers.find(
            barber =>
              barber.id ===
              booking.barberId
          )?.name ||
          'Master';


        /*
          Terminamos la sesión para que
          el próximo mensaje pueda iniciar
          una reserva completamente nueva.
        */
        resetSession(from);


        return sendWhatsApp(
          from,

          '✅ *¡Reserva confirmada!*\n\n' +

          `👤 ${booking.name}\n` +

          `👥 ${booking.cantidadPersonas} ${
            booking.cantidadPersonas === 1
              ? 'turno'
              : 'turnos'
          }\n` +

          `✂️ ${serviceName}\n` +

          `💈 ${barberName}\n` +

          `📅 ${booking.date}\n` +

          `🕐 Inicio: ${booking.time}\n` +

          `🏁 Final aprox.: ${booking.endTime}\n\n` +

          `Código: ${booking.id}`
        );
      }


      /* =====================================================
         PASO: NOMBRE DEL CLIENTE
      ===================================================== */

      if (
        session.step === 'name'
      ) {

        /*
          Guardamos el nombre escrito
          por el cliente.
        */
        session.data.name =
          text;


        const serviceName =
          db.services.find(
            service =>
              service.id ===
              session.data.serviceId
          )?.name ||
          'Servicio';


        const barberName =
          db.barbers.find(
            barber =>
              barber.id ===
              session.data.barberId
          )?.name ||
          'Master';


        /*
          Calculamos a qué hora terminará
          aproximadamente toda la reserva.
        */
        session.data.endTime =
          calculateEndTime(

            db,

            session.data.time,

            session.data.serviceId,

            session.data
              .cantidadPersonas
          );


        session.step =
          'confirm';


        waSessions.set(
          from,
          session
        );


        return sendWhatsApp(
          from,

          '📋 *Resumen de tu reserva*\n\n' +

          `👤 ${session.data.name}\n` +

          `👥 ${session.data.cantidadPersonas} ${
            session.data.cantidadPersonas === 1
              ? 'turno'
              : 'turnos'
          }\n` +

          `✂️ ${serviceName}\n` +

          `💈 ${barberName}\n` +

          `📅 ${session.data.date}\n` +

          `🕐 Inicio: ${session.data.time}\n` +

          `🏁 Final aprox.: ${session.data.endTime}\n\n` +

          '¿Está todo correcto?\n\n' +

          '✅ Escribe *CONFIRMAR* para reservar\n' +

          '✏️ Escribe *EDITAR* para cambiar la hora\n' +

          '❌ Escribe *CANCELAR* para cancelar'
        );
      }


      /* =====================================================
         PASO: ELEGIR HORA
      ===================================================== */

      if (
        session.step === 'time'
      ) {

        ensureBarber(
          session,
          db
        );


        /*
          Si previamente mostramos una
          lista numerada de horarios
          cercanos, permitimos responder:

          1
          2
          3
          4

          SIN confundir ese número con
          1pm, 2pm, 3pm o 4pm.
        */
        const optionNumber =
          /^\d+$/.test(text.trim())
            ? Number(text.trim())
            : null;


        let requested = null;


        if (
          optionNumber &&
          Array.isArray(
            session.data.lastNearby
          ) &&
          optionNumber >= 1 &&
          optionNumber <=
            session.data.lastNearby.length
        ) {

          requested =
            session.data.lastNearby[
              optionNumber - 1
            ];


          session.data.lastNearby =
            null;
        }

        else {

          requested =
            extractRequestedTime(
              text
            );
        }


        /*
          No pudimos entender la hora.
        */
        if (!requested) {

          return sendWhatsApp(
            from,

            '🕐 Dime una hora, por ejemplo: “2 de la tarde”, “3:30 pm” o “10 de la mañana”.'
          );
        }


        const available =
          slotsFor(

            session.data.date,

            session.data.barberId,

            session.data.serviceId,

            session.data
              .cantidadPersonas
          );


        /*
          La hora exacta solicitada
          no está disponible.
        */
        if (
          !available.includes(
            requested
          )
        ) {

          const nearby =
            nearestSlots(

              available,

              requested,

              4
            );


          /*
            Guardamos temporalmente
            las opciones para permitir
            que el cliente responda
            simplemente 1, 2, 3 o 4.
          */
          session.data.lastNearby =
            nearby;


          waSessions.set(
            from,
            session
          );


          if (
            !nearby.length
          ) {

            return sendWhatsApp(
              from,

              `😕 No tengo un bloque suficiente para ${session.data.cantidadPersonas} ${
                session.data.cantidadPersonas === 1
                  ? 'turno'
                  : 'turnos'
              } ese día.\n\n` +

              '¿Quieres probar con otra fecha?'
            );
          }


          return sendWhatsApp(
            from,

            `A las ${requested} no tengo disponible todo el bloque necesario para ${session.data.cantidadPersonas} ${
              session.data.cantidadPersonas === 1
                ? 'turno'
                : 'turnos'
            }.\n\n` +

            'Los horarios disponibles más cercanos son:\n' +

            nearby
              .map(
                (slot, index) =>
                  `${index + 1}. ${slot}`
              )
              .join('\n') +

            '\n\nPuedes escribir el número de la opción o la hora que prefieras.'
          );
        }


        /*
          La hora está disponible.
        */
        session.data.time =
          requested;


        session.data.endTime =
          calculateEndTime(

            db,

            requested,

            session.data.serviceId,

            session.data
              .cantidadPersonas
          );


        session.data.lastNearby =
          null;


        session.step =
          'name';


        waSessions.set(
          from,
          session
        );


        return sendWhatsApp(
          from,

          '✅ Perfecto. Tengo disponible todo el bloque.\n\n' +

          `🕐 Inicio: ${session.data.time}\n` +

          `🏁 Final aprox.: ${session.data.endTime}\n\n` +

          '👤 ¿A nombre de quién registro la reserva?'
        );
      }

          /* =====================================================
         PASO: ELEGIR FECHA
      ===================================================== */

      if (
        session.step === 'date'
      ) {

        const date =
          dateFromSpanish(text);


        if (!date) {

          return sendWhatsApp(
            from,

            '📅 Dime el día. Puedes decir “hoy”, “mañana”, “viernes” o escribir una fecha.'
          );
        }


        session.data.date =
          date;


        ensureBarber(
          session,
          db
        );


        session.step =
          'time';


        waSessions.set(
          from,
          session
        );


        return sendWhatsApp(
          from,

          `📅 Perfecto, ${date}.\n\n` +
          '🕐 ¿A qué hora aproximadamente deseas comenzar?'
        );
      }


      /* =====================================================
         PASO: ELEGIR SERVICIO
      ===================================================== */

      if (
        session.step === 'service'
      ) {

        let chosenService =
          null;


        /*
          El cliente puede responder
          con el número del servicio.
        */
        const option =
          Number(
            text.trim()
          ) - 1;


        if (
          Number.isInteger(option) &&
          option >= 0 &&
          option <
            db.services.length
        ) {

          chosenService =
            db.services[
              option
            ];
        }

        else {

          /*
            También puede escribirlo
            naturalmente:

            "corte"
            "barba"
            "corte y barba"
          */
          chosenService =
            findServiceFromText(
              text,
              db
            );
        }


        if (!chosenService) {

          return sendWhatsApp(
            from,

            'No alcancé a identificar el servicio.\n\n' +

            'Elige una opción:\n\n' +

            formatServiceList(db)
          );
        }


        session.data.serviceId =
          chosenService.id;


        /*
          Si el cliente ya había dicho
          el día en un mensaje anterior,
          no volvemos a preguntarlo.
        */
        if (
          session.data.date
        ) {

          ensureBarber(
            session,
            db
          );


          session.step =
            'time';


          waSessions.set(
            from,
            session
          );


          return sendWhatsApp(
            from,

            `✂️ Perfecto: ${chosenService.name}.\n\n` +

            `📅 Ya tengo el día: ${session.data.date}.\n\n` +

            '🕐 ¿A qué hora aproximadamente deseas comenzar?'
          );
        }


        session.step =
          'date';


        waSessions.set(
          from,
          session
        );


        return sendWhatsApp(
          from,

          `✂️ Perfecto: ${chosenService.name}.\n\n` +

          `📅 ¿Para qué día necesitas ${
            session.data.cantidadPersonas === 1
              ? 'el turno'
              : 'los turnos'
          }?`
        );
      }


      /* =====================================================
         PASO: CANTIDAD DE TURNOS
      ===================================================== */

      if (
        session.step === 'quantity'
      ) {

        /*
          Aquí sí permitimos que el
          cliente responda simplemente:

          1
          2
          3
          etc.

          Porque sabemos que Elia acaba
          de preguntarle cuántos turnos.
        */
        const cantidad =
          extraerCantidadPersonas(
            text,
            true
          );


        if (!cantidad) {

          return sendWhatsApp(
            from,

            '👥 ¿Cuántos turnos necesitas? Puedes reservar de 1 a 10.'
          );
        }


        session.data
          .cantidadPersonas =
          cantidad;


        /*
          Si el cliente ya había indicado
          un servicio anteriormente,
          no necesitamos preguntarlo otra vez.
        */
        if (
          session.data.serviceId
        ) {

          if (
            session.data.date
          ) {

            ensureBarber(
              session,
              db
            );


            session.step =
              'time';


            waSessions.set(
              from,
              session
            );


            return sendWhatsApp(
              from,

              `Perfecto 👌 Serán ${cantidad} ${
                cantidad === 1
                  ? 'turno'
                  : 'turnos'
              }.\n\n` +

              `📅 Ya tengo el día: ${session.data.date}.\n\n` +

              '🕐 ¿A qué hora aproximadamente deseas comenzar?'
            );
          }


          session.step =
            'date';


          waSessions.set(
            from,
            session
          );


          return sendWhatsApp(
            from,

            `Perfecto 👌 Serán ${cantidad} ${
              cantidad === 1
                ? 'turno'
                : 'turnos'
            }.\n\n` +

            '📅 ¿Para qué día los necesitas?'
          );
        }


        session.step =
          'service';


        waSessions.set(
          from,
          session
        );


        return askServices(
          from,
          db,
          cantidad
        );
      }


      /* =====================================================
         NUEVA RESERVA / CONVERSACIÓN INICIAL
      ===================================================== */

      if (
        session.step === 'idle'
      ) {

        /*
          Intentamos recuperar toda la
          información que el cliente ya
          haya escrito en su primer mensaje.

          Ejemplos:

          "Quiero dos turnos mañana"

          "Necesito 3 cortes mañana"

          "Quiero un corte mañana a las 3"

          De esta forma Elia no vuelve a
          preguntar datos que ya recibió.
        */

        const cantidad =
          extraerCantidadPersonas(
            text,
            false
          );


        const service =
          findServiceFromText(
            text,
            db
          );


        const date =
          dateFromSpanish(
            text
          );


        const requestedTime =
          extractRequestedTime(
            text
          );


        /*
          Guardamos todo lo que
          logremos entender.
        */
        if (cantidad) {

          session.data
            .cantidadPersonas =
            cantidad;
        }


        if (service) {

          session.data
            .serviceId =
            service.id;
        }


        if (date) {

          session.data.date =
            date;
        }


        if (requestedTime) {

          session.data
            .requestedTime =
            requestedTime;
        }


        ensureBarber(
          session,
          db
        );


        /* ---------------------------------
           FALTA CANTIDAD
        --------------------------------- */

        if (!cantidad) {

          session.step =
            'quantity';


          waSessions.set(
            from,
            session
          );


          return sendWhatsApp(
            from,

            '👋 ¡Hola! Bienvenido a El Máster 💈\n\n' +

            'Con gusto puedo ayudarte con tu reserva.\n\n' +

            '👥 ¿Cuántos turnos necesitas?\n' +

            'Puedes reservar de 1 a 10.'
          );
        }


        /* ---------------------------------
           FALTA SERVICIO
        --------------------------------- */

        if (
          !session.data.serviceId
        ) {

          session.step =
            'service';


          waSessions.set(
            from,
            session
          );


          return askServices(
            from,
            db,
            cantidad
          );
        }


        /* ---------------------------------
           FALTA FECHA
        --------------------------------- */

        if (
          !session.data.date
        ) {

          session.step =
            'date';


          waSessions.set(
            from,
            session
          );


          return sendWhatsApp(
            from,

            `Perfecto 👌 Entendí que necesitas ${cantidad} ${
              cantidad === 1
                ? 'turno'
                : 'turnos'
            }.\n\n` +

            '📅 ¿Para qué día los necesitas?'
          );
        }


        /* ---------------------------------
           YA TENEMOS:
           cantidad + servicio + fecha
        --------------------------------- */

        session.step =
          'time';


        waSessions.set(
          from,
          session
        );


        /*
          Si además escribió una hora
          en el mismo mensaje, comprobamos
          esa hora inmediatamente.
        */
        if (
          requestedTime
        ) {

          const available =
            slotsFor(

              session.data.date,

              session.data.barberId,

              session.data.serviceId,

              cantidad
            );


          /*
            LA HORA EXACTA ESTÁ DISPONIBLE
          */
          if (
            available.includes(
              requestedTime
            )
          ) {

            session.data.time =
              requestedTime;


            session.data.endTime =
              calculateEndTime(

                db,

                requestedTime,

                session.data
                  .serviceId,

                cantidad
              );


            session.data
              .lastNearby =
              null;


            session.step =
              'name';


            waSessions.set(
              from,
              session
            );


            return sendWhatsApp(
              from,

              '✅ Sí, tengo disponible todo el bloque solicitado.\n\n' +

              `🕐 Inicio: ${requestedTime}\n` +

              `🏁 Final aprox.: ${session.data.endTime}\n\n` +

              '👤 ¿A nombre de quién registro la reserva?'
            );
          }


          /*
            LA HORA EXACTA NO ESTÁ DISPONIBLE.
            BUSCAMOS LAS MÁS CERCANAS.
          */
          const nearby =
            nearestSlots(

              available,

              requestedTime,

              4
            );


          session.data
            .lastNearby =
            nearby;


          waSessions.set(
            from,
            session
          );


          if (
            nearby.length
          ) {

            return sendWhatsApp(
              from,

              `A las ${requestedTime} no tengo disponible todo el bloque necesario para ${cantidad} ${
                cantidad === 1
                  ? 'turno'
                  : 'turnos'
              }.\n\n` +

              'Los horarios disponibles más cercanos son:\n' +

              nearby
                .map(
                  (slot, index) =>
                    `${index + 1}. ${slot}`
                )
                .join('\n') +

              '\n\nPuedes escribir el número de la opción o la hora que prefieras.'
            );
          }


          return sendWhatsApp(
            from,

            '😕 No tengo un bloque suficiente ese día.\n\n' +

            '¿Quieres probar con otra fecha?'
          );
        }


        /*
          Si todavía falta la hora.
        */
        return sendWhatsApp(
          from,

          '🕐 ¿A qué hora aproximadamente deseas comenzar?'
        );
      }


      /* =====================================================
         RESPUESTA DE SEGURIDAD
      ===================================================== */

      /*
        Si por alguna razón una sesión
        queda en un estado desconocido,
        la reiniciamos para que el cliente
        nunca se quede atrapado.
      */
      resetSession(
        from
      );


      return sendWhatsApp(
        from,

        '💈 Con gusto puedo ayudarte con una nueva reserva.\n\n' +

        '👥 ¿Cuántos turnos necesitas?'
      );
    }

    catch (error) {

      console.error(
        'WhatsApp webhook error:',
        error
      );
    }
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
  }
);
