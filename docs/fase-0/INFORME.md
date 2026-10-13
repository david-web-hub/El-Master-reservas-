# Fase 0 — Red de seguridad (respaldos y pruebas)

Rama: `claude/hopeful-curie-fcnqea`. Esta fase **no modifica** `server.js`,
`public/`, `data/db.json`, la configuración de Render ni la de Meta/WhatsApp,
y no toca el repositorio del Panel Maestro. El único archivo existente que
cambia es `package.json`, para añadir los comandos `check` y `test` (no cambia
`start` ni las dependencias).

## 1. Qué se añadió

| Archivo | Para qué |
|---|---|
| `test/apoyo/servidor.js` | Arranca una copia aislada de la app en una carpeta temporal. No escribe en `data/db.json` del repositorio, no hereda tokens de WhatsApp/Meta ni `DATABASE_URL` reales, y rechaza bases que no sean de pruebas. |
| `test/reservas.test.js` | Reservas web, disponibilidad, descansos, solapamientos, estados y cancelación. |
| `test/administracion.test.js` | Barberos, horarios (incluidos días libres) y servicios. |
| `test/whatsapp-elia.test.js` | Verificación del webhook, flujo completo de Elia (reservar, editar, confirmar, cancelar), choque web/Elia y conversaciones separadas. |
| `test/postgres.test.js` | Configuración, negocio, mensajes de Elia, productos, ventas, caja, reportes, imágenes y respaldo. |
| `test/persistencia.test.js` | Reinicio sobre el mismo disco y **despliegue limpio** (disco efímero). |
| `scripts/capturas.js` | 38 capturas (web pública + 7 páginas del panel + 11 ajustes, escritorio y móvil) y comparación píxel a píxel. |
| `scripts/respaldo/respaldo-api.js` | Respaldo de la app en producción usando solo `GET`. |
| `scripts/respaldo/respaldo-postgres.sh` | `pg_dump` completo + esquema + filas por tabla + SHA-256. |
| `scripts/respaldo/identificar-base.js` | Huella de solo lectura de la base a la que apunta `DATABASE_URL`, y comparación entre las dos apps. |
| `.github/workflows/pruebas.yml` | Ejecuta las pruebas y la comparación de diseño en GitHub Actions. No despliega nada. |
| `.gitignore` | Evita subir `node_modules`, respaldos y capturas (contienen datos de clientes). |

## 2. Resultados

`npm test` con PostgreSQL de pruebas (con SSL, como en producción):

```
# tests 31
# pass 29
# fail 0
# todo 2
```

Las 2 pruebas `todo` describen el comportamiento correcto que se logrará en la
fase 1. **Hoy fallan y reproducen el problema reportado:**

1. *Los datos sobreviven a un despliegue limpio*: un barbero, un horario y una
   reserva creados antes de un despliegue nuevo desaparecen después.
2. *Un db.json dañado no debe reemplazarse por los datos de ejemplo*: si el
   archivo se daña, la siguiente escritura lo sobrescribe con los datos por
   defecto y se pierde todo.

Diseño: dos capturas consecutivas y la comparación `main` contra esta rama dan
**0,000 % de píxeles distintos** en las 38 pantallas.

Respaldo verificado: `respaldo-postgres.sh` sobre la base de pruebas →
`pg_restore` en una base nueva → mismas filas.

## 3. ¿Qué base usa cada aplicación? ¿Comparten PostgreSQL?

**Comprobado en el código:**

| | Master Reservas | Panel Maestro (`master-fade-`) |
|---|---|---|
| Variable | `DATABASE_URL` | `DATABASE_URL` (y `DATABASE_SSL`) |
| SSL | Siempre que haya `DATABASE_URL` (`rejectUnauthorized:false`) | Según `DATABASE_SSL` |
| Tablas que crea | `sales`, `cash_sessions`, `products`, `admin_settings`, `media_assets` | `master_fade_plans`, `master_fade_plan_changes` |
| Otros datos | `data/db.json`: reservas, barberos, horarios, servicios | `localStorage` del navegador: barberías de demostración |

Los nombres de las tablas no coinciden, así que **las dos apps podrían compartir
una base sin pisarse**, pero el código no dice si la comparten.

**No verificado:** desde esta sesión no tengo acceso a Render ni a los valores
de `DATABASE_URL`, así que **no puedo afirmar** si comparten PostgreSQL. Para
comprobarlo sin modificar nada:

1. En Render → cada servicio → **Environment**: ver si `DATABASE_URL` está
   enlazada a una base (Render muestra el nombre de la base vinculada) y
   anotar su nombre (no el valor).
2. Definitivo: en la **Shell** de cada servicio en Render, ejecutar
   `node scripts/respaldo/identificar-base.js > huella.json` (requiere que el
   script esté desplegado; si no, ejecutarlo en local con la URL externa de
   cada base) y luego
   `node scripts/respaldo/identificar-base.js comparar huella-reservas.json huella-panel.json`.
   El script usa una transacción de solo lectura y no muestra credenciales ni
   host (solo una huella SHA-256).
3. Revisar en Render el **plan** de cada PostgreSQL y su fecha de caducidad
   (las bases gratuitas caducan).

## 4. Procedimiento de respaldo (antes de la fase 1)

Hacerlo **justo antes** de cualquier despliegue, porque desplegar borra
`data/db.json` en un disco efímero.

1. **Pausar el despliegue automático** en Render (Settings → Build & Deploy →
   Auto-Deploy: *No*) mientras dure la intervención. *Requiere tu
   autorización; no lo he cambiado.*
2. **Respaldo de la app en ejecución** (lo que hoy está en `db.json`):
   - Desde el panel: Configuración → Datos → Respaldo, o
   - `node scripts/respaldo/respaldo-api.js https://TU-SERVICIO.onrender.com`
     → carpeta `respaldos/api-<fecha>/` con `MANIFIESTO.json` y resumen
     (reservas, barberos, servicios, horarios).
3. **Respaldo de PostgreSQL**:
   `DATABASE_URL='<URL externa>' scripts/respaldo/respaldo-postgres.sh`
   → `respaldos/pg-<fecha>/` con `base.dump`, `esquema.sql`, `filas.txt` y
   `SHA256SUMS`. Además, si el plan lo permite, crear un respaldo o
   *snapshot* desde el panel de Render.
4. **Probar la restauración** en una base vacía de pruebas:
   `createdb restaurar_test && pg_restore -d restaurar_test --no-owner base.dump`
   y comparar con `filas.txt`.
5. **Etiqueta de la versión actual**: `git tag antes-fase-1 <commit desplegado>`
   para poder volver exactamente a ella.
6. Guardar los respaldos fuera del repositorio (contienen teléfonos de
   clientes), idealmente en dos lugares.

**Volver atrás:** redeploy del commit etiquetado en Render y, si hiciera
falta, `pg_restore --clean` del `base.dump` en la base afectada (solo con
autorización expresa, porque reemplaza datos).

## 5. Cómo ejecutar las pruebas

```bash
npm install --no-package-lock
npm run check
npm test                                              # sin PostgreSQL: se omiten las de base de datos
TEST_DATABASE_URL=postgres://usuario@localhost:5432/reservas_test npm test
node scripts/capturas.js capturar capturas/antes      # antes de un cambio
node scripts/capturas.js capturar capturas/despues    # después
node scripts/capturas.js comparar capturas/antes capturas/despues
```

`TEST_DATABASE_URL` debe ser local y su nombre debe contener `test` o
`prueba`; si no, las pruebas se niegan a ejecutarse. El servidor exige SSL,
así que la base de pruebas debe tener SSL activado (o añadir
`?sslmode=disable` a la URL).

## 6. Hallazgos adicionales (no corregidos, fuera de la fase 0)

- **Texto "null" en la portada pública** cuando la página no tiene
  descripción (`public/index.html:243`): se ve en las capturas de referencia.
  Si en producción hay descripción configurada, no se nota.
- **Fecha de ventas y caja** usa `CURRENT_DATE` de PostgreSQL. Si la base está
  en UTC, las ventas hechas después de las 19:00 de Ecuador cuentan para el
  día siguiente. Pendiente de confirmar con la zona horaria real de la base.
- El respaldo `/api/admin/backup` y todas las rutas `/api/admin/*` siguen sin
  autenticación (previsto en la fase 3).
- Las imágenes solo quedan en el respaldo de PostgreSQL (`base.dump`), no en
  el respaldo por API.
- Existe la rama `respaldo-estable` (otra versión de `server.js` e
  `index.html`). No la he tocado. Conviene confirmar **qué rama despliega
  Render**: las pruebas y la comparación de diseño usan `main` como
  referencia.
