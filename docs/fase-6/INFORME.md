# Fase 6 — Integración de El Máster Reservas con el Panel Maestro V3

Ramas: `claude/hopeful-curie-fcnqea` en los dos repositorios (`El-Master-reservas-` y `master-fade-`).

**No se desplegó nada.** No se tocó Render, ninguna base real, Meta, WhatsApp ni Elia.
`main` no cambia en ningún repositorio y no hay Pull Requests. Todo se probó con bases y
datos de prueba.

## 1. Cómo funciona

```
Panel (navegador) ──sesión de administrador──▶ Panel (servidor) ──petición firmada──▶ El Máster Reservas
                                                     ▲                                       │
                                                     └──── barberías, cifras y avisos ───────┘
```

- **Quién decide cada dato:**
  - **El Máster Reservas** es la fuente de las barberías, cuentas, reservas, clientes y caja, y es quien **aplica** el acceso.
  - **El Panel Maestro** decide los planes y las suscripciones (plan, estado y fechas).
- **Comunicación:** solo de servidor a servidor. Cada petición lleva una firma HMAC-SHA256 con
  la clave compartida `PLATAFORMA_CLAVE`, la fecha (±5 minutos) y un nonce de un solo uso.
  - El código está en `firma-plataforma.js`, idéntico en los dos repositorios y comprobado con el mismo vector de prueba (también verificado con `openssl`).
  - La clave nunca llega al navegador ni a los registros.
  - El Panel exige `https://` para conectarse fuera de su propio equipo.
- **Sincronización:** el Panel sincroniza al arrancar, cada minuto y con «Sincronizar ahora». En cada ciclo:
  1. Envía su catálogo de planes.
  2. Recoge los avisos de Reservas y los confirma.
  3. Actualiza las barberías y sus cifras.
  4. Envía los cambios de suscripción pendientes.
- **Si un servidor no responde:** nada se pierde.
  - Los cambios quedan pendientes en el Panel y se reintentan.
  - Reservas aplica las fechas por su cuenta, así que una prueba vence a tiempo aunque el Panel esté caído.

## 2. Qué se implementó

| Condición de la autorización | Resultado |
|---|---|
| 4. Inicio de sesión seguro del Panel | Cuentas de administrador con contraseña cifrada (scrypt, mínimo 12 caracteres) y sesión en cookie HttpOnly y SameSite=Strict, que vence a las 12 horas o tras 2 horas sin uso. Bloqueo tras 10 fallos por cuenta y por IP, protección CSRF y registro de accesos. No hay usuarios por defecto: el primero se crea con `scripts/crear-admin.js`. Todas las pantallas y datos exigen sesión. |
| 5. Comunicación segura y sincronización | Rutas `/api/plataforma/*` en Reservas, protegidas con firma y bloqueo de IP tras 20 firmas inválidas. Las barberías registradas aparecen solas en el Panel. Las suscripciones se administran desde «Barberías» o «Suscripciones», con control de versiones e historial. |
| 6. Planes y 7 días de prueba del catálogo | El catálogo del Panel se copia en Reservas. El registro solo acepta planes activos de ese catálogo y calcula la prueba con sus días (hoy 7). El Panel también calcula la prueba con su catálogo. |
| 7. Información administrativa sin datos personales | Reservas envía solo cifras: barberos, usuarios, reservas totales, de los últimos 30 días y próximas, clientes distintos y ventas de 30 días. También envía el contacto del propietario. Nunca nombres ni teléfonos de clientes; hay pruebas que lo verifican, incluida la de extremo a extremo con una reserva real. |
| 8. Vencimiento | Los datos y las reservas existentes se conservan, el panel de la barbería sigue abierto con un aviso de renovación y la página pública rechaza reservas nuevas. Hay avisos también para pago pendiente y para una prueba que termina en 3 días o menos. «Suspendida» impide el acceso, como antes. |
| 8. El Máster protegida | Seis barreras: (1) la pantalla del Panel desactiva esas opciones; (2) el servidor del Panel las rechaza; (3) Reservas las rechaza; (4) las fechas no la afectan; (5) una restricción en la base impide guardar ese estado; (6) al arrancar, Reservas la vuelve a proteger y reactivar. |
| 3. Diseño V3 | Mismos componentes. En el Panel, las 12 pantallas que no cambian son idénticas píxel a píxel en computadora y teléfono. En Reservas, las 38 capturas no tienen diferencias no aprobadas: el aviso solo aparece si hay algo que avisar. |
| 9. Pruebas en GitHub Actions | Ver sección 4. |
| 1, 2, 10. Restricciones | Solo ramas de desarrollo, sin despliegues, sin datos reales, sin PR ni fusiones. |

### Cambios en El Máster Reservas
- **`firma-plataforma.js`** (nuevo): firma y verificación.
- **`plataforma.js`** (nuevo): estado efectivo de la suscripción, barberías con cifras, suscripción versionada, catálogo de planes y avisos con confirmación.
- **Migración `2026-10-fase6-001`**: solo agrega columnas (`protected`, `current_period_end`, `subscription_version`, `subscription_updated_at`), dos restricciones y la tabla `platform_plans`. No borra ni modifica datos.
  - La restricción de estados válidos es `NOT VALID`: no revisa las filas antiguas.
- **`server.js`:**
  - Rutas `/api/plataforma/*`, `GET /api/public/planes` y la suscripción en `/api/auth/sesion`.
  - Bloqueo de reservas nuevas si la suscripción venció.
  - Protección de la barbería principal y de las indicadas en `NEGOCIOS_PROTEGIDOS`.
- **`autenticacion.js`:**
  - El registro usa el catálogo; un plan inválido devuelve `PLAN_INVALIDO`.
  - Una barbería protegida nunca queda fuera aunque su estado fuera «suspendida».
- **`admin.html`:** aviso de suscripción bajo el título, con el estilo de las tarjetas.
- **`acceso.html`:** el enlace del Panel rellena el registro (nunca la contraseña) y muestra el plan con sus días de prueba.

### Cambios en el Panel Maestro
- **Módulos nuevos:**
  - `auth.js`: cuentas y sesiones.
  - `integracion.js`: sincronización.
  - `firma-plataforma.js`: copia idéntica del de Reservas.
  - `scripts/crear-admin.js`: crea el primer administrador.
  - `scripts/capturas.js`: comparación de diseño.
- **`server.js`:** acceso, `/api/admin/resumen`, `/api/admin/sincronizar` y `/api/admin/barberias/:id/suscripcion`. Envía el catálogo al guardar un plan y sincroniza periódicamente.
- **`app.js`:**
  - Pantalla de acceso y «Cerrar sesión» en la barra lateral.
  - «Barberías», «Suscripciones», «Reservas globales», «Clientes» y el inicio, con datos reales.
  - El autorregistro lleva al registro real.
  - Desaparecen las barberías de demostración guardadas en el navegador.
- **`styles.css`:** dos ajustes solo para teléfono. Las tablas largas se desplazan dentro de su tarjeta y las cabeceras con botón pueden pasar a dos líneas. Antes, «Barberías» y «Autorregistro» ya se salían de la pantalla del teléfono.

## 3. Errores encontrados y corregidos durante la fase

1. **Avisos perdidos tras restaurar la base de Reservas:** el Panel identificaba cada aviso solo por su número. Si Reservas restaurara su base, los números se repetirían y el Panel descartaría avisos nuevos sin decirlo. Ahora la clave incluye la barbería y el tipo de aviso. Lo detectó una prueba.
2. **Tablas desbordadas en el teléfono** en las pantallas nuevas del Panel: corregido sin cambiar el aspecto en computadora.
3. **Mensajes de error de sincronización sin el código de respuesta:** ahora indican, por ejemplo, «respondió 409: barbería protegida».
4. **Plan inventado para El Máster:** al no tener plan, el Panel le asignaba el primero del catálogo. Ahora queda sin plan hasta que se le asigne.
5. **Pantalla de acceso del Panel:** el fondo se cortaba a media altura; corregido.

## 4. Pruebas

| Ejecución | Resultado |
|---|---|
| Reservas · `npm test` (agenda en archivo + PostgreSQL + navegador) | 122 pruebas; las 2 fallas de la primera corrida se debían a datos de prueba, se corrigieron y se volvieron a comprobar |
| Reservas · `TEST_ALMACEN=postgres npm test` | igual (1 omitida, solo aplica al modo archivo) |
| Reservas · diseño contra `main` (38 capturas) | sin diferencias no aprobadas |
| Panel · `npm test` con PostgreSQL, navegador y **Reservas real** | **52/52** |
| Panel · `npm test` sin base | 10 correctas y 5 omitidas (requieren base) |
| Panel · diseño contra `main` (40 capturas) | sin diferencias no aprobadas; 12 pantallas idénticas en cada tamaño |

**Pruebas nuevas en Reservas (14):**
- Vector de firma; verificador (fecha, repetición, clave anterior, cuerpo alterado); estado efectivo.
- Sin firma no hay acceso, ni con la sesión de un propietario; ruta, fecha, cuerpo o nonce alterados se rechazan.
- El catálogo de 7 días se aplica al registro; planes inexistentes o inactivos se rechazan.
- Las cifras salen sin datos personales (con una reserva real de un cliente).
- Avisos con confirmación.
- Suscripción: versiones, pago pendiente, vencimiento (datos accesibles, sin reservas nuevas), suspensión y reactivación.
- El Máster protegida desde el Panel, por fechas y en la base, y reprotegida al reiniciar.
- Sin clave no funciona; bloqueo tras 20 firmas inválidas; la clave nunca aparece en los registros.
- Navegador: avisos (vencida, pago pendiente, prueba por terminar, al día), teléfono y registro desde el enlace del Panel.

**Pruebas nuevas en el Panel (31):**
- Acceso (9).
- Sincronización contra un Reservas simulado (10): caída, lentitud, clave equivocada, `http://` fuera de este equipo y privacidad.
- Extremo a extremo con Reservas real (6).
- Navegador (11).
- Firma (2).

Las capturas están en `docs/fase-6/` de cada repositorio.

## 5. Riesgos y pendientes

1. **Despliegue de las fases 1 a 6 sobre los datos reales:** es el mayor riesgo. Debe seguir el procedimiento de respaldo, importación y verificación de `docs/fase-1`. **Requiere tu autorización.**
2. **Configuración en Render (requiere autorización):**
   - `PLATAFORMA_CLAVE`: el mismo valor en los dos servicios, de 32 caracteres aleatorios o más.
   - En el Panel: `RESERVAS_URL` (https) y `TRUST_PROXY=1`.
   - Crear el primer administrador del Panel.
   - Opcional: `NEGOCIOS_PROTEGIDOS`.
3. **Cobros:** no hay pasarela de pago. Por ahora un administrador registra el pago cambiando el estado y la fecha «Pagado hasta». Integrar pagos es una fase propia.
4. **Página pública y Elia por barbería:** hoy solo existen para El Máster, que está protegida. El bloqueo por vencimiento ya está en la ruta de reservas para cuando existan. Elia no se modificó; cuando atienda otras barberías, deberá consultar el mismo estado.
5. **Rama de Reservas en el CI del Panel:** el CI del Panel descarga Reservas desde `claude/hopeful-curie-fcnqea`. Al fusionar, cambiar `RESERVAS_REF` a `main`.
6. **Varias instancias:** el registro de nonces y el límite por IP viven en memoria (como el límite de acceso de fases anteriores). Con una instancia, como hoy en Render, es suficiente. La sincronización ya usa un bloqueo en PostgreSQL.
7. **Inicio del Panel en el teléfono:** el gráfico de ingresos de ejemplo se sale de la pantalla, ya ocurría en `main`. No se tocó para no cambiar el diseño.
8. **Nombre en la barra lateral de Reservas:** sigue fijo en «EL MÁSTER» (observación de la fase 5).
