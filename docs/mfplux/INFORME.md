# MF Plux: marca y tipo de negocio (barbería o salón de belleza)

Rama: `claude/mf-plux-tipo-negocio`. **No se desplegó nada.** No se tocó Render, Cloudflare, los DNS ni la base de producción. `main` no cambia.

## Qué cambia

| Pedido | Implementación |
|---|---|
| Marca MF Plux | La página comercial (`sitio-publico.js`), el acceso y el registro (`acceso.html`), el cierre de sesión, el panel de cada propietario, los correos, el manifiesto de la aplicación y el nombre en la app de autenticación de dos pasos (solo en activaciones nuevas) dicen «MF Plux». **No cambian:** el nombre de El Máster ni el de ningún negocio existente. |
| Barbería o salón de belleza | En «Crear cuenta» se elige primero **Barbería** o **Salón de belleza**; el formulario aparece después. Un enlace con `?tipo=barberia` o `?tipo=salon` llega con la opción ya elegida. Los dos tipos usan la misma aplicación, con los mismos planes, precios y funciones. |
| Guardar el tipo | Columna nueva `businesses.business_type` (`barberia` o `salon`). La API de registro acepta `businessType`; sin tipo (enlaces anteriores) queda `barberia`; un valor distinto se rechaza (400). |
| Página pública según el tipo | En `/b/<dirección>/` de un negocio con tipo, el servidor escribe el título del navegador («Nombre · Salón de belleza» o «Nombre · Barbería»), la descripción y Open Graph. Si el nombre ya dice la categoría, no se repite. En la página: etiqueta de categoría junto al nombre y, en los salones, «Profesionales», «Elige tu profesional»; en las barberías, «Barberos», «Elige tu barbero». |
| Negocios existentes | Quedan **sin tipo** (columna vacía) y su página pública es exactamente la de antes, incluida la de El Máster en `/`. |
| Panel Maestro | La sincronización envía `businessType` de cada negocio (null en los anteriores). |
| mfplux.com | El dominio sale de las variables de entorno: no hay ningún dominio escrito en el código. En el dominio principal, los webhooks de WhatsApp (`/webhooks/...`) ahora llegan a la aplicación en lugar de redirigirse, para que WhatsApp no se corte si Meta usa ese dominio. |

## Base de datos

Migración `2026-10-mfplux-001`, automática al arrancar y una sola vez:

```sql
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS business_type TEXT
  CHECK (business_type IS NULL OR business_type IN ('barberia', 'salon'));
```

- **No es destructiva:** no tiene valor por defecto, así que no reescribe ninguna fila. No borra ni modifica datos.
- **Si se vuelve a la versión anterior del código,** la columna queda sin uso y no molesta.

## Pruebas

| Archivo | Qué prueba |
|---|---|
| `test/mfplux.test.js` (nuevo) | Migración sin cambios en los negocios existentes; registro como barbería, salón, sin tipo y con tipo inválido; el tipo se conserva al confirmar el correo, iniciar y cerrar sesión; título y metadatos de `/b/…`; El Máster sin cambios; el Panel recibe el tipo; mismos planes y precios; mfplux.com con la página comercial, El Máster en su enlace y webhooks intactos; navegador: elección antes del formulario, «Cambiar», enlace con `?tipo=`, «Profesionales/Barberos» y título que se mantiene al recargar. |
| Pruebas existentes | Se actualizaron solo los textos de marca y el paso nuevo de elegir el tipo en los recorridos de registro. |

## Publicación (requiere tu autorización; no se ha hecho)

Antes de empezar, haz un respaldo de la base de producción (`scripts/respaldo/`).

### 1. Fusionar

1. Fusiona primero esta rama en `main` de El-Master-reservas-.
2. Después, la rama del Panel Maestro. El orden no rompe nada: cada lado ignora los datos nuevos del otro mientras no se actualiza.

### 2. Comprobar dónde está hoy la aplicación

En Render, servicio **El-Master-reservas-** → **Environment**, mira `PUBLIC_BASE_URL`.

- Si es la dirección `…onrender.com` (u otra distinta de `mfplux.com`), pasa al paso 3.
- Si es `https://mfplux.com`, primero hay que darle a la aplicación otra dirección. La recomendada es `https://reservas.mfplux.com`:
  1. En Render, **Settings → Custom Domains**, añade `reservas.mfplux.com`.
  2. Crea el registro DNS que Render indique (CNAME).
  3. Espera a que el certificado esté listo.
  4. Cambia `PUBLIC_BASE_URL=https://reservas.mfplux.com`.

  Mientras tanto, `mfplux.com` sigue funcionando como hoy. **No uses `app.mfplux.com`**: esa dirección queda reservada para el Panel Maestro, y si se usa para la aplicación, el sitio comercial no se activa.

### 3. Activar la página comercial en mfplux.com

En el servicio **El-Master-reservas-**:

| Variable | Valor |
|---|---|
| `SITIO_PUBLICO_DOMINIO` | `mfplux.com` |
| `SITIO_CONTACTO_EMAIL` | (opcional) el correo de contacto de MF Plux |
| `CORREO_REMITENTE` | (opcional) cambia solo el nombre visible a «MF Plux» y conserva la dirección verificada en Resend |

Guarda y despliega. Después de desplegar:

- **`mfplux.com/`** muestra la página comercial de MF Plux con los planes y «Crear mi cuenta». `www.mfplux.com` redirige a `mfplux.com`.
- **`mfplux.com/b/<dirección>/`**, `/acceso.html` y `/admin.html` redirigen (301) a la misma ruta en `PUBLIC_BASE_URL`. Los enlaces ya compartidos siguen funcionando.
- **El Máster:** su página de reservas sigue en `PUBLIC_BASE_URL` (la raíz `/`) y en `<PUBLIC_BASE_URL>/b/el-master/`. Comprueba en la base el valor real de `DEFAULT_BUSINESS_ID` o el `slug` de El Máster. `mfplux.com/b/el-master/` lleva allí. Quien tenga guardado `mfplux.com/` verá ahora la página comercial: comparte con los clientes de El Máster el enlace `mfplux.com/b/el-master/`.
- **Propietarios con la sesión abierta en `mfplux.com/admin.html`:** tendrán que iniciar sesión una vez en la dirección de la aplicación, porque la cookie es de cada dominio. Sus datos no cambian.
- **WhatsApp:** si el webhook de Meta apunta a `mfplux.com/webhooks/whatsapp`, sigue funcionando (está probado). Cuando quieras, cámbialo en Meta a `<PUBLIC_BASE_URL>/webhooks/whatsapp`.

### 4. Panel Maestro (sigue privado y aparte)

- **`RESERVAS_URL`** debe apuntar a la **aplicación** (`PUBLIC_BASE_URL`), **nunca a `mfplux.com`**. En el dominio principal, la API redirige, y el Panel rechaza las redirecciones por seguridad, así que la sincronización se detendría. Si hoy dice `https://mfplux.com`, cámbiala por la dirección de la aplicación en el mismo despliegue.
- (Opcional) `SITIO_PUBLICO_URL=https://mfplux.com`, para que los enlaces antiguos a `/registro` del Panel lleven a la página comercial.
- El Panel no se traslada a `mfplux.com` ni se enlaza desde allí.

### 5. Comprobación después de publicar

1. `mfplux.com` dice MF Plux, muestra los tres planes con los precios de siempre y «Crear mi cuenta» abre el registro con la elección Barbería o Salón de belleza.
2. La página de El Máster abre en su enlace, con sus servicios, barberos y reservas.
3. En el Panel Maestro, «Sincronizar ahora» funciona y Barberías muestra el tipo de los negocios nuevos.
4. Una reserva de prueba en una barbería existente.

### Cómo volver atrás

- **Página comercial:** borra `SITIO_PUBLICO_DOMINIO` (o ponle el valor anterior) y vuelve a desplegar. `mfplux.com` muestra de nuevo lo de antes.
- **Código:** vuelve a desplegar el commit anterior. La columna nueva queda sin uso y no hay que borrar nada.
