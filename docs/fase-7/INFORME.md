# Fase 7 — Barberías reales e independientes

Objetivo: que cualquier propietario pueda registrarse desde la página pública de Master Fade, confirmar su correo, elegir un plan y tener desde el primer día **su propio sistema de reservas**, con su panel, su página pública, su enlace y, cuando lo conecte, su propio WhatsApp con Elia.

## Qué cambia

### 1. Registro público (Panel Maestro → El Máster Reservas)
- `https://<Panel Maestro>/registro`: página pública, sin sesión, con el botón «Crear mi cuenta». El formulario pide usuario, correo, WhatsApp, país y nombre de la barbería. Después el propietario elige su plan y los días gratis.
- La contraseña se crea en El Máster Reservas, que recibe los datos y el plan ya completados. La contraseña nunca pasa por el Panel Maestro.
- Si dos barberías tienen el mismo nombre, la segunda recibe otra dirección (`fade-zone-2`) en lugar de un error.
- Cada barbería nueva empieza con un barbero que lleva el nombre del propietario y con el catálogo de servicios de ejemplo. Así puede recibir reservas desde el primer día y cambiarlo todo desde su panel.
- Cada propietario solo administra su propia barbería: la barbería sale de la sesión, nunca de lo que envía el navegador. Las cuentas de propietario no sirven en el Panel Maestro.

### 2. Correo y verificación (Resend)
- En producción la confirmación del correo es **obligatoria siempre**. `VERIFICAR_CORREO=0` ya no la desactiva en producción.
- Sin confirmar el correo no se abre sesión: el inicio de sesión responde 403 y no crea cookie.
- El propietario puede pedir el reenvío del enlace (`/api/auth/verificacion/reenviar`). La respuesta es la misma exista o no la cuenta.
- Si Resend rechaza el envío (por ejemplo, con el dominio sin verificar), la cuenta queda pendiente y el propietario ve el aviso para pedir otro enlace. La cuenta nunca se activa sola.
- El registro en producción se abre solo con `REGISTRO_ABIERTO=1` **y** el correo configurado (`RESEND_API_KEY`, `CORREO_REMITENTE`, `PUBLIC_BASE_URL`).
- Panel Maestro → **Integraciones** muestra si el correo está configurado, si la verificación es obligatoria y si el registro está abierto. Tiene además un botón **«Enviar prueba»**, que manda un correo real por Resend.

### 3. Barberías independientes
- **Página pública propia:** `https://<El Máster Reservas>/b/<dirección>/`. Muestra sus servicios, sus barberos, sus horarios, sus fotos, sus colores y la reserva en línea.
- Bajo `/b/<dirección>/` solo existen la página y sus cuatro llamadas públicas: información, imágenes, disponibilidad y reservas. No hay administración, sesiones, cuentas ni WhatsApp.
- Una dirección que no existe responde «Barbería no encontrada». Una barbería suspendida no tiene página pública. Una vencida conserva su página, pero no acepta reservas.
- **La barbería principal no cambia:** El Máster sigue en `/`, con su página, sus reservas, su WhatsApp y su protección.
- Cada barbería usa su propia zona horaria para calcular los horarios.
- El propietario ve su enlace en **Configuración → Tu página de reservas**, con los botones Copiar, Abrir y Compartir por WhatsApp.
- El panel de cada barbería muestra su propio nombre. El saludo de Elia por defecto usa ese nombre. El Máster conserva su marca.
- Las reservas de cada barbería llegan a su agenda. El Panel Maestro las ve como cifras (sin datos de clientes), junto con su enlace público y el estado de su WhatsApp.

### 4. WhatsApp y Elia por barbería
- El Máster sigue con su número, configurado en las variables del servidor. **Ese número nunca se usa para otra barbería** y nadie más puede conectarlo.
- Cada barbería conecta **su** número de **su** cuenta de Meta en **Configuración → WhatsApp y Elia**:
  - pega el *Phone number ID*, el *WhatsApp Business Account ID*, el token permanente y el *App Secret*;
  - el servidor los comprueba con Meta antes de guardarlos (con `appsecret_proof`) y los guarda cifrados (AES-256-GCM con `WHATSAPP_CLAVE_CIFRADO`);
  - el token y el App Secret nunca se vuelven a mostrar, ni en el panel ni en el Panel Maestro;
  - un número solo puede pertenecer a una barbería.
- Cada barbería tiene su propio webhook, `/webhooks/whatsapp/n/<clave aleatoria>`, con su propio token de verificación:
  - un mensaje se acepta solo si viene **firmado** con el App Secret de esa barbería (`X-Hub-Signature-256`) y para su número;
  - Elia responde con los datos de esa barbería y **desde su número**.
- Las conversaciones en curso se separan por barbería: la misma persona puede escribir a dos barberías sin que se mezclen. Ninguna barbería ve conversaciones de otra.
- Con la suscripción vencida o suspendida, Elia avisa que la barbería no recibe reservas en línea.
- El webhook de El Máster ignora los mensajes dirigidos a otro número.

## Migraciones (no destructivas)
- El Máster Reservas, `2026-10-fase7-001`: solo **crea** la tabla `business_whatsapp`.
- Panel Maestro: solo **añade** dos columnas (`public_url`, `whatsapp`) a `master_fade_businesses`.
- Ensayado con el código real de `main` (`test/actualizacion.test.js`):
  - producción actual con datos → esta versión: mismas filas y mismo contenido en todas las tablas;
  - vuelta atrás: `main` arranca de nuevo sobre la base actualizada con todos los datos.

## Pruebas nuevas
- `test/fase7-barberias.test.js` (API):
  - registro con direcciones únicas, primer barbero y enlace;
  - página pública por barbería, rutas bloqueadas bajo `/b/`;
  - reservas aisladas y aislamiento entre propietarios;
  - datos para el Panel Maestro sin datos de clientes;
  - WhatsApp: comprobación con Meta simulada, cifrado, número reservado y número en uso, verificación del webhook, firma obligatoria, respuesta desde el número correcto, suscripción vencida y desconexión;
  - correo en producción: verificación obligatoria, reenvío y rechazo de Resend.
- `test/fase7-navegador.test.js` (Chromium, tamaño de teléfono): un cliente sin sesión reserva en la página de la barbería nueva. El propietario ve su nombre, su enlace y la conexión de WhatsApp. La página de El Máster sigue igual.
- `test/actualizacion.test.js`: ensayo de actualización y de vuelta atrás.
- En el Panel Maestro: registro completo desde `/registro` sin sesión, reserva real en la página propia de la barbería nueva desde un teléfono, pantalla Integraciones y correo de prueba.
