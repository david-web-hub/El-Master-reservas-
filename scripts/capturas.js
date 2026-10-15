#!/usr/bin/env node
'use strict';
/*
  Capturas de pantalla para comprobar que el diseño no cambia.

  Capturar (servidor aislado, datos de ejemplo, WhatsApp en modo demostración):
    node scripts/capturas.js capturar <carpeta>
  Comparar dos capturas, píxel a píxel:
    node scripts/capturas.js comparar <carpetaAntes> <carpetaDespués> [umbral%]

  Requiere Playwright con Chromium (CHROMIUM_PATH opcional). Si existe
  TEST_DATABASE_URL, el panel se captura con PostgreSQL de pruebas.
  Comparar solo tiene sentido con capturas tomadas en la misma máquina.
*/
const fs = require('node:fs');
const path = require('node:path');
const { iniciarServidor, urlBasePruebas } = require('../test/apoyo/servidor');

async function abrirNavegador() {
  const navegador = await require('../test/apoyo/navegador').abrirNavegador();
  if (!navegador) throw new Error('No se encontró Playwright con Chromium. Instálalo con: npm i --no-save playwright-core');
  return navegador;
}

const FECHA_FIJA = new Date('2026-10-14T15:00:00Z');
const PANEL = ['inicio', 'reservas', 'caja', 'productos', 'clientes', 'informes', 'configuracion'];
const AJUSTES = ['negocio', 'barberos', 'horarios', 'pagos', 'mensajes', 'pagina', 'multimedia', 'apariencia', 'notificaciones', 'datos', 'avanzada'];
/* Pantallas nuevas: solo se capturan en las versiones que las tienen. */
const AJUSTES_NUEVOS = ['cuenta', 'usuarios', 'enlace', 'whatsapp'];
const PANTALLAS = [{ nombre: 'escritorio', width: 1366, height: 900 }, { nombre: 'movil', width: 390, height: 844 }];

async function capturar(destino) {
  fs.mkdirSync(destino, { recursive: true });
  const servidor = await iniciarServidor({ postgres: Boolean(urlBasePruebas()) });
  const navegador = await abrirNavegador();
  const hechas = [];
  try {
    for (const p of PANTALLAS) {
      const opcionesCtx = { viewport: { width: p.width, height: p.height }, locale: 'es-EC', timezoneId: 'America/Guayaquil', reducedMotion: 'reduce' };
      const ctx = await navegador.newContext(opcionesCtx);
      /* Versiones con cuentas: el panel se captura con la sesión del propietario de prueba. */
      if (servidor.cookie) {
        const [name, value] = servidor.cookie.split('=');
        await ctx.addCookies([{ name, value, url: servidor.base }]);
      }
      const page = await ctx.newPage();
      await page.clock.setFixedTime(FECHA_FIJA);
      const guardar = async (nombre, pagina = page) => {
        await pagina.waitForTimeout(400);
        /* Datos que cambian en cada ejecución (correo aleatorio de la cuenta de prueba y hora de acceso): se fijan. */
        await pagina.evaluate(() => {
          const fijar = t => t
            .replace(/propietario-[a-z0-9-]+@prueba\.test/g, 'propietario@prueba.test')
            .replace(/http:\/\/127\.0\.0\.1:\d+/g, 'http://127.0.0.1:10000')
            .replace(/\d{1,2}\/\d{1,2}\/\d{4},? \d{1,2}:\d{2}(:\d{2})?( [ap]\. ?m\.)?/g, '14/10/2026, 10:00:00 a. m.');
          const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          for (let n = w.nextNode(); n; n = w.nextNode()) { const v = fijar(n.nodeValue); if (v !== n.nodeValue) n.nodeValue = v; }
          document.querySelectorAll('input').forEach(i => { const v = fijar(i.value); if (v !== i.value) i.value = v; });
        });
        const archivo = path.join(destino, `${p.nombre}-${nombre}.png`);
        await pagina.screenshot({ path: archivo, fullPage: true, animations: 'disabled' });
        hechas.push(archivo);
      };

      await page.goto(servidor.base + '/', { waitUntil: 'networkidle' });
      await guardar('publica');

      await page.goto(servidor.base + '/admin.html', { waitUntil: 'networkidle' });
      for (const id of PANEL) {
        await page.evaluate(id => window.goTo(id), id);
        await guardar(`panel-${id}`);
      }
      for (const id of AJUSTES) {
        await page.evaluate(id => { window.goTo('configuracion'); window.openSetting(id); }, id);
        await page.waitForLoadState('networkidle');
        await guardar(`ajustes-${id}`);
      }
      for (const id of AJUSTES_NUEVOS) {
        const existe = await page.evaluate(id => typeof settings !== 'undefined' && settings.some(s => s[0] === id), id);
        if (!existe) continue;
        await page.evaluate(id => { window.goTo('configuracion'); window.openSetting(id); }, id);
        await page.waitForLoadState('networkidle');
        await guardar(`ajustes-${id}`);
      }

      /* Pantalla de acceso (sin sesión), si la versión la tiene. */
      const anonimo = await navegador.newContext(opcionesCtx);
      const acceso = await anonimo.newPage();
      const r = await acceso.goto(servidor.base + '/acceso.html', { waitUntil: 'load' });
      if (r && r.status() === 200) {
        await acceso.waitForTimeout(300);
        await guardar('acceso-login', acceso);
        await acceso.click('[data-ir=registro]');
        await guardar('acceso-registro', acceso);
      }
      await anonimo.close();
      await ctx.close();
    }
  } finally {
    await navegador.close();
    await servidor.detener();
    servidor.borrar();
  }
  console.log(`${hechas.length} capturas en ${destino}`);
}

/*
  Cambios de diseño aprobados (archivo JSON):
  [{ "patron": "regex", "region": [x, y, ancho, alto|null], "motivo": "..." }  -> solo puede cambiar esa zona
   { "patron": "regex", "completo": true, "motivo": "..." }]                  -> pantalla rediseñada a propósito
  Cualquier otra diferencia hace fallar la comparación.
*/
function leerEsperados(archivo) {
  if (!archivo) return [];
  return JSON.parse(fs.readFileSync(archivo, 'utf8')).map(e => ({ ...e, rx: new RegExp(e.patron) }));
}

async function comparar(a, b, umbral, archivoEsperados) {
  const esperados = leerEsperados(archivoEsperados);
  const navegador = await abrirNavegador();
  const page = await navegador.newPage();
  let fallos = 0;
  const archivos = fs.readdirSync(a).filter(f => f.endsWith('.png')).sort();
  for (const f of archivos) {
    const otra = path.join(b, f);
    if (!fs.existsSync(otra)) { console.log(`FALTA  ${f}`); fallos++; continue; }
    const regla = esperados.find(e => e.rx.test(f));
    if (regla && regla.completo) {
      console.log(`CAMBIO APROBADO ${f}: ${regla.motivo}`);
      continue;
    }
    const uri = x => 'data:image/png;base64,' + fs.readFileSync(x).toString('base64');
    const r = await page.evaluate(async ([x, y, region]) => {
      const cargar = src => new Promise((ok, mal) => { const i = new Image(); i.onload = () => ok(i); i.onerror = mal; i.src = src; });
      const [i1, i2] = await Promise.all([cargar(x), cargar(y)]);
      if (i1.width !== i2.width || i1.height !== i2.height) return { tam: `${i1.width}x${i1.height} → ${i2.width}x${i2.height}` };
      const datos = img => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0); return g.getImageData(0, 0, img.width, img.height).data; };
      const d1 = datos(i1); const d2 = datos(i2);
      const dentro = (px, py) => region && px >= region[0] && py >= region[1] &&
        px < region[0] + region[2] && (region[3] === null || py < region[1] + region[3]);
      let dif = 0;
      let difZona = 0;
      for (let k = 0; k < d1.length; k += 4) {
        const distinto = Math.abs(d1[k] - d2[k]) + Math.abs(d1[k + 1] - d2[k + 1]) + Math.abs(d1[k + 2] - d2[k + 2]) > 30;
        if (!distinto) continue;
        const px = (k / 4) % i1.width;
        const py = Math.floor(k / 4 / i1.width);
        if (dentro(px, py)) difZona++; else dif++;
      }
      return { pct: (dif * 100) / (d1.length / 4), zona: difZona };
    }, [uri(path.join(a, f)), uri(otra), regla ? regla.region : null]);
    if (r.tam) { console.log(`TAMAÑO ${f}: ${r.tam}`); fallos++; continue; }
    const ok = r.pct <= umbral;
    if (!ok) fallos++;
    const nota = regla && r.zona ? ` · cambio aprobado en la zona (${regla.motivo})` : '';
    console.log(`${ok ? 'IGUAL ' : 'DISTINTA'} ${f}: ${r.pct.toFixed(3)}% de píxeles distintos fuera de zonas aprobadas${nota}`);
  }
  const nuevas = fs.readdirSync(b).filter(f => f.endsWith('.png') && !archivos.includes(f));
  for (const f of nuevas) console.log(`NUEVA  ${f}`);
  await navegador.close();
  console.log(fallos ? `${fallos} capturas con diferencias no aprobadas` : 'Sin diferencias de diseño no aprobadas');
  process.exitCode = fallos ? 1 : 0;
}

const args = process.argv.slice(2);
const iEsperados = args.indexOf('--esperados');
const esperados = iEsperados >= 0 ? path.resolve(args[iEsperados + 1]) : null;
if (iEsperados >= 0) args.splice(iEsperados, 2);
const [modo, x, y, u] = args;
const tarea = modo === 'capturar' && x ? capturar(path.resolve(x))
  : modo === 'comparar' && x && y ? comparar(path.resolve(x), path.resolve(y), Number(u ?? 0.1), esperados)
  : null;
if (!tarea) {
  console.log('Uso:\n  node scripts/capturas.js capturar <carpeta>\n  node scripts/capturas.js comparar <antes> <después> [umbral%] [--esperados archivo.json]');
  process.exitCode = 2;
} else {
  tarea.catch(e => { console.error(e); process.exitCode = 1; });
}
