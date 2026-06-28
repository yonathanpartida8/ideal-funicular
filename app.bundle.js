/* AI Driving HUD — bundle clásico autogenerado por build.mjs.
   NO editar a mano: edita los módulos en js/ y ejecuta `node build.mjs`.
   Se entrega como <script> clásico para no depender del MIME del servidor. */
(function () {
'use strict';

/* ===== js/util/math.js ===== */
/** Utilidades matemáticas compartidas (sin dependencias). */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;
const deg2rad = (d) => (d * Math.PI) / 180;
const rad2deg = (r) => (r * 180) / Math.PI;

/** Media móvil exponencial escalar. */
class EMA {
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
function smoothBox(prev, target, smoothing) {
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
function iou(a, b) {
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
function wrapDeg(d) {
  let x = ((d + 180) % 360 + 360) % 360 - 180;
  return x;
}

/** Catmull-Rom: punto interpolado suave entre p1 y p2 (t en [0,1]). */
function catmullRom(p0, p1, p2, p3, t) {
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
const nextId = () => _idCounter++;

// ── fin js/util/math.js ──

/* ===== js/config.js ===== */
/**
 * Configuración global del AI Driving HUD.
 * Todos los parámetros ajustables del pipeline viven aquí.
 */
const CONFIG = Object.freeze({
  camera: {
    // Resolución ideal en orden de preferencia. Se negocia con el dispositivo.
    preferred: [
      { width: 3840, height: 2160 }, // 4K
      { width: 2560, height: 1440 }, // 2K
      { width: 1920, height: 1080 }, // 1080p
      { width: 1280, height: 720 },  // 720p fallback
    ],
    facingMode: 'environment', // cámara trasera
    fps: 30,
  },

  inference: {
    // Throttling adaptativo: rango de FPS de IA permitido.
    minFps: 8,
    targetFps: 18,
    maxFps: 30,
    // Resolución a la que se reduce el frame antes de inferir (lado mayor).
    inputSizes: [320, 416, 512], // se elige según carga
    defaultSizeIdx: 1,
    scoreThreshold: 0.45,
    maxDetections: 20,
    // Clases COCO consideradas "vehículo" (índices/labels de COCO-SSD).
    vehicleLabels: ['car', 'truck', 'bus', 'motorcycle', 'bicycle', 'train'],
  },

  tracking: {
    maxAge: 12,        // frames sin match antes de eliminar un track
    minHits: 3,        // detecciones antes de considerar el track confirmado
    iouThreshold: 0.25,
    process_noise: 1.0,
    measurement_noise: 8.0,
  },

  estimation: {
    // Anchos físicos aproximados por tipo (m) para profundidad por tamaño.
    typicalWidthMeters: {
      car: 1.8, truck: 2.5, bus: 2.55, motorcycle: 0.8,
      bicycle: 0.6, train: 3.0, default: 1.8,
    },
    // Distancia focal aproximada en px (se re-calibra con el FOV/ancho real).
    assumedHFovDeg: 62,
    opticalFlow: {
      gridStep: 24,    // muestreo LK en píxeles (sobre imagen reducida)
      window: 7,       // ventana Lucas-Kanade
      pyramidLevels: 2,
      maxFlow: 40,
    },
  },

  prediction: {
    horizonsSec: [1.0, 2.0, 3.0],
    // Umbrales de tiempo a colisión (TTC) en segundos.
    ttc: { warn: 4.0, critical: 2.0 },
    // Distancia de seguimiento segura mínima (regla de los 2 s) en metros @ v.
    safeHeadwaySec: 2.0,
  },

  ui: {
    boxSmoothing: 0.35,   // EMA de las cajas (0=instantáneo, 1=congelado)
    trajectorySmoothing: 0.4,
    nightLumaThreshold: 0.28, // luma media para activar modo nocturno
    dayLumaThreshold: 0.42,
  },

  audio: {
    cooldownMs: { low: 2500, medium: 1400, critical: 700 },
  },

  perf: {
    // Si el tiempo medio de frame supera esto (ms) se reduce calidad.
    frameBudgetMs: 22,
    sampleWindow: 30,
  },
});

// ── fin js/config.js ──

/* ===== js/util/PerfMonitor.js ===== */

/**
 * Monitor de rendimiento y controlador adaptativo.
 * Mide tiempos de frame y decide nivel de calidad (resolución de inferencia
 * y FPS de IA) para mantener el hilo principal fluido.
 */
class PerfMonitor {
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

// ── fin js/util/PerfMonitor.js ──

/* ===== js/prediction/PredictionEngine.js ===== */

/** Niveles de riesgo. */
const RISK = { NONE: 0, LOW: 1, MEDIUM: 2, CRITICAL: 3 };

/**
 * Motor de predicción y evaluación de riesgo.
 *  - Proyecta la trayectoria futura de cada objeto (1–3 s) en coordenadas de
 *    imagen normalizadas, usando la velocidad del centroide del tracker
 *    (px/frame) integrada en el horizonte temporal.
 *  - Calcula distancia de seguimiento segura (regla de los N segundos).
 *  - Determina el nivel de riesgo combinando TTC y distancia segura.
 */
class PredictionEngine {
  /**
   * @param {object} track   salida del tracker (box normalizada, velPx, id)
   * @param {object} metrics salida de MotionEstimator (distanceM, ttc, closing)
   * @param {number} egoSpeedMps velocidad del usuario
   * @param {number} aiFps   FPS real de IA (para convertir px/frame -> px/s)
   */
  evaluate(track, metrics, egoSpeedMps, aiFps) {
    const fps = clamp(aiFps || 15, 5, 60);
    const [vx, vy] = track.velPx || [0, 0]; // px/frame en el frame de análisis

    // Trayectoria proyectada en coords normalizadas (asumiendo box normalizada).
    // velPx está en px del frame de análisis; aquí ya viene normalizada por main.
    const cx = track.box[0] + track.box[2] / 2;
    const cy = track.box[1] + track.box[3] / 2;
    const path = [];
    for (const tSec of CONFIG.prediction.horizonsSec) {
      const frames = tSec * fps;
      path.push({
        t: tSec,
        x: clamp(cx + vx * frames, 0, 1),
        y: clamp(cy + vy * frames, 0, 1),
      });
    }

    // Distancia de seguimiento segura (regla de los 2 s) según velocidad ego.
    const safeDist = Math.max(5, egoSpeedMps * CONFIG.prediction.safeHeadwaySec);
    const distanceDeficit = safeDist - metrics.distanceM; // >0 => demasiado cerca

    // Riesgo por TTC.
    let risk = RISK.NONE;
    const { warn, critical } = CONFIG.prediction.ttc;
    if (metrics.ttc <= critical) risk = RISK.CRITICAL;
    else if (metrics.ttc <= warn) risk = RISK.MEDIUM;
    else if (distanceDeficit > 0 && metrics.closingMps > 0) risk = RISK.LOW;

    // Sólo cuenta como riesgo real si el objeto está en la zona central
    // (delante del vehículo), no en los extremos del encuadre.
    const lateral = Math.abs(cx - 0.5);
    if (lateral > 0.38 && risk < RISK.CRITICAL) {
      risk = Math.max(RISK.NONE, risk - 1);
    }

    return {
      id: track.id,
      path,
      safeDistM: safeDist,
      distanceDeficit,
      risk,
      ttc: metrics.ttc,
    };
  }
}

// ── fin js/prediction/PredictionEngine.js ──

/* ===== js/tracking/KalmanFilter.js ===== */
/**
 * Filtro de Kalman para una caja en formato de estado
 * x = [cx, cy, s, r, vx, vy, vs]  donde
 *   cx,cy = centro, s = área (escala), r = aspecto (w/h),
 *   vx,vy = velocidad del centro, vs = tasa de cambio de escala.
 * Modelo de velocidad constante (estilo SORT). Implementación ligera sin
 * dependencias de álgebra externa: se aprovecha la estructura dispersa.
 */
class BoxKalman {
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
function boxToZ(b) {
  const w = Math.max(1, b[2]);
  const h = Math.max(1, b[3]);
  return [b[0] + w / 2, b[1] + h / 2, w * h, w / h];
}

// ── fin js/tracking/KalmanFilter.js ──

/* ===== js/tracking/SortTracker.js ===== */

/**
 * Tracker multi-objeto estilo SORT:
 *   predicción Kalman + asociación por IOU (greedy) + gestión de ciclo de vida.
 * Mantiene IDs temporales consistentes. NO identifica personas, placas ni
 * datos personales: sólo asocia cajas genéricas de "vehículo" entre frames.
 */
class SortTracker {
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

// ── fin js/tracking/SortTracker.js ──

/* ===== js/sensors/SensorFusion.js ===== */

/**
 * Fusión de sensores del dispositivo:
 *   - GPS (Geolocation): velocidad real y rumbo (heading) cuando disponible.
 *   - Acelerómetro: aceleración longitudinal.
 *   - Giroscopio / orientación: orientación del vehículo.
 *   - Brújula (compass): dirección absoluta.
 *
 * Usa un filtro complementario para fusionar la velocidad del GPS (precisa
 * pero lenta y ruidosa a baja velocidad) con la integración del acelerómetro
 * (rápida pero con deriva), obteniendo una estimación estable de la velocidad
 * del usuario. No se recoge ni transmite ninguna posición: todo es efímero
 * y local.
 */
class SensorFusion {
  constructor() {
    this.state = {
      speedMps: 0,        // velocidad estimada (m/s)
      gpsSpeedMps: null,  // última velocidad GPS válida
      accelLong: 0,       // aceleración longitudinal (m/s^2)
      heading: null,      // rumbo (deg, 0=N)
      pitch: 0, roll: 0, yaw: 0,
      yawRate: 0,         // velocidad angular (deg/s) del giroscopio
      gpsAccuracy: null,
      hasGps: false, hasMotion: false, hasOrientation: false,
    };
    this._speedEma = new EMA(0.25, 0);
    this._accelEma = new EMA(0.2, 0);
    this._lastAccelTs = 0;
    this._geoWatch = null;
    this._gravity = [0, 0, 9.81];
    this._compAlpha = 0.98; // peso del modelo inercial en el filtro complementario
  }

  async start() {
    await this._requestPermissions();
    this._startGeolocation();
    this._startMotion();
    this._startOrientation();
  }

  /** iOS 13+ requiere petición explícita de permiso para sensores de movimiento. */
  async _requestPermissions() {
    try {
      if (typeof DeviceMotionEvent !== 'undefined' &&
          typeof DeviceMotionEvent.requestPermission === 'function') {
        await DeviceMotionEvent.requestPermission().catch(() => {});
      }
      if (typeof DeviceOrientationEvent !== 'undefined' &&
          typeof DeviceOrientationEvent.requestPermission === 'function') {
        await DeviceOrientationEvent.requestPermission().catch(() => {});
      }
    } catch { /* ignorar */ }
  }

  _startGeolocation() {
    if (!('geolocation' in navigator)) return;
    this._geoWatch = navigator.geolocation.watchPosition(
      (pos) => {
        const c = pos.coords;
        this.state.hasGps = true;
        this.state.gpsAccuracy = c.accuracy;
        if (typeof c.speed === 'number' && !Number.isNaN(c.speed) && c.speed >= 0) {
          this.state.gpsSpeedMps = c.speed;
        }
        if (typeof c.heading === 'number' && !Number.isNaN(c.heading)) {
          this.state.heading = c.heading;
        }
      },
      () => { /* permiso denegado / sin señal: se sigue con inercial */ },
      { enableHighAccuracy: true, maximumAge: 500, timeout: 8000 }
    );
  }

  _startMotion() {
    window.addEventListener('devicemotion', (e) => {
      this.state.hasMotion = true;
      const now = performance.now();
      const dt = this._lastAccelTs ? (now - this._lastAccelTs) / 1000 : 0;
      this._lastAccelTs = now;

      // Aceleración lineal (sin gravedad) si está disponible.
      const a = e.acceleration && e.acceleration.x !== null
        ? e.acceleration
        : e.accelerationIncludingGravity;
      if (!a) return;

      // Magnitud horizontal como proxy de aceleración longitudinal.
      const mag = Math.hypot(a.x || 0, a.y || 0, a.z || 0);
      // Si incluye gravedad, restamos ~9.81 del módulo.
      const longAccel = (e.acceleration && e.acceleration.x !== null)
        ? (a.y || 0)               // eje y del dispositivo en landscape ≈ avance
        : clamp(mag - 9.81, -10, 10);
      this.state.accelLong = this._accelEma.push(longAccel);

      if (e.rotationRate && typeof e.rotationRate.alpha === 'number') {
        this.state.yawRate = e.rotationRate.alpha;
      }

      this._fuseSpeed(dt);
    });
  }

  _startOrientation() {
    const handler = (e) => {
      this.state.hasOrientation = true;
      // alpha = brújula (heading), beta = pitch, gamma = roll.
      if (typeof e.webkitCompassHeading === 'number') {
        this.state.heading = e.webkitCompassHeading; // iOS: ya es heading verdadero
      } else if (typeof e.alpha === 'number') {
        // En Android alpha es relativo; se usa como yaw y, a falta de GPS, como rumbo.
        this.state.yaw = e.alpha;
        if (this.state.heading === null) this.state.heading = wrapDeg(360 - e.alpha);
      }
      if (typeof e.beta === 'number') this.state.pitch = e.beta;
      if (typeof e.gamma === 'number') this.state.roll = e.gamma;
    };
    window.addEventListener('deviceorientationabsolute', handler, true);
    window.addEventListener('deviceorientation', handler, true);
  }

  /**
   * Filtro complementario para la velocidad:
   *   v = α·(v + a·dt) + (1-α)·v_gps
   * Cuando hay GPS válido, corrige la deriva de la integración del acelerómetro.
   */
  _fuseSpeed(dt) {
    if (dt <= 0 || dt > 0.5) dt = 0.05;
    let v = this.state.speedMps + this.state.accelLong * dt;
    if (v < 0) v = 0;

    const g = this.state.gpsSpeedMps;
    if (g !== null && Number.isFinite(g)) {
      // Confianza del GPS según precisión: peor precisión => menos peso.
      const acc = this.state.gpsAccuracy || 20;
      const gpsTrust = clamp(1 - (acc - 5) / 50, 0.2, 0.9);
      const alpha = 1 - gpsTrust * (1 - this._compAlpha + 0.15);
      v = alpha * v + (1 - alpha) * g;
    } else {
      // Sin GPS: amortigua hacia 0 para limitar deriva.
      v *= 0.995;
    }
    this.state.speedMps = this._speedEma.push(clamp(v, 0, 120));
  }

  get speedKmh() { return this.state.speedMps * 3.6; }

  snapshot() { return { ...this.state, speedKmh: this.speedKmh }; }

  stop() {
    if (this._geoWatch !== null) navigator.geolocation.clearWatch(this._geoWatch);
  }
}

// ── fin js/sensors/SensorFusion.js ──

/* ===== js/estimation/MotionEstimator.js ===== */

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
class MotionEstimator {
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

// ── fin js/estimation/MotionEstimator.js ──

/* ===== js/vision/LightDetector.js ===== */
/**
 * Detección de luces de vehículo (faros / pilotos) por análisis de brillo y
 * contraste dentro de la región del bounding box. Sirve como señal auxiliar
 * para mejorar la estimación de distancia de noche (más par de luces brillantes
 * y separadas => coche más cerca / mejor calibración de escala).
 *
 * Trabaja sobre el ImageData reducido del frame (no sobre el video completo)
 * para mantener el coste despreciable.
 */
class LightDetector {
  /**
   * @param {ImageData} img  frame reducido
   * @param {[number,number,number,number]} boxNorm  caja normalizada [x,y,w,h]
   * @param {number} luma  luma media de la escena (0..1) para umbral adaptativo
   */
  analyze(img, boxNorm, luma) {
    if (!img) return null;
    const W = img.width, H = img.height, d = img.data;
    const x0 = Math.max(0, Math.floor(boxNorm[0] * W));
    const y0 = Math.max(0, Math.floor(boxNorm[1] * H));
    const x1 = Math.min(W, Math.ceil((boxNorm[0] + boxNorm[2]) * W));
    const y1 = Math.min(H, Math.ceil((boxNorm[1] + boxNorm[3]) * H));
    if (x1 - x0 < 3 || y1 - y0 < 3) return null;

    // Umbral de brillo adaptativo: más bajo de día, más alto de noche para
    // aislar fuentes de luz reales frente a reflejos.
    const bright = luma < 0.3 ? 0.78 : 0.92;
    let count = 0, total = 0;
    let sumX = 0, sumX2 = 0, weight = 0;
    let leftCx = 0, rightCx = 0, leftW = 0, rightW = 0;
    const midX = (x0 + x1) / 2;

    // Muestreo cada 2 px para velocidad.
    for (let y = y0; y < y1; y += 2) {
      for (let x = x0; x < x1; x += 2) {
        const i = (y * W + x) * 4;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const l = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        total++;
        if (l >= bright) {
          count++;
          // Pilotos traseros: dominante rojo. Faros: blanco/amarillo.
          const reddish = r > 160 && r > g * 1.25 && r > b * 1.25;
          const w = reddish ? 1.2 : 1.0;
          sumX += x * w; sumX2 += x * x * w; weight += w;
          if (x < midX) { leftCx += x; leftW++; } else { rightCx += x; rightW++; }
        }
      }
    }
    if (total === 0) return null;
    const ratio = count / total;
    if (ratio < 0.004) return { hasLights: false, ratio, pairSeparation: 0 };

    // Separación entre el blob izquierdo y derecho (par de luces) en px de img.
    let sep = 0;
    if (leftW > 2 && rightW > 2) {
      sep = (rightCx / rightW) - (leftCx / leftW);
    }
    return {
      hasLights: ratio > 0.01 || sep > (x1 - x0) * 0.2,
      ratio,
      pairSeparation: Math.max(0, sep) / W, // normalizado al frame
      brightnessBoost: Math.min(1, ratio * 8),
    };
  }
}

// ── fin js/vision/LightDetector.js ──

/* ===== js/vision/VisionEngine.js ===== */

/**
 * Interfaz del hilo principal con el worker de inferencia.
 * Gestiona el envío de frames (con throttling adaptativo y descarte para
 * evitar backlog) y emite las detecciones normalizadas a través de un callback.
 */
class VisionEngine {
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

// ── fin js/vision/VisionEngine.js ──

/* ===== js/camera/CameraCapture.js ===== */

/**
 * Captura de cámara trasera en la máxima calidad disponible.
 * Negocia la resolución probando de mayor a menor y expone el <video>
 * más un canvas de trabajo reducido para extraer ImageData/bitmaps sin
 * bloquear el hilo de render.
 */
class CameraCapture {
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

// ── fin js/camera/CameraCapture.js ──

/* ===== js/audio/AlertSystem.js ===== */

/**
 * Sistema de alertas sonoras con Web Audio API.
 * Tonos sintetizados (sin assets) con latencia mínima y distinto carácter
 * según el nivel de riesgo. Incluye cooldown por nivel para no saturar.
 */
class AlertSystem {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this._lastPlay = { [RISK.LOW]: 0, [RISK.MEDIUM]: 0, [RISK.CRITICAL]: 0 };
  }

  /** Debe llamarse tras un gesto del usuario (autoplay policy). */
  resume() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  setMuted(m) { this.muted = m; }

  /** Reproduce la alerta correspondiente al nivel (con cooldown). */
  alert(level) {
    if (this.muted || !this.ctx || level <= RISK.NONE) return;
    const now = performance.now();
    const cdMap = CONFIG.audio.cooldownMs;
    const cd = level === RISK.CRITICAL ? cdMap.critical
      : level === RISK.MEDIUM ? cdMap.medium : cdMap.low;
    if (now - (this._lastPlay[level] || 0) < cd) return;
    this._lastPlay[level] = now;

    if (level === RISK.CRITICAL) this._beep([880, 1320], 0.12, 'square', 2, 0.9);
    else if (level === RISK.MEDIUM) this._beep([660], 0.16, 'sawtooth', 1, 0.6);
    else this._beep([440], 0.12, 'sine', 1, 0.4);
  }

  /** Genera una secuencia de tonos. */
  _beep(freqs, dur, type, repeats, gain) {
    const ctx = this.ctx;
    let t = ctx.currentTime;
    for (let r = 0; r < repeats; r++) {
      for (const f of freqs) {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(f, t);
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(gain, t + 0.008);     // ataque rápido
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur); // caída
        osc.connect(g); g.connect(this.master);
        osc.start(t); osc.stop(t + dur + 0.02);
        t += dur * 0.65;
      }
      t += 0.04;
    }
  }
}

// ── fin js/audio/AlertSystem.js ──

/* ===== js/ui/HudRenderer.js ===== */

/**
 * Renderer del HUD.
 *  - Capa WebGL2: dibuja el frame de cámara como textura (con tono adaptativo
 *    día/noche en el fragment shader) y la geometría vectorial (cajas con
 *    "glow" por multipasada aditiva y trayectorias curvas como tiras gruesas).
 *  - Capa Canvas2D: texto nítido (velocidad, distancia, IDs, alertas, brújula).
 *
 * Ambas capas comparten el mismo encuadre "cover" para alinearse pixel a pixel.
 */
const RISK_COLOR = {
  [RISK.NONE]: [0.18, 0.95, 0.88],
  [RISK.LOW]: [0.30, 1.0, 0.63],
  [RISK.MEDIUM]: [1.0, 0.81, 0.30],
  [RISK.CRITICAL]: [1.0, 0.30, 0.37],
};

class HudRenderer {
  constructor(glCanvas, hudCanvas, video, forceFallback = false) {
    this.glCanvas = glCanvas;
    this.hudCanvas = hudCanvas;
    this.video = video;
    this.ctx2d = hudCanvas.getContext('2d');
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.night = false;
    this.glFailed = false;
    this._tone = { brightness: 1.0, contrast: 1.0, gamma: 1.0 };
    if (!forceFallback) {
      try { this._initGL(); }
      catch (e) { console.error('[gl init]', e); this.glFailed = true; }
    } else {
      this.glFailed = true;
    }
    if (this.glFailed) this._initFallback2D();
    this._resize();
    window.addEventListener('resize', () => this._resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this._resize(), 200));
  }

  // ---------- Inicialización WebGL2 ----------
  _initGL() {
    const gl = this.glCanvas.getContext('webgl2', {
      alpha: false, antialias: true, desynchronized: true, powerPreference: 'high-performance',
    });
    this.gl = gl;
    if (!gl) { this.glFailed = true; return; }

    // Programa de video (textura + tono).
    this.vidProg = this._program(`#version 300 es
      in vec2 aPos; in vec2 aUV; out vec2 vUV;
      void main(){ vUV = aUV; gl_Position = vec4(aPos, 0.0, 1.0); }`,
      `#version 300 es
      precision highp float;
      in vec2 vUV; out vec4 frag;
      uniform sampler2D uTex;
      uniform float uBrightness, uContrast, uGamma;
      void main(){
        vec3 c = texture(uTex, vUV).rgb;
        c = (c - 0.5) * uContrast + 0.5;      // contraste
        c *= uBrightness;                     // brillo
        c = pow(clamp(c, 0.0, 1.0), vec3(1.0/uGamma)); // gamma
        frag = vec4(c, 1.0);
      }`);

    // Programa de geometría vectorial (posición en px + color por vértice).
    this.geoProg = this._program(`#version 300 es
      in vec2 aPos; in vec4 aColor;
      uniform vec2 uRes; out vec4 vColor;
      void main(){
        vec2 clip = (aPos / uRes) * 2.0 - 1.0;
        gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
        vColor = aColor;
      }`,
      `#version 300 es
      precision highp float;
      in vec4 vColor; out vec4 frag;
      void main(){ frag = vColor; }`);

    // Quad full-screen para el video.
    this.vidVAO = gl.createVertexArray();
    gl.bindVertexArray(this.vidVAO);
    const quad = new Float32Array([
      -1, -1, 0, 1,   1, -1, 1, 1,   -1, 1, 0, 0,
      -1, 1, 0, 0,    1, -1, 1, 1,    1, 1, 1, 0,
    ]);
    this.vidBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vidBuf);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(this.vidProg, 'aPos');
    const aUV = gl.getAttribLocation(this.vidProg, 'aUV');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(aUV);
    gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 16, 8);
    gl.bindVertexArray(null);

    // Textura de video.
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    // VAO/buffer dinámico para geometría.
    this.geoVAO = gl.createVertexArray();
    gl.bindVertexArray(this.geoVAO);
    this.geoBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.geoBuf);
    const gPos = gl.getAttribLocation(this.geoProg, 'aPos');
    const gCol = gl.getAttribLocation(this.geoProg, 'aColor');
    gl.enableVertexAttribArray(gPos);
    gl.vertexAttribPointer(gPos, 2, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(gCol);
    gl.vertexAttribPointer(gCol, 4, gl.FLOAT, false, 24, 8);
    gl.bindVertexArray(null);
    this._geoData = new Float32Array(4096 * 6);
  }

  /** Contexto 2D sobre el canvas de fondo cuando no hay WebGL2. */
  _initFallback2D() {
    // getContext('2d') sólo es válido si NO se obtuvo antes un contexto webgl.
    this.glBg = this.glCanvas.getContext('2d');
  }

  _program(vsSrc, fsSrc) {
    const gl = this.gl;
    const vs = this._shader(gl.VERTEX_SHADER, vsSrc);
    const fs = this._shader(gl.FRAGMENT_SHADER, fsSrc);
    const p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('Link error: ' + gl.getProgramInfoLog(p));
    }
    return p;
  }
  _shader(type, src) {
    const gl = this.gl;
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error('Shader error: ' + gl.getShaderInfoLog(s));
    }
    return s;
  }

  // ---------- Layout / encuadre "cover" ----------
  _resize() {
    const w = window.innerWidth, h = window.innerHeight;
    for (const c of [this.glCanvas, this.hudCanvas]) {
      c.width = Math.round(w * this.dpr);
      c.height = Math.round(h * this.dpr);
      c.style.width = w + 'px';
      c.style.height = h + 'px';
    }
    this.W = this.glCanvas.width;
    this.H = this.glCanvas.height;
    this.ctx2d.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.cssW = w; this.cssH = h;
  }

  _coverParams() {
    const vw = this.video.videoWidth || 16, vh = this.video.videoHeight || 9;
    const scale = Math.max(this.W / vw, this.H / vh);
    const dw = vw * scale, dh = vh * scale;
    return { ox: (this.W - dw) / 2, oy: (this.H - dh) / 2, dw, dh };
  }
  /** Normalizado de video -> px de canvas (espacio de dispositivo). */
  _n2s(nx, ny) {
    const p = this._cover;
    return [p.ox + nx * p.dw, p.oy + ny * p.dh];
  }

  setTone(night, luma) {
    this.night = night;
    // Día: leve realce de contraste. Noche: sube brillo/gamma para visibilidad.
    if (night) this._tone = { brightness: 1.18, contrast: 1.12, gamma: 1.35 };
    else this._tone = { brightness: 1.0, contrast: 1.06, gamma: 1.0 };
  }

  // ---------- Render principal ----------
  /**
   * @param {object} frame  { objects:[{box,label,id,risk,distanceM,objSpeedKmh,path,lights}],
   *                          ego:{speedKmh,heading,accelLong}, alerts:{level,text},
   *                          stats:{uiFps,aiFps,backend,inputSize} }
   */
  render(frame) {
    this._cover = this._coverParams();
    if (this.glFailed) {
      this._drawVideo2D();      // vídeo por Canvas2D (modo compatibilidad)
    } else {
      this._drawVideoGL();
      this._drawGeometryGL(frame);
    }
    this._drawOverlay2D(frame);  // texto/cajas/paneles siempre por Canvas2D
  }

  /** Dibuja el vídeo con Canvas2D (fallback sin WebGL2), encuadre "cover". */
  _drawVideo2D() {
    const ctx = this.glBg;
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.W, this.H);
    if (this.video.readyState >= 2) {
      const p = this._cover;
      const t = this._tone;
      ctx.filter = `brightness(${t.brightness}) contrast(${t.contrast})`;
      try { ctx.drawImage(this.video, p.ox, p.oy, p.dw, p.dh); } catch {}
      ctx.filter = 'none';
    }
  }

  _drawVideoGL() {
    const gl = this.gl;
    gl.viewport(0, 0, this.W, this.H);
    gl.disable(gl.BLEND);
    if (this.video.readyState >= 2) {
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, this.video); }
      catch { /* frame no listo */ }
    }
    gl.useProgram(this.vidProg);
    gl.uniform1i(gl.getUniformLocation(this.vidProg, 'uTex'), 0);
    gl.uniform1f(gl.getUniformLocation(this.vidProg, 'uBrightness'), this._tone.brightness);
    gl.uniform1f(gl.getUniformLocation(this.vidProg, 'uContrast'), this._tone.contrast);
    gl.uniform1f(gl.getUniformLocation(this.vidProg, 'uGamma'), this._tone.gamma);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.bindVertexArray(this.vidVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }

  _drawGeometryGL(frame) {
    const gl = this.gl;
    this._geo = [];
    for (const o of frame.objects) {
      const col = RISK_COLOR[o.risk] || RISK_COLOR[RISK.NONE];
      this._pushBox(o.box, col, o.risk);
      if (o.path && o.path.length) this._pushTrajectory(o, col);
    }
    if (!this._geo.length) return;

    const data = this._geoData.length >= this._geo.length
      ? this._geoData : (this._geoData = new Float32Array(this._geo.length));
    data.set(this._geo);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE); // aditivo: produce el efecto glow
    gl.useProgram(this.geoProg);
    gl.uniform2f(gl.getUniformLocation(this.geoProg, 'uRes'), this.W, this.H);
    gl.bindVertexArray(this.geoVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.geoBuf);
    gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, this._geo.length), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, this._geo.length / 6);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }

  /** Caja redondeada con glow: varias pasadas de grosor decreciente en alpha. */
  _pushBox(box, col, risk) {
    const [x0, y0] = this._n2s(box[0], box[1]);
    const [x1, y1] = this._n2s(box[0] + box[2], box[1] + box[3]);
    const baseT = (risk >= RISK.CRITICAL ? 4 : 2.5) * this.dpr;
    const passes = [
      { t: baseT * 3.0, a: 0.10 },
      { t: baseT * 1.8, a: 0.18 },
      { t: baseT, a: 0.95 },
    ];
    const corner = Math.min(22 * this.dpr, (x1 - x0) * 0.18, (y1 - y0) * 0.18);
    for (const p of passes) {
      this._pushRoundedRectOutline(x0, y0, x1, y1, corner, p.t, col, p.a);
    }
  }

  /** Contorno de rect redondeado con esquinas tipo corchete (estética HUD). */
  _pushRoundedRectOutline(x0, y0, x1, y1, r, t, col, a) {
    const segLen = Math.min((x1 - x0), (y1 - y0)) * 0.28; // longitud de corchetes
    const L = (ax, ay, bx, by) => this._pushThickLine(ax, ay, bx, by, t, col, a);
    // Esquinas (corchetes) en lugar de marco completo: menos intrusivo.
    // Superior-izq
    L(x0, y0 + r, x0, y0 + r + segLen); L(x0 + r, y0, x0 + r + segLen, y0);
    // Superior-der
    L(x1, y0 + r, x1, y0 + r + segLen); L(x1 - r, y0, x1 - r - segLen, y0);
    // Inferior-izq
    L(x0, y1 - r, x0, y1 - r - segLen); L(x0 + r, y1, x0 + r + segLen, y1);
    // Inferior-der
    L(x1, y1 - r, x1, y1 - r - segLen); L(x1 - r, y1, x1 - r - segLen, y1);
  }

  /** Línea gruesa como dos triángulos (quad). */
  _pushThickLine(ax, ay, bx, by, t, col, a) {
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len * t * 0.5, ny = dx / len * t * 0.5;
    const v = this._geo;
    const push = (x, y) => { v.push(x, y, col[0], col[1], col[2], a); };
    push(ax + nx, ay + ny); push(ax - nx, ay - ny); push(bx + nx, by + ny);
    push(bx + nx, by + ny); push(ax - nx, ay - ny); push(bx - nx, by - ny);
  }

  /** Trayectoria curva suave (Catmull-Rom) como tira de líneas gruesas. */
  _pushTrajectory(o, col) {
    const cx = o.box[0] + o.box[2] / 2;
    const cy = o.box[1] + o.box[3];           // base del objeto
    const pts = [[cx, cy], ...o.path.map((p) => [p.x, Math.min(1, p.y + o.box[3] / 2)])];
    if (pts.length < 2) return;
    // Densifica con Catmull-Rom.
    const dense = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1];
      const p3 = pts[Math.min(pts.length - 1, i + 2)];
      for (let s = 0; s < 6; s++) dense.push(catmullRom(p0, p1, p2, p3, s / 6));
    }
    dense.push(pts[pts.length - 1]);
    for (let i = 0; i < dense.length - 1; i++) {
      const [ax, ay] = this._n2s(dense[i][0], dense[i][1]);
      const [bx, by] = this._n2s(dense[i + 1][0], dense[i + 1][1]);
      const fade = 0.5 * (1 - i / dense.length); // se desvanece hacia el futuro
      this._pushThickLine(ax, ay, bx, by, 3 * this.dpr, col, fade + 0.15);
    }
  }

  // ---------- Overlay Canvas2D (texto e indicadores) ----------
  _drawOverlay2D(frame) {
    const ctx = this.ctx2d;
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    ctx.textBaseline = 'middle';

    // En modo compatibilidad (sin WebGL2) dibujamos las cajas aquí.
    if (this.glFailed) this._drawBoxes2D(ctx, frame);

    // Etiquetas flotantes por objeto.
    for (const o of frame.objects) {
      const col = RISK_COLOR[o.risk] || RISK_COLOR[RISK.NONE];
      const rgb = `rgb(${(col[0] * 255) | 0},${(col[1] * 255) | 0},${(col[2] * 255) | 0})`;
      const [sx, sy] = this._n2s(o.box[0], o.box[1]);
      const x = sx / this.dpr, y = sy / this.dpr;
      const dist = o.distanceM != null ? `${o.distanceM.toFixed(0)}m` : '--';
      const rel = o.objSpeedKmh != null ? `${o.objSpeedKmh >= 0 ? '' : ''}${o.objSpeedKmh.toFixed(0)}km/h` : '';
      const label = `#${o.id} · ${dist}`;
      ctx.font = `600 ${13}px ${'Segoe UI, Roboto, sans-serif'}`;
      const tw = Math.max(ctx.measureText(label).width, ctx.measureText(rel).width) + 14;
      ctx.fillStyle = 'rgba(2,10,14,0.55)';
      this._roundRect(ctx, x, y - 38, tw, 34, 7); ctx.fill();
      ctx.fillStyle = rgb;
      ctx.fillText(label, x + 7, y - 28);
      ctx.fillStyle = '#bfeef0';
      if (rel) ctx.fillText(rel, x + 7, y - 13);
      if (o.lights && o.lights.hasLights) {
        ctx.fillStyle = this.night ? '#fff2a8' : '#9fe';
        ctx.fillText('◉', x + tw + 4, y - 21);
      }
    }

    this._drawSpeedo(ctx, frame.ego);
    this._drawCompass(ctx, frame.ego);
    if (frame.showDetail !== false) this._drawInfoPanel(ctx, frame);
    this._drawAlertBanner(ctx, frame.alerts);
    this._drawStats(ctx, frame.stats);
  }

  /** Cajas con esquinas tipo corchete usando Canvas2D (fallback sin WebGL2). */
  _drawBoxes2D(ctx, frame) {
    for (const o of frame.objects) {
      const col = RISK_COLOR[o.risk] || RISK_COLOR[RISK.NONE];
      const rgb = `rgb(${(col[0] * 255) | 0},${(col[1] * 255) | 0},${(col[2] * 255) | 0})`;
      const [ax, ay] = this._n2s(o.box[0], o.box[1]);
      const [bx, by] = this._n2s(o.box[0] + o.box[2], o.box[1] + o.box[3]);
      const x0 = ax / this.dpr, y0 = ay / this.dpr, x1 = bx / this.dpr, y1 = by / this.dpr;
      const seg = Math.min(x1 - x0, y1 - y0) * 0.28;
      ctx.strokeStyle = rgb;
      ctx.lineWidth = o.risk >= RISK.CRITICAL ? 3.5 : 2.2;
      ctx.shadowColor = rgb; ctx.shadowBlur = 12;
      ctx.beginPath();
      // 4 esquinas (corchetes).
      ctx.moveTo(x0, y0 + seg); ctx.lineTo(x0, y0); ctx.lineTo(x0 + seg, y0);
      ctx.moveTo(x1 - seg, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y0 + seg);
      ctx.moveTo(x0, y1 - seg); ctx.lineTo(x0, y1); ctx.lineTo(x0 + seg, y1);
      ctx.moveTo(x1 - seg, y1); ctx.lineTo(x1, y1); ctx.lineTo(x1, y1 - seg);
      ctx.stroke();
      ctx.shadowBlur = 0;
      // Trayectoria.
      if (o.path && o.path.length) {
        ctx.strokeStyle = rgb; ctx.lineWidth = 2; ctx.globalAlpha = 0.5;
        ctx.beginPath();
        const cx = o.box[0] + o.box[2] / 2, cy = o.box[1] + o.box[3];
        const [px, py] = this._n2s(cx, cy);
        ctx.moveTo(px / this.dpr, py / this.dpr);
        for (const p of o.path) {
          const [qx, qy] = this._n2s(p.x, Math.min(1, p.y + o.box[3] / 2));
          ctx.lineTo(qx / this.dpr, qy / this.dpr);
        }
        ctx.stroke(); ctx.globalAlpha = 1;
      }
    }
  }

  /** Panel de información: distancia segura, conteo, objetivo más cercano, TTC. */
  _drawInfoPanel(ctx, frame) {
    const safe = frame.safe || {};
    const focus = frame.focus;
    const x = 12, y = this.cssH - 168, w = 188;
    ctx.save();
    ctx.fillStyle = 'rgba(2,12,16,0.55)';
    this._roundRect(ctx, x, y, w, 120, 12); ctx.fill();
    ctx.strokeStyle = 'rgba(47,243,224,0.22)'; ctx.lineWidth = 1;
    this._roundRect(ctx, x, y, w, 120, 12); ctx.stroke();

    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    let ly = y + 22;
    const row = (label, value, color) => {
      ctx.fillStyle = '#8fc6cc'; ctx.font = '600 11px Segoe UI, Roboto, sans-serif';
      ctx.fillText(label, x + 12, ly);
      ctx.fillStyle = color || '#eafdff';
      ctx.font = '700 14px Segoe UI, Roboto, sans-serif';
      ctx.textAlign = 'right'; ctx.fillText(value, x + w - 12, ly);
      ctx.textAlign = 'left'; ly += 25;
    };

    const safeColor = safe.tooClose ? 'rgb(255,77,94)' : 'rgb(77,255,161)';
    row('Distancia segura', `${(safe.distM || 0).toFixed(0)} m`, safeColor);
    row('Vehículos', `${safe.count || 0}`);
    if (focus) {
      row('Más cercano', `${focus.distanceM.toFixed(0)} m`,
        focus.risk >= 2 ? 'rgb(255,207,77)' : '#eafdff');
      const ttc = Number.isFinite(focus.ttc) ? `${focus.ttc.toFixed(1)} s` : '—';
      row('TTC', ttc, focus.risk >= 3 ? 'rgb(255,77,94)' : '#eafdff');
    } else {
      row('Más cercano', '—');
      row('TTC', '—');
    }
    ctx.restore();
    ctx.textBaseline = 'middle';
  }

  _drawSpeedo(ctx, ego) {
    const cx = this.cssW - 78, cy = this.cssH - 110, r = 52;
    ctx.save();
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(47,243,224,0.22)';
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    const v = clamp((ego.speedKmh || 0) / 160, 0, 1);
    ctx.strokeStyle = '#2ff3e0';
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + v * Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#eafdff';
    ctx.textAlign = 'center';
    ctx.font = '700 30px Segoe UI, Roboto, sans-serif';
    ctx.fillText(Math.round(ego.speedKmh || 0), cx, cy - 2);
    ctx.font = '600 11px Segoe UI, Roboto, sans-serif';
    ctx.fillStyle = '#7fd6d2';
    ctx.fillText('km/h', cx, cy + 18);
    ctx.textAlign = 'left';
    ctx.restore();
  }

  _drawCompass(ctx, ego) {
    if (ego.heading == null) return;
    const x = this.cssW - 78, y = 64;
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const idx = Math.round(((ego.heading % 360) / 45)) % 8;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(2,10,14,0.5)';
    this._roundRect(ctx, x - 26, y - 18, 52, 36, 8); ctx.fill();
    ctx.fillStyle = '#2ff3e0';
    ctx.font = '700 16px Segoe UI, Roboto, sans-serif';
    ctx.fillText(dirs[idx], x, y - 2);
    ctx.fillStyle = '#7fd6d2';
    ctx.font = '600 10px Segoe UI, Roboto, sans-serif';
    ctx.fillText(`${Math.round(ego.heading)}°`, x, y + 12);
    ctx.textAlign = 'left';
    ctx.restore();
  }

  _drawAlertBanner(ctx, alerts) {
    if (!alerts || alerts.level <= RISK.NONE) return;
    const col = RISK_COLOR[alerts.level];
    const rgb = `rgb(${(col[0] * 255) | 0},${(col[1] * 255) | 0},${(col[2] * 255) | 0})`;
    const pulse = alerts.level >= RISK.CRITICAL
      ? 0.55 + 0.45 * Math.sin(performance.now() / 120) : 0.85;
    const w = Math.min(this.cssW - 32, 360);
    const x = (this.cssW - w) / 2, y = 24;
    ctx.save();
    ctx.globalAlpha = pulse;
    ctx.fillStyle = 'rgba(2,10,14,0.65)';
    this._roundRect(ctx, x, y, w, 44, 12); ctx.fill();
    ctx.strokeStyle = rgb; ctx.lineWidth = 2;
    this._roundRect(ctx, x, y, w, 44, 12); ctx.stroke();
    ctx.fillStyle = rgb;
    ctx.textAlign = 'center';
    ctx.font = '700 16px Segoe UI, Roboto, sans-serif';
    ctx.fillText(alerts.text, this.cssW / 2, y + 22);
    ctx.textAlign = 'left';
    ctx.restore();
  }

  _drawStats(ctx, s) {
    if (!s) return;
    ctx.save();
    ctx.fillStyle = 'rgba(160,220,225,0.65)';
    ctx.font = '500 10px Segoe UI, Roboto, monospace';
    ctx.fillText(`${s.backend} · in ${s.inputSize}px`, 12, this.cssH - 16);
    ctx.restore();
  }

  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}

// ── fin js/ui/HudRenderer.js ──

/* ===== js/main.js ===== */

/** Escala virtual para que el tracker Kalman trabaje en un espacio estable. */
const VSCALE = 1000;

const RISK_TEXT = {
  [RISK.LOW]: 'ATENCIÓN · vehículo cercano',
  [RISK.MEDIUM]: 'PRECAUCIÓN · reduce velocidad',
  [RISK.CRITICAL]: '¡FRENA! · riesgo de colisión',
};

/**
 * Orquestador del pipeline con arranque a prueba de fallos:
 *   1) abre la cámara y MUESTRA el HUD de inmediato (render a 60 fps),
 *   2) carga el modelo de IA en segundo plano (su fallo NO bloquea la cámara),
 *   3) arranca sensores en segundo plano.
 * Etapas desacopladas: captura → inferencia(worker) → tracking → fusión →
 * estimación → predicción → render → alertas.
 */
class App {
  constructor(onStatus) {
    this.onStatus = onStatus || (() => {});
    this.video = document.getElementById('camVideo');
    this.camera = new CameraCapture(this.video);
    this.sensors = new SensorFusion();
    this.motion = new MotionEstimator();
    this.predict = new PredictionEngine();
    this.lights = new LightDetector();
    this.audio = new AlertSystem();
    this.perf = new PerfMonitor();
    this.tracker = new SortTracker();
    this.vision = null;   // se crea tras revelar la cámara
    this.renderer = null; // idem
    this.aiReady = false;

    this.objects = new Map();
    this.sceneLuma = 0.5;
    this._lumaEma = 0.5;
    this.running = false;
    this.muted = false;
    this.showDetail = true;
  }

  async start() {
    this._wireControls();

    // 1) CÁMARA primero. Es lo crítico: si esto falla, lo decimos claro.
    this.onStatus('Solicitando acceso a la cámara…');
    this.audio.resume();
    let settings;
    try {
      settings = await this.camera.start();
    } catch (err) {
      throw new Error(this._cameraErrorText(err));
    }
    this.onStatus(`Cámara ${settings.width}×${settings.height} lista.`);

    // 2) Revela el escenario y arranca el render YA (se ve el vídeo al instante).
    document.getElementById('startScreen').classList.add('hidden');
    document.getElementById('stage').classList.remove('hidden');
    this.renderer = this._makeRenderer();
    this.running = true;
    requestAnimationFrame((t) => this._renderLoop(t));

    // 3) Sensores en segundo plano (no bloqueante).
    this.sensors.start().catch((e) => console.warn('[sensors]', e));

    // 4) Modelo de IA en segundo plano: su fallo no apaga la cámara.
    this._setAiState('IA: cargando modelo…');
    this._initVision();
  }

  _makeRenderer() {
    try {
      return new HudRenderer(
        document.getElementById('glCanvas'),
        document.getElementById('hudCanvas'),
        this.video,
      );
    } catch (e) {
      console.error('[renderer]', e);
      this._toast('Render en modo compatibilidad (sin WebGL2).');
      return new HudRenderer(
        document.getElementById('glCanvas'),
        document.getElementById('hudCanvas'),
        this.video,
        true, // forzar fallback 2D
      );
    }
  }

  async _initVision() {
    try {
      this.vision = new VisionEngine();
      this.vision.onDetections = (dets) => this._onDetections(dets);
      this.vision.onError = (e) => console.warn('[vision]', e);
      await this.vision.init();
      this.aiReady = true;
      this._setAiState(`IA lista · ${this.vision.backend}`);
      this._inferLoop();
    } catch (err) {
      console.error('[vision init]', err);
      this.aiReady = false;
      this._setAiState('IA no disponible (offline). Cámara + sensores activos.');
      this._toast('Modelo no cargado: revisa red o vendoriza en /vendor. La cámara y los sensores siguen activos.');
    }
  }

  _wireControls() {
    const mute = document.getElementById('muteBtn');
    mute && mute.addEventListener('click', (e) => {
      this.muted = !this.muted;
      this.audio.setMuted(this.muted);
      e.currentTarget.textContent = this.muted ? '🔇' : '🔊';
      e.currentTarget.classList.toggle('off', this.muted);
    });
    const hud = document.getElementById('hudBtn');
    hud && hud.addEventListener('click', (e) => {
      this.showDetail = !this.showDetail;
      e.currentTarget.classList.toggle('off', !this.showDetail);
    });
    const stop = document.getElementById('stopBtn');
    stop && stop.addEventListener('click', () => this._shutdown());
  }

  // ---------- Inferencia (cadencia adaptativa) ----------
  async _inferLoop() {
    if (!this.running || !this.aiReady) return;
    const interval = this.perf.aiFrameInterval;
    this.vision.setConfig({ inputSize: this.perf.inputSize });
    try {
      await this.vision.maybeInfer(
        () => this.camera.grabBitmap(this.perf.inputSize),
        interval,
      );
    } catch (e) { /* frame perdido; continúa */ }
    setTimeout(() => this._inferLoop(), Math.max(8, interval / 2));
  }

  _onDetections(dets) {
    this.perf.tickAI();

    const reduced = this.camera.grabReduced(this.perf.inputSize);
    if (reduced) {
      this._updateLuma(reduced);
      this.motion.computeSceneFlow(reduced);
    }

    const scaled = dets.map((d) => ({
      box: [d.box[0] * VSCALE, d.box[1] * VSCALE, d.box[2] * VSCALE, d.box[3] * VSCALE],
      label: d.label, score: d.score,
    }));
    const tracks = this.tracker.update(scaled);

    const ego = this.sensors.snapshot();
    const frameW = reduced ? reduced.width : this.perf.inputSize;
    const aiFps = this.perf.aiFps || CONFIG.inference.targetFps;
    const activeIds = new Set();

    for (const t of tracks) {
      const boxN = [t.box[0] / VSCALE, t.box[1] / VSCALE, t.box[2] / VSCALE, t.box[3] / VSCALE];
      const velN = [t.velPx[0] / VSCALE, t.velPx[1] / VSCALE];
      const trackN = { id: t.id, label: t.label, score: t.score, box: boxN, velPx: velN };

      const lights = reduced ? this.lights.analyze(reduced, boxN, this._lumaEma) : null;
      const metrics = this.motion.estimate(trackN, frameW, ego.speedMps, lights);
      const pred = this.predict.evaluate(trackN, metrics, ego.speedMps, aiFps);

      activeIds.add(t.id);
      const prev = this.objects.get(t.id);
      this.objects.set(t.id, {
        id: t.id, label: t.label,
        targetBox: boxN, box: prev ? prev.box : boxN.slice(),
        distanceM: metrics.distanceM, objSpeedKmh: metrics.objSpeedKmh,
        closingMps: metrics.closingMps, ttc: metrics.ttc,
        risk: pred.risk, path: pred.path, safeDistM: pred.safeDistM,
        lights, lastSeen: performance.now(),
      });
    }

    for (const [id, o] of this.objects) {
      if (!activeIds.has(id) && performance.now() - o.lastSeen > 600) this.objects.delete(id);
    }
    this.motion.prune(activeIds);
  }

  _updateLuma(img) {
    const d = img.data;
    let sum = 0; const step = 16 * 4; let n = 0;
    for (let i = 0; i < d.length; i += step) {
      sum += (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]); n++;
    }
    const luma = (sum / n) / 255;
    this._lumaEma += 0.05 * (luma - this._lumaEma);
    this.sceneLuma = this._lumaEma;
  }

  // ---------- Render (60 fps) ----------
  _renderLoop(t) {
    if (!this.running) return;
    this.perf.tickUI();

    let maxRisk = RISK.NONE;
    let nearest = null;
    const objects = [];
    for (const o of this.objects.values()) {
      o.box = smoothBox(o.box, o.targetBox, CONFIG.ui.boxSmoothing);
      if (o.risk > maxRisk) maxRisk = o.risk;
      // "Más cercano en trayectoria" = central y a menor distancia.
      const central = Math.abs((o.box[0] + o.box[2] / 2) - 0.5) < 0.33;
      if (central && (!nearest || o.distanceM < nearest.distanceM)) nearest = o;
      objects.push(o);
    }

    if (!this.renderer.night && this._lumaEma < CONFIG.ui.nightLumaThreshold) {
      this.renderer.setTone(true, this._lumaEma);
    } else if (this.renderer.night && this._lumaEma > CONFIG.ui.dayLumaThreshold) {
      this.renderer.setTone(false, this._lumaEma);
    }

    if (maxRisk > RISK.NONE) this.audio.alert(maxRisk);

    const ego = this.sensors.snapshot();
    const safeDist = Math.max(5, ego.speedMps * CONFIG.prediction.safeHeadwaySec);

    this.renderer.render({
      objects,
      showDetail: this.showDetail,
      ego: { speedKmh: ego.speedKmh, heading: ego.heading, accelLong: ego.accelLong,
             hasGps: ego.hasGps },
      focus: nearest ? {
        distanceM: nearest.distanceM, ttc: nearest.ttc,
        closingMps: nearest.closingMps, risk: nearest.risk,
      } : null,
      safe: { distM: safeDist, count: objects.length,
              tooClose: nearest ? nearest.distanceM < safeDist : false },
      alerts: { level: maxRisk, text: RISK_TEXT[maxRisk] || '' },
      stats: {
        uiFps: this.perf.uiFps, aiFps: this.perf.aiFps,
        backend: this.vision ? this.vision.backend : '--',
        inputSize: this.perf.inputSize, aiReady: this.aiReady,
      },
    });

    this._updateTelemetry();
    requestAnimationFrame((tt) => this._renderLoop(tt));
  }

  _updateTelemetry() {
    this._set('fpsUI', `UI ${this.perf.uiFps.toFixed(0)} fps`);
    this._set('fpsAI', `AI ${this.aiReady ? this.perf.aiFps.toFixed(0) : '--'} fps`);
    this._set('modeTag', this.renderer.night ? '🌙 noche' : '☀️ día');
  }

  _set(id, txt) { const el = document.getElementById(id); if (el) el.textContent = txt; }
  _setAiState(txt) { this._set('aiState', txt); }

  _toast(msg, ms = 4200) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => el.classList.add('hidden'), ms);
  }

  _cameraErrorText(err) {
    const name = err && err.name ? err.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError')
      return 'Permiso de cámara denegado. Acéptalo en el navegador y reintenta.';
    if (name === 'NotFoundError' || name === 'OverconstrainedError')
      return 'No se encontró una cámara compatible en el dispositivo.';
    if (name === 'NotReadableError')
      return 'La cámara está en uso por otra app. Ciérrala y reintenta.';
    if (!window.isSecureContext)
      return 'La cámara requiere HTTPS o http://localhost (contexto seguro).';
    return 'No se pudo abrir la cámara: ' + (err && err.message ? err.message : err);
  }

  _shutdown() {
    this.running = false;
    this.camera.stop();
    this.sensors.stop();
    if (this.vision) this.vision.dispose();
    document.getElementById('stage').classList.add('hidden');
    document.getElementById('startScreen').classList.remove('hidden');
    const btn = document.getElementById('startBtn');
    if (btn) btn.disabled = false;
    this.onStatus('Detenido. Pulsa para reiniciar.');
  }
}

/** Punto de entrada llamado por el bootstrap de index.html. */
async function startApp({ onStatus } = {}) {
  if (window.__app && window.__app.running) return window.__app;
  const app = new App(onStatus);
  window.__app = app;
  await app.start();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  return app;
}

// ── fin js/main.js ──

window.startApp = startApp;
})();
