import { CONFIG } from '../config.js';

/**
 * Captura de cámara trasera en la máxima calidad disponible.
 * Negocia la resolución probando de mayor a menor y expone el <video>
 * más un canvas de trabajo reducido para extraer ImageData/bitmaps sin
 * bloquear el hilo de render.
 */
export class CameraCapture {
  constructor(videoEl) {
    this.video = videoEl;
    this.stream = null;
    this.track = null;
    this.settings = null;
    // Canvas offscreen para muestreo reducido (optical flow / análisis luma).
    this._work = document.createElement('canvas');
    this._workCtx = this._work.getContext('2d', { willReadFrequently: true });
    this.ready = false;
  }

  async start() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const e = new Error('getUserMedia no disponible (¿contexto inseguro?)');
      e.name = 'SecurityError';
      throw e;
    }
    let lastErr = null;
    for (const res of CONFIG.camera.preferred) {
      try {
        const constraints = {
          audio: false,
          video: {
            facingMode: { ideal: CONFIG.camera.facingMode },
            width: { ideal: res.width },
            height: { ideal: res.height },
            frameRate: { ideal: CONFIG.camera.fps, max: 60 },
          },
        };
        this.stream = await navigator.mediaDevices.getUserMedia(constraints);
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!this.stream) {
      // Último intento sin restricciones de resolución.
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: CONFIG.camera.facingMode } },
        audio: false,
      }).catch((e) => { throw lastErr || e; });
    }

    this.track = this.stream.getVideoTracks()[0];
    this.settings = this.track.getSettings();
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.setAttribute('playsinline', '');
    try { await this.video.play(); } catch { /* reintento tras metadata */ }

    // Espera a metadata para tener dimensiones reales.
    if (!this.video.videoWidth) {
      await new Promise((r) => {
        const done = () => r();
        this.video.addEventListener('loadedmetadata', done, { once: true });
        setTimeout(done, 3000); // no bloquear indefinidamente
      });
    }
    try { await this.video.play(); } catch { /* ya reproduciendo */ }
    this.ready = true;
    return this.settings;
  }

  get width() { return this.video.videoWidth || (this.settings && this.settings.width) || 0; }
  get height() { return this.video.videoHeight || (this.settings && this.settings.height) || 0; }

  /**
   * Devuelve un ImageData reducido (lado mayor = size) para análisis ligero.
   * Se reutiliza el canvas de trabajo para no generar basura por frame.
   */
  grabReduced(size) {
    if (!this.ready || !this.width) return null;
    const ar = this.width / this.height;
    let w, h;
    if (ar >= 1) { w = size; h = Math.round(size / ar); }
    else { h = size; w = Math.round(size * ar); }
    if (this._work.width !== w || this._work.height !== h) {
      this._work.width = w; this._work.height = h;
    }
    this._workCtx.drawImage(this.video, 0, 0, w, h);
    return this._workCtx.getImageData(0, 0, w, h);
  }

  /** Crea un ImageBitmap del frame actual (transferible a un Worker). */
  async grabBitmap(size) {
    if (!this.ready || !this.width) return null;
    const ar = this.width / this.height;
    let w, h;
    if (ar >= 1) { w = size; h = Math.round(size / ar); }
    else { h = size; w = Math.round(size * ar); }
    // resizeWidth/Height permite escalar barato en el decodificador.
    return createImageBitmap(this.video, {
      resizeWidth: w, resizeHeight: h, resizeQuality: 'low',
    });
  }

  /** Intenta ajustar el zoom/torch si el dispositivo lo soporta (opcional). */
  async setTorch(on) {
    try {
      const caps = this.track.getCapabilities ? this.track.getCapabilities() : {};
      if (caps.torch) await this.track.applyConstraints({ advanced: [{ torch: !!on }] });
    } catch { /* no soportado */ }
  }

  stop() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null; this.track = null; this.ready = false;
  }
}
