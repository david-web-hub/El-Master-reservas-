# Barber Studio — reservas web + WhatsApp

MVP funcional preparado para:
- Reservas por web.
- Selección de servicio y barbero.
- Consulta de horarios libres.
- Bloqueo de horarios ocupados.
- Revalidación antes de guardar para reducir dobles reservas.
- Nombre y WhatsApp del cliente.
- Agenda única (`/admin.html`) para reservas web y WhatsApp.
- Galería de fotos/videos.
- Webhook de WhatsApp Cloud API.
- Flujo conversacional por WhatsApp que consulta disponibilidad y crea la cita.

## Probar localmente
1. Instala Node.js 18+.
2. Copia `.env.example` a `.env`.
3. Ejecuta:
   npm install
   npm start
4. Abre http://localhost:3000
5. Agenda: http://localhost:3000/admin.html

## Conectar WhatsApp real
Necesitas una cuenta de Meta Business/WhatsApp Business Platform y configurar:
- WHATSAPP_TOKEN
- WHATSAPP_PHONE_NUMBER_ID
- WHATSAPP_VERIFY_TOKEN
- PUBLIC_BASE_URL con HTTPS público

En Meta configura el webhook:
`https://TU-DOMINIO.com/webhooks/whatsapp`

## Antes de producción
Este paquete es un MVP. Para producción conviene reemplazar `data/db.json` por PostgreSQL/Supabase y crear una restricción UNIQUE sobre (barber_id, date, time), además de:
- autenticación del administrador;
- validación de firma del webhook;
- plantillas aprobadas para mensajes iniciados por el negocio;
- política de privacidad;
- almacenamiento real de galería (Cloudinary/S3/Supabase Storage);
- horarios configurables por barbero, descansos, vacaciones y duración real por servicio;
- zona horaria America/Guayaquil;
- cancelación/reprogramación y recordatorios.


## WhatsApp inteligente — versión 2
El bot ahora entiende mensajes naturales frecuentes en español:
- "¿Tienes para hoy?"
- "Mañana en la tarde"
- "Hoy después de las 5"
- "El viernes"
- "Reserva a las 16:00"
- Servicio/barbero escritos por nombre.

Todos los mensajes de texto reciben respuesta automática. La disponibilidad siempre se consulta contra la misma agenda del sitio.

### Importante
Este MVP interpreta lenguaje natural con reglas locales, sin costo de IA por mensaje. Para conversaciones totalmente abiertas ("¿qué corte me recomiendas?", preguntas sobre precios, ubicación, estilos, etc.) se puede añadir después un modelo de IA, pero las acciones de agenda deben seguir pasando por las funciones verificadas del servidor para evitar reservas inventadas.

### Datos necesarios para conectarlo a tu WhatsApp real
- Meta Business Portfolio.
- WhatsApp Business Account (WABA).
- Número de teléfono empresarial registrado.
- `WHATSAPP_PHONE_NUMBER_ID`.
- Token con permiso `whatsapp_business_messaging`.
- Webhook HTTPS público y suscripción de la app al WABA.


## Configuración real de El Máster
- Barbería: El Máster
- Barbero: Master
- Atención: lunes a sábado
- Horario: 08:00–12:00 y 13:30–19:00
- Descanso: 12:00–13:30
- Domingo: cerrado
- Corte: $5.00 / 40 min
- Barba: $2.00 / 20 min
- Diseño: $1.50 / 15 min
- Corte + barba: $7.00 / 60 min
- Corte + diseño: $6.50 / 55 min
- Corte + barba + diseño: $8.50 / 75 min
- Anticipo: desactivado por ahora y preparado para activarse después.

La disponibilidad toma en cuenta la duración real del servicio y los bloques de descanso.
