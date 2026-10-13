'use strict';
/* Chromium con Playwright para las pruebas del panel. Devuelve null si no está instalado. */
const fs = require('node:fs');

function cargarPlaywright() {
  const rutas = [process.env.PLAYWRIGHT_MODULE, 'playwright', 'playwright-core', '/opt/node22/lib/node_modules/playwright'].filter(Boolean);
  for (const r of rutas) {
    try { return require(r); } catch { /* siguiente */ }
  }
  return null;
}

async function abrirNavegador() {
  const pw = cargarPlaywright();
  if (!pw) return null;
  const opciones = {};
  const exe = process.env.CHROMIUM_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : null);
  if (exe && fs.statSync(exe).isFile()) opciones.executablePath = exe;
  try {
    return await pw.chromium.launch(opciones);
  } catch {
    return null;
  }
}

module.exports = { cargarPlaywright, abrirNavegador };
