/** Utilidades matemáticas compartidas (sin dependencias). */

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const deg2rad = (d) => (d * Math.PI) / 180;
export const rad2deg = (r) => (r * 180) / Math.PI;

/** Media móvil exponencial escalar. */
export class EMA {
  constructor(alpha = 0.3, initial = null) {
    this.alpha = alpha;
    this.value = initial;
  }
  push(x) {
    if (this.value === null || !Number.isFinite(this.value)) this.value = x;
    else this.value = this.value + this.alpha * (x - this.value);
    return this.value;
  }
  get() { return this.value; }
  reset(v = null) { this.value = v; }
}

/** Suaviza una caja [x,y,w,h] hacia un objetivo con factor de smoothing. */
export function smoothBox(prev, target, smoothing) {
  if (!prev) return target.slice();
  const t = 1 - smoothing;
  return [
    lerp(prev[0], target[0], t),
    lerp(prev[1], target[1], t),
    lerp(prev[2], target[2], t),
    lerp(prev[3], target[3], t),
  ];
}

/** IOU entre dos cajas en formato [x,y,w,h]. */
export function iou(a, b) {
  const ax2 = a[0] + a[2], ay2 = a[1] + a[3];
  const bx2 = b[0] + b[2], by2 = b[1] + b[3];
  const ix1 = Math.max(a[0], b[0]);
  const iy1 = Math.max(a[1], b[1]);
  const ix2 = Math.min(ax2, bx2);
  const iy2 = Math.min(ay2, by2);
  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  const ua = a[2] * a[3] + b[2] * b[3] - inter;
  return ua <= 0 ? 0 : inter / ua;
}

/** Normaliza un ángulo a [-180,180). */
export function wrapDeg(d) {
  let x = ((d + 180) % 360 + 360) % 360 - 180;
  return x;
}

/** Catmull-Rom: punto interpolado suave entre p1 y p2 (t en [0,1]). */
export function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return [
    0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t +
      (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
      (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
    0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t +
      (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
      (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
  ];
}

let _idCounter = 1;
export const nextId = () => _idCounter++;
