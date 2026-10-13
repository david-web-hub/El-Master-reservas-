# Fase 3 — Cuentas, sesiones, roles y aislamiento por cuenta

Rama: `claude/hopeful-curie-fcnqea`. **No se desplegó nada** ni se tocó producción,
Render, Meta, WhatsApp, Elia ni el Panel Maestro. `main` no cambia. Todas las pruebas
usan bases de datos de prueba.

## 1. Qué se implementó

**Cuentas y acceso**
- **Registro** (`POST /api/auth/registro`): crea la barbería y su propietario en una
  sola transacción. Si algo falla, no queda nada a medias. Incluye país, moneda y zona
  horaria, 14 días de prueba y el evento `business.created` para el Panel Maestro.
- **Inicio de sesión** (`POST /api/auth/login`):
  - El mensaje de error es el mismo si el correo no existe o si la contraseña es incorrecta.
  - Si la cuenta pertenece a varias barberías, la persona elige a cuál entrar.
- **Cierre de sesión** (`POST /api/auth/logout`, o la página `/salir.html`): invalida
  la sesión en la base de datos, no solo en el navegador.
- **Recuperación** (`/api/auth/recuperar` y `/api/auth/restablecer`):
  - El enlace es de un solo uso, vence en 1 hora y se guarda solo como resumen.
  - La respuesta no revela si un correo está registrado.
  - Al cambiar la contraseña se cierran todas las sesiones anteriores.
- **Cambiar contraseña** (`/api/auth/cambiar-clave`): exige la contraseña actual y
  cierra las demás sesiones.
- **Sesión actual** (`GET /api/auth/sesion`): devuelve usuario, barbería, rol y permisos.

**Protección**
- **Contraseñas:** scrypt con sal aleatoria. Mínimo 10 caracteres y se rechazan las
  fáciles de adivinar.
- **Sesiones:**
  - Identificador aleatorio de 256 bits, en una cookie `HttpOnly` y `SameSite=Lax`
    (`Secure` cuando se usa HTTPS).
  - En la base solo se guarda su resumen SHA-256.
  - Duran 14 días y dejan de valer si la cuenta se desactiva, cambia de rol o la
    barbería se suspende.
- **Bloqueo de cuenta** tras 10 intentos fallidos (15 minutos), además de un límite de
  intentos por IP en acceso, registro y recuperación.
- **Protección contra solicitudes desde otros sitios (CSRF):** se rechaza todo cambio
  de datos cuyo origen no sea el propio sitio.
- **Cabeceras de seguridad:** `nosniff`, `SAMEORIGIN`, `Referrer-Policy`, y HSTS con HTTPS.
- **Registro de seguridad** (`auth_events`): registros, accesos, intentos fallidos,
  bloqueos, recuperaciones y cambios de usuarios.

**Rutas administrativas**
- Todo lo que no es público exige sesión. Una ruta nueva queda cerrada por defecto:
  solo la puede usar el propietario hasta que se le asigne un permiso.
- Siguen públicas: la página pública, la disponibilidad, `POST /api/bookings` (los
  clientes reservan sin cuenta), las imágenes públicas, `/api/health`, el webhook de
  WhatsApp y Elia.
- `/admin.html` sin sesión redirige a la nueva pantalla de acceso (`/acceso.html`).
  **`admin.html` no se modificó.**

**Aislamiento por cuenta**
- La barbería de cada petición administrativa sale **solo de la sesión verificada en
  la base de datos**.
- Se ignoran `businessId`, `business_id`, `X-Business-Id` o cualquier otro dato que
  envíe el navegador. Probado alterando el cuerpo, los parámetros y las cabeceras.
- Iniciar sesión pidiendo una barbería ajena se rechaza.

**Roles y permisos**

| Permiso | Propietario | Administrador | Recepción y caja | Barbero |
|---|:-:|:-:|:-:|:-:|
| Ver panel, configuración y agenda | ✅ | ✅ | ✅ | ✅ |
| Reservas de todos | ✅ | ✅ | ✅ | solo las suyas |
| Caja y ventas | ✅ | ✅ | ✅ | — |
| Productos (ver / editar) | ✅ / ✅ | ✅ / ✅ | ✅ / — | — |
| Informes | ✅ | ✅ | — | — |
| Configuración, barberos, horarios, servicios e imágenes | ✅ | ✅ | — | — |
| Respaldo | ✅ | ✅ | — | — |
| Usuarios (ver / gestionar) | ✅ / ✅ | ✅ / — | — | — |

- Gestión de usuarios: `GET`/`POST /api/admin/usuarios` y `PATCH /api/admin/usuarios/:id`.
  Las invitaciones llegan como enlace para crear la contraseña.
- Siempre queda al menos un propietario activo, y un administrador no puede nombrarse
  propietario.

**El Máster**
- Sus datos no cambian.
- Como hoy no tiene cuentas, después del despliegue se crea su propietario con
  `scripts/cuentas/crear-propietario.js --negocio el-master --email …`. El script
  muestra un enlace de un solo uso, válido 24 h, para crear la contraseña (probado).

## 2. Archivos

- **Nuevos:**
  - `autenticacion.js`: cuentas, sesiones, recuperación, roles y usuarios.
  - `public/acceso.html`: pantalla de acceso, registro, recuperación y nueva contraseña,
    con el estilo del panel.
  - `public/salir.html`: cierre de sesión.
  - `scripts/cuentas/crear-propietario.js`.
  - `test/fase3-seguridad.test.js`.
  - Capturas en `docs/fase-3/`.
- **Modificados:**
  - `server.js`: seguridad por petición, permisos por ruta, rutas de cuentas y
    filtro de reservas propias del barbero.
  - `almacen.js`: migración `2026-10-fase3-001` y creación de barbería dentro de la
    transacción del registro.
  - Arnés de pruebas: inicia sesión como propietario.
  - `scripts/capturas.js`: captura el panel con sesión.
  - `test/fase1-postgres.test.js`: una prueba ahora inicia sesión antes de consultar.
  - `package.json`: solo `check`.
- **Sin cambios:** `public/admin.html`, `public/index.html`, `data/db.json`, webhook
  de WhatsApp, Elia.

## 3. Pruebas

| Ejecución | Resultado |
|---|---|
| `npm test` (agenda en archivo + PostgreSQL) | **72/72** |
| `TEST_ALMACEN=postgres npm test` | **71/71** + 1 omitida (solo modo archivo) |
| 38 capturas `main` vs esta rama (panel con sesión iniciada) | **38 iguales, 0,000 %** |
| Navegador real (Chromium) | sin sesión → acceso; error; entrar; salir; registro → panel |

Pruebas de seguridad (15):
- **Rutas:** 30 rutas administrativas responden 401 sin sesión o con una cookie
  inventada, y las públicas siguen funcionando, incluida Elia.
- **Registro:** cookie segura, contraseña y sesión guardadas solo como resumen,
  barbería nueva vacía y evento para el Panel Maestro. Rechaza datos inválidos,
  correos repetidos y direcciones repetidas.
- **Inicio de sesión:** mismo mensaje con correo inexistente o contraseña incorrecta;
  la cuenta se bloquea tras 10 fallos y hay límite de intentos por IP.
- **Validez de la sesión:**
  - Deja de valer tras cerrar sesión, al vencer o si la barbería se suspende.
  - Al recuperar o cambiar la contraseña se cierran las demás sesiones.
- **Recuperación:** un solo uso, enlace vencido o inventado rechazado, y respuesta
  idéntica exista o no el correo.
- **CSRF:** se rechazan cambios desde otro sitio.
- **Aislamiento:** con la cuenta de la barbería B y alterando el cuerpo, los
  parámetros o las cabeceras no se puede ver ni modificar reservas, configuración,
  productos ni el respaldo de A.
- **Roles:** 11 rutas × 3 roles con el resultado esperado. El barbero solo ve y
  cambia sus reservas. Desactivar a alguien lo saca de inmediato. Siempre queda un
  propietario.
- **Varias barberías:** una persona con dos barberías elige una y solo tiene los
  permisos de esa.
- **El Máster:** el script de consola crea al propietario, que entra y ve las
  reservas existentes.

## 4. Pendiente y decisiones que requieren tu autorización

1. **Elementos del panel que cambiarían su diseño** (no los agregué):
   - Botón «Cerrar sesión». Hoy existe la página `/salir.html`.
   - Pantalla de usuarios y roles. Hoy existe solo el API.
   - Cambio de contraseña dentro del panel.
   - Redirigir al acceso si la sesión vence con el panel abierto. Hoy se muestra el
     mensaje «Inicia sesión para continuar».
2. **Correo en producción:** para que la recuperación y las invitaciones lleguen por
   correo hacen falta `RESEND_API_KEY`, `CORREO_REMITENTE` y `PUBLIC_BASE_URL` en
   Render. Sin ellas, en producción no se envía el enlace ni se muestra en los
   registros.
3. **Registro abierto:** cualquiera puede crear una barbería, con límite de intentos.
   Se puede cerrar con `REGISTRO_ABIERTO=0`.
4. **Verificación del correo** al registrarse y **segundo factor (2FA)**: no
   implementados (mejora recomendada).
5. **Varias instancias del servidor:** el límite de intentos por IP vive en memoria,
   así que cada instancia lleva su propia cuenta. El bloqueo de cuenta sí está en la
   base de datos.

## 5. Producción

Nada de esta fase se ejecutó contra producción ni se usaron credenciales reales. Al
desplegar (con tu autorización) hay que:
1. Seguir el procedimiento de `docs/fase-1/INFORME.md`.
2. Ejecutar `crear-propietario.js` para El Máster.

Las tablas nuevas se crean solas al arrancar.
