import { wrapDeg, EMA, clamp } from '../util/math.js';

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
export class SensorFusion {
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
