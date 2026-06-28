import { CONFIG } from '../config.js';
import { iou, nextId } from '../util/math.js';
import { BoxKalman, boxToZ } from './KalmanFilter.js';

/**
 * Tracker multi-objeto estilo SORT:
 *   predicción Kalman + asociación por IOU (greedy) + gestión de ciclo de vida.
 * Mantiene IDs temporales consistentes. NO identifica personas, placas ni
 * datos personales: sólo asocia cajas genéricas de "vehículo" entre frames.
 */
export class SortTracker {
  constructor(cfg = CONFIG.tracking) {
    this.cfg = cfg;
    this.tracks = []; // { id, kf, label, score, box, hits, conf, lastBox }
  }

  /**
   * @param {Array<{box:[x,y,w,h], label:string, score:number}>} detections
   * @returns {Array} tracks confirmados con box predicha/corregida
   */
  update(detections) {
    // 1) Predicción de todos los tracks existentes.
    for (const t of this.tracks) {
      t.predBox = t.kf.predict();
    }

    // 2) Matriz de costes IOU y asociación greedy.
    const N = this.tracks.length;
    const M = detections.length;
    const assignedTrack = new Array(N).fill(false);
    const assignedDet = new Array(M).fill(false);

    const pairs = [];
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < M; j++) {
        const score = iou(this.tracks[i].predBox, detections[j].box);
        if (score >= this.cfg.iouThreshold) pairs.push([score, i, j]);
      }
    }
    pairs.sort((a, b) => b[0] - a[0]);
    for (const [, i, j] of pairs) {
      if (assignedTrack[i] || assignedDet[j]) continue;
      assignedTrack[i] = true;
      assignedDet[j] = true;
      const t = this.tracks[i];
      const d = detections[j];
      t.kf.update(boxToZ(d.box));
      t.label = d.label;
      t.score = d.score;
    }

    // 3) Crear tracks nuevos para detecciones sin asociar.
    for (let j = 0; j < M; j++) {
      if (assignedDet[j]) continue;
      const d = detections[j];
      const kf = new BoxKalman(boxToZ(d.box), {
        processNoise: this.cfg.process_noise,
        measurementNoise: this.cfg.measurement_noise,
      });
      this.tracks.push({ id: nextId(), kf, label: d.label, score: d.score });
    }

    // 4) Eliminar tracks viejos.
    this.tracks = this.tracks.filter((t) => t.kf.timeSinceUpdate <= this.cfg.maxAge);

    // 5) Salida: tracks confirmados (con histéresis minHits).
    const out = [];
    for (const t of this.tracks) {
      const confirmed = t.kf.hits >= this.cfg.minHits || t.kf.timeSinceUpdate === 0;
      if (!confirmed && t.kf.age > this.cfg.minHits) continue;
      const box = t.kf.stateToBox();
      out.push({
        id: t.id,
        label: t.label,
        score: t.score,
        box,
        velPx: t.kf.velocity,       // px/frame del centro
        timeSinceUpdate: t.kf.timeSinceUpdate,
        hits: t.kf.hits,
      });
    }
    return out;
  }

  reset() { this.tracks = []; }
}
