import { CONFIG } from './config.js';
import { CameraCapture } from './camera/CameraCapture.js';
import { VisionEngine } from './vision/VisionEngine.js';
import { SortTracker } from './tracking/SortTracker.js';
import { SensorFusion } from './sensors/SensorFusion.js';
import { MotionEstimator } from './estimation/MotionEstimator.js';
import { PredictionEngine, RISK } from './prediction/PredictionEngine.js';
import { LightDetector } from './vision/LightDetector.js';
import { AlertSystem } from './audio/AlertSystem.js';
import { HudRenderer } from './ui/HudRenderer.js';
import { PerfMonitor } from './util/PerfMonitor.js';
import { smoothBox, clamp } from './util/math.js';

/** Escala virtual para que el tracker Kalman trabaje en un espacio estable. */
const VSCALE = 1000;

const RISK_TEXT = {
  [RISK.LOW]: 'ATENCIÓN · vehículo cercano',
  [RISK.MEDIUM]: 'PRECAUCIÓN · reduce velocidad',
  [RISK.CRITICAL]: '¡FRENA! · riesgo de colisión',
};

/**
 * Orquestador del pipeline. Mantiene etapas desacopladas:
 *   captura → inferencia (worker) → tracking → fusión de sensores →
 *   estimación → predicción → render (60 fps) → alertas.
 * El render corre a la cadencia de la pantalla; la IA a su propio ritmo
 * adaptativo, y la UI interpola entre actualizaciones para fluidez.
 */
class App {
  constructor() {
    this.video = document.getElementById('camVideo');
    this.camera = new CameraCapture(this.video);
    this.vision = new VisionEngine();
    this.tracker = new SortTracker();
    this.sensors = new SensorFusion();
    this.motion = new MotionEstimator();
    this.predict = new PredictionEngine();
    this.lights = new LightDetector();
    this.audio = new AlertSystem();
    this.perf = new PerfMonitor();
    this.renderer = new HudRenderer(
      document.getElementById('glCanvas'),
      document.getElementById('hudCanvas'),
      this.video,
    );

    this.objects = new Map(); // id -> estado de objeto suavizado para UI
    this.sceneLuma = 0.5;
    this.running = false;
    this.muted = false;
    this._lumaEma = 0.5;
    this._wireUI();
  }

  _wireUI() {
    const status = document.getElementById('startStatus');
    document.getElementById('startBtn').addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try {
        status.textContent = 'Solicitando cámara y sensores…';
        this.audio.resume();
        await this._boot(status);
      } catch (err) {
        status.textContent = 'Error: ' + (err.message || err);
        e.currentTarget.disabled = false;
      }
    });

    document.getElementById('muteBtn').addEventListener('click', (e) => {
      this.muted = !this.muted;
      this.audio.setMuted(this.muted);
      e.currentTarget.textContent = this.muted ? '🔇' : '🔊';
      e.currentTarget.classList.toggle('off', this.muted);
    });
    document.getElementById('hudBtn').addEventListener('click', (e) => {
      this.detail = !this.detail;
      e.currentTarget.classList.toggle('off', !this.detail);
    });
    document.getElementById('stopBtn').addEventListener('click', () => this._shutdown());
  }

  async _boot(status) {
    // 1) Cámara trasera en máxima calidad.
    const settings = await this.camera.start();
    status.textContent = `Cámara ${settings.width}×${settings.height} · cargando modelo…`;

    // 2) Worker de visión (TensorFlow.js).
    await this.vision.init();
    this.vision.onDetections = (dets) => this._onDetections(dets);
    this.vision.onError = (e) => console.warn('[vision]', e);

    // 3) Sensores (no bloqueante).
    this.sensors.start().catch((e) => console.warn('[sensors]', e));

    // 4) Mostrar escenario y arrancar bucles.
    document.getElementById('startScreen').classList.add('hidden');
    document.getElementById('stage').classList.remove('hidden');
    this.renderer._resize();

    this.running = true;
    this._lastInfer = 0;
    requestAnimationFrame((t) => this._renderLoop(t));
    this._inferLoop();
  }

  // ---------- Bucle de inferencia (cadencia adaptativa) ----------
  async _inferLoop() {
    if (!this.running) return;
    const interval = this.perf.aiFrameInterval;
    this.vision.setConfig({ inputSize: this.perf.inputSize });
    await this.vision.maybeInfer(
      () => this.camera.grabBitmap(this.perf.inputSize),
      interval,
    );
    // Reprograma sin bloquear; el descarte de frames lo gestiona el worker.
    setTimeout(() => this._inferLoop(), Math.max(8, interval / 2));
  }

  /** Callback con detecciones normalizadas del worker. */
  _onDetections(dets) {
    this.perf.tickAI();

    // Frame reducido para optical flow, luma y análisis de luces.
    const reduced = this.camera.grabReduced(this.perf.inputSize);
    if (reduced) {
      this._updateLuma(reduced);
      this.motion.computeSceneFlow(reduced);
    }

    // Tracking en espacio virtual estable.
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
      // Vuelve a normalizado [0,1].
      const boxN = [t.box[0] / VSCALE, t.box[1] / VSCALE, t.box[2] / VSCALE, t.box[3] / VSCALE];
      const velN = [t.velPx[0] / VSCALE, t.velPx[1] / VSCALE];
      const trackN = { id: t.id, label: t.label, score: t.score, box: boxN, velPx: velN };

      const lights = reduced ? this.lights.analyze(reduced, boxN, this._lumaEma) : null;
      const metrics = this.motion.estimate(trackN, frameW, ego.speedMps, lights);
      const pred = this.predict.evaluate(trackN, metrics, ego.speedMps, aiFps);

      activeIds.add(t.id);
      const prev = this.objects.get(t.id);
      this.objects.set(t.id, {
        id: t.id,
        label: t.label,
        targetBox: boxN,
        box: prev ? prev.box : boxN.slice(),
        distanceM: metrics.distanceM,
        objSpeedKmh: metrics.objSpeedKmh,
        closingMps: metrics.closingMps,
        ttc: metrics.ttc,
        risk: pred.risk,
        path: pred.path,
        lights,
        lastSeen: performance.now(),
      });
    }

    // Limpieza de objetos perdidos.
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

  // ---------- Bucle de render (60 fps) ----------
  _renderLoop(t) {
    if (!this.running) return;
    this.perf.tickUI();

    // Interpolación temporal: suaviza cajas hacia su objetivo cada frame.
    let maxRisk = RISK.NONE;
    const objects = [];
    for (const o of this.objects.values()) {
      o.box = smoothBox(o.box, o.targetBox, CONFIG.ui.boxSmoothing);
      if (o.risk > maxRisk) maxRisk = o.risk;
      objects.push(o);
    }

    // Día/noche automático con histéresis.
    if (!this.renderer.night && this._lumaEma < CONFIG.ui.nightLumaThreshold) {
      this.renderer.setTone(true, this._lumaEma);
    } else if (this.renderer.night && this._lumaEma > CONFIG.ui.dayLumaThreshold) {
      this.renderer.setTone(false, this._lumaEma);
    }

    // Alertas sonoras según riesgo máximo.
    if (maxRisk > RISK.NONE) this.audio.alert(maxRisk);

    const ego = this.sensors.snapshot();
    this.renderer.render({
      objects,
      ego: { speedKmh: ego.speedKmh, heading: ego.heading, accelLong: ego.accelLong },
      alerts: { level: maxRisk, text: RISK_TEXT[maxRisk] || '' },
      stats: {
        uiFps: this.perf.uiFps, aiFps: this.perf.aiFps,
        backend: this.vision.backend, inputSize: this.perf.inputSize,
      },
    });

    // Telemetría DOM (barato, 1 vez/frame).
    this._updateTelemetry();

    requestAnimationFrame((tt) => this._renderLoop(tt));
  }

  _updateTelemetry() {
    document.getElementById('fpsUI').textContent = `UI ${this.perf.uiFps.toFixed(0)} fps`;
    document.getElementById('fpsAI').textContent = `AI ${this.perf.aiFps.toFixed(0)} fps`;
    document.getElementById('modeTag').textContent =
      (this.renderer.night ? '🌙 noche' : '☀️ día');
  }

  _shutdown() {
    this.running = false;
    this.camera.stop();
    this.sensors.stop();
    this.vision.dispose();
    document.getElementById('stage').classList.add('hidden');
    const start = document.getElementById('startScreen');
    start.classList.remove('hidden');
    document.getElementById('startBtn').disabled = false;
    document.getElementById('startStatus').textContent = 'Detenido. Pulsa para reiniciar.';
  }
}

// Arranque.
window.addEventListener('DOMContentLoaded', () => {
  // Requiere contexto seguro para getUserMedia (https o localhost).
  if (!window.isSecureContext && location.hostname !== 'localhost' &&
      location.hostname !== '127.0.0.1') {
    document.getElementById('startStatus').textContent =
      'Aviso: la cámara requiere HTTPS o localhost.';
  }
  window.__app = new App();

  // Service worker opcional: cachea el shell para ejecución 100% offline.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* offline opcional */ });
  }
});
