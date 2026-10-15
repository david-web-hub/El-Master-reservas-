# Fase 9 — Sección «Planes» del propietario

## Auditoría de pagos
- No hay pagos integrados. No existe pasarela, cobro ni webhook de pagos en ninguna de las dos aplicaciones. En el Panel Maestro, «Pagos y facturación» es una pantalla de demostración.
- Por eso un cambio de plan **no se activa solo** y **no se simula ningún pago**. El propietario envía una **solicitud** y el Panel Maestro la aprueba o la rechaza. Hasta entonces no cambia nada: ni el plan, ni los límites, ni los privilegios.

## Qué ve el propietario
- **Menú:** «Planes», justo debajo de Configuración, en el menú lateral de escritorio y en la barra inferior del teléfono.
  - Solo lo ve el **propietario** de una barbería registrada.
  - No aparece para el personal ni en la barbería principal protegida (El Máster). Por eso el panel de El Máster no cambia.
- **Su plan:** nombre, días de prueba que le quedan (con la fecha de fin) o el estado de la suscripción, y «Barberos activos: X de N».
- **Tarjetas de planes:** solo los planes **activos** del catálogo del Panel Maestro, leídos de la base. No hay precios fijos en el código.
  - Cada tarjeta muestra nombre, precio, límite de barberos y días de prueba.
  - El plan que tiene lleva la marca «Plan actual». Si ese plan ya no se ofrece, se sigue mostrando y lo conserva.
  - Los demás planes tienen el botón «Solicitar este plan».
- **Solicitud:**
  - Mientras está pendiente se ve un aviso y se puede cancelar.
  - Cuando el Panel Maestro la resuelve, el propietario ve si se aprobó o se rechazó, con el motivo.

## Reglas en el servidor
- `GET /api/admin/planes`, `POST /api/admin/planes/solicitud` y `DELETE /api/admin/planes/solicitud` son **solo para el propietario**. El personal recibe 403 y sin sesión se responde 401.
- La barbería sale siempre de la sesión: nadie puede pedir ni ver solicitudes de otra.
- Solo se pueden pedir planes **activos** del catálogo (400 `PLAN_INVALIDO`). Pedir el mismo plan que ya tiene devuelve 400 `MISMO_PLAN`.
- **Bajar de plan** usa la misma validación de la fase 8: si hay más barberos activos que el límite del plan pedido, se rechaza con una explicación (409 `LIMITE_BARBEROS`) y no se guarda nada. No se borra ni se desactiva ningún barbero.
- Hay **una sola solicitud pendiente** por barbería. Pedir otro plan cancela la anterior.
- **El Máster** (protegida) no puede pedir cambios (409 `NEGOCIO_PROTEGIDO`).
- Cada solicitud genera el evento `plan.requested` para la actividad del Panel Maestro.

## Panel Maestro
- **Suscripciones → «Solicitudes de cambio de plan»:** la tarjeta aparece solo cuando hay solicitudes, con los botones Aprobar y Rechazar.
- **Sincronización:** las solicitudes llegan con la sincronización firmada de siempre, mediante `GET /api/plataforma/solicitudes`.
- **Aprobar:**
  1. El Panel aplica el plan pedido con la **misma validación** que un cambio manual: control de versiones, límite de barberos con el dato del momento y barbería protegida. El estado y las fechas de la suscripción no cambian, y el cambio queda en el historial.
  2. Después marca la solicitud como aprobada. El Máster Reservas solo acepta marcarla aprobada si el plan **ya está aplicado** (409 `PLAN_NO_APLICADO`).
  - Si El Máster Reservas no responde, la solicitud **sigue pendiente**.
- **Rechazar:** el Panel envía el motivo, que verá el propietario. El plan no cambia.
- **Compatibilidad:** si El Máster Reservas aún tiene la versión anterior (sin solicitudes), la sincronización del Panel sigue funcionando.

## Migraciones (solo añaden)
- **El Máster Reservas `2026-10-fase9-001`:** tabla `plan_requests` e índices: una sola pendiente por barbería y búsqueda por barbería.
- **Panel Maestro:** tabla `master_fade_plan_requests` (copia de las solicitudes, sin datos de clientes) e índice por estado.
- No se borra ni se modifica ningún dato existente. No cambia ninguna suscripción ni se genera ningún cobro.

## Pruebas
- **El Máster Reservas:** `test/fase9-planes-solicitudes.test.js` (10 pruebas). Cubre:
  - el catálogo sincronizado y los cambios de precio, límite y disponibilidad;
  - la identificación del plan actual;
  - las solicitudes pendientes sin privilegios;
  - la aprobación, que solo vale con el plan aplicado;
  - el rechazo con motivo y la cancelación;
  - la bajada rechazada por exceso de barberos;
  - el aislamiento entre barberías y por rol;
  - El Máster protegida;
  - que todo persiste tras reiniciar y que la migración se aplica una sola vez;
  - el navegador en teléfono y escritorio.
- **Panel Maestro:**
  - `test/solicitudes.test.js`: sincronización, aprobar, rechazar, sesión y mismo origen, bajada con barberos de más, Reservas caído y Reservas anterior sin solicitudes;
  - una prueba más en el navegador (`test/ui.test.js`);
  - un paso de extremo a extremo con El Máster Reservas real (`test/e2e.test.js`).
- **Diseño:** las capturas de El Máster y del Panel Maestro son idénticas a las de `main`.
