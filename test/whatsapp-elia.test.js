'use strict';
/*
  Webhook de WhatsApp y Elia. El servidor arranca sin WHATSAPP_TOKEN, así que
  ninguna respuesta sale hacia Meta: solo se registra "[DEMO WhatsApp]".
*/
const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciarServidor, proximoDia, VERIFY_TOKEN } = require('./apoyo/servidor');

const LUNES = proximoDia(1);
const [Y, M, D] = LUNES.split('-');
const FECHA_TEXTO = `${D}/${M}/${Y}`;

let s;
test.before(async () => { s = await iniciarServidor(); });
test.after(async () => { await s.detener(); s.borrar(); });

test('verificación del webhook (GET) con el token correcto', async () => {
  const ok = await s.pedir('GET', `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=12345`);
  assert.equal(ok.status, 200);
  assert.equal(ok.texto, '12345');
  const mal = await s.pedir('GET', '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=12345');
  assert.equal(mal.status, 403);
});

test('el webhook responde 200 a eventos sin mensajes (estados de entrega)', async () => {
  const r = await s.pedir('POST', '/webhooks/whatsapp', { entry: [{ changes: [{ value: { statuses: [{ status: 'delivered' }] } }] }] });
  assert.equal(r.status, 200);
});

test('saludo, cancelación y despedida', async () => {
  const from = '593990000101';
  assert.match(await s.enviarWhatsApp('hola', from), /Bienvenido a El Máster/);
  assert.match(await s.enviarWhatsApp('quiero reservar', from), /Cuántos turnos/);
  assert.match(await s.enviarWhatsApp('cancelar', from), /quedó cancelado/);
  assert.match(await s.enviarWhatsApp('gracias', from), /placer atenderte/);
});

test('reserva completa por Elia con edición y confirmación', async () => {
  const from = '593990000102';
  assert.match(await s.enviarWhatsApp('quiero reservar', from), /Cuántos turnos/);
  assert.match(await s.enviarWhatsApp('1', from), /Qué servicio/);
  assert.match(await s.enviarWhatsApp('corte', from), /Para qué día/);
  assert.match(await s.enviarWhatsApp(FECHA_TEXTO, from), /qué hora/);
  assert.match(await s.enviarWhatsApp('10:00', from), /A nombre de quién/);
  const resumen = await s.enviarWhatsApp('Cliente Elia', from);
  assert.match(resumen, /Resumen de tu reserva/);
  assert.match(resumen, new RegExp(LUNES));
  assert.match(resumen, /10:00 AM – 10:40 AM/);

  assert.match(await s.enviarWhatsApp('editar', from), /Qué deseas editar/);
  assert.match(await s.enviarWhatsApp('hora', from), /nueva hora/);
  assert.match(await s.enviarWhatsApp('11:00', from), /11:00 AM – 11:40 AM/);

  assert.equal(s.leerDb().bookings.filter(b => b.phone === from).length, 0, 'nada se guarda antes de confirmar');
  const ok = await s.enviarWhatsApp('confirmar', from);
  assert.match(ok, /Reserva confirmada/);
  const codigo = ok.match(/BK-\d+/)[0];

  const guardadas = s.leerDb().bookings.filter(b => b.phone === from);
  assert.equal(guardadas.length, 1);
  assert.equal(guardadas[0].id, codigo);
  assert.equal(guardadas[0].source, 'whatsapp');
  assert.equal(guardadas[0].date, LUNES);
  assert.equal(guardadas[0].time, '11:00');
  assert.equal(guardadas[0].status, 'confirmed');

  const panel = await s.pedir('GET', '/api/bookings');
  assert.ok(panel.json.some(b => b.id === codigo), 'la reserva de Elia aparece en el panel');

  const disp = await s.pedir('GET', `/api/availability?date=${LUNES}&barberId=master&serviceIds=corte`);
  assert.ok(!disp.json.slots.includes('11:00'), 'web y Elia comparten agenda');
});

test('Elia no confirma un horario que la web ocupó durante la conversación', async () => {
  const from = '593990000103';
  await s.enviarWhatsApp('quiero reservar', from);
  await s.enviarWhatsApp('1', from);
  await s.enviarWhatsApp('barba', from);
  await s.enviarWhatsApp(FECHA_TEXTO, from);
  await s.enviarWhatsApp('15:00', from);
  assert.match(await s.enviarWhatsApp('Cliente Choque', from), /Resumen de tu reserva/);

  const web = await s.pedir('POST', '/api/bookings', { name: 'Cliente Web', phone: '0990000104', barberId: 'master', serviceIds: ['barba'], date: LUNES, time: '15:00' });
  assert.equal(web.status, 201);

  assert.match(await s.enviarWhatsApp('confirmar', from), /acaba de ocuparse/);
  assert.equal(s.leerDb().bookings.filter(b => b.date === LUNES && b.time === '15:00').length, 1, 'sin reservas duplicadas');
});

test('las conversaciones de dos clientes no se mezclan', async () => {
  const a = '593990000105';
  const b = '593990000106';
  await s.enviarWhatsApp('quiero reservar', a);
  await s.enviarWhatsApp('1', a);
  assert.match(await s.enviarWhatsApp('hola', b), /Bienvenido/);
  assert.match(await s.enviarWhatsApp('corte', a), /Para qué día/, 'A sigue en su propio paso');
  await s.enviarWhatsApp('cancelar', a);
});
