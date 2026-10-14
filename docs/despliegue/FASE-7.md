# Fase 7 — Despliegue coordinado y configuración externa

Todo se hace desde Render, Resend y Meta, sin terminal. Los pasos marcados con 🔒 necesitan tu autorización.

## A. Correo con Resend (necesario para abrir el registro)

Resend solo envía correos a otras personas desde un **dominio propio verificado**. La dirección de pruebas `onboarding@resend.dev` solo llega a tu propio correo de Resend, así que no sirve para tus clientes. Si todavía no tienes un dominio (por ejemplo `masterfade.com`), cómpralo primero en cualquier registrador (unos 10–15 USD al año).

1. Crea tu cuenta en https://resend.com (gratis hasta 3 000 correos al mes y 100 al día).
2. Ve a **Domains → Add Domain**. Escribe tu dominio o un subdominio para correos, por ejemplo `correo.masterfade.com`, y elige la región (us-east-1 está bien).
3. Resend te muestra varios registros DNS (DKIM, SPF y MX). Cópialos **exactamente** en el panel DNS de tu dominio, en el registrador o en Cloudflare.
4. Vuelve a Resend y pulsa **Verify DNS Records**. Espera a que el dominio diga **Verified**: suelen ser minutos, a veces horas.
5. Ve a **API Keys → Create API Key**:
   - nombre: `master-reservas-produccion`;
   - permiso: **Sending access**;
   - dominio: el que verificaste.

   Copia la clave (empieza por `re_`): **solo se muestra una vez**. Guárdala en tu gestor de contraseñas y **no la pegues en el chat**.
6. En Render → **El Máster Reservas** → **Environment**, añade con **Save only**:

   | Variable | Valor |
   |---|---|
   | `RESEND_API_KEY` | La clave del paso 5 |
   | `CORREO_REMITENTE` | `Master Fade <no-responder@TU-DOMINIO>`, con el dominio verificado del paso 4 |
   | `CORREO_RESPONDER_A` | Opcional: el correo donde quieres recibir respuestas |

7. Después de desplegar (sección D), abre Panel Maestro → **Integraciones** → **Enviar prueba** a tu correo. Si no llega, revisa la carpeta de correo no deseado y que el dominio siga en **Verified**.

## B. WhatsApp de cada barbería (lo hace cada propietario)

El número de El Máster no se toca ni se comparte. Cada barbería usa su propio número y su propia cuenta de Meta. El propietario ve estos pasos en su panel, en **Configuración → WhatsApp y Elia**.

1. **Meta Business:** en https://business.facebook.com, crear o usar el portafolio comercial de la barbería.
2. **Aplicación:** en https://developers.facebook.com → **Mis apps → Crear app**:
   - tipo **Empresa**;
   - vincularla al portafolio de la barbería;
   - agregar el producto **WhatsApp**.
3. **Número:** en WhatsApp → **Configuración de la API**, agregar el número de la barbería y verificarlo por SMS o llamada. Ese número no puede estar en uso en la app de WhatsApp: si lo está, hay que eliminar esa cuenta antes. Meta revisa el **nombre visible**.
4. **Token permanente:** en Configuración del negocio → **Usuarios del sistema**:
   - crear uno con rol Administrador;
   - asignarle la app y la cuenta de WhatsApp con control total;
   - **Generar token** con caducidad **Nunca** y los permisos `whatsapp_business_messaging` y `whatsapp_business_management`.
5. **Datos que pega en su panel:**
   - *Phone number ID* y *WhatsApp Business Account ID*: los dos están en WhatsApp → Configuración de la API;
   - el **token** del paso 4;
   - la **clave secreta de la app**: Configuración de la app → Básica → *App Secret*.

   Pulsa **Comprobar y conectar**. Meta valida los datos al momento.
6. **Webhook:** en la app de Meta, WhatsApp → **Configuración → Webhook**:
   - pegar la **URL de devolución de llamada** y el **token de verificación** que muestra su panel;
   - pulsar **Verificar y guardar**;
   - suscribirse al campo **messages**.
7. **Publicar la app (modo En vivo):** Meta pide una URL de política de privacidad y otra de eliminación de datos. Puede usar:
   - `https://<El Máster Reservas>/politica-privacidad.html`;
   - `https://<El Máster Reservas>/eliminacion-datos.html`.
8. **Opcional:** agregar un método de pago en WhatsApp Manager para conversaciones que inicia la barbería, y la **verificación del negocio** para ampliar los límites de mensajes.

Más adelante, Master Fade puede registrarse como **Proveedor de tecnología** de Meta y ofrecer el **Registro insertado** (Embedded Signup), en el que el propietario conecta su número con un solo botón. Eso exige la verificación del negocio de Master Fade y la revisión de la app por parte de Meta. El flujo actual ya guarda cada conexión por barbería, así que se puede añadir sin cambiar nada de lo anterior.

## C. Variables de Render

**El Máster Reservas** (con **Save only**):

| Variable | Cuándo | Valor |
|---|---|---|
| `WHATSAPP_CLAVE_CIFRADO` | Antes de desplegar | Al menos 48 caracteres aleatorios (generador de tu gestor de contraseñas). **No la cambies nunca**: si cambia, los propietarios tendrán que volver a conectar su WhatsApp. Sin ella, la conexión de WhatsApp de las barberías queda desactivada (El Máster no se ve afectada). |
| `RESEND_API_KEY`, `CORREO_REMITENTE` (y `CORREO_RESPONDER_A`) | Cuando Resend diga **Verified** | Ver la sección A |
| `REGISTRO_ABIERTO` = `1` | **Al final**, después de las comprobaciones de la sección D | Abre el registro de barberías reales |

Las demás variables no cambian: `DATABASE_URL`, `PUBLIC_BASE_URL`, `PLATAFORMA_CLAVE` y las de WhatsApp de El Máster.

**Panel Maestro:** ninguna variable nueva.

## D. Despliegue único y coordinado 🔒 (unos 20 minutos)

1. **Autorización:** fusiono los dos Pull Requests con `main`, primero El Máster Reservas y después el Panel Maestro. Con Auto-Deploy desactivado, fusionar no publica nada.
2. **Render → El Máster Reservas → Environment:** añade `WHATSAPP_CLAVE_CIFRADO`, y las de Resend si ya las tienes, con **Save only**.
3. **Render → El Máster Reservas → Manual Deploy → Deploy latest commit.** En **Logs** deben aparecer:
   - `MIGRACIÓN APLICADA: 2026-10-fase7-001`;
   - `BARBERÍA PROTEGIDA: el-master`;
   - `EL MÁSTER RESERVAS INICIADO`.
4. **Render → Panel Maestro → Manual Deploy → Deploy latest commit.**
5. **Comprobaciones:**
   - **Página pública de El Máster:** carga igual que antes. Haz una reserva de prueba y cancélala desde el panel.
   - **WhatsApp de El Máster:** escribe «hola» a Elia y responde.
   - **Panel Maestro → Integraciones:** El Máster Reservas «Conectado», Correo «Configuradas» y WhatsApp por barbería «Activada». Pulsa **Enviar prueba** y comprueba que el correo llega.
6. **Ensayo real del registro:**
   - añade `REGISTRO_ABIERTO=1` en El Máster Reservas con **Save only** y pulsa **Manual Deploy → Restart service** (no hace falta compilar de nuevo);
   - en una ventana de incógnito, abre `https://<Panel Maestro>/registro` y registra una barbería de prueba con **otro correo tuyo**;
   - confirma el correo, entra y abre **Configuración → Tu página de reservas**;
   - haz una reserva desde tu teléfono con ese enlace: debe aparecer en esa barbería y, como cifra, en el Panel Maestro;
   - termina suspendiendo esa barbería de prueba desde el Panel Maestro → Suscripciones.
7. **Listo para barberías reales:** comparte `https://<Panel Maestro>/registro`.

**Si algo falla:**
- **Render → Events → Rollback** del servicio afectado. Las migraciones solo añaden una tabla y dos columnas, y la versión anterior arranca sobre la base actualizada con todos los datos (ensayado).
- Para cerrar el registro de inmediato: `REGISTRO_ABIERTO=0` y **Restart service**.
