/**
 * Configuración global del AI Driving HUD.
 * Todos los parámetros ajustables del pipeline viven aquí.
 */
export const CONFIG = Object.freeze({
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
