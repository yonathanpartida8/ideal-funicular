import { CONFIG } from '../config.js';

/**
 * Interfaz del hilo principal con el worker de inferencia.
 * Gestiona el envío de frames (con throttling adaptativo y descarte para
 * evitar backlog) y emite las detecciones normalizadas a través de un callback.
 */
export class VisionEngine {
  constructor() {
    this.worker = null;
    this.ready = false;
    this.backend = '--';
    this._seq = 0;
    this._inFlight = false;
    this._lastSent = 0;
    this.onDetections = null;  // (dets, meta) => void
    this.onReady = null;
    this.onError = null;
    this.lastMs = 0;
  }

  async init() {
    const base = document.baseURI;
    const abs = (p) => new URL(p, base).href;
    const workerAbs = abs('js/vision/detector.worker.js');

    // El navegador rechaza scripts de Worker (y de importScripts) con MIME
    // no-JS, incluso clásicos. Para funcionar en CUALQUIER servidor estático
    // (p. ej. servidores de archivos de Android que entregan .js como
    // text/plain), descargamos el código del worker con fetch() —que ignora el
    // MIME— y creamos el Worker desde un Blob cuyo MIME sí controlamos.
    try {
      const res = await fetch(workerAbs);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const code = await res.text();
      const blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      this.worker = new Worker(blobUrl, { type: 'classic' });
    } catch (e) {
      // Respaldo: carga directa (servidores con MIME correcto).
      this.worker = new Worker(workerAbs, { type: 'classic' });
    }
    this.worker.onmessage = (ev) => this._onMessage(ev.data);
    this.worker.onerror = (e) => this.onError && this.onError(e.message || 'worker error');

    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('Timeout cargando el modelo de visión')), 30000);
      this._initResolve = (v) => { clearTimeout(to); resolve(v); };
      this._initReject = (e) => { clearTimeout(to); reject(e); };
      this.worker.postMessage({
        type: 'init',
        opts: {
          inputSize: CONFIG.inference.inputSizes[CONFIG.inference.defaultSizeIdx],
          scoreThreshold: CONFIG.inference.scoreThreshold,
          vehicleLabels: CONFIG.inference.vehicleLabels,
          // URLs absolutas (vendor local primero, luego CDN) para el blob worker.
          tfUrls: [abs('vendor/tf.min.js'),
            'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.20.0/dist/tf.min.js'],
          cocoUrls: [abs('vendor/coco-ssd.min.js'),
            'https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js'],
        },
      });
    });
  }

  setConfig({ inputSize, scoreThreshold } = {}) {
    if (!this.worker) return;
    this.worker.postMessage({ type: 'config', inputSize, scoreThreshold });
  }

  /**
   * Intenta enviar un frame a inferir respetando el intervalo objetivo.
   * @param {() => Promise<ImageBitmap|null>} grab  función que produce el bitmap
   * @param {number} minIntervalMs  intervalo mínimo entre inferencias
   */
  async maybeInfer(grab, minIntervalMs) {
    if (!this.ready || this._inFlight) return false;
    const now = performance.now();
    if (now - this._lastSent < minIntervalMs) return false;

    const bitmap = await grab();
    if (!bitmap) return false;
    this._inFlight = true;
    this._lastSent = now;
    const seq = ++this._seq;
    this.worker.postMessage({ type: 'frame', seq, bitmap }, [bitmap]);
    return true;
  }

  _onMessage(msg) {
    switch (msg.type) {
      case 'ready':
        this.ready = true;
        this.backend = msg.backend;
        this._initResolve && this._initResolve(msg);
        this.onReady && this.onReady(msg);
        break;
      case 'detections':
        this._inFlight = false;
        this.lastMs = msg.ms;
        this.backend = msg.backend;
        this.onDetections && this.onDetections(msg.dets, msg);
        break;
      case 'dropped':
        this._inFlight = false;
        break;
      case 'error':
        this._inFlight = false;
        if (this._initReject) this._initReject(new Error(msg.error));
        this.onError && this.onError(msg.error);
        break;
    }
  }

  dispose() { if (this.worker) this.worker.terminate(); }
}
