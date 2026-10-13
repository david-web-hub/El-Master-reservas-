# Fase 2 — Preparación multiempresa

Rama: `claude/hopeful-curie-fcnqea`. **No se desplegó nada**, no se tocó la base
de producción, Render, Meta/WhatsApp, Elia ni el Panel Maestro, y `main` no cambia.
Todas las pruebas usan bases de datos de prueba.

## 1. Qué se hizo

**Cada consulta pertenece a una barbería.** Las 29 consultas de ventas, caja,
productos, configuración (incluida Elia) e imágenes filtran por `business_id`, y
cada fila nueva se guarda con su `business_id`. La barbería de cada petición se
obtiene de un solo lugar (`negocioActual()` en `server.js`). Por ahora siempre es
la barbería principal (`el-master`). Cuando existan cuentas (fase 3), saldrá de la
sesión iniciada y nunca de un dato que envíe el navegador sin verificar.

**Claves por barbería** (antes impedían tener dos barberías):

| Tabla | Antes | Ahora |
|---|---|---|
| `cash_sessions` | una caja por día para todos | una caja por barbería y día |
| `admin_settings` | una sección para todos | `(business_id, section)` |
| `media_assets` | `logo` era único global | `(business_id, id)` |

El cambio es idempotente, se hace en una transacción al arrancar y **no modifica
ni borra filas**. Los datos que ya existían quedan asignados a `el-master`.

**Agenda por barbería:** reservas, barberos, servicios y horarios ya tenían
`business_id` desde la fase 1. Ahora cada petición lee y guarda la agenda de su
barbería, y la memoria de cada barbería está separada.

**Preparado para cuentas y Panel Maestro** (sin exponerse todavía por internet):
- `businesses` incorpora plan, fin de prueba, correo y teléfono de contacto, y origen.
- `almacen.crearNegocio()` crea una barbería con agenda propia (sin barberos ni
  reservas, con el catálogo de servicios de ejemplo). Rechaza ids o direcciones
  repetidos y datos no válidos.
- `almacen.listarNegocios()` devuelve las barberías con sus totales para el Panel Maestro.
- `platform_events` es una bandeja de salida: cada alta genera `business.created`
  pendiente de entregar al Panel Maestro (fase 6). El Máster también tiene el suyo.

## 2. Archivos

- `server.js`: contexto de barbería por petición, filtros `business_id` en todas
  las consultas, cambio de claves al arrancar.
- `almacen.js`: migración `2026-10-fase2-001`, `crearNegocio`, `listarNegocios`,
  evento de alta.
- `scripts/migracion/revertir-claves-fase2.sql`: devuelve las claves antiguas, por
  si hubiera que volver a una versión anterior. Se niega si ya hay varias barberías.
- `scripts/respaldo/identificar-base.js`: reconoce las tablas nuevas.
- `test/fase2-multiempresa.test.js` (nuevo) y `.github/workflows/pruebas.yml`
  (el usuario de pruebas puede crear una base temporal).
- Sin cambios: `public/admin.html`, `public/index.html`, `data/db.json`, webhook de
  WhatsApp, lógica de Elia, credenciales.

## 3. Pruebas

Local, PostgreSQL 16 con SSL:

| Ejecución | Resultado |
|---|---|
| `npm test` (agenda en archivo + PostgreSQL) | **57/57** |
| `TEST_ALMACEN=postgres npm test` | **56/56** + 1 omitida (solo modo archivo) |
| 38 capturas: `main` vs esta rama | **38 iguales, 0,000 %** |
| Respaldo `pg_dump` → restauración | mismas filas en todas las tablas |

Pruebas nuevas (11):
- **Aislamiento** (dos barberías en la misma base):
  - **Productos:** B no ve, no edita y no vende los de A, y el inventario de A no cambia.
  - **Configuración y página pública:** cada barbería conserva la suya.
  - **Elia:** cada barbería usa sus propios mensajes y su propio encendido o apagado.
  - **Imágenes:** dos `logo` distintos conviven, y borrar el de B no toca el de A.
  - **Ventas, caja y reportes:** cada barbería ve solo sus montos, y cerrar la caja de B no cierra la de A.
  - **Respaldo:** cada barbería solo descarga sus datos.
- **Datos existentes de El Máster:** una base con las tablas exactamente como en
  producción hoy (sin `business_id`) conserva cada fila intacta, ahora asignada a
  El Máster. Producto, página, mensajes de Elia, logo y reporte siguen funcionando.
  El cambio de claves se puede revertir y repetir sin perder nada.
- **Registro y Panel Maestro:** se crea una barbería nueva con agenda vacía y evento
  pendiente; no se aceptan repetidos ni datos inválidos; la lista incluye todas;
  la memoria de una barbería no se mezcla con la de otra.

## 4. Pendiente (no es un error, es trabajo de fases siguientes)

- **Fase 3:** inicio de sesión y registro de cuentas. Hoy todas las peticiones
  pertenecen a `el-master` y las rutas de administración siguen sin contraseña.
- **Fase 4:** página pública por barbería (`/b/<slug>`) y elegir la barbería según
  la sesión.
- **Fase 5:** Elia y WhatsApp por número de cada barbería; mensajes por barbero;
  conversaciones en curso fuera de la memoria.
- **Fase 6:** entregar `platform_events` y la lista de barberías al Panel Maestro
  (requiere tu autorización para modificar ese repositorio).
- Producción: desplegar las fases 1 y 2 juntas con el procedimiento de
  `docs/fase-1/INFORME.md`. La fase 2 no necesita pasos ni variables extra: las
  claves se ajustan solas al arrancar. Para volver atrás: redesplegar la versión
  anterior y, solo si se vuelve a una versión previa a la fase 2, ejecutar
  `revertir-claves-fase2.sql` (con autorización).

## 5. Producción

Confirmado: nada de esta fase se ejecutó contra producción. No se usaron
credenciales reales. Todas las bases fueron temporales o de prueba (local y
GitHub Actions).
