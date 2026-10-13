# Fase 1 — Agenda persistente en PostgreSQL

Rama: `claude/hopeful-curie-fcnqea`. **No se ha desplegado nada** ni se ha
tocado la base de datos de producción, Render, Meta/WhatsApp, Elia ni el
Panel Maestro. `main` no cambia.

## 1. Qué se corrigió

| Problema (auditoría) | Solución |
|---|---|
| Reservas, barberos, servicios y horarios vivían en `data/db.json`, que Render borra en cada reinicio o despliegue | Con `DATABASE_URL` todo se guarda en PostgreSQL. El archivo solo se usa una vez, para la importación inicial. |
| Si `db.json` se dañaba, la siguiente escritura lo reemplazaba por los datos de ejemplo | Nunca se reemplaza un archivo ilegible: la escritura se rechaza. En PostgreSQL, una barbería nueva con archivo dañado no arranca vacía. |
| La respuesta al cliente salía antes de guardar | Cada ruta espera a que PostgreSQL confirme; si falla, responde error y no se guarda nada. |
| Choques de horario solo controlados en memoria | Control dentro de la base: bloqueo por barbería + restricción de exclusión `booking_slots_sin_solapes`. Funciona aunque haya dos instancias. |
| `BK-${Date.now()}` podía repetirse | Generador de id único y `PRIMARY KEY (business_id, id)`. Un id repetido nunca sobrescribe otra reserva. |
| Dos cambios simultáneos podían pisarse | Solo se guardan los registros que cada petición cambió. |

## 2. Archivos

**Nuevos**
- `almacen.js` — capa de datos (PostgreSQL o archivo), migraciones, importación inicial, control de choques.
- `scripts/migracion/importar.js`, `verificar.js`, `exportar.js`, `comun.js` — migración segura a producción.
- `test/fase1-postgres.test.js`, `test/migracion.test.js` — pruebas nuevas.
- `docs/fase-1/INFORME.md` — este informe.

**Modificados**
- `server.js` — solo el acceso a datos: `readDb`/`writeDb` usan el almacén; 9 rutas esperan el guardado (`await`); 409 si el horario se ocupó; Elia responde igual que antes si el horario se ocupó al confirmar; `/api/health` informa el almacén; el respaldo del panel incluye `hours` y `agendaSettings`; arranque seguro; columna `business_id` en las tablas existentes.
- `test/*` y `test/apoyo/servidor.js` — la batería de la fase 0 corre en los dos modos (archivo y PostgreSQL), cada servidor de prueba con su propia barbería.
- `package.json` (solo `check`), `.github/workflows/pruebas.yml` (ejecuta la batería en los dos modos).

**Sin cambios:** `public/admin.html`, `public/index.html` (diseño), `data/db.json`, webhook de WhatsApp y lógica de Elia, ventas, caja y productos (salvo la columna nueva).

## 3. Base de datos (solo aditivo)

Tablas nuevas, todas con `business_id`:

| Tabla | Contenido |
|---|---|
| `businesses` | Barbería: id, slug, nombre, país, moneda, idioma, zona horaria, estado |
| `barbers`, `services` | Registro completo en `data` (JSONB) + columnas para consultar; `position` conserva el orden |
| `bookings` | Reserva completa en `data` + barbero, fecha, hora, estado, origen, cliente y teléfono |
| `booking_slots` | Minutos ocupados por cada reserva activa; restricción de exclusión contra solapes |
| `business_state` | Horarios (`hours`, `hoursConfig`), `schedule`, `business`, `settings` de la agenda |
| `data_imports` | Registro de cada importación |
| `master_reservas_migrations` | Versiones de esquema aplicadas |

Tablas existentes (`sales`, `cash_sessions`, `products`, `admin_settings`, `media_assets`): se agrega `business_id TEXT NOT NULL DEFAULT 'el-master'` + índice. No se modifica ni borra ninguna fila.

Nada se borra: si una escritura omite un barbero, servicio o reserva, el registro se conserva en la base y se registra un aviso. Cada guardado es una transacción.

## 4. Pruebas

Ejecutadas en local con PostgreSQL 16 con SSL (como en Render):

| Ejecución | Resultado |
|---|---|
| `npm test` (agenda en archivo + pruebas de PostgreSQL) | **46/46** |
| `TEST_ALMACEN=postgres npm test` (todo en PostgreSQL) | **45/45** + 1 omitida (solo aplica al modo archivo) |
| Capturas `main` vs esta rama (38 pantallas) | **0,000 %** de diferencia |

Pruebas nuevas destacadas:
- Despliegues limpios repetidos: barbero, servicio, horario, reserva y cancelación permanecen.
- 15 reservas simultáneas al mismo horario → 1 guardada, 14 rechazadas (409).
- Dos instancias del servidor a la vez → la base rechaza el choque.
- Cambios simultáneos (estado, barbero, horario, servicio, reserva) → ninguno se pierde.
- Dos barberías en la misma base → datos independientes.
- Reactivar una reserva cancelada cuyo horario ya se ocupó → 409, sin cambios.
- Reserva por Elia + cobro → en PostgreSQL y tras un nuevo despliegue.
- Fallo simulado a mitad de una escritura → no se guarda nada; la memoria tampoco cambia.
- Barbería nueva con `db.json` dañado → no arranca y no crea nada; barbería existente → arranca con sus datos.
- **Ensayo completo de migración** (respaldo → despliegue → reserva entrante → importación simulada y aplicada → verificación → exportación).

Tus 8 pruebas de aceptación quedan cubiertas: barbero (1), horarios (2), reserva (3), recarga (4), cerrar y abrir (5), reinicio y despliegue (6), mensajes de Elia (7, ya persistían en PostgreSQL) y reservas sin duplicados (8).

## 5. Procedimiento para producción (requiere tu autorización)

Variables: **no hace falta ninguna nueva**. Usa `DATABASE_URL` actual. Opcional: `DEFAULT_BUSINESS_ID` (por defecto `el-master`).

1. Confirmar en Render qué rama se despliega y que `DATABASE_URL` de Master Reservas apunta a una base de pago o con fecha de caducidad conocida.
2. Pausar el despliegue automático.
3. Respaldos inmediatamente antes:
   `node scripts/respaldo/respaldo-api.js https://<servicio>.onrender.com` y
   `DATABASE_URL=… scripts/respaldo/respaldo-postgres.sh`.
4. Fusionar la rama en la rama que despliega Render y desplegar. Al arrancar:
   crea las tablas, importa el `db.json` del repositorio para `el-master`
   y solo entonces empieza a atender. En los registros debe verse
   `AGENDA EN POSTGRESQL LISTA … restricción de solapes: activa`.
5. Importar los datos reales del respaldo del paso 3:
   `DATABASE_URL=… node scripts/migracion/importar.js respaldos/api-…/respaldo-completo.json` (simulación) y, si el resumen es correcto, repetir con `--aplicar`.
6. Reiniciar el servicio en Render para que cargue lo importado.
7. Verificar: `node scripts/migracion/verificar.js …/respaldo-completo.json`, `GET /api/health` (`storage: "postgres"`) y tus 8 pruebas.
8. Reactivar el despliegue automático.

**Volver atrás:** volver a desplegar el commit anterior. Las tablas nuevas no molestan a la versión anterior y los datos quedan en PostgreSQL; `scripts/migracion/exportar.js` genera un `db.json` con todo lo guardado. No se necesita borrar nada.

## 6. Lo que falta para producción

- Tu autorización y los datos de Render (rama desplegada, plan y caducidad de PostgreSQL).
- Ejecutar el procedimiento anterior.
- Confirmar en los registros que la restricción de solapes quedó **activa** (requiere la extensión `btree_gist`, disponible en Render). Si no, el control sigue funcionando con el bloqueo por barbería.

## 7. Límites conocidos (fases siguientes)

- La copia en memoria supone **una sola instancia** del servicio (plan actual). Con varias instancias, los choques siguen bloqueados por la base, pero otra instancia puede mostrar disponibilidad desactualizada hasta reiniciarse.
- Ventas, caja, productos, configuración e imágenes ya tienen `business_id`, pero sus claves únicas siguen siendo globales (`cash_sessions.session_date`, `admin_settings.section`, `media_assets.id`): se ajustan en la fase multiempresa (4).
- Los mensajes de Elia siguen siendo una sola configuración (fase 5).
- Las conversaciones de WhatsApp en curso siguen en memoria (fase 5).
- Rutas administrativas sin inicio de sesión (fase 3).
