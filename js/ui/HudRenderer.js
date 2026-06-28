import { CONFIG } from '../config.js';
import { RISK } from '../prediction/PredictionEngine.js';
import { catmullRom, clamp } from '../util/math.js';

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

export class HudRenderer {
  constructor(glCanvas, hudCanvas, video) {
    this.glCanvas = glCanvas;
    this.hudCanvas = hudCanvas;
    this.video = video;
    this.ctx2d = hudCanvas.getContext('2d');
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.night = false;
    this._tone = { brightness: 1.0, contrast: 1.0, gamma: 1.0 };
    this._initGL();
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
    if (this.glFailed) return;
    this._cover = this._coverParams();
    this._drawVideoGL();
    this._drawGeometryGL(frame);
    this._drawOverlay2D(frame);
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
    this._drawAlertBanner(ctx, frame.alerts);
    this._drawStats(ctx, frame.stats);
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
