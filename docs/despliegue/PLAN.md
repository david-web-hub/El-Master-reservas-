# Publicación de Master Fade — procedimiento directo (opción A, sin terminal)

Estado: **preparado, sin ejecutar.** Los pasos marcados con 🔒 necesitan tu autorización
definitiva. Todo se hace desde el panel de Render y GitHub; **no hace falta Shell ni instalar nada**.

## Qué hace este procedimiento

- Publica las fases 1 a 6 en los **dos servicios actuales** de Render. No se crean servicios nuevos.
- **No borra nada.** En su primer arranque, la versión nueva de El Máster Reservas mueve las
  5 tablas de la demostración al esquema `respaldo_demo` de la misma base: ese es el respaldo.
  Después crea tablas nuevas, vacías.
- Tu barbería es la principal (`el-master`): página pública de reservas, WhatsApp/Elia y
  protección contra vencimiento. Empieza con la plantilla (un barbero, 6 servicios, sin
  reservas), que editas en el panel.
- Tus dos cuentas se crean solas en el primer arranque, con variables de Render:
  - **propietario** de tu barbería en El Máster Reservas;
  - **administrador** del Panel Maestro.
- El catálogo de planes del Panel **no se modifica**.
- Resend (correo) queda para después: no es necesario para publicar. Sin correo, el registro
  de otras barberías permanece cerrado.

## Comprobación 1 — Qué base usa cada servicio (antes de autorizar)

En https://dashboard.render.com:

1. Abre el **Web Service de El Máster Reservas** → menú **Environment** → fila `DATABASE_URL`.
   - Si está **enlazada** a una base, Render muestra el nombre de esa base: anótalo.
   - Si es un valor escrito, pulsa el ícono del ojo **sin copiarlo** y fíjate solo en la parte
     después de `@` y antes de `.`, que empieza por `dpg-`: es el identificador del servidor.
2. Repite lo mismo en el **Web Service del Panel Maestro**.
3. Abre cada **PostgreSQL** de la lista → página **Info**. Anota su **nombre**, su
   identificador `dpg-…` (aparece en la dirección de la página y en *Hostname*) y el campo
   **Database** (el nombre de la base dentro del servidor).
4. En cada Web Service → **Settings** → **Build & Deploy**, anota la **rama** (*Branch*). Debe
   ser `main`; si es otra, dímelo antes de seguir.
5. Respóndeme con:
   - el nombre de la base PostgreSQL de cada servicio;
   - si son **la misma o distintas**;
   - el campo **Database** de la base de El Máster Reservas, que es el valor exacto para `ARCHIVAR_DEMO`.

Los identificadores `dpg-…` y los nombres no son secretos. **Nunca compartas la URL completa ni
la contraseña.**

## Comprobación 2 — La limpieza solo afecta a la demostración (comprobado en el código y ensayado)

- La versión nueva **solo mueve** estas 5 tablas: `sales`, `cash_sessions`, `products`,
  `admin_settings` y `media_assets`. Son las únicas que crea la versión que hoy está publicada.
- **No toca:**
  - las tablas del Panel (`master_fade_*`), aunque compartan base;
  - ninguna otra tabla;
  - las variables de WhatsApp y Meta, que no están en la base.
- La agenda de la demostración (barberos, reservas y clientes) vive en el disco temporal de
  Render y se descarta sola al desplegar.
- **Protecciones** (todas ensayadas con el código real que hoy está en producción):
  - si `ARCHIVAR_DEMO` no coincide exactamente con el nombre de la base, la versión nueva no arranca, no toca nada y Render mantiene la anterior;
  - solo actúa en el primer arranque de la versión nueva; después no hace nada aunque la variable siga;
  - si ya existe un respaldo en `respaldo_demo`, no lo sobrescribe y no arranca;
  - todo ocurre en una transacción.

## Comprobación 3 — Catálogo de planes del Panel

- La versión nueva del Panel solo **crea tablas nuevas**: acceso, barberías, suscripciones,
  historial y actividad.
- `master_fade_plans` y `master_fade_plan_changes` no se modifican.
- Una prueba lo comprueba después de varios arranques (Individual, Pro y Business con 7 días).

## Comprobación 4 — Variables y acceso de administrador

Prepara antes dos valores aleatorios y guárdalos en tu gestor de contraseñas. **No los pegues
en el chat.**
- **`PLATAFORMA_CLAVE`:** al menos 48 caracteres aleatorios, el **mismo** valor en los dos
  servicios. Puedes usar el generador de tu gestor de contraseñas, o el botón **Generate** de
  Render si aparece al crear la variable, y luego copiarlo al otro servicio.
- **Tus contraseñas:** propietario (10 caracteres o más) y administrador del Panel (12 o más).

**El Máster Reservas** → **Environment** → **Add Environment Variable**:

| Variable | Valor |
|---|---|
| `PLATAFORMA_CLAVE` | La clave compartida |
| `PUBLIC_BASE_URL` | La dirección pública del servicio, con `https://` |
| `ARCHIVAR_DEMO` | El campo **Database** de su base (Comprobación 1) |
| `PROPIETARIO_INICIAL_EMAIL` | Tu correo |
| `PROPIETARIO_INICIAL_NOMBRE` | Tu nombre |
| `PROPIETARIO_INICIAL_CLAVE` | Tu contraseña de propietario |

No cambies `DATABASE_URL` ni las variables de WhatsApp.

**Panel Maestro** → **Environment**:

| Variable | Valor |
|---|---|
| `RESERVAS_URL` | La dirección pública de El Máster Reservas, con `https://` |
| `PLATAFORMA_CLAVE` | La misma clave compartida |
| `TRUST_PROXY` | `1` |
| `ADMIN_INICIAL_EMAIL` | Tu correo de administrador |
| `ADMIN_INICIAL_NOMBRE` | Tu nombre |
| `ADMIN_INICIAL_CLAVE` | Tu contraseña de administrador |

Al guardar variables, Render puede ofrecer **Save, rebuild and deploy**. Elige **Save only**
(o «Save changes» sin desplegar) para que nada se publique antes de tiempo. Si Render
redespliega por error la versión actual, no pasa nada: sigue siendo la misma versión.

Las cuentas solo se crean si todavía no existe ninguna. Después de entrar por primera vez,
**borra `PROPIETARIO_INICIAL_CLAVE` y `ADMIN_INICIAL_CLAVE`** de Render.

## Comprobación 5 — Recuperación si algo falla

| Situación | Qué pasa o qué se hace |
|---|---|
| La versión nueva no arranca (por ejemplo, `ARCHIVAR_DEMO` incorrecto) | Render marca el despliegue como fallido y **mantiene la versión anterior**. No se tocó nada. |
| Falla algo después de publicar | Render → servicio → **Events** → despliegue anterior → **Rollback**. |
| Quieres recuperar la demostración | `scripts/despliegue/restaurar-demo.sql` devuelve las tablas de `respaldo_demo` y aparta las nuevas en `respaldo_nueva`, sin borrar. Ensayado. 🔒 |
| Falla el Panel | **Rollback** del Panel. El catálogo no cambió. |

## Pasos de la publicación 🔒 (unos 20 minutos)

1. **Render — variables** de las dos tablas de arriba, con **Save only**. Van **antes** de
   fusionar: si Render redespliega al guardar, publica la versión actual, que ignora las
   variables nuevas. No pasa nada.
2. **GitHub — fusionar las dos ramas con `main`.** Las dos `main` no cambiaron desde que se
   crearon las ramas, así que la fusión no tiene conflictos.
   - Con tu autorización, abro un Pull Request en cada repositorio y lo fusionas tú; o lo
     fusiono yo si me lo indicas.
   - Con Auto-Deploy desactivado, fusionar no publica nada.
3. **Render — El Máster Reservas** → **Manual Deploy** → **Deploy latest commit**. En **Logs**
   deben aparecer, en este orden:
   - `ARCHIVAR_DEMO: datos de la demostración guardados en el esquema respaldo_demo …`
   - `MIGRACIÓN APLICADA: …` (varias)
   - `BARBERÍA PROTEGIDA: el-master`
   - `AGENDA EN POSTGRESQL LISTA (barbería: el-master, restricción de solapes: activa)`
   - `PROPIETARIO INICIAL CREADO para "el-master": …`
   - `EL MÁSTER RESERVAS INICIADO`

   Si aparece `NO SE ARRANCA`, la versión anterior sigue funcionando: envíame el mensaje.
4. **Render — Panel Maestro** → **Manual Deploy** → **Deploy latest commit**. En **Logs**:
   - `administrador inicial creado …`
   - `sincronización con El Máster Reservas cada 60 s.`
5. **Comprobaciones finales:**
   - **Página pública:** carga y muestra la disponibilidad del día.
   - **Panel de Reservas** (`/acceso.html`): entras con tu correo de propietario; el inicio está vacío.
   - **Reserva de prueba:** haces una desde la página pública y luego la cancelas en el panel.
   - **WhatsApp:** escribes «hola» a Elia y responde.
   - **Panel Maestro:** entras; en **Barberías → Sincronizar ahora** aparece «El Máster» como *protegida*.
6. **Render — limpiar variables:** borra `PROPIETARIO_INICIAL_CLAVE`, `ADMIN_INICIAL_CLAVE` y
   `ARCHIVAR_DEMO`, con **Save only**: no hace falta redesplegar.
7. **Panel de Reservas → Configuración:** cambia el nombre de la barbería, los barberos, los
   servicios y los horarios por los tuyos.
8. Activa de nuevo **Auto-Deploy** cuando quieras.

## Ensayado (`test/despliegue.test.js` en Reservas y `test/admin-inicial.test.js` en el Panel)

Con el código real que hoy está publicado como «producción»:
1. Demostración y catálogo del Panel en la misma base.
2. `ARCHIVAR_DEMO` incorrecto: la versión nueva no arranca y la base queda igual.
3. Primer arranque correcto:
   - las 5 tablas pasan a `respaldo_demo` con todas sus filas;
   - las tablas nuevas empiezan vacías y `el-master` queda protegida;
   - el propietario puede entrar y la contraseña no aparece en los registros;
   - el catálogo sigue intacto.
4. Segundo arranque con las variables todavía puestas: no repite nada y no cambia la contraseña.
5. Reversión: `restaurar-demo.sql` devuelve la demostración y la versión anterior arranca con ella.
6. Panel: el administrador inicial se crea una sola vez; una contraseña corta no crea nada; el
   catálogo de planes no cambia.

El procedimiento anterior con terminal (`limpiar-demo.js`, `respaldo-postgres.sh` y
`verificar-restauracion.sh`) también está ensayado y sigue disponible como alternativa.
