import { CONFIG } from '../config.js';
import { deg2rad, clamp, EMA } from '../util/math.js';

/**
 * Estimación de movimiento, profundidad y velocidad relativa.
 *
 *  - Profundidad aproximada: pinhole inverso usando el ancho físico típico del
 *    tipo de vehículo y el ancho del bounding box en píxeles (más cambio de
 *    escala entre frames como señal secundaria).
 *  - Velocidad relativa (closing speed): derivada de la distancia estimada en
 *    el tiempo, suavizada.
 *  - Optical flow disperso (Lucas-Kanade) sobre el frame en escala de grises
 *    reducida: aporta una medida global de movimiento de la escena para detectar
 *    el avance del ego-vehículo y validar la velocidad relativa de los objetos.
 *  - TTC (time-to-collision) = distancia / velocidad de cierre.
 */
export class MotionEstimator {
  constructor() {
    this._prevGray = null;
    this._prevW = 0; this._prevH = 0;
    this._focalPx = null;       // distancia focal estimada (px) según FOV
    this._tracks = new Map();   // id -> { distEma, distHist, closingEma, lastT }
    this.sceneFlow = { mag: 0, fx: 0, fy: 0 }; // flujo medio global
  }

  /** Calibra la focal a partir del ancho del frame de análisis y el FOV. */
  _focal(frameW) {
    if (this._focalPx && this._calW === frameW) return this._focalPx;
    const fov = deg2rad(CONFIG.estimation.assumedHFovDeg);
    this._focalPx = (frameW / 2) / Math.tan(fov / 2);
    this._calW = frameW;
    return this._focalPx;
  }

  /** Distancia (m) por modelo pinhole: Z = f * W_real / w_px. */
  _distanceFromBox(label, boxNorm, frameW) {
    const f = this._focal(frameW);
    const wPx = Math.max(2, boxNorm[2] * frameW);
    const Wreal = CONFIG.estimation.typicalWidthMeters[label] ||
                  CONFIG.estimation.typicalWidthMeters.default;
    return clamp((f * Wreal) / wPx, 1, 300);
  }

  /**
   * Optical flow Lucas-Kanade disperso sobre rejilla.
   * Devuelve el flujo medio (px) de la escena, útil para estimar el avance.
   */
  computeSceneFlow(imgData) {
    if (!imgData) return this.sceneFlow;
    const W = imgData.width, H = imgData.height;
    const gray = this._toGray(imgData);
    if (this._prevGray && this._prevW === W && this._prevH === H) {
      const { gridStep, window: win, maxFlow } = CONFIG.estimation.opticalFlow;
      const half = win >> 1;
      let sfx = 0, sfy = 0, n = 0;
      for (let y = half + 1; y < H - half - 1; y += gridStep) {
        for (let x = half + 1; x < W - half - 1; x += gridStep) {
          const v = this._lk(this._prevGray, gray, W, x, y, half, maxFlow);
          if (v) { sfx += v[0]; sfy += v[1]; n++; }
        }
      }
      if (n > 0) {
        this.sceneFlow = { fx: sfx / n, fy: sfy / n, mag: Math.hypot(sfx / n, sfy / n) };
      }
    }
    this._prevGray = gray; this._prevW = W; this._prevH = H;
    return this.sceneFlow;
  }

  /** Un paso de Lucas-Kanade en un punto (sin pirámide; movimientos pequeños). */
  _lk(prev, cur, W, x, y, half, maxFlow) {
    let Gxx = 0, Gyy = 0, Gxy = 0, Gxt = 0, Gyt = 0;
    for (let j = -half; j <= half; j++) {
      for (let i = -half; i <= half; i++) {
        const idx = (y + j) * W + (x + i);
        const ix = (prev[idx + 1] - prev[idx - 1]) * 0.5;
        const iy = (prev[idx + W] - prev[idx - W]) * 0.5;
        const it = cur[idx] - prev[idx];
        Gxx += ix * ix; Gyy += iy * iy; Gxy += ix * iy;
        Gxt += ix * it; Gyt += iy * it;
      }
    }
    const det = Gxx * Gyy - Gxy * Gxy;
    if (Math.abs(det) < 1e-3) return null;
    const u = (-Gyy * Gxt + Gxy * Gyt) / det;
    const v = (Gxy * Gxt - Gxx * Gyt) / det;
    if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
    if (Math.abs(u) > maxFlow || Math.abs(v) > maxFlow) return null;
    return [u, v];
  }

  _toGray(imgData) {
    const { data, width, height } = imgData;
    const g = new Float32Array(width * height);
    for (let p = 0, i = 0; p < g.length; p++, i += 4) {
      g[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    return g;
  }

  /**
   * Actualiza la estimación para un track y devuelve métricas físicas.
   * @param {object} track  salida del SortTracker (id, label, box, ...)
   * @param {number} frameW  ancho del frame de análisis (px)
   * @param {number} egoSpeedMps  velocidad del usuario (sensor fusion)
   * @param {object|null} lights  resultado de LightDetector (opcional)
   */
  estimate(track, frameW, egoSpeedMps, lights) {
    const now = performance.now();
    let s = this._tracks.get(track.id);
    if (!s) {
      s = { distEma: new EMA(0.3), closingEma: new EMA(0.25, 0), lastDist: null, lastT: now };
      this._tracks.set(track.id, s);
    }

    let dist = this._distanceFromBox(track.label, track.box, frameW);

    // Corrección nocturna: si hay par de luces, su separación da una escala
    // independiente del tamaño de la caja (robusta cuando el contorno se pierde).
    if (lights && lights.hasLights && lights.pairSeparation > 0.02) {
      const f = this._focal(frameW);
      const Wreal = CONFIG.estimation.typicalWidthMeters[track.label] ||
                    CONFIG.estimation.typicalWidthMeters.default;
      const sepPx = lights.pairSeparation * frameW;
      // Separación de luces ≈ 0.55–0.7 del ancho del vehículo.
      const distLights = clamp((f * (Wreal * 0.62)) / Math.max(2, sepPx), 1, 300);
      dist = dist * 0.5 + distLights * 0.5;
    }

    const distS = s.distEma.push(dist);
    const dt = Math.max(0.016, (now - s.lastT) / 1000);

    // Velocidad de cierre (positiva = acercándose).
    let closing = 0;
    if (s.lastDist !== null) closing = (s.lastDist - distS) / dt;
    closing = s.closingEma.push(clamp(closing, -80, 80));
    s.lastDist = distS; s.lastT = now;

    // Velocidad relativa del objeto respecto al suelo (aprox):
    // si nos acercamos a velocidad de cierre C y vamos a egoSpeed,
    // el objeto va a (egoSpeed - C) en nuestra misma dirección.
    const objSpeedMps = egoSpeedMps - closing;

    // TTC: sólo definido si nos acercamos.
    const ttc = closing > 0.3 ? distS / closing : Infinity;

    return {
      distanceM: distS,
      closingMps: closing,
      objSpeedMps,
      objSpeedKmh: objSpeedMps * 3.6,
      ttc,
    };
  }

  /** Limpieza de estados de tracks que ya no existen. */
  prune(activeIds) {
    for (const id of this._tracks.keys()) {
      if (!activeIds.has(id)) this._tracks.delete(id);
    }
  }
}
