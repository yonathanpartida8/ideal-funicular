import { CONFIG } from '../config.js';
import { clamp } from '../util/math.js';

/** Niveles de riesgo. */
export const RISK = { NONE: 0, LOW: 1, MEDIUM: 2, CRITICAL: 3 };

/**
 * Motor de predicción y evaluación de riesgo.
 *  - Proyecta la trayectoria futura de cada objeto (1–3 s) en coordenadas de
 *    imagen normalizadas, usando la velocidad del centroide del tracker
 *    (px/frame) integrada en el horizonte temporal.
 *  - Calcula distancia de seguimiento segura (regla de los N segundos).
 *  - Determina el nivel de riesgo combinando TTC y distancia segura.
 */
export class PredictionEngine {
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
