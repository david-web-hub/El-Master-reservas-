# Fase 8 — Límite de barberos por plan

| Plan | Precio | Barberos activos | Prueba |
|---|---|---|---|
| Individual | $10.99/mes | 1 | 7 días |
| Pro | $19.99/mes | 4 | 7 días |
| Business | $34.99/mes | 10 | 7 días |

## Cómo funciona
- **Dónde vive:** el límite está en el catálogo del Panel Maestro (`master_fade_plans.max_barbers`) y se administra en **Planes → Editar plan**. Si se deja vacío, el plan no tiene límite. Viaja a El Máster Reservas con la misma sincronización firmada de siempre (`platform_plans.max_barbers`).
- **Cuál se aplica:** el de su plan. La barbería principal protegida (El Máster) no tiene límite y conserva su protección.
- **Qué cuenta:** solo los barberos **activos**. Los desactivados se conservan y no cuentan.
- **Control en el servidor** (`POST` y `PATCH /api/admin/barbers`):
  - crear un barbero activo, o activar uno desactivado, se rechaza con `403 LIMITE_BARBEROS` si la barbería ya está en el límite;
  - los cambios de barberos de una misma barbería se procesan de uno en uno, para que dos solicitudes a la vez no superen el límite;
  - la barbería sale siempre de la sesión: nadie puede tocar los barberos de otra;
  - el propietario no puede cambiarse de plan: la API de plataforma exige la firma del Panel Maestro.
- **Lo que ve el propietario:** en **Configuración → Barberos**, «Barberos activos: X de N». Al llegar al límite, un aviso para cambiar de plan y el botón «Agregar barbero» desactivado. El registro muestra cuántos barberos permite cada plan.
- **Subir de plan:** el límite nuevo se aplica al momento, sin tocar datos.
- **Bajar de plan** (política explícita):
  - si la barbería tiene más barberos activos de los que permite el plan nuevo, el cambio **se rechaza** (409 `LIMITE_BARBEROS`) y no se guarda nada;
  - no se borra ni se desactiva ningún barbero: el propietario desactiva los que sobran y entonces el cambio se puede hacer;
  - el Panel lo comprueba antes de guardar, con el dato del momento de El Máster Reservas, y El Máster Reservas lo vuelve a comprobar al aplicarlo.
- **Cambios de estado o fechas con el mismo plan** (vencida, pago pendiente…) nunca se bloquean.
- **Si se baja el límite de un plan en el catálogo:** las barberías que ya tenían más barberos los conservan, pero no pueden agregar ni activar otros hasta estar por debajo del límite.
- **El Panel Maestro ve, por barbería:** los barberos activos y el límite de su plan («Barberías → Administrar»).

## Migraciones (solo añaden)
- **El Máster Reservas `2026-10-fase8-001`:** columna `platform_plans.max_barbers` y los límites 1/4/10 para Individual/Pro/Business donde falten.
- **Panel Maestro:**
  - columna `master_fade_plans.max_barbers` con los mismos límites;
  - una sola vez: el precio de Individual pasa de 9.99 a 10.99, **solo si sigue en 9.99**. El cambio queda en el historial de precios con origen `migracion`.
- No se borra nada. No se cambian suscripciones, fechas ni planes de ninguna barbería, ni se genera ningún cobro.
