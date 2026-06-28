/**
 * Detección de luces de vehículo (faros / pilotos) por análisis de brillo y
 * contraste dentro de la región del bounding box. Sirve como señal auxiliar
 * para mejorar la estimación de distancia de noche (más par de luces brillantes
 * y separadas => coche más cerca / mejor calibración de escala).
 *
 * Trabaja sobre el ImageData reducido del frame (no sobre el video completo)
 * para mantener el coste despreciable.
 */
export class LightDetector {
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
