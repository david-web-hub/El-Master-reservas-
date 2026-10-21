'use strict';
/*
  SITIO PÚBLICO DE MF PLUX (lanzamiento).
  - Se sirve desde este mismo servicio cuando la petición llega por el dominio
    principal (SITIO_PUBLICO_DOMINIO, por ejemplo mfplux.com, y su www).
  - La aplicación de los negocios (acceso, panel de cada propietario, páginas
    de reservas, API) sigue en PUBLIC_BASE_URL, sin cambios.
  - app.<dominio> es el Panel Maestro (privado, otro servicio): el sitio nunca
    enlaza ni redirige allí; si PUBLIC_BASE_URL apuntara a esa dirección, el
    sitio no se activa.
  - Los planes salen del catálogo real (el que administra el Panel Maestro).
  - Nunca enlaza al Panel Maestro ni muestra datos de ningún negocio.
  - Barberías y salones de belleza usan la misma aplicación, planes y precios.
*/

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const precio = n => `$${Number(n).toFixed(2)}`;
const MARCA = 'MF Plux';

function normalizarDominio(v) {
  return String(v || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '').replace(/^www\./, '');
}

function hostDe(req) {
  return String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
}

/* Funciones que ya funcionan. WhatsApp/Elia, videos y pagos en línea no se anuncian todavía. */
const FUNCIONES = [
  ['Tu página de reservas', 'Un enlace propio para compartir: tus clientes eligen profesional, servicio, día y hora desde el teléfono, sin llamadas.'],
  ['Agenda en orden', 'Todas las reservas en un solo lugar, sin horarios duplicados ni citas que se crucen.'],
  ['Equipo y horarios', 'Cada barbero o profesional con sus días y horas de trabajo. Actívalos o desactívalos cuando lo necesites.'],
  ['Servicios y precios', 'Tu lista de servicios con su duración y precio, siempre actualizada en tu página.'],
  ['Caja y productos', 'Registra cobros y ventas del día y lleva el control de los productos que vendes.'],
  ['Clientes e informes', 'Conoce a tus clientes y revisa cómo va tu negocio con informes claros.'],
  ['Tu equipo, con permisos', 'Invita a administradores, recepción y profesionales; cada uno ve solo lo que le corresponde.'],
  ['Datos separados y seguros', 'Cada negocio accede únicamente a su información. Contraseñas cifradas y conexión segura.']
];

const PREGUNTAS = [
  ['¿Necesito tarjeta para empezar?', 'No. Creas tu cuenta y empiezas tu prueba gratuita sin ingresar ningún medio de pago.'],
  ['¿Sirve para salones de belleza?', 'Sí. Al crear tu cuenta eliges si tienes una barbería o un salón de belleza. Los dos usan la misma aplicación, con los mismos planes, precios y funciones.'],
  ['¿Qué pasa cuando termina la prueba?', 'Tus datos, tu equipo y tus reservas se conservan. Para seguir recibiendo reservas nuevas, nuestro equipo activa tu plan contigo; no hay cobros automáticos.'],
  ['¿Puedo cambiar de plan?', 'Sí. Desde la sección Planes de tu panel solicitas el cambio y nuestro equipo lo confirma. Nunca se borra nada al cambiar.'],
  ['¿Funciona en el celular?', 'Sí. Tanto tu página de reservas como tu panel de administración están pensados para usarse desde el teléfono o la computadora.']
];

const ESTILO = `
:root{--gold:#d4af37;--gold2:#f4c94d;--bg:#080808;--card:#141414;--text:#f5f5f5;--muted:rgba(255,255,255,.66);--line:rgba(255,255,255,.12);--r:16px;--font:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{font-family:var(--font);background:var(--bg);color:var(--text);line-height:1.55;-webkit-text-size-adjust:100%}
a{color:inherit}
.wrap{max-width:1080px;margin:0 auto;padding:0 16px}
header{position:sticky;top:0;z-index:10;background:rgba(8,8,8,.9);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
header .wrap{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:60px}
.logo{display:flex;align-items:center;gap:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;text-decoration:none;color:var(--gold);font-size:17px;white-space:nowrap}
.logo b{display:grid;place-items:center;width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,var(--gold2),#9d7511);color:#111;font-size:18px}
nav{display:flex;align-items:center;gap:6px}
nav a{text-decoration:none;font-size:14px;padding:8px 10px;border-radius:10px;color:var(--muted);white-space:nowrap}
nav a:hover{color:var(--text)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:0;border-radius:12px;padding:14px 22px;font-weight:800;font-size:16px;text-decoration:none;cursor:pointer;background:linear-gradient(135deg,var(--gold2),var(--gold));color:#111}
.btn.ghost{background:transparent;color:var(--text);border:1px solid var(--line)}
.btn.small{padding:9px 14px;font-size:14px}
.hero{padding:72px 0 56px;background:radial-gradient(900px 400px at 80% -10%,rgba(212,175,55,.18),transparent 70%)}
.hero h1{font-size:clamp(34px,7vw,58px);line-height:1.06;font-weight:800;max-width:17ch}
.hero h1 em{font-style:normal;color:var(--gold)}
.hero p{color:var(--muted);font-size:clamp(17px,2.4vw,20px);max-width:56ch;margin:18px 0 28px}
.cta{display:flex;flex-wrap:wrap;gap:12px;align-items:center}
.nota{color:var(--muted);font-size:14px;margin-top:14px}
section{padding:56px 0;border-top:1px solid var(--line)}
h2{font-size:clamp(26px,4vw,34px);line-height:1.15;margin-bottom:10px}
.lead{color:var(--muted);max-width:60ch;margin-bottom:26px}
.grid{display:grid;gap:14px}
.g3{grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
.g4{grid-template-columns:repeat(auto-fit,minmax(230px,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:20px}
.card h3{font-size:17px;margin-bottom:6px}
.card p{color:var(--muted);font-size:15px}
.paso b{display:inline-grid;place-items:center;width:32px;height:32px;border-radius:50%;background:rgba(212,175,55,.15);color:var(--gold);margin-bottom:10px}
.plan{display:flex;flex-direction:column;gap:6px}
.plan.destacado{border-color:var(--gold)}
.plan .precio{font-size:36px;font-weight:800}
.plan .precio small{font-size:15px;font-weight:600;color:var(--muted)}
.plan ul{list-style:none;color:var(--muted);font-size:15px;margin:6px 0 14px;display:grid;gap:4px}
.plan ul li::before{content:"✓ ";color:var(--gold)}
.plan .btn{margin-top:auto}
details{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:16px 18px}
details+details{margin-top:10px}
summary{cursor:pointer;font-weight:700}
details p{color:var(--muted);margin-top:8px}
footer{border-top:1px solid var(--line);padding:36px 0 48px;color:var(--muted);font-size:14px}
footer .wrap{display:grid;gap:14px}
footer nav{flex-wrap:wrap;gap:4px 14px}
footer nav a{padding:0}
.legal h1{font-size:clamp(28px,5vw,40px);margin:40px 0 6px}
.legal h2{font-size:20px;margin:26px 0 6px}
.legal p,.legal li{color:var(--muted);max-width:75ch}
.legal ul{padding-left:20px;display:grid;gap:4px}
.legal .fecha{color:var(--muted);font-size:14px;margin-bottom:10px}
@media (max-width:640px){nav .op{display:none}header .logo{font-size:14px;gap:8px}nav a{padding:8px 6px;font-size:13px}.btn.small{padding:8px 10px}.hero{padding:44px 0 40px}section{padding:44px 0}}
`;

const ICONO = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23d4af37'/%3E%3Ctext x='32' y='44' font-size='34' text-anchor='middle' fill='%23111' font-family='Arial' font-weight='700'%3EM%3C/text%3E%3C/svg%3E";

function crearSitioPublico({ dominio, appUrl, catalogo, registroAbierto, contacto = {}, registro = console }) {
  const principal = normalizarDominio(dominio);
  const base = String(appUrl || '').replace(/\/+$/, '');
  let hostApp = '';
  try { hostApp = new URL(base).host.toLowerCase(); } catch { /* sin dirección de la aplicación */ }

  let motivo = null;
  if (!principal) motivo = 'SITIO_PUBLICO_DOMINIO no está definido';
  else if (!base || !hostApp) motivo = 'PUBLIC_BASE_URL no está definido: el sitio no sabría a dónde enviar a los visitantes';
  else if (hostApp.replace(/:\d+$/, '').replace(/^www\./, '') === principal) {
    motivo = `PUBLIC_BASE_URL (${hostApp}) usa el mismo dominio que el sitio público; la aplicación de las barberías debe estar en otra dirección`;
  } else if (hostApp.replace(/:\d+$/, '') === 'app.' + principal) {
    /* app.<dominio> es el Panel Maestro (privado): el sitio público nunca envía visitantes allí. */
    motivo = `PUBLIC_BASE_URL (${hostApp}) es la dirección del Panel Maestro; el sitio público solo puede enlazar a la aplicación de las barberías`;
  }
  const activo = !motivo;
  if (dominio && motivo) registro.error('SITIO PÚBLICO DESACTIVADO:', motivo);
  if (activo) registro.log(`SITIO PÚBLICO: https://${principal} (aplicación en ${base})`);

  const urlSitio = `https://${principal}`;
  const enlaceRegistro = plan => `${base}/acceso.html${plan ? '?plan=' + encodeURIComponent(plan) : ''}#registro`;
  const enlaceAcceso = `${base}/acceso.html`;
  const correo = String(contacto.email || '').trim();
  const whatsapp = String(contacto.whatsapp || '').replace(/[^\d]/g, '');

  async function planesActivos() {
    try {
      return (await catalogo()).filter(p => p.active);
    } catch (error) {
      registro.error('SITIO PÚBLICO: no se pudo leer el catálogo:', error.message);
      return [];
    }
  }

  function pie() {
    const contactos = [
      correo ? `<a href="mailto:${esc(correo)}">${esc(correo)}</a>` : '',
      whatsapp ? `<a href="https://wa.me/${esc(whatsapp)}" rel="noopener">WhatsApp +${esc(whatsapp)}</a>` : ''
    ].filter(Boolean).join(' · ');
    return `<footer><div class="wrap">
      <a class="logo" href="/"><b>M</b>${MARCA}</a>
      ${contactos ? `<p>Contacto: ${contactos}</p>` : ''}
      <nav aria-label="Enlaces legales"><a href="/privacidad">Privacidad</a><a href="/condiciones">Condiciones de uso</a><a href="${esc(enlaceAcceso)}">Iniciar sesión</a></nav>
      <p>© ${new Date().getFullYear()} ${MARCA}. Todos los derechos reservados.</p>
    </div></footer>`;
  }

  function documento({ titulo, descripcion, ruta, cuerpo, extraHead = '' }) {
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(titulo)}</title>
<meta name="description" content="${esc(descripcion)}">
<meta name="robots" content="index, follow">
<link rel="canonical" href="${esc(urlSitio + ruta)}">
<meta name="theme-color" content="#080808">
<link rel="icon" href="${ICONO}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${MARCA}">
<meta property="og:locale" content="es_EC">
<meta property="og:title" content="${esc(titulo)}">
<meta property="og:description" content="${esc(descripcion)}">
<meta property="og:url" content="${esc(urlSitio + ruta)}">
<meta name="twitter:card" content="summary">
${extraHead}
<style>${ESTILO}</style>
</head>
<body>
<header><div class="wrap">
  <a class="logo" href="/" aria-label="${MARCA}, inicio"><b>M</b>${MARCA}</a>
  <nav aria-label="Principal">
    <a class="op" href="/#funciones">Funciones</a>
    <a class="op" href="/#planes">Planes</a>
    <a href="${esc(enlaceAcceso)}" id="iniciarSesion">Iniciar sesión</a>
    <a class="btn small" href="/#planes">Crear mi cuenta</a>
  </nav>
</div></header>
<main>${cuerpo}</main>
${pie()}
</body>
</html>`;
  }

  async function inicio() {
    const planes = await planesActivos();
    const abierto = registroAbierto();
    const dias = [...new Set(planes.map(p => p.trialDays).filter(d => d > 0))];
    const textoPrueba = dias.length === 1 ? `${dias[0]} días de prueba gratis` : dias.length ? 'Prueba gratis' : '';
    const barberos = n => n == null ? 'Profesionales sin límite' : n === 1 ? '1 barbero o profesional' : `Hasta ${n} barberos o profesionales`;

    const tarjetas = planes.map((p, i) => `
      <article class="card plan${i === 1 && planes.length > 2 ? ' destacado' : ''}" data-plan="${esc(p.name)}">
        <h3>${esc(p.name)}</h3>
        <div class="precio">${precio(p.price)}<small> /mes</small></div>
        <ul>
          <li>${esc(barberos(p.maxBarbers))}</li>
          ${p.trialDays > 0 ? `<li>${p.trialDays} días de prueba gratis</li>` : ''}
          <li>Página de reservas propia</li>
          <li>Agenda, caja, clientes e informes</li>
        </ul>
        ${abierto
          ? `<a class="btn" href="${esc(enlaceRegistro(p.name))}">Crear mi cuenta</a>`
          : '<span class="btn ghost" aria-disabled="true">Muy pronto</span>'}
      </article>`).join('');

    const descripcion = `${MARCA} es la plataforma de reservas en línea y administración para barberías y salones de belleza: página de reservas propia, agenda, equipo, caja y clientes.${textoPrueba ? ' ' + textoPrueba + ', sin tarjeta.' : ''}`;
    const datos = {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: MARCA,
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Web',
      url: urlSitio + '/',
      description: descripcion,
      ...(planes.length ? { offers: planes.map(p => ({ '@type': 'Offer', name: p.name, price: Number(p.price).toFixed(2), priceCurrency: 'USD' })) } : {})
    };

    const cuerpo = `
<section class="hero" style="border-top:0"><div class="wrap">
  <h1>Las reservas de tu barbería o salón, <em>simples y en orden.</em></h1>
  <p>${MARCA} le da a tu barbería o salón de belleza una página de reservas propia y un panel para administrar agenda, equipo, servicios, caja y clientes. Desde el celular o la computadora.</p>
  <div class="cta">
    ${abierto ? '<a class="btn" href="#planes" id="crearBarberia">Crear mi cuenta</a>' : '<a class="btn" href="#planes" id="crearBarberia">Ver planes</a>'}
    <a class="btn ghost" href="${esc(enlaceAcceso)}">Iniciar sesión</a>
  </div>
  <p class="nota">${abierto ? `${textoPrueba ? esc(textoPrueba) + ' · ' : ''}Sin tarjeta · Sin cobros automáticos` : 'El registro de nuevos negocios abrirá muy pronto.'}</p>
</div></section>

<section><div class="wrap">
  <h2>Empieza en minutos</h2>
  <p class="lead">Sin instalar nada. Creas tu cuenta, configuras tu negocio y compartes tu enlace.</p>
  <div class="grid g3">
    <div class="card paso"><b>1</b><h3>Crea tu cuenta</h3><p>Elige si tienes una barbería o un salón de belleza, tu plan y el nombre de tu negocio, y confirma tu correo.</p></div>
    <div class="card paso"><b>2</b><h3>Configúralo</h3><p>Agrega tus servicios, precios, tu equipo y tus horarios de atención.</p></div>
    <div class="card paso"><b>3</b><h3>Comparte tu enlace</h3><p>Tus clientes reservan solos en tu página; tú ves cada cita en tu agenda.</p></div>
  </div>
</div></section>

<section id="funciones"><div class="wrap">
  <h2>Todo lo que tu negocio necesita</h2>
  <p class="lead">Reservas en línea y administración del día a día en una sola plataforma.</p>
  <div class="grid g4">${FUNCIONES.map(([t, d]) => `<div class="card"><h3>${esc(t)}</h3><p>${esc(d)}</p></div>`).join('')}</div>
</div></section>

<section id="planes"><div class="wrap">
  <h2>Planes</h2>
  <p class="lead">Elige el plan según el tamaño de tu equipo. ${textoPrueba ? esc(textoPrueba) + ' en todos los planes. ' : ''}Precios en dólares, por mes.</p>
  ${tarjetas ? `<div class="grid g3">${tarjetas}</div>` : '<div class="card"><p>Los planes estarán disponibles muy pronto.</p></div>'}
  <p class="nota">Por ahora no hay cobros en línea: al terminar tu prueba, nuestro equipo te ayuda a activar tu plan.</p>
</div></section>

<section id="preguntas"><div class="wrap">
  <h2>Preguntas frecuentes</h2>
  ${PREGUNTAS.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}
</div></section>`;

    return documento({
      titulo: `${MARCA} | Reservas en línea y administración para barberías y salones de belleza`,
      descripcion,
      ruta: '/',
      cuerpo,
      extraHead: `<script type="application/ld+json">${JSON.stringify(datos).replace(/</g, '\\u003c')}</script>`
    });
  }

  const FECHA_LEGAL = '21 de octubre de 2026';
  const contactoLegal = correo ? `escribiendo a <a href="mailto:${esc(correo)}">${esc(correo)}</a>` : 'mediante los canales de contacto indicados en esta página';

  function privacidad() {
    return documento({
      titulo: `Política de privacidad | ${MARCA}`,
      descripcion: `Cómo ${MARCA} trata los datos de los negocios (barberías y salones de belleza) y de sus clientes.`,
      ruta: '/privacidad',
      cuerpo: `<div class="wrap legal">
<h1>Política de privacidad</h1>
<p class="fecha">Última actualización: ${FECHA_LEGAL}</p>
<p>${MARCA} es una plataforma que permite a las barberías y los salones de belleza recibir reservas en línea y administrar su negocio. Esta política explica qué datos tratamos y con qué fin.</p>
<h2>1. Datos que tratamos</h2>
<ul>
<li>De las personas que crean un negocio: nombre, correo electrónico, nombre y tipo del negocio y los datos que configuren (servicios, horarios, equipo, precios).</li>
<li>De los clientes que reservan en la página de un negocio: nombre, teléfono y los datos de la cita (servicio, profesional, fecha y hora).</li>
<li>Datos técnicos necesarios para la seguridad, como la dirección IP y registros de acceso.</li>
</ul>
<h2>2. Para qué los usamos</h2>
<ul>
<li>Crear y administrar las cuentas, los negocios y sus reservas.</li>
<li>Enviar correos necesarios para el servicio, como la confirmación de la cuenta o el cambio de contraseña.</li>
<li>Proteger la plataforma y evitar usos indebidos.</li>
</ul>
<h2>3. Quién ve los datos</h2>
<p>Cada negocio accede únicamente a su propia información y a las reservas de sus clientes. No vendemos datos personales. Usamos proveedores tecnológicos para alojar la aplicación, la base de datos y el envío de correos, solo en la medida necesaria para prestar el servicio.</p>
<h2>4. Conservación</h2>
<p>Conservamos los datos mientras la cuenta esté activa y el tiempo razonable necesario para cumplir obligaciones aplicables. Al terminar una prueba o una suscripción, los datos del negocio se conservan para que pueda reactivarla, salvo que solicite su eliminación.</p>
<h2>5. Seguridad</h2>
<p>Las contraseñas se guardan cifradas, las conexiones usan HTTPS y el acceso a cada negocio está separado. Ningún sistema es completamente infalible, pero aplicamos medidas razonables para proteger la información.</p>
<h2>6. Derechos</h2>
<p>Puedes solicitar acceso, corrección o eliminación de tus datos ${contactoLegal}. Si reservaste en un negocio, también puedes pedírselo directamente a ese negocio.</p>
<h2>7. Cambios</h2>
<p>Podemos actualizar esta política; la fecha de actualización se indica al inicio.</p>
</div>`
    });
  }

  function condiciones() {
    return documento({
      titulo: `Condiciones de uso | ${MARCA}`,
      descripcion: `Condiciones para usar ${MARCA}, la plataforma de reservas para barberías y salones de belleza.`,
      ruta: '/condiciones',
      cuerpo: `<div class="wrap legal">
<h1>Condiciones de uso</h1>
<p class="fecha">Última actualización: ${FECHA_LEGAL}</p>
<h2>1. El servicio</h2>
<p>${MARCA} ofrece a las barberías y los salones de belleza una página de reservas en línea y herramientas de administración (agenda, equipo, servicios, caja, productos, clientes e informes).</p>
<h2>2. Cuenta</h2>
<p>Quien crea un negocio es responsable de la veracidad de sus datos, de mantener su contraseña en secreto y de las personas que invite a su equipo.</p>
<h2>3. Prueba gratuita, planes y pagos</h2>
<ul>
<li>Cada negocio nuevo empieza con una prueba gratuita por los días indicados en su plan. No se solicita medio de pago ni se realizan cobros automáticos.</li>
<li>Al terminar la prueba, el negocio conserva sus datos, pero no recibe reservas nuevas hasta que su plan sea activado por nuestro equipo.</li>
<li>Cada plan permite un número máximo de barberos o profesionales activos. Los cambios de plan se solicitan desde el panel y se aplican cuando nuestro equipo los aprueba.</li>
</ul>
<h2>4. Uso adecuado</h2>
<p>No está permitido usar la plataforma para fines ilegales, para enviar información falsa o para intentar acceder a datos de otros negocios. Podemos suspender cuentas que incumplan estas condiciones.</p>
<h2>5. Datos de los clientes</h2>
<p>Cada negocio es responsable del uso que hace de los datos de sus clientes. ${MARCA} los trata según su <a href="/privacidad">política de privacidad</a>.</p>
<h2>6. Disponibilidad</h2>
<p>Trabajamos para que el servicio esté disponible de forma continua, pero puede haber interrupciones por mantenimiento o causas ajenas a nosotros.</p>
<h2>7. Contacto</h2>
<p>Para cualquier consulta sobre estas condiciones, comunícate con nosotros ${contactoLegal}.</p>
</div>`
    });
  }

  function robots() {
    return `User-agent: *\nAllow: /\n\nSitemap: ${urlSitio}/sitemap.xml\n`;
  }

  function sitemap() {
    const urls = ['/', '/privacidad', '/condiciones'];
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `  <url><loc>${urlSitio}${u}</loc></url>`).join('\n')}\n</urlset>\n`;
  }

  /* Middleware: solo actúa en el dominio principal (y su www). */
  function middleware(req, res, next) {
    if (!activo) return next();
    const host = hostDe(req);
    if (host !== principal && host !== 'www.' + principal) return next();
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'SAMEORIGIN' });
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') res.set('Strict-Transport-Security', 'max-age=15552000');
    if (host !== principal) return res.redirect(301, urlSitio + req.originalUrl);
    /* Salud y webhooks (WhatsApp) siguen llegando a la aplicación aunque usen el dominio principal. */
    if (req.path === '/api/health' || req.path.startsWith('/webhooks/')) return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(404).json({ ok: false, error: 'No encontrado' });

    const html = (contenido, segundos = 300) => {
      res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': `public, max-age=${segundos}` });
      res.send(contenido);
    };
    const paginas = {
      '/': async () => html(await inicio(), 60),
      '/privacidad': () => html(privacidad()),
      '/condiciones': () => html(condiciones()),
      '/robots.txt': () => res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(robots()),
      '/sitemap.xml': () => res.type('application/xml').set('Cache-Control', 'public, max-age=3600').send(sitemap())
    };
    const pagina = paginas[req.path];
    if (pagina) return Promise.resolve(pagina()).catch(next);
    /* Cualquier otra dirección (acceso, paneles, reservas, /b/…) está en la aplicación: por ejemplo, la página de El Máster en /b/el-master/. */
    return res.redirect(301, base + req.originalUrl);
  }

  return { activo, motivo, dominio: principal, middleware, inicio, privacidad, condiciones, robots, sitemap };
}

module.exports = { crearSitioPublico, normalizarDominio };
