# Lanzamiento público de Master Plus

## Arquitectura

| Dirección | Servicio de Render | Qué muestra |
|---|---|---|
| `masterfadeplus.com` | **El Máster Reservas**, el mismo servicio de siempre | Página pública de Master Plus, `/privacidad`, `/condiciones`, `/robots.txt` y `/sitemap.xml` |
| `www.masterfadeplus.com` | El Máster Reservas | Redirige (301) a `masterfadeplus.com` |
| Dirección actual de El Máster Reservas (`PUBLIC_BASE_URL`, sin cambios) | El Máster Reservas | La aplicación de las barberías: acceso y registro (`/acceso.html`), panel de cada propietario, páginas de reservas `/b/<dirección>/` y la página de El Máster en `/`. Más adelante puede tener un subdominio propio, como `reservas.masterfadeplus.com`, si lo confirman |
| `app.masterfadeplus.com` | **Panel Maestro V3**, servicio aparte, sin cambios | Administración privada, solo para los administradores de Master Plus. Las cuentas de las barberías no sirven allí. El sitio público nunca lo enlaza ni redirige a él, y ningún buscador lo indexa |

- **No hace falta un servicio nuevo.** El Máster Reservas responde con la página pública solo cuando la petición llega por `SITIO_PUBLICO_DOMINIO`.
- En el dominio principal, cualquier otra dirección, como `/acceso.html`, `/admin.html` o `/b/...`, redirige a la misma ruta en `PUBLIC_BASE_URL`. Así nunca se sirve nada privado desde `masterfadeplus.com`.
- Si `PUBLIC_BASE_URL` usa el mismo dominio que el sitio público, el sitio **no se activa** y se avisa en el registro del servidor. Así no reemplaza la página de reservas de El Máster.

## Recorrido de un visitante
1. Abre `masterfadeplus.com`, pulsa «Crear mi barbería» y elige un plan.
2. Llega a `<El Máster Reservas>/acceso.html?plan=<Plan>#registro`, el registro de siempre con el plan ya elegido.
3. Confirma su correo y entra a su panel. Solo ve su propia barbería y tiene 7 días de prueba (los días que indique el catálogo).
4. Configura horarios, servicios y barberos, y copia su enlace público en **Configuración → Tu página de reservas**.
5. Sus clientes reservan en `<El Máster Reservas>/b/<dirección>/`.

## Lo que se muestra y lo que no
- **Planes:** salen del catálogo real que administra el Panel Maestro, con precio, límite de barberos y días de prueba. Los cambios se ven en un minuto como máximo y los planes inactivos no se muestran.
- **Funciones anunciadas:** solo las que ya funcionan.
  - Página de reservas, agenda, barberos y horarios, servicios, caja y productos, clientes e informes, equipo con permisos.
  - No se anuncian **WhatsApp/Elia**, los **videos** ni los **pagos en línea**.
- **Pagos:** no se simula ningún pago ni hay cobros automáticos. El sitio lo dice tal cual: al terminar la prueba, el equipo activa el plan.
- **Al terminar la prueba:**
  - la barbería conserva sus datos y sus reservas, pero no recibe reservas nuevas;
  - su plan no cambia;
  - puede solicitar un plan, que queda pendiente hasta que el Panel Maestro lo apruebe (flujo de la fase 9).
- **Si el registro está cerrado** (`REGISTRO_ABIERTO` distinto de `1`, o correo sin configurar): la página muestra «Muy pronto» en lugar de «Crear mi barbería».

## Buscadores
- **Sitio público:**
  - título, descripción, `canonical`, Open Graph, `lang="es"` y datos estructurados (`SoftwareApplication` con los precios);
  - `robots.txt` lo permite todo e indica el sitemap;
  - `sitemap.xml` incluye `/`, `/privacidad` y `/condiciones`.
- **Aplicación:**
  - las páginas de reservas se pueden indexar;
  - `/acceso.html`, `/admin.html`, `/salir.html`, `/api/*` y `/webhooks/*` envían `X-Robots-Tag: noindex, nofollow`;
  - `robots.txt` excluye `/api/`.
- **Panel Maestro:** todas sus respuestas llevan `X-Robots-Tag: noindex, nofollow` y su `robots.txt` lo excluye todo (`Disallow: /`).

## Variables nuevas (El Máster Reservas)

| Variable | Valor | Obligatoria |
|---|---|---|
| `SITIO_PUBLICO_DOMINIO` | `masterfadeplus.com` | Sí, para activar el sitio |
| `PUBLIC_BASE_URL` | **No se cambia.** Sigue siendo la dirección actual de El Máster Reservas. **Nunca** `app.masterfadeplus.com`: es el Panel Maestro, y si se pone allí el sitio no se activa | Ya existe |
| `SITIO_CONTACTO_EMAIL` | Correo público de contacto, por ejemplo `hola@masterfadeplus.com` | Sí, para el lanzamiento |
| `SITIO_CONTACTO_WHATSAPP` | Número con código de país, solo dígitos | Opcional |

Si más adelante se da a El Máster Reservas un subdominio propio, se agrega como dominio del servicio y se cambia `PUBLIC_BASE_URL`. La dirección anterior sigue funcionando, así que los enlaces ya compartidos no se rompen.

## Pasos en Render (manuales, después de confirmar)
1. **Copia de seguridad:** exporta la base de datos de El Máster Reservas antes de nada.
2. **Dominios:** en el servicio **El Máster Reservas → Settings → Custom Domains → Add Custom Domain**, agrega:
   - `masterfadeplus.com`;
   - `www.masterfadeplus.com`.

   Render muestra el registro DNS de cada uno: cópialo tal cual (ver la sección siguiente).
3. **Variables:** en **Environment**, define `SITIO_PUBLICO_DOMINIO` y `SITIO_CONTACTO_EMAIL`. **No cambies `PUBLIC_BASE_URL`.** Guarda **sin desplegar todavía** (Save only).
4. **Despliegue:** **Manual Deploy → Deploy latest commit** de El Máster Reservas. Después, el del Panel Maestro.
5. **Registro:** cuando el correo de Resend esté verificado, `REGISTRO_ABIERTO=1` abre el registro. Mientras no lo esté, la página muestra «Muy pronto».
6. **Panel Maestro:** no se toca. Sigue en `app.masterfadeplus.com`, con su servicio, su base de datos y sus administradores. Su `RESERVAS_URL` tampoco cambia.

## DNS (en el registrador del dominio o en Cloudflare)

| Tipo | Nombre | Valor |
|---|---|---|
| `A` | `@` (masterfadeplus.com) | La IP que indique Render para dominios raíz. Hoy es `216.24.57.1`, pero usa la que muestre Render. Si el proveedor admite `ALIAS`/`ANAME`/CNAME en la raíz, usa `<tu-servicio>.onrender.com` |
| `CNAME` | `www` | `<tu-servicio>.onrender.com` (el servicio de **El Máster Reservas**, no el del Panel) |

- **No toques el registro `app`**: es el Panel Maestro.
- Borra cualquier registro `AAAA` o `A` anterior de `@` y `www` que apunte a otro sitio, por ejemplo la página de aparcamiento del registrador.
- En Cloudflare, deja estos registros en **DNS only** (nube gris) hasta que Render emita los certificados.
- No toques los registros de correo de Resend (DKIM, SPF, MX).
- En Render, espera a que cada dominio diga **Verified** y **Certificate Issued**.

## Google Search Console
1. Entra en https://search.google.com/search-console y pulsa **Agregar propiedad → Dominio → `masterfadeplus.com`**.
2. Google te da un registro `TXT` (`google-site-verification=…`). Agrégalo en el DNS (nombre `@`) y pulsa **Verificar**. Puede tardar unos minutos.
3. En **Sitemaps**, envía `https://masterfadeplus.com/sitemap.xml`.
4. En **Inspección de URLs**, escribe `https://masterfadeplus.com/` y pulsa **Solicitar indexación**.

Google tarda de días a semanas en mostrar el sitio. Revisa **Páginas** en Search Console para ver el avance.
