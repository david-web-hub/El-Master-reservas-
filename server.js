require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB = path.join(__dirname, 'data', 'db.json');

app.use(express.json());
app.use(express.urlencoded({extended:true}));
app.use(express.static(path.join(__dirname, 'public')));

function readDB(){ return JSON.parse(fs.readFileSync(DB,'utf8')); }
function writeDB(data){ fs.writeFileSync(DB, JSON.stringify(data,null,2),'utf8'); }

function parseDateLocal(dateStr){
  const [y,m,d]=dateStr.split('-').map(Number);
  return new Date(Date.UTC(y,m-1,d,12,0,0));
}

function toMinutes(hhmm){
  const [h,m]=hhmm.split(':').map(Number);
  return h*60+m;
}

function toHHMM(total){
  return `${String(Math.floor(total/60)).padStart(2,'0')}:${String(total%60).padStart(2,'0')}`;
}

function slotsFor(date, barberId, serviceId=null){
  const db = readDB();
  const barber = db.barbers.find(b=>b.id===barberId && b.active!==false);
  if(!barber) return [];

  const jsDay = parseDateLocal(date).getUTCDay();
  const periods = barber.schedule?.[String(jsDay)] || [];
  if(!periods.length) return [];

  const service = serviceId ? db.services.find(s=>s.id===serviceId) : null;
  const duration = service?.duration || 40;
  const step = 5;

  const bookings = db.bookings.filter(b=>
    b.date===date &&
    b.barberId===barberId &&
    b.status!=='cancelled'
  );

  const overlaps = (start,end) => bookings.some(b=>{
    const bookedService = db.services.find(s=>s.id===b.serviceId);
    const bookedDuration = bookedService?.duration || 40;
    const bs = toMinutes(b.time);
    const be = bs + bookedDuration;
    return start < be && end > bs;
  });

  const out=[];
  for(const [from,to] of periods){
    const start=toMinutes(from);
    const end=toMinutes(to);
    for(let t=start; t+duration<=end; t+=step){
      if(!overlaps(t,t+duration)) out.push(toHHMM(t));
    }
  }
  return out;
}

app.get('/api/config',(req,res)=>{
  const db=readDB();
  res.json({services:db.services,barbers:db.barbers,gallery:db.gallery});
});

app.get('/api/availability',(req,res)=>{
  const {date,barberId,serviceId}=req.query;
  if(!date || !barberId) return res.status(400).json({error:'date y barberId son obligatorios'});
  res.json({date,barberId,serviceId:serviceId||null,slots:slotsFor(date,barberId,serviceId||null)});
});

app.get('/api/bookings',(req,res)=>{
  res.json(readDB().bookings);
});

app.post('/api/bookings',(req,res)=>{
  const {name,phone,serviceId,barberId,date,time,source='web'}=req.body;
  if(!name||!phone||!serviceId||!barberId||!date||!time){
    return res.status(400).json({error:'Faltan datos obligatorios'});
  }
  // Revalidar justo antes de guardar para prevenir doble reserva.
  if(!slotsFor(date,barberId,serviceId).includes(time)){
    return res.status(409).json({error:'Ese horario acaba de ocuparse. Elige otro.'});
  }
  const db=readDB();
  const booking={
    id: `BK-${Date.now()}`, name, phone, serviceId, barberId, date, time,
    source, status:'confirmed', createdAt:new Date().toISOString()
  };
  db.bookings.push(booking); writeDB(db);
  res.status(201).json(booking);
});

app.patch('/api/bookings/:id',(req,res)=>{
  const db=readDB();
  const b=db.bookings.find(x=>x.id===req.params.id);
  if(!b) return res.status(404).json({error:'Reserva no encontrada'});
  Object.assign(b, req.body); writeDB(db); res.json(b);
});

// WhatsApp webhook verification
app.get('/webhooks/whatsapp',(req,res)=>{
  const mode=req.query['hub.mode'];
  const token=req.query['hub.verify_token'];
  const challenge=req.query['hub.challenge'];
  if(mode==='subscribe' && token===process.env.WHATSAPP_VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

async function sendWhatsApp(to, body){
  const token=process.env.WHATSAPP_TOKEN;
  const phoneId=process.env.WHATSAPP_PHONE_NUMBER_ID;
  const version=process.env.WHATSAPP_GRAPH_VERSION || 'v23.0';
  if(!token || !phoneId) {
    console.log('[DEMO WhatsApp]', to, body);
    return;
  }
  await fetch(`https://graph.facebook.com/${version}/${phoneId}/messages`,{
    method:'POST',
    headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    body:JSON.stringify({messaging_product:'whatsapp',to,type:'text',text:{body}})
  });
}


const TZ = 'America/Guayaquil';

function localDateParts(offsetDays=0){
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA',{
    timeZone:TZ, year:'numeric', month:'2-digit', day:'2-digit'
  }).formatToParts(now);
  const y=Number(parts.find(x=>x.type==='year').value);
  const m=Number(parts.find(x=>x.type==='month').value);
  const d=Number(parts.find(x=>x.type==='day').value);
  const utc = new Date(Date.UTC(y,m-1,d+offsetDays,12,0,0));
  return utc.toISOString().slice(0,10);
}

function dateFromSpanish(text){
  const t=text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  if(/\bhoy\b/.test(t)) return localDateParts(0);
  if(/\bmanana\b/.test(t)) return localDateParts(1);
  if(/\bpasado manana\b/.test(t)) return localDateParts(2);

  const iso=t.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if(iso) return iso[0];

  const dm=t.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](20\d{2}))?\b/);
  if(dm){
    const year=dm[3]||localDateParts().slice(0,4);
    return `${year}-${String(dm[2]).padStart(2,'0')}-${String(dm[1]).padStart(2,'0')}`;
  }

  const weekdays={domingo:0,lunes:1,martes:2,miercoles:3,jueves:4,viernes:5,sabado:6};
  for(const [name,target] of Object.entries(weekdays)){
    if(new RegExp(`\\b${name}\\b`).test(t)){
      const base = new Date(localDateParts()+'T12:00:00-05:00');
      const cur = base.getDay();
      let add=(target-cur+7)%7;
      if(add===0 && !/\bhoy\b/.test(t)) add=7;
      return localDateParts(add);
    }
  }
  return null;
}

function minutesOf(hhmm){ const [h,m]=hhmm.split(':').map(Number); return h*60+m; }

function filterSlotsByPhrase(slots,text){
  const t=text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  let out=[...slots];

  if(/\bmanana\b/.test(t) && !/\bpasado manana\b/.test(t)) {
    // "mañana" can mean tomorrow; date parsing handles it. Don't treat it as morning.
  }
  if(/\ben la manana\b|\bpor la manana\b/.test(t)) out=out.filter(s=>minutesOf(s)<12*60);
  if(/\btarde\b/.test(t)) out=out.filter(s=>minutesOf(s)>=12*60 && minutesOf(s)<18*60);
  if(/\bnoche\b/.test(t)) out=out.filter(s=>minutesOf(s)>=18*60);

  const after=t.match(/(?:despues de|desde)\s+(?:las?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if(after){
    let h=Number(after[1]), m=Number(after[2]||0);
    if(after[3]==='pm' && h<12) h+=12;
    if(after[3]==='am' && h===12) h=0;
    if(!after[3] && h<=8) h+=12; // "después de las 5" => 17:00 in barber context
    const min=h*60+m;
    out=out.filter(s=>minutesOf(s)>=min);
  }

  const before=t.match(/(?:antes de|hasta)\s+(?:las?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if(before){
    let h=Number(before[1]), m=Number(before[2]||0);
    if(before[3]==='pm' && h<12) h+=12;
    if(before[3]==='am' && h===12) h=0;
    const min=h*60+m;
    out=out.filter(s=>minutesOf(s)<=min);
  }

  return out;
}

function findServiceFromText(text, db){
  const t=text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  if(/corte.*barba.*disen|disen.*barba.*corte|corte.*disen.*barba/.test(t))
    return db.services.find(s=>s.id==='corte-barba-diseno');
  if(/corte.*barba|barba.*corte/.test(t))
    return db.services.find(s=>s.id==='corte-barba');
  if(/corte.*disen|disen.*corte/.test(t))
    return db.services.find(s=>s.id==='corte-diseno');
  if(/\bbarba\b/.test(t)) return db.services.find(s=>s.id==='barba');
  if(/\bdisen/.test(t)) return db.services.find(s=>s.id==='diseno');
  if(/\bcorte\b/.test(t)) return db.services.find(s=>s.id==='corte');
  return null;
}

function findBarberFromText(text, db){
  const t=text.toLowerCase();
  return db.barbers.find(b=>t.includes(b.name.toLowerCase()));
}

function availabilityMessage(date, barberId, phrase=''){
  const db=readDB();
  let slots=slotsFor(date,barberId);
  slots=filterSlotsByPhrase(slots,phrase).slice(0,10);
  const barber=db.barbers.find(x=>x.id===barberId)?.name || 'el barbero';
  if(!slots.length) return `No tengo horarios libres que coincidan para ${date} con ${barber}. Si quieres, dime otra fecha u horario y lo reviso enseguida.`;
  return `📅 Para ${date} con ${barber} tengo disponibles:\n${slots.map((x,i)=>`${i+1}. ${x}`).join('\n')}\n\nPuedes responder con el número o escribir la hora que prefieras.`;
}

function looksLikeAvailabilityQuestion(text){
  const t=text.toLowerCase();
  return /(disponible|disponibilidad|horario|hora|cita|turno|espacio|cupo|reserv|agend|hoy|mañana|manana|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo)/.test(t);
}

function parseChosenTime(text, available){
  const n=parseInt(text.trim(),10);
  if(Number.isInteger(n) && n>=1 && n<=available.length) return available[n-1];

  const m=text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if(!m) return null;
  let h=Number(m[1]), mins=Number(m[2]||0);
  const ap=(m[3]||'').toLowerCase();
  if(ap==='pm' && h<12) h+=12;
  if(ap==='am' && h===12) h=0;
  if(!ap && h<=8) h+=12;
  const hhmm=`${String(h).padStart(2,'0')}:${String(mins).padStart(2,'0')}`;
  return available.includes(hhmm)?hhmm:null;
}

const waSessions = new Map();

app.post('/webhooks/whatsapp', async (req,res)=>{
  res.sendStatus(200);
  try{
    const value=req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg=value?.messages?.[0];
    if(!msg) return;

    const from=msg.from;
    const text=(msg.text?.body||'').trim();
    if(!text) return sendWhatsApp(from,'Por ahora puedo ayudarte por texto. Escríbeme qué día y horario buscas para tu cita.');

    const lower=text.toLowerCase();
    const db=readDB();
    let s=waSessions.get(from)||{step:'idle',data:{}};

    // Greeting / help
    if(/^(hola|buenas|buenos dias|buenas tardes|buenas noches|hey|ola)\b/i.test(lower) && s.step==='idle'){
      waSessions.set(from,s);
      return sendWhatsApp(from,
        '👋 ¡Hola! Soy el asistente de reservas de la barbería.\n\n' +
        'Puedes escribirme de forma natural, por ejemplo:\n' +
        '• “¿Tienes cita para hoy después de las 5?”\n' +
        '• “Quiero corte mañana en la tarde”\n' +
        '• “Reserva el viernes a las 16:00”\n\n' +
        'Yo reviso la agenda y te ayudo a reservar.'
      );
    }

    // Capture service/barber/date wherever they appear.
    const service=findServiceFromText(text,db);
    if(service) s.data.serviceId=service.id;
    const barber=findBarberFromText(text,db);
    if(barber) s.data.barberId=barber.id;
    const parsedDate=dateFromSpanish(text);
    if(parsedDate) s.data.date=parsedDate;

    // Availability questions can start from any message.
    if(looksLikeAvailabilityQuestion(text) && (parsedDate || s.data.date)){
      const date=s.data.date;
      if(!s.data.barberId && db.barbers.length===1) s.data.barberId=db.barbers[0].id;

      if(!s.data.barberId){
        s.step='barber';
        waSessions.set(from,s);
        return sendWhatsApp(from,
          `Claro 👍 Para ${date}, ¿con qué barbero prefieres?\n` +
          db.barbers.map((x,i)=>`${i+1}. ${x.name}`).join('\n')
        );
      }

      let available=filterSlotsByPhrase(slotsFor(date,s.data.barberId),text);
      s.data.lastAvailable=available.slice(0,10);
      s.step='time';
      waSessions.set(from,s);
      return sendWhatsApp(from,availabilityMessage(date,s.data.barberId,text));
    }

    if(s.step==='barber'){
      const idx=parseInt(text,10)-1;
      const chosen=db.barbers[idx] || findBarberFromText(text,db);
      if(!chosen) return sendWhatsApp(from,'Dime el nombre del barbero o responde con el número de la lista.');
      s.data.barberId=chosen.id;
      if(!s.data.date){
        s.step='date'; waSessions.set(from,s);
        return sendWhatsApp(from,'Perfecto. ¿Para qué día necesitas la cita? Puedes decir “hoy”, “mañana” o una fecha.');
      }
      s.data.lastAvailable=slotsFor(s.data.date,s.data.barberId).slice(0,10);
      s.step='time'; waSessions.set(from,s);
      return sendWhatsApp(from,availabilityMessage(s.data.date,s.data.barberId,text));
    }

    if(s.step==='date'){
      const date=dateFromSpanish(text);
      if(!date) return sendWhatsApp(from,'Dime una fecha, por ejemplo “hoy”, “mañana”, “viernes” o 2026-09-15.');
      s.data.date=date;
      s.data.lastAvailable=filterSlotsByPhrase(slotsFor(date,s.data.barberId),text).slice(0,10);
      s.step='time'; waSessions.set(from,s);
      return sendWhatsApp(from,availabilityMessage(date,s.data.barberId,text));
    }

    if(s.step==='time'){
      let available=slotsFor(s.data.date,s.data.barberId,s.data.serviceId||null);
      const chosen=parseChosenTime(text, available);
      if(!chosen){
        // User may have changed date or asked another availability question.
        const changed=dateFromSpanish(text);
        if(changed){
          s.data.date=changed;
          s.data.lastAvailable=filterSlotsByPhrase(slotsFor(changed,s.data.barberId),text).slice(0,10);
          waSessions.set(from,s);
          return sendWhatsApp(from,availabilityMessage(changed,s.data.barberId,text));
        }
        return sendWhatsApp(from,'Ese horario no está libre. Escríbeme otra hora o dime otro día y te muestro opciones.');
      }
      s.data.time=chosen;

      if(!s.data.serviceId){
        s.step='service'; waSessions.set(from,s);
        return sendWhatsApp(from,
          `Listo, apartemos ${chosen}. ¿Qué servicio deseas?\n` +
          db.services.map((x,i)=>`${i+1}. ${x.name} · $${x.price}`).join('\n')
        );
      }
      s.step='name'; waSessions.set(from,s);
      return sendWhatsApp(from,'Perfecto 👌 ¿A nombre de quién registro la cita?');
    }

    if(s.step==='service'){
      const idx=parseInt(text,10)-1;
      const chosen=db.services[idx] || findServiceFromText(text,db);
      if(!chosen) return sendWhatsApp(from,'Dime el servicio o responde con el número de la lista.');
      s.data.serviceId=chosen.id;
      s.step='name'; waSessions.set(from,s);
      return sendWhatsApp(from,'Perfecto 👌 ¿A nombre de quién registro la cita?');
    }

    if(s.step==='name'){
      // Atomic-ish last validation in this MVP. Production DB should enforce UNIQUE.
      if(!slotsFor(s.data.date,s.data.barberId,s.data.serviceId||null).includes(s.data.time)){
        s.step='time';
        waSessions.set(from,s);
        return sendWhatsApp(from,
          '⚠️ Ese horario acaba de ser reservado por otra persona.\n\n' +
          availabilityMessage(s.data.date,s.data.barberId,'')
        );
      }

      const fresh=readDB();
      const booking={
        id:`BK-${Date.now()}`,
        name:text,
        phone:from,
        serviceId:s.data.serviceId,
        barberId:s.data.barberId,
        date:s.data.date,
        time:s.data.time,
        source:'whatsapp',
        status:'confirmed',
        createdAt:new Date().toISOString()
      };
      fresh.bookings.push(booking);
      writeDB(fresh);
      waSessions.delete(from);

      const serviceName=fresh.services.find(x=>x.id===booking.serviceId)?.name;
      const barberName=fresh.barbers.find(x=>x.id===booking.barberId)?.name;
      return sendWhatsApp(from,
        `✅ ¡Reserva confirmada!\n\n` +
        `👤 ${booking.name}\n` +
        `✂️ ${serviceName}\n` +
        `💈 ${barberName}\n` +
        `📅 ${booking.date}\n` +
        `🕐 ${booking.time}\n\n` +
        `Código: ${booking.id}\n` +
        `Si luego necesitas cambiarla, escríbeme “cambiar cita”.`
      );
    }

    // Generic auto-reply so no text message is left unanswered.
    s.step='date';
    waSessions.set(from,s);
    return sendWhatsApp(from,
      'Claro, te ayudo con tu cita 😊 ¿Para qué día la necesitas? ' +
      'Puedes decirme “hoy”, “mañana”, un día de la semana o una fecha.'
    );

  }catch(e){
    console.error('WhatsApp webhook error:',e);
  }
});
app.listen(PORT,()=>console.log(`Barbería: http://localhost:${PORT}`));
