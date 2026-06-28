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
    this.worker = new Worker(new URL('./detector.worker.js', import.meta.url), {
      type: 'classic',
    });
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
