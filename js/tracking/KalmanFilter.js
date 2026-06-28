/**
 * Filtro de Kalman para una caja en formato de estado
 * x = [cx, cy, s, r, vx, vy, vs]  donde
 *   cx,cy = centro, s = área (escala), r = aspecto (w/h),
 *   vx,vy = velocidad del centro, vs = tasa de cambio de escala.
 * Modelo de velocidad constante (estilo SORT). Implementación ligera sin
 * dependencias de álgebra externa: se aprovecha la estructura dispersa.
 */
export class BoxKalman {
  constructor(box, { processNoise = 1.0, measurementNoise = 8.0 } = {}) {
    const [cx, cy, s, r] = box;
    // Estado.
    this.x = [cx, cy, s, r, 0, 0, 0];
    // Covarianza diagonal (suficiente para este modelo desacoplado).
    this.P = [10, 10, 10, 10, 1e4, 1e4, 1e4];
    this.q = processNoise;
    this.rMeas = measurementNoise;
    this.timeSinceUpdate = 0;
    this.hits = 0;
    this.age = 0;
  }

  predict() {
    // x_{k} = F x_{k-1} (velocidad constante en cx,cy,s).
    this.x[0] += this.x[4];
    this.x[1] += this.x[5];
    this.x[2] = Math.max(1, this.x[2] + this.x[6]);
    // Crecimiento de incertidumbre.
    for (let i = 0; i < 7; i++) this.P[i] += this.q * (i >= 4 ? 0.01 : 1);
    this.age++;
    this.timeSinceUpdate++;
    return this.stateToBox();
  }

  update(box) {
    const z = box; // [cx,cy,s,r]
    for (let i = 0; i < 4; i++) {
      const k = this.P[i] / (this.P[i] + this.rMeas); // ganancia de Kalman
      const innov = z[i] - this.x[i];
      this.x[i] += k * innov;
      // Actualiza velocidad asociada (i+4) para cx,cy,s.
      if (i < 3) this.x[i + 4] += (k * innov) * 0.35;
      this.P[i] *= (1 - k);
    }
    this.timeSinceUpdate = 0;
    this.hits++;
  }

  /** Convierte estado a [x,y,w,h]. */
  stateToBox() {
    const [cx, cy, s, r] = this.x;
    const w = Math.sqrt(Math.max(1, s * r));
    const h = s > 0 && w > 0 ? s / w : 1;
    return [cx - w / 2, cy - h / 2, w, h];
  }

  /** Velocidad del centro en px/frame. */
  get velocity() { return [this.x[4], this.x[5]]; }
}

/** Convierte [x,y,w,h] -> [cx,cy,s,r]. */
export function boxToZ(b) {
  const w = Math.max(1, b[2]);
  const h = Math.max(1, b[3]);
  return [b[0] + w / 2, b[1] + h / 2, w * h, w / h];
}
