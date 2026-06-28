import { CONFIG } from '../config.js';

/**
 * Monitor de rendimiento y controlador adaptativo.
 * Mide tiempos de frame y decide nivel de calidad (resolución de inferencia
 * y FPS de IA) para mantener el hilo principal fluido.
 */
export class PerfMonitor {
  constructor() {
    this._frames = [];
    this._aiTimes = [];
    this._lastUi = performance.now();
    this._lastAi = 0;
    this.uiFps = 0;
    this.aiFps = 0;

    // Nivel de calidad: índice de inputSizes y FPS objetivo de IA.
    this.qualityIdx = CONFIG.inference.defaultSizeIdx;
    this.aiTargetFps = CONFIG.inference.targetFps;
    this._lastAdjust = performance.now();
  }

  /** Llamar una vez por frame de UI (rAF). */
  tickUI() {
    const now = performance.now();
    const dt = now - this._lastUi;
    this._lastUi = now;
    this._push(this._frames, dt);
    this.uiFps = 1000 / this._avg(this._frames);
    this._maybeAdjust(now);
    return dt;
  }

  /** Marca el final de un ciclo de inferencia (para medir FPS de IA real). */
  tickAI() {
    const now = performance.now();
    if (this._lastAi) {
      this._push(this._aiTimes, now - this._lastAi);
      this.aiFps = 1000 / this._avg(this._aiTimes);
    }
    this._lastAi = now;
  }

  get inputSize() {
    return CONFIG.inference.inputSizes[this.qualityIdx];
  }

  get aiFrameInterval() {
    return 1000 / this.aiTargetFps;
  }

  _maybeAdjust(now) {
    if (now - this._lastAdjust < 1200) return; // ajusta como mucho c/1.2s
    this._lastAdjust = now;
    const avg = this._avg(this._frames);
    const budget = CONFIG.perf.frameBudgetMs;

    if (avg > budget * 1.25) {
      // Sobrecargado: baja calidad/FPS de IA.
      if (this.aiTargetFps > CONFIG.inference.minFps) {
        this.aiTargetFps = Math.max(CONFIG.inference.minFps, this.aiTargetFps - 3);
      } else if (this.qualityIdx > 0) {
        this.qualityIdx--;
      }
    } else if (avg < budget * 0.7) {
      // Holgura: sube calidad/FPS de IA con histéresis.
      if (this.qualityIdx < CONFIG.inference.inputSizes.length - 1 &&
          this.aiTargetFps >= CONFIG.inference.targetFps) {
        this.qualityIdx++;
      } else if (this.aiTargetFps < CONFIG.inference.maxFps) {
        this.aiTargetFps = Math.min(CONFIG.inference.maxFps, this.aiTargetFps + 2);
      }
    }
  }

  _push(arr, v) {
    arr.push(v);
    if (arr.length > CONFIG.perf.sampleWindow) arr.shift();
  }
  _avg(arr) {
    if (!arr.length) return 16.7;
    let s = 0;
    for (const v of arr) s += v;
    return s / arr.length;
  }
}
