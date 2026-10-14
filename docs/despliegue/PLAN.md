# Plan de despliegue — instalación limpia de Master Fade

Estado: **preparado, sin ejecutar.** Nada de este plan se ha hecho en producción. Cada paso
marcado con 🔒 necesita tu autorización final.

Ramas listas: `claude/hopeful-curie-fcnqea` en `El-Master-reservas-` y en `master-fade-`.
Ninguno de los dos `main` cambió desde que se crearon, así que la fusión no tiene conflictos.

## 0. Qué cambió con tu aclaración

La barbería actual es solo una demostración, así que **no se migran datos**:
- no hay importación de reservas;
- no hace falta una ventana de mantenimiento para conservar datos;
- volver atrás es sencillo.

Se empieza con una base limpia, conservando:
- el código y los módulos;
- el catálogo de planes del Panel;
- las credenciales de WhatsApp y Meta (son variables de Render y no se tocan).

## 1. Qué es demostración y qué se conserva

Comprobado en el código de `main` (lo que hoy está en producción). El inventario del paso P3
lo confirma sobre la base real.

| Dónde | Contenido | Qué se hace |
|---|---|---|
| Disco de Render de El Máster Reservas (`data/db.json`) | Agenda de la demostración: barberos, servicios, horarios, reservas, clientes | Desaparece solo al desplegar (el disco es temporal). No hay que borrarlo. |
| PostgreSQL de El Máster Reservas: `sales`, `cash_sessions`, `products`, `admin_settings`, `media_assets` | Ventas, caja, productos, configuración (textos de Elia, página pública) e imágenes de la demostración | Se borran con `limpiar-demo.js` después de un respaldo verificado. |
| Cuentas de usuario | **No existen** en la versión actual (no tiene inicio de sesión) | Nada que borrar. |
| Conversaciones de Elia | Solo en memoria | Se reinician al desplegar, como en cualquier despliegue. |
| PostgreSQL del Panel: `master_fade_plans`, `master_fade_plan_changes` | **Catálogo de planes real** (precios y días de prueba) y su historial | **Se conservan.** |
| Barberías de demostración del Panel | Solo en el navegador (`localStorage`) | La versión nueva las borra del navegador al abrir el Panel. |
| Variables de Render: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `DATABASE_URL` | Credenciales reales | **No se tocan.** |
| Cualquier otra tabla que aparezca en la base | Desconocida | `limpiar-demo.js` nunca la toca. |

`limpiar-demo.js` tiene varias protecciones:
- Sin `--ejecutar` solo muestra la lista; no borra nada.
- Para ejecutarlo exige el **nombre exacto** de la base y un archivo de **respaldo**.
- Borra todo en **una sola transacción**: si algo falla, no se borra nada.
- Nunca usa `CASCADE`.
- Al terminar, comprueba que las tablas conservadas siguen idénticas.

Si las dos aplicaciones comparten la misma base, las tablas del Panel quedan intactas; el
ensayo lo prueba.

## 2. Protección de El Máster y el inicio limpio

- **Cómo funciona hoy la barbería principal:**
  - Se crea sola en el primer arranque. Su identificador interno es `el-master` (`DEFAULT_BUSINESS_ID`).
  - Arranca solo con la plantilla: el nombre «El Máster», un barbero «Master», 6 servicios y el horario por defecto. Sin reservas ni cuentas.
  - Nunca se bloquea por suscripción.
  - **Es la única que hoy tiene página pública de reservas y WhatsApp/Elia.**
- **Las barberías creadas con el registro** pueden:
  - usar todo el panel (agenda, caja, productos, equipo);
  - ser administradas desde el Panel Maestro, con plan y prueba de 7 días.

  **Pero todavía no tienen página pública ni WhatsApp propios:** sus clientes no pueden reservar en línea.

**Decisión que necesito de ti — cómo crear tu barbería:**

| | A. Tu barbería es la principal *(recomendada para lanzar ya)* | B. Tu barbería por el registro normal |
|---|---|---|
| Cómo | Después de desplegar, el script de consola crea tu cuenta de propietario. En el panel cambias el nombre, los barberos, los servicios y los horarios de la plantilla. | Te registras en `acceso.html` como cualquier cliente. |
| Página pública y WhatsApp | **Sí**, desde el primer día | **No**, hasta que se desarrolle la página pública por barbería |
| Suscripción | Protegida: nunca vence | Prueba de 7 días; el Panel la administra |
| Requisitos | Ninguno nuevo | Configurar el correo (Resend) para confirmar la cuenta; requiere crear la cuenta de Resend |
| Inicio limpio | Sí: la plantilla no tiene reservas ni clientes | Sí, pero la principal «El Máster» queda como plantilla vacía |

Las dos opciones conservan la seguridad: la protección solo se aplica a la barbería principal,
y el registro sigue cerrado en producción hasta configurar el correo. Con la opción A, el
registro normal se puede probar más tarde con una barbería de prueba, cuando el correo esté
listo.

## 3. Variables de entorno (solo los nombres, nunca los valores)

**El Máster Reservas (servicio web actual en Render)**

| Variable | Estado | Nota |
|---|---|---|
| `DATABASE_URL`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN` | Ya existen | Sin cambios |
| `PLATAFORMA_CLAVE` | **Nueva, obligatoria** | 48 caracteres aleatorios o más (`openssl rand -base64 48`). El mismo valor en el Panel. Guárdala en un gestor de contraseñas. |
| `PUBLIC_BASE_URL` | **Nueva, obligatoria** | Dirección pública con `https://`. La usan los enlaces de la cuenta del propietario y de los correos. |
| `RENDER` | Render la define sola | Activa el modo producción: registro cerrado y cookies seguras. |
| `CLAVE_DOS_PASOS` | Opcional | Activa la verificación en dos pasos. Valor aleatorio largo que no debe perderse. |
| `RESEND_API_KEY`, `CORREO_REMITENTE`, `CORREO_RESPONDER_A` | Opcional (opción B) | Correo; requiere crear la cuenta de Resend y verificar el dominio. |
| `REGISTRO_ABIERTO=1` | Opcional | Solo funciona con el correo configurado. |
| `DEFAULT_BUSINESS_ID` | No definir | Por defecto, `el-master`. |

**Panel Maestro (servicio web actual en Render)**

| Variable | Estado | Nota |
|---|---|---|
| `DATABASE_URL`, `DATABASE_SSL` | Ya existen | Sin cambios |
| `RESERVAS_URL` | **Nueva, obligatoria** | Dirección `https://` de El Máster Reservas |
| `PLATAFORMA_CLAVE` | **Nueva, obligatoria** | La misma que en Reservas |
| `TRUST_PROXY=1` | Recomendada | Para que el límite de intentos use la IP real |
| `ADMIN_API_KEY` | Opcional | Ya no hace falta para el panel. Si se deja vacía, la edición por scripts queda desactivada. |

## 4. Pasos exactos

### Preparación (sin efecto en producción)

| Paso | Qué | Quién y cómo |
|---|---|---|
| P1 | Anotar en Render: el nombre de cada servicio y su rama de despliegue, la base enlazada a cada uno (nombre, no valor), el plan y la caducidad de cada PostgreSQL. **Pausar el despliegue automático** de los dos servicios. 🔒 | Tú, en el panel de Render |
| P2 | Respaldo de la base de Reservas (y de la del Panel si es otra): una instantánea en Render si el plan lo permite, más `DATABASE_URL='<URL externa>' scripts/respaldo/respaldo-postgres.sh` | Tu computadora (Node 22 y `pg_dump` 16), o esta sesión si me das acceso (sección 7) |
| P3 | Inventario de solo lectura: `DATABASE_URL=... node scripts/despliegue/inventario.js` en cada base. Confirma qué tablas hay, si la base es compartida y si aparece alguna tabla «otra». | Igual que P2 |
| P4 | Verificar el respaldo: crear una base vacía de prueba y ejecutar `RESTAURAR_URL=... scripts/respaldo/verificar-restauracion.sh respaldos/pg-<fecha>` (sumas SHA-256, restauración y mismas filas en cada tabla) | Igual que P2 |
| P5 | Simulación de la limpieza: `DATABASE_URL=... node scripts/despliegue/limpiar-demo.js`. Muestra exactamente qué se borraría. **Revisas la lista.** | Igual que P2 |
| P6 | Generar `PLATAFORMA_CLAVE` (y `CLAVE_DOS_PASOS` si la quieres) y guardarlas en tu gestor de contraseñas | Tú |

### Ejecución 🔒 (unos 15 minutos, mejor a una hora de poco movimiento)

| Paso | Qué | Efecto visible |
|---|---|---|
| E1 | Fusionar las dos ramas con `main` (avance rápido, sin conflictos) | Ninguno, con el despliegue automático pausado |
| E2 | Render, El Máster Reservas: agregar `PLATAFORMA_CLAVE` y `PUBLIC_BASE_URL` | Ninguno hasta desplegar |
| E3 | `limpiar-demo.js --ejecutar --confirmar <base> --respaldo <archivo .dump>` | Desde aquí hasta E4, el panel antiguo falla en caja, productos y configuración. Solo afecta a la demostración y dura minutos. |
| E4 | Despliegue manual de Reservas. En los registros deben verse las migraciones aplicadas, `BARBERÍA PROTEGIDA: el-master`, `AGENDA EN POSTGRESQL LISTA … restricción de solapes: activa` y `EL MÁSTER RESERVAS INICIADO`. | Render mantiene la versión anterior hasta que la nueva responde: sin caída del servicio. Si el servicio tiene un disco persistente, Render detiene antes la versión anterior: unos segundos sin servicio. Se ve en P1. |
| E5 | Tu cuenta de propietario (opción A), en el *Shell* de Render o desde tu computadora con la URL externa: `node scripts/cuentas/crear-propietario.js --negocio el-master --email <tu correo> --nombre "<tu nombre>"`. Devuelve un enlace de un solo uso, válido 24 horas, para crear tu contraseña. | — |
| E6 | Render, Panel: agregar `RESERVAS_URL`, `PLATAFORMA_CLAVE` y `TRUST_PROXY=1`, y desplegar | Al abrir el Panel se pedirá iniciar sesión |
| E7 | Tu administrador del Panel: `node scripts/crear-admin.js <tu correo> "<tu nombre>"`. Si no indicas `ADMIN_NUEVA_CLAVE`, genera una contraseña aleatoria y la muestra **una sola vez**: así no queda en el historial de comandos. Cámbiala volviendo a ejecutar el script cuando quieras. | — |
| E8 | Comprobaciones: la página pública carga; disponibilidad del día; una reserva de prueba que después cancelas; un mensaje de prueba a Elia por WhatsApp; entrar al panel de Reservas; en el Panel Maestro, «Sincronizar ahora» muestra «El Máster» protegida; el registro sigue cerrado. | — |
| E9 | Reactivar el despliegue automático | — |

## 5. Cómo volver atrás

| Problema | Acción | Datos |
|---|---|---|
| La versión nueva de Reservas no arranca | Nada: Render mantiene la anterior y marca el despliegue como fallido | Sin cambios |
| Falla algo después del cambio | Render → *Rollback* al despliegue anterior. La versión anterior arranca sobre la base nueva (ensayado). Si al guardar su configuración da error, se ejecuta `scripts/migracion/revertir-claves-fase2.sql` (ensayado; no borra filas). | Las tablas nuevas se conservan para volver a la versión nueva |
| Quieres recuperar la demostración | `pg_restore` del respaldo P2 🔒 | Vuelven los datos de la demostración |
| Falla el Panel | Render → *Rollback*. La versión anterior ignora las tablas nuevas. El catálogo de planes no cambia. | Sin pérdida |

## 6. Ensayo realizado (`test/despliegue.test.js`, también en GitHub Actions)

Usa el código real de `main` como producción:
1. `main` con datos de demostración en una base que además tiene tablas del Panel y una tabla ajena.
2. El inventario clasifica bien y no muestra datos personales.
3. Respaldo con `pg_dump` y restauración verificada en otra base. Se niega a restaurar sobre una base con datos.
4. Limpieza:
   - la simulación no borra nada;
   - se niega a ejecutar con otro nombre de base o sin respaldo;
   - al ejecutar borra solo las 5 tablas de la demostración; el Panel y la tabla ajena quedan intactos.
5. Primer arranque de la versión nueva como en Render:
   - base limpia, `el-master` protegida y activa;
   - 0 cuentas, reservas, ventas, productos o imágenes;
   - registro cerrado y panel con inicio de sesión obligatorio.
6. Cuenta del propietario con el script: el enlace crea la contraseña, se entra y no hay datos de la demostración.
7. Con el correo configurado (Resend simulado), una barbería nueva se registra por el proceso normal: correo de confirmación, inicio de sesión, prueba de 7 días y visible para el Panel.
8. Reversión: `main` vuelve a arrancar sobre la base nueva y guarda su configuración después del script de claves. Las cuentas nuevas se conservan.

## 7. Lo que no pude verificar desde esta sesión

Desde este entorno **no hay acceso a Render**: su política de red bloquea la conexión. Por
eso no he visto los servicios, las bases ni los respaldos reales. Hay dos formas de completarlo:

1. **Tú ejecutas P1 a P5** con los comandos de arriba y me pasas la salida del inventario y de
   la verificación. No contienen datos personales ni credenciales.
2. **Me das acceso** en la configuración del entorno:
   - en *Network access*, agregar los dominios de Render (`*.render.com` y `*.onrender.com`);
   - guardar la URL externa de la base como variable de entorno, por ejemplo `RESERVAS_DATABASE_URL`.

   Nunca la pegues en el chat. Con eso ejecuto P2 a P5 en modo de solo lectura (la limpieza solo
   en simulación) y te muestro los resultados.
