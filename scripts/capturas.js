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

function cargarPlaywright() {
  const rutas = [process.env.PLAYWRIGHT_MODULE, 'playwright', 'playwright-core', '/opt/node22/lib/node_modules/playwright'].filter(Boolean);
  for (const r of rutas) { try { return require(r); } catch { /* siguiente */ } }
  throw new Error('No se encontró Playwright. Instálalo con: npm i --no-save playwright-core');
}

async function abrirNavegador() {
  const { chromium } = cargarPlaywright();
  const opciones = {};
  const exe = process.env.CHROMIUM_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : null);
  if (exe && fs.statSync(exe).isFile()) opciones.executablePath = exe;
  return chromium.launch(opciones);
}

const FECHA_FIJA = new Date('2026-10-14T15:00:00Z');
const PANEL = ['inicio', 'reservas', 'caja', 'productos', 'clientes', 'informes', 'configuracion'];
const AJUSTES = ['negocio', 'barberos', 'horarios', 'pagos', 'mensajes', 'pagina', 'multimedia', 'apariencia', 'notificaciones', 'datos', 'avanzada'];
const PANTALLAS = [{ nombre: 'escritorio', width: 1366, height: 900 }, { nombre: 'movil', width: 390, height: 844 }];

async function capturar(destino) {
  fs.mkdirSync(destino, { recursive: true });
  const servidor = await iniciarServidor({ postgres: Boolean(urlBasePruebas()) });
  const navegador = await abrirNavegador();
  const hechas = [];
  try {
    for (const p of PANTALLAS) {
      const ctx = await navegador.newContext({ viewport: { width: p.width, height: p.height }, locale: 'es-EC', timezoneId: 'America/Guayaquil', reducedMotion: 'reduce' });
      /* Versiones con cuentas: el panel se captura con la sesión del propietario de prueba. */
      if (servidor.cookie) {
        const [name, value] = servidor.cookie.split('=');
        await ctx.addCookies([{ name, value, url: servidor.base }]);
      }
      const page = await ctx.newPage();
      await page.clock.setFixedTime(FECHA_FIJA);
      const guardar = async nombre => {
        await page.waitForTimeout(400);
        const archivo = path.join(destino, `${p.nombre}-${nombre}.png`);
        await page.screenshot({ path: archivo, fullPage: true, animations: 'disabled' });
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
      await ctx.close();
    }
  } finally {
    await navegador.close();
    await servidor.detener();
    servidor.borrar();
  }
  console.log(`${hechas.length} capturas en ${destino}`);
}

async function comparar(a, b, umbral) {
  const navegador = await abrirNavegador();
  const page = await navegador.newPage();
  let fallos = 0;
  const archivos = fs.readdirSync(a).filter(f => f.endsWith('.png')).sort();
  for (const f of archivos) {
    const otra = path.join(b, f);
    if (!fs.existsSync(otra)) { console.log(`FALTA  ${f}`); fallos++; continue; }
    const uri = x => 'data:image/png;base64,' + fs.readFileSync(x).toString('base64');
    const r = await page.evaluate(async ([x, y]) => {
      const cargar = src => new Promise((ok, mal) => { const i = new Image(); i.onload = () => ok(i); i.onerror = mal; i.src = src; });
      const [i1, i2] = await Promise.all([cargar(x), cargar(y)]);
      if (i1.width !== i2.width || i1.height !== i2.height) return { tam: `${i1.width}x${i1.height} → ${i2.width}x${i2.height}` };
      const datos = img => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0); return g.getImageData(0, 0, img.width, img.height).data; };
      const d1 = datos(i1); const d2 = datos(i2);
      let dif = 0;
      for (let k = 0; k < d1.length; k += 4) {
        if (Math.abs(d1[k] - d2[k]) + Math.abs(d1[k + 1] - d2[k + 1]) + Math.abs(d1[k + 2] - d2[k + 2]) > 30) dif++;
      }
      return { pct: (dif * 100) / (d1.length / 4) };
    }, [uri(path.join(a, f)), uri(otra)]);
    if (r.tam) { console.log(`TAMAÑO ${f}: ${r.tam}`); fallos++; continue; }
    const ok = r.pct <= umbral;
    if (!ok) fallos++;
    console.log(`${ok ? 'IGUAL ' : 'DISTINTA'} ${f}: ${r.pct.toFixed(3)}% de píxeles distintos`);
  }
  await navegador.close();
  console.log(fallos ? `${fallos} capturas con diferencias` : 'Sin diferencias de diseño');
  process.exitCode = fallos ? 1 : 0;
}

const [modo, x, y, u] = process.argv.slice(2);
const tarea = modo === 'capturar' && x ? capturar(path.resolve(x))
  : modo === 'comparar' && x && y ? comparar(path.resolve(x), path.resolve(y), Number(u ?? 0.1))
  : null;
if (!tarea) {
  console.log('Uso:\n  node scripts/capturas.js capturar <carpeta>\n  node scripts/capturas.js comparar <antes> <después> [umbral%]');
  process.exitCode = 2;
} else {
  tarea.catch(e => { console.error(e); process.exitCode = 1; });
}
