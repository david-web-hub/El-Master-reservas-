# Fase 4 — Integración visual de cuentas, verificación de correo y dos pasos

Rama: `claude/hopeful-curie-fcnqea`. **No se desplegó nada.** No se tocó Render, Meta,
WhatsApp, Elia, datos reales ni el repositorio del Panel Maestro (Master Fade). No se
configuró ningún servicio de correo ni se usó ninguna clave real. `main` no cambia.

## 1. Qué se implementó

| Pedido | Implementación |
|---|---|
| 1. Cerrar sesión | Botón «Cerrar sesión» al pie de la barra lateral (escritorio), con el estilo de los botones del menú y el nombre y rol de la persona. En móvil está en **Configuración → Mi cuenta** (la barra inferior ya tiene 7 secciones). La sesión se invalida en la base de datos. |
| 2. Usuarios y roles | **Configuración → Usuarios y roles**: lista del equipo con rol, estado y último acceso. El propietario agrega personas (reciben un enlace para crear la contraseña), cambia roles (para «Barbero» se elige su ficha) y desactiva o reactiva. El administrador solo ve la lista. |
| Permisos en el panel | Cada persona ve solo lo que puede usar. **Recepción y caja**: Inicio, Reservas, Caja, Productos, Clientes y, en Configuración, solo «Mi cuenta». **Barbero**: Inicio, Reservas (las suyas) y «Mi cuenta». El servidor aplica los mismos permisos aunque se altere el navegador. |
| 3. Cambiar contraseña | **Mi cuenta**: contraseña actual, nueva y repetición. Al cambiarla se cierran las demás sesiones. |
| 4. Sesión vencida | Si la sesión vence, se cierra en otro dispositivo o se desactiva la cuenta, el panel vuelve a la pantalla de acceso con el aviso «Tu sesión terminó. Inicia sesión de nuevo». |
| 5. Verificación de correo | El registro no abre sesión: envía un enlace de confirmación de un solo uso, válido 24 horas. Hasta confirmar, el inicio de sesión responde «Confirma tu correo» (solo si la contraseña es correcta, para no revelar cuentas). Se puede pedir otro enlace; la respuesta es la misma exista o no la cuenta. Las invitaciones y el propietario creado por consola confirman el correo al crear su contraseña. |
| 6. Dos pasos (opcional) | TOTP estándar (Google Authenticator, Microsoft Authenticator, 1Password…), activable por cada persona en «Mi cuenta». Detalles abajo. **No es obligatoria.** |
| Registro | Abierto en desarrollo y pruebas. **Cerrado por defecto en producción** (Render define `RENDER=true`). Se abre con `REGISTRO_ABIERTO=1` y se cierra en cualquier entorno con `REGISTRO_ABIERTO=0`. Si está cerrado, la pantalla de acceso oculta «Crear cuenta». |

**Detalles de la verificación en dos pasos**
- El secreto se guarda cifrado con AES-256-GCM.
- Al activarla se entregan 10 códigos de recuperación, de un solo uso y guardados como resumen.
- Un mismo código no se puede reutilizar.
- El paso intermedio del inicio de sesión dura 5 minutos y admite como máximo 5 intentos.
- Desactivarla exige la contraseña y un código.
- En producción necesita `CLAVE_DOS_PASOS`. Sin ella la función queda desactivada: no se inventa una clave.

## 2. Diseño

- `admin.html` mantiene su estructura y estilo. Los elementos nuevos usan las mismas
  clases: `nav-btn`, `card`, `setting-card`, `form-grid`, `input`, `btn-gold`,
  `btn-dark`, `btn-danger`, `badge`, `chip`, `barber-card` y la ventana modal.
- La página pública (`index.html`) no cambia.
- **Comparación automática** de las 38 capturas contra `main`. Ahora solo acepta los
  cambios aprobados en `test/diseno/cambios-esperados.json`:
  - **Móvil:** las 18 pantallas del panel son idénticas, salvo Configuración por las
    dos tarjetas nuevas (cambio aprobado).
  - **Escritorio:** las 18 pantallas del panel son **idénticas píxel a píxel fuera de
    la barra lateral** (0,000 %), salvo Configuración (cambio aprobado). Cualquier
    otra diferencia hace fallar la prueba.
  - **Página pública:** idéntica en escritorio y móvil.
  - Se capturan 8 pantallas nuevas: Mi cuenta, Usuarios y roles, y acceso/registro,
    en escritorio y móvil.
- Capturas en `docs/fase-4/`:
  - Configuración antes y después.
  - Mi cuenta, en escritorio y móvil.
  - Activación de dos pasos.
  - Usuarios y roles, y el formulario para agregar usuario.
  - Acceso, confirmar correo, segundo paso y sesión vencida.

## 3. Archivos

- **`public/admin.html`:**
  - Pie de la barra lateral con «Cerrar sesión».
  - Secciones «Mi cuenta» y «Usuarios y roles».
  - Menú y cargas según permisos.
  - Redirección cuando vence la sesión.
- **`public/acceso.html`:**
  - Confirmación de correo, reenvío y segundo paso.
  - Aviso de sesión vencida.
  - «Crear cuenta» se oculta si el registro está cerrado.
  - Los enlaces de los correos funcionan aunque la pantalla ya esté abierta.
- **`autenticacion.js`:** verificación de correo, TOTP, cifrado y códigos de recuperación.
- **`almacen.js`:** migración `2026-10-fase4-001`, solo con columnas y tablas nuevas.
- **`server.js`:**
  - Rutas `/api/auth/config`, `/api/auth/verificar`, `/api/auth/verificacion/reenviar`
    y `/api/auth/2fa/*`.
  - Registro cerrado en producción y `esProduccion()`.
- **Pruebas:** `test/fase4-cuentas.test.js` y `test/fase4-panel.test.js` (navegador real),
  `test/apoyo/navegador.js`, `test/diseno/cambios-esperados.json`, ajustes en la fase 3
  (el registro ahora exige confirmar el correo) y `scripts/capturas.js`.
- **`.github/workflows/pruebas.yml`:** instala Chromium para las pruebas del panel y
  compara el diseño solo con los cambios aprobados.

## 4. Pruebas

| Ejecución | Resultado |
|---|---|
| `npm test` (agenda en archivo + PostgreSQL + navegador) | **86/86** |
| `TEST_ALMACEN=postgres npm test` | **85/85** + 1 omitida (solo modo archivo) |
| Diseño contra `main` | Sin diferencias no aprobadas |

**Pruebas nuevas en el servidor (8)**
- **Confirmación de correo:** sin confirmar no hay sesión, y la cuenta no se revela con
  una contraseña incorrecta. El enlace es de un solo uso; reenviar invalida el anterior
  y la respuesta es la misma exista o no la cuenta. Las invitaciones confirman el correo.
- **Configuración del acceso y producción:**
  - La pantalla de acceso sabe si el registro está abierto.
  - En producción el registro está cerrado por defecto, se abre explícitamente con
    `REGISTRO_ABIERTO=1` y se cierra con `REGISTRO_ABIERTO=0`.
  - Sin `CLAVE_DOS_PASOS`, los dos pasos no están disponibles.
  - Los enlaces nunca aparecen en los registros.
- **Dos pasos:**
  - Activación con un código real.
  - El secreto se guarda cifrado.
  - La contraseña sola ya no abre sesión.
  - Un código ya usado se rechaza.
  - Máximo 5 intentos por paso.
  - Los códigos de recuperación sirven una sola vez.
  - Un desafío inventado se rechaza.
  - Desactivarla exige contraseña y código.
  - Sin sesión no se puede usar.
- **Aislamiento:** una barbería no ve ni modifica los usuarios de otra, e invitar un
  correo ajeno no da acceso a la otra barbería.

**Pruebas nuevas en el navegador real (6)**
- **Cierre de sesión:** botón con nombre y rol; al salir, el panel ya no abre.
- **Usuarios y roles:**
  - Agregar, cambiar a barbero con su ficha y desactivar (verificado en la base).
  - El administrador solo ve la lista.
- **Mi cuenta:**
  - Contraseña actual incorrecta: se rechaza sin cerrar la sesión.
  - Cambio de contraseña correcto.
  - Activación de dos pasos con 10 códigos.
  - El siguiente acceso pide el código.
- **Sesión vencida:** vuelve al acceso con el aviso.
- **Menús por rol:** recepción y barbero solo ven sus secciones.
- **Registro completo:** el enlace de confirmación funciona y luego se entra al panel.

## 5. Errores encontrados y corregidos durante la fase

1. **Enlace de confirmación con la pantalla abierta:** si `acceso.html` ya estaba
   abierta, el enlace no hacía nada (solo cambiaba lo que va después de `#`). Ahora se
   atiende también ese cambio.
2. **Botón «Abrir en la aplicación»** (dos pasos): aparecía subrayado por ser un
   enlace. Se igualó al estilo de los botones oscuros.

## 6. Pendiente y decisiones que requieren tu autorización

1. **Correo en producción:** sin `RESEND_API_KEY`, `CORREO_REMITENTE` y
   `PUBLIC_BASE_URL` no llegan los correos de confirmación, recuperación ni
   invitaciones. Por eso, en producción el registro debe seguir cerrado, como está por
   defecto. Configurarlos requiere tu autorización.
2. **Dos pasos en producción:** requiere definir `CLAVE_DOS_PASOS`, un valor largo y
   aleatorio que no debe perderse: sin él no se pueden leer los secretos ya guardados.
3. **Código QR:** la activación muestra la clave para copiarla y un enlace que abre la
   aplicación en el teléfono. Generar un código QR para escanear exige una librería o un
   servicio adicional: está pendiente de tu aprobación.
4. **Invitaciones:** hoy, agregar el correo de alguien que ya tiene cuenta le da acceso
   directo a la barbería que lo invita. No da acceso a los datos de su barbería, pero
   conviene que la persona **acepte** la invitación antes. Mejora recomendada.
5. **Panel Maestro (Master Fade):** no se modificó. Su conexión con las cuentas de las
   barberías (fase 6) requiere tu autorización para ese repositorio.
6. **Varias instancias:** el límite de intentos por IP vive en memoria. El bloqueo de
   cuenta y los demás controles sí están en la base de datos.

## 7. Producción

Nada se ejecutó contra producción. Al desplegar (con tu autorización), el registro
queda cerrado y los dos pasos desactivados hasta configurar las variables indicadas.
La creación del propietario de El Máster sigue el procedimiento de
`docs/fase-3/INFORME.md`.
