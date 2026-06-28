/* eslint-disable no-restricted-globals */
/**
 * Worker de inferencia de visión.
 * Ejecuta detección de objetos fuera del hilo principal. Por defecto usa
 * TensorFlow.js + COCO-SSD (modelo ligero) con backend WebGL en el worker.
 *
 * Está diseñado con una interfaz de "detector" intercambiable: se puede
 * sustituir COCO-SSD por un modelo Graph (YOLOv5/YOLOv8 exportado a
 * TF.js Graph Model u ONNX vía onnxruntime-web) implementando el mismo
 * contrato `{init(), detect(imageData) -> [{box,label,score}]}`.
 *
 * Privacidad: sólo se emiten clases genéricas de vehículo. No se ejecuta
 * ningún reconocimiento facial, de matrículas ni de identidad.
 */

let tf = null;
let model = null;
let backend = 'cpu';
let inputSize = 416;
let scoreThreshold = 0.45;
let vehicleLabels = ['car', 'truck', 'bus', 'motorcycle', 'bicycle', 'train'];
let busy = false;

const offscreen = (typeof OffscreenCanvas !== 'undefined')
  ? new OffscreenCanvas(inputSize, inputSize)
  : null;
const offCtx = offscreen ? offscreen.getContext('2d', { willReadFrequently: true }) : null;

/** Carga de scripts con fallback local -> CDN. */
function tryImport(urls) {
  for (const u of urls) {
    try { importScripts(u); return u; } catch (_) { /* siguiente */ }
  }
  return null;
}

async function init(opts = {}) {
  inputSize = opts.inputSize || inputSize;
  scoreThreshold = opts.scoreThreshold ?? scoreThreshold;
  if (opts.vehicleLabels) vehicleLabels = opts.vehicleLabels;

  // 1) Cargar TensorFlow.js (vendor local primero, luego CDN).
  const tfUrl = tryImport([
    '../../vendor/tf.min.js',
    'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.20.0/dist/tf.min.js',
  ]);
  if (!tfUrl || typeof self.tf === 'undefined') {
    throw new Error('No se pudo cargar TensorFlow.js (sin vendor local ni red).');
  }
  tf = self.tf;

  // 2) Backend: WebGL en worker si hay OffscreenCanvas; si no, wasm/cpu.
  try {
    await tf.setBackend('webgl');
    await tf.ready();
    backend = tf.getBackend();
  } catch {
    try { await tf.setBackend('cpu'); await tf.ready(); backend = 'cpu'; } catch {}
  }

  // 3) Cargar COCO-SSD (vendor local primero, luego CDN).
  tryImport([
    '../../vendor/coco-ssd.min.js',
    'https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js',
  ]);
  if (typeof self.cocoSsd === 'undefined') {
    throw new Error('No se pudo cargar el modelo COCO-SSD.');
  }
  // lite_mobilenet_v2: el más ligero, óptimo para tiempo real en móvil.
  model = await self.cocoSsd.load({ base: 'lite_mobilenet_v2' });

  return { backend, ready: true };
}

/** Convierte ImageBitmap -> ImageData en el canvas del worker. */
function bitmapToImageData(bitmap, size) {
  const ar = bitmap.width / bitmap.height;
  let w, h;
  if (ar >= 1) { w = size; h = Math.round(size / ar); }
  else { h = size; w = Math.round(size * ar); }
  if (offscreen.width !== w || offscreen.height !== h) {
    offscreen.width = w; offscreen.height = h;
  }
  offCtx.drawImage(bitmap, 0, 0, w, h);
  return { data: offCtx.getImageData(0, 0, w, h), w, h };
}

async function detect(bitmap) {
  if (!model) return [];
  const { data, w, h } = bitmapToImageData(bitmap, inputSize);
  bitmap.close && bitmap.close();

  const raw = await model.detect(data, 20);
  const out = [];
  for (const d of raw) {
    if (d.score < scoreThreshold) continue;
    if (!vehicleLabels.includes(d.class)) continue; // sólo vehículos genéricos
    // Normaliza la caja a [0,1] respecto del frame.
    out.push({
      box: [d.bbox[0] / w, d.bbox[1] / h, d.bbox[2] / w, d.bbox[3] / h],
      label: d.class,
      score: d.score,
    });
  }
  return out;
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === 'init') {
      const res = await init(msg.opts);
      self.postMessage({ type: 'ready', ...res });
    } else if (msg.type === 'frame') {
      if (busy) { // descarta frames si vamos retrasados (evita backlog)
        msg.bitmap.close && msg.bitmap.close();
        self.postMessage({ type: 'dropped', seq: msg.seq });
        return;
      }
      busy = true;
      const t0 = performance.now();
      const dets = await detect(msg.bitmap);
      busy = false;
      self.postMessage({
        type: 'detections', seq: msg.seq, dets, ms: performance.now() - t0, backend,
      });
    } else if (msg.type === 'config') {
      if (msg.inputSize) inputSize = msg.inputSize;
      if (msg.scoreThreshold != null) scoreThreshold = msg.scoreThreshold;
    }
  } catch (err) {
    busy = false;
    self.postMessage({ type: 'error', error: String(err && err.message || err) });
  }
};
