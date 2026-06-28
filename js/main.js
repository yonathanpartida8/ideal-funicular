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
import { smoothBox } from './util/math.js';

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
export async function startApp({ onStatus } = {}) {
  if (window.__app && window.__app.running) return window.__app;
  const app = new App(onStatus);
  window.__app = app;
  await app.start();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  return app;
}
