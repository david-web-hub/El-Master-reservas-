# Fase 5 — Invitaciones seguras y correos electrónicos

Rama: `claude/hopeful-curie-fcnqea`. **No se desplegó nada.** No se tocó Render, Meta,
WhatsApp, Elia, datos reales ni el repositorio del Panel Maestro. No se creó ninguna
cuenta externa, no se contrató Resend y no se usó ninguna clave real: todos los envíos
se probaron contra un servidor falso local. `main` no cambia y no hay Pull Request.

## 1. Qué se implementó

### Invitaciones que se aceptan expresamente

| Pedido | Implementación |
|---|---|
| Invitación pendiente | «+ Invitar usuario» (Configuración → Usuarios y roles) crea una invitación **pendiente**. Nadie obtiene acceso, ni se crea su cuenta, hasta que acepta. |
| Aceptar o rechazar | **Con el enlace del correo** (`acceso.html#invitacion=…`): quien no tiene cuenta escribe su nombre y crea su contraseña; quien ya la tiene confirma con **su contraseña** y, si usa dos pasos, con **su código**. **Desde «Mi cuenta»**, si ya inició sesión con ese mismo correo: bloque «Invitaciones pendientes» con «Aceptar» y «Rechazar», y un aviso al entrar al panel. |
| Sin accesos automáticos | Invitar un correo que ya tiene cuenta ya no da acceso directo (era la mejora pendiente de la fase 4). Iniciar sesión pidiendo esa barbería, cambiarse a ella o conocer el identificador de la invitación no sirve. |
| Varias barberías | Si la persona pertenece a más de una, «Mi cuenta» muestra «Mis barberías» y permite **entrar** a otra sin escribir la contraseña. Solo aparecen las suyas; la sesión anterior se cierra. Aceptar no cambia la barbería abierta. |
| Gestión del propietario | Lista «Invitaciones pendientes» con estado **Pendiente** o **Vencida**, **Reenviar** (enlace nuevo y 7 días más; el anterior deja de servir) y **Cancelar invitación**. Invitar otra vez al mismo correo reemplaza la pendiente. Invitar a quien ya es miembro responde «ya tiene acceso». |
| Permisos | Solo el propietario invita, reenvía y cancela. El administrador ve la lista. Recepción y barbero no la ven. |

### Correos con Resend (preparado, sin activar)

- `correo.js`: módulo nuevo y único punto de envío. Lo usan la **confirmación de cuenta**,
  la **recuperación de contraseña** y las **invitaciones**.
- Plantillas HTML con la identidad del sistema (fondo negro, tarjeta gris oscuro, botón
  dorado, corona), con versión de texto plano, el enlace copiable y el plazo de
  vencimiento. Se ven bien en computadora y en teléfono. Los datos se escapan. Vistas
  previas en `docs/fase-5/correo-*.png`.
- **Credenciales solo por variables de entorno:** `RESEND_API_KEY`, `CORREO_REMITENTE`,
  `CORREO_RESPONDER_A` (opcional), `PUBLIC_BASE_URL` y `CORREO_TIEMPO_LIMITE_MS`
  (opcional, 10 s por defecto). La clave nunca aparece en los registros.
- **Errores de envío:**
  - Tiempo límite por intento.
  - Un solo reintento ante errores temporales (429, 5xx o sin conexión), con la misma
    clave de idempotencia para que Resend no lo envíe dos veces.
  - Un rechazo (por ejemplo, remitente no verificado) no se reintenta.
  - La cuenta o la invitación no se pierden: el panel avisa «No se pudo enviar el
    correo» y se puede reenviar.
  - Cada fallo queda en el registro de seguridad (`correo_fallido`), sin datos sensibles.
  - La recuperación de contraseña responde lo mismo aunque falle, para no revelar cuentas.
- **Sin configurar:**
  - En desarrollo el enlace se muestra en la consola, como antes.
  - En producción no se envía nada y **nunca** se escribe el enlace en los registros.
- **Registro en producción:** sigue cerrado. Ahora solo se abre si se cumplen **las dos
  condiciones**: `REGISTRO_ABIERTO=1` y correo completo (`RESEND_API_KEY`,
  `CORREO_REMITENTE`, `PUBLIC_BASE_URL`). Si falta el correo, el servidor lo advierte al
  arrancar y el registro sigue cerrado.

### Enlaces de un solo uso, vencidos y revocados

| Enlace | Plazo | Usado | Vencido | Revocado o reemplazado |
|---|---|---|---|---|
| Confirmación de correo | 24 h | «Este enlace ya se usó» → pedir otro | «El enlace venció» → pedir otro | Reenviar anula el anterior |
| Recuperación de contraseña | 1 h | Mensaje propio → pedir otro | Mensaje propio → pedir otro | Uno nuevo anula el anterior |
| Invitación | 7 días | «ya se aceptó» / «se rechazó» | «venció: pide una nueva» | «La barbería la canceló o envió una más reciente» |

Los enlaces se guardan como resumen SHA-256 y se consumen dentro de una transacción con
bloqueo de fila, así que dos clics simultáneos no pueden usarlo dos veces.

### Fuera del alcance (como se pidió)

El código QR para la verificación en dos pasos queda para una actualización posterior.
No se añadieron otras funciones.

## 2. Diseño

- Los elementos nuevos usan las clases existentes: `card`, `barber-card`, `badge`,
  `btn-gold`, `btn-dark`, `btn-danger`, `switch-row`, `input` y la ventana modal.
- La pantalla de acceso suma la vista «Invitación» con su mismo estilo.
- La página pública no cambia.
- Comparación automática contra `main`: ver la sección 4.
- Capturas en `docs/fase-5/`:
  - Invitación con cuenta nueva y con cuenta existente, en escritorio y teléfono.
  - Invitación no disponible.
  - «Mi cuenta» con invitaciones pendientes y «Mis barberías».
  - «Usuarios y roles» con invitaciones pendientes, y el formulario para invitar.
  - Elegir barbería al iniciar sesión (pantalla existente, para quien pertenece a varias).
  - Los tres correos, en escritorio y teléfono.

## 3. Archivos

- **`correo.js` (nuevo):** plantillas y envío con Resend.
- **`autenticacion.js`:**
  - Invitaciones: crear, listar, reenviar, cancelar, consultar, aceptar y rechazar.
  - «Mis invitaciones» y cambio de barbería.
  - Enlaces con estado usado, vencido o inválido.
  - Registro de fallos de correo.
- **`almacen.js`:** migración `2026-10-fase5-001`. Solo crea la tabla `invitations` y sus
  índices; no modifica ni borra nada existente.
- **`server.js`:**
  - Rutas `/api/admin/invitaciones*`, `/api/auth/invitacion/*`, `/api/auth/invitaciones*`,
    `/api/auth/barberias` y `/api/auth/cambiar-barberia`.
  - Configuración del correo y regla del registro en producción.
- **`public/admin.html`:** invitaciones en «Usuarios y roles» y en «Mi cuenta», y
  «Mis barberías».
- **`public/acceso.html`:** vista «Invitación» y mensajes para enlaces usados o vencidos.
- **Pruebas:**
  - Nuevas: `test/fase5-correo.test.js`, `test/fase5-invitaciones.test.js`,
    `test/fase5-panel.test.js` y `test/apoyo/resend-falso.js`.
  - Ajustadas al nuevo comportamiento: pruebas de las fases 3 y 4 (invitar ya no da
    acceso directo; el registro en producción exige correo).

## 4. Pruebas

| Ejecución | Resultado |
|---|---|
| `npm run check` | Correcto |
| `npm test` (agenda en archivo + PostgreSQL + navegador) | **108/108** |
| `TEST_ALMACEN=postgres npm test` | **107/107** + 1 omitida (solo aplica al modo archivo) |
| Diseño contra `main` (38 capturas, base de pruebas vacía) | **Sin diferencias no aprobadas**. Las 36 pantallas existentes, salvo Configuración, son idénticas; Configuración solo muestra el cambio ya aprobado en la fase 4. |

Las pruebas nuevas de esta fase son 22.

**Correo (10 pruebas, servidor de Resend falso; ningún mensaje real):**
- Plantillas con la marca, botón, enlace y texto plano.
- Escape de datos.
- Comportamiento sin credenciales en desarrollo y en producción.
- Envío con la clave por variable de entorno, idempotencia y dirección de respuesta.
- Ni el enlace ni la clave aparecen en los registros.
- El enlace del correo funciona.
- Reintento único con la misma clave de idempotencia.
- Rechazo y tiempo agotado: se avisa sin perder la cuenta ni la invitación, y el reenvío
  funciona.
- Regla de registro en producción.
- Enlaces de confirmación y de recuperación usados, vencidos e inventados.

**Invitaciones (7 pruebas, entre barberías distintas):**
- Cuenta nueva: sin acceso ni cuenta hasta aceptar; un solo uso.
- Cuenta de otra barbería:
  - Sin acceso antes de aceptar, ni con `businessId` ni cambiando de barbería.
  - Contraseña obligatoria; un intento fallido no cambia la cuenta y queda registrado.
  - Al aceptar ve solo lo de A con su rol; cambia entre sus dos barberías.
  - No puede pasar a una barbería ajena.
- Dos pasos: aceptar exige el código.
- «Mi cuenta»: nadie responde invitaciones ajenas (404); rechazar cierra el enlace.
- Vencimiento y reenvío: el enlace viejo deja de servir.
- Cancelar y reemplazar.
- Aislamiento y permisos:
  - B no ve, reenvía ni cancela invitaciones de A.
  - Un `businessId` en el cuerpo no cambia de barbería.
  - Recepción y administrador no invitan; sin sesión, 401.

**Navegador real (5 pruebas, Chromium, escritorio y teléfono 390 px):**
- Aceptar con el enlace creando la cuenta (teléfono), sin desplazamiento horizontal.
- Aceptar con una cuenta existente (contraseña incorrecta y luego correcta) y cambiar de
  barbería en «Mis barberías».
- Rechazar desde el enlace.
- Aviso al entrar, y rechazar y aceptar desde «Mi cuenta» en el teléfono.
- Invitación vencida, «Reenviar» y «Cancelar invitación» desde el panel del propietario.

## 5. Errores encontrados y corregidos durante la fase

1. **Intentos fallidos sin registrar:** el intento de aceptar una invitación con una
   contraseña incorrecta se anotaba dentro de la transacción que se deshacía, así que se
   perdía. Ahora se registra aparte.
2. **Pruebas antiguas:** dos pruebas suponían que invitar daba acceso directo y que
   `REGISTRO_ABIERTO=1` bastaba en producción. Se actualizaron al comportamiento seguro.

## 6. Configuración necesaria antes del lanzamiento (requiere tu autorización)

1. **Resend:**
   - Crear la cuenta.
   - Verificar el dominio del remitente (registros DNS SPF y DKIM).
   - Definir en Render `RESEND_API_KEY`, `CORREO_REMITENTE` (por ejemplo,
     `El Máster Reservas <no-responder@tu-dominio>`), `CORREO_RESPONDER_A` (opcional) y
     `PUBLIC_BASE_URL` (la dirección pública del sistema).
2. **Prueba controlada:** con esas variables, enviar los tres correos a una dirección
   propia y comprobar que llegan y que los enlaces funcionan. Solo después, si quieres
   abrir el registro, definir `REGISTRO_ABIERTO=1`.
3. **`CLAVE_DOS_PASOS`:** sin ella, la verificación en dos pasos sigue desactivada en
   producción (ver fase 4).
4. **Propietario de El Máster:** crearlo con `scripts/cuentas/crear-propietario.js`
   (fase 3). Después, el propietario invita a su equipo desde el panel.
5. **Despliegue:** seguir el procedimiento de respaldo y migración de `docs/fase-1`. La
   migración de esta fase solo crea una tabla nueva.

## 7. Observaciones fuera del alcance de esta fase

- **Nombre en la barra lateral:** el panel muestra «EL MÁSTER · Barbería» escrito en el
  diseño original, aunque se entre a otra barbería. El nombre correcto sí aparece en
  «Mi cuenta», «Mis barberías» y en los correos. Mostrar el nombre de cada barbería en la
  barra lateral es un cambio de diseño: queda para cuando lo autorices.

## 8. Producción

Nada se ejecutó contra producción. Al desplegar (con tu autorización) y hasta configurar
el correo:
- El registro queda cerrado.
- Las invitaciones se crean, pero el correo no sale; el panel lo indica.
- Los enlaces no se escriben en los registros.
