import { CONFIG } from '../config.js';
import { RISK } from '../prediction/PredictionEngine.js';

/**
 * Sistema de alertas sonoras con Web Audio API.
 * Tonos sintetizados (sin assets) con latencia mínima y distinto carácter
 * según el nivel de riesgo. Incluye cooldown por nivel para no saturar.
 */
export class AlertSystem {
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
