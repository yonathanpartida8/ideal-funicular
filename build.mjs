/**
 * Build sin dependencias: concatena los módulos ES en un único script CLÁSICO
 * (`app.bundle.js`) que cualquier servidor estático puede entregar, sin la
 * verificación estricta de MIME que aplican los módulos ES (`type="module"`).
 *
 * Quita las líneas `import ...` y la palabra `export` de las declaraciones,
 * envolviendo todo en una IIFE con ámbito compartido. El orden respeta las
 * dependencias evaluadas en tiempo de carga (p. ej. RISK antes de su uso).
 *
 * Uso:  node build.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

// Orden de concatenación (dependencias de carga primero).
const ORDER = [
  'js/util/math.js',
  'js/config.js',
  'js/util/PerfMonitor.js',
  'js/prediction/PredictionEngine.js', // define RISK (usado al cargar más abajo)
  'js/tracking/KalmanFilter.js',
  'js/tracking/SortTracker.js',
  'js/sensors/SensorFusion.js',
  'js/estimation/MotionEstimator.js',
  'js/vision/LightDetector.js',
  'js/vision/VisionEngine.js',
  'js/camera/CameraCapture.js',
  'js/audio/AlertSystem.js',
  'js/ui/HudRenderer.js',
  'js/main.js',
];

function strip(src, file) {
  return src
    .split('\n')
    .filter((line) => !/^\s*import\s.*from\s.*;?\s*$/.test(line) &&
                      !/^\s*import\s*\{[^}]*\}\s*;?\s*$/.test(line))
    // export class/function/const/let/var/async function -> sin "export"
    .map((line) => line.replace(/^(\s*)export\s+(default\s+)?(async\s+function|function|class|const|let|var)\b/, '$1$3'))
    // export { ... }  -> eliminar
    .map((line) => /^\s*export\s*\{[^}]*\}\s*;?\s*$/.test(line) ? '' : line)
    .join('\n') + `\n// ── fin ${file} ──\n`;
}

let out = `/* AI Driving HUD — bundle clásico autogenerado por build.mjs.
   NO editar a mano: edita los módulos en js/ y ejecuta \`node build.mjs\`.
   Se entrega como <script> clásico para no depender del MIME del servidor. */
(function () {
'use strict';
`;

for (const f of ORDER) {
  out += `\n/* ===== ${f} ===== */\n`;
  out += strip(readFileSync(f, 'utf8'), f);
}

// Exponer el punto de entrada al ámbito global para el bootstrap de index.html.
out += `
window.startApp = startApp;
})();
`;

writeFileSync('app.bundle.js', out);
console.log('app.bundle.js generado (' + out.length + ' bytes)');
