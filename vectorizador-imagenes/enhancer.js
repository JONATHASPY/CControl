/*
 * Mejora de calidad de imagen (sin IA, algoritmos clásicos):
 *   1. Reducción de ruido con filtro bilateral (conserva los bordes).
 *   2. Ampliación con remuestreo Lanczos-3 (más nítido que bicúbico).
 *   3. Enfoque con máscara de desenfoque (unsharp mask).
 *   4. Ajuste automático de niveles y saturación.
 *
 * Trabaja sobre objetos tipo ImageData: { width, height, data }.
 */
(function (root) {
  'use strict';

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // ---------------------------------------------------------------------------
  // Conversión a flotantes con alfa premultiplicado (evita halos en bordes
  // transparentes al filtrar).
  function toPremultipliedFloat(img) {
    const n = img.width * img.height;
    const src = img.data;
    const out = new Float32Array(n * 4);
    for (let i = 0; i < n * 4; i += 4) {
      const a = src[i + 3] / 255;
      out[i] = src[i] * a;
      out[i + 1] = src[i + 1] * a;
      out[i + 2] = src[i + 2] * a;
      out[i + 3] = src[i + 3];
    }
    return out;
  }

  function fromPremultipliedFloat(buf, width, height) {
    const n = width * height;
    const out = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n * 4; i += 4) {
      const a = clamp(buf[i + 3], 0, 255);
      out[i + 3] = a;
      if (a > 0) {
        const k = 255 / a;
        out[i] = buf[i] * k;
        out[i + 1] = buf[i + 1] * k;
        out[i + 2] = buf[i + 2] * k;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Filtro bilateral 5x5: suaviza zonas planas sin difuminar los bordes.
  function bilateral(buf, width, height, strength) {
    const radius = 2;
    const sigmaS = 1.6;
    const sigmaR = 4 + strength * 0.5; // 0..100 -> 4..54 niveles
    const spatial = [];
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        spatial.push(Math.exp(-(dx * dx + dy * dy) / (2 * sigmaS * sigmaS)));
      }
    }
    const rangeLut = new Float32Array(256 * 3 + 1);
    for (let d = 0; d < rangeLut.length; d++) {
      rangeLut[d] = Math.exp(-(d * d) / (2 * sigmaR * sigmaR * 3));
    }
    const out = new Float32Array(buf.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const r0 = buf[i], g0 = buf[i + 1], b0 = buf[i + 2];
        let sr = 0, sg = 0, sb = 0, sa = 0, sw = 0, k = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          const yy = clamp(y + dy, 0, height - 1);
          for (let dx = -radius; dx <= radius; dx++, k++) {
            const xx = clamp(x + dx, 0, width - 1);
            const j = (yy * width + xx) * 4;
            const diff = Math.abs(buf[j] - r0) + Math.abs(buf[j + 1] - g0) + Math.abs(buf[j + 2] - b0);
            const w = spatial[k] * rangeLut[diff < 768 ? diff | 0 : 768];
            sr += buf[j] * w; sg += buf[j + 1] * w; sb += buf[j + 2] * w; sa += buf[j + 3] * w;
            sw += w;
          }
        }
        out[i] = sr / sw; out[i + 1] = sg / sw; out[i + 2] = sb / sw; out[i + 3] = sa / sw;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Remuestreo Lanczos-3 separable.
  function sinc(x) {
    if (x === 0) return 1;
    x *= Math.PI;
    return Math.sin(x) / x;
  }

  function lanczosKernel(x, a) {
    return x > -a && x < a ? sinc(x) * sinc(x / a) : 0;
  }

  function buildWeights(srcLen, dstLen, a) {
    const scale = dstLen / srcLen;
    const filterScale = scale < 1 ? 1 / scale : 1; // se ensancha al reducir
    const support = a * filterScale;
    const taps = Math.ceil(support) * 2 + 1;
    const index = new Int32Array(dstLen * taps);
    const weight = new Float32Array(dstLen * taps);
    for (let i = 0; i < dstLen; i++) {
      const center = (i + 0.5) / scale - 0.5;
      const start = Math.floor(center - support) + 1;
      let sum = 0;
      for (let t = 0; t < taps; t++) {
        const j = start + t;
        const w = lanczosKernel((j - center) / filterScale, a);
        index[i * taps + t] = clamp(j, 0, srcLen - 1);
        weight[i * taps + t] = w;
        sum += w;
      }
      for (let t = 0; t < taps; t++) weight[i * taps + t] /= sum;
    }
    return { index, weight, taps };
  }

  function resampleLanczos(buf, width, height, newWidth, newHeight) {
    const wx = buildWeights(width, newWidth, 3);
    const wy = buildWeights(height, newHeight, 3);

    // Pasada horizontal: width x height -> newWidth x height
    const tmp = new Float32Array(newWidth * height * 4);
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < newWidth; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        const base = x * wx.taps;
        for (let t = 0; t < wx.taps; t++) {
          const w = wx.weight[base + t];
          if (w === 0) continue;
          const j = (row + wx.index[base + t]) * 4;
          r += buf[j] * w; g += buf[j + 1] * w; b += buf[j + 2] * w; a += buf[j + 3] * w;
        }
        const o = (y * newWidth + x) * 4;
        tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = b; tmp[o + 3] = a;
      }
    }

    // Pasada vertical: newWidth x height -> newWidth x newHeight
    const out = new Float32Array(newWidth * newHeight * 4);
    for (let y = 0; y < newHeight; y++) {
      const base = y * wy.taps;
      for (let x = 0; x < newWidth; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let t = 0; t < wy.taps; t++) {
          const w = wy.weight[base + t];
          if (w === 0) continue;
          const j = (wy.index[base + t] * newWidth + x) * 4;
          r += tmp[j] * w; g += tmp[j + 1] * w; b += tmp[j + 2] * w; a += tmp[j + 3] * w;
        }
        const o = (y * newWidth + x) * 4;
        // Recorta el "ringing" de Lanczos y mantiene color <= alfa.
        const alpha = clamp(a, 0, 255);
        out[o + 3] = alpha;
        out[o] = clamp(r, 0, alpha);
        out[o + 1] = clamp(g, 0, alpha);
        out[o + 2] = clamp(b, 0, alpha);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Desenfoque gaussiano separable de un solo canal (usado por el enfoque).
  function gaussianBlurChannel(src, width, height, sigma) {
    const radius = Math.max(1, Math.ceil(sigma * 3));
    const kernel = new Float32Array(radius * 2 + 1);
    let sum = 0;
    for (let i = -radius; i <= radius; i++) {
      kernel[i + radius] = Math.exp(-(i * i) / (2 * sigma * sigma));
      sum += kernel[i + radius];
    }
    for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;

    const tmp = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        let acc = 0;
        for (let k = -radius; k <= radius; k++) {
          acc += src[row + clamp(x + k, 0, width - 1)] * kernel[k + radius];
        }
        tmp[row + x] = acc;
      }
    }
    const out = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let acc = 0;
        for (let k = -radius; k <= radius; k++) {
          acc += tmp[clamp(y + k, 0, height - 1) * width + x] * kernel[k + radius];
        }
        out[y * width + x] = acc;
      }
    }
    return out;
  }

  // Unsharp mask sobre la luminancia: realza detalles sin crear halos de color.
  function unsharpMask(buf, width, height, amount, sigma) {
    const n = width * height;
    const luma = new Float32Array(n);
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      luma[p] = 0.299 * buf[i] + 0.587 * buf[i + 1] + 0.114 * buf[i + 2];
    }
    const blurred = gaussianBlurChannel(luma, width, height, sigma);
    const threshold = 1.5; // no amplifica el ruido muy fino
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      let d = luma[p] - blurred[p];
      if (d > -threshold && d < threshold) continue;
      d *= amount;
      const a = buf[i + 3];
      buf[i] = clamp(buf[i] + d, 0, a);
      buf[i + 1] = clamp(buf[i + 1] + d, 0, a);
      buf[i + 2] = clamp(buf[i + 2] + d, 0, a);
    }
  }

  // ---------------------------------------------------------------------------
  // Niveles automáticos (mismo estiramiento en los 3 canales: sin dominantes).
  function autoLevels(data) {
    const hist = new Uint32Array(256);
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue;
      const l = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) | 0;
      hist[l]++;
      count++;
    }
    if (count === 0) return;
    const cut = count * 0.005;
    let lo = 0, hi = 255, acc = 0;
    for (; lo < 255; lo++) { acc += hist[lo]; if (acc > cut) break; }
    acc = 0;
    for (; hi > 0; hi--) { acc += hist[hi]; if (acc > cut) break; }
    if (hi - lo < 16 || (lo < 3 && hi > 252)) return;
    const k = 255 / (hi - lo);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = (data[i] - lo) * k;
      data[i + 1] = (data[i + 1] - lo) * k;
      data[i + 2] = (data[i + 2] - lo) * k;
    }
  }

  function adjustSaturation(data, amount) {
    const f = 1 + amount / 100;
    for (let i = 0; i < data.length; i += 4) {
      const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      data[i] = l + (data[i] - l) * f;
      data[i + 1] = l + (data[i + 1] - l) * f;
      data[i + 2] = l + (data[i + 2] - l) * f;
    }
  }

  // ---------------------------------------------------------------------------
  /**
   * @param {{width:number,height:number,data:Uint8ClampedArray}} img
   * @param {object} opts
   *   scale      factor de ampliación (1..4)
   *   denoise    0..100 reducción de ruido
   *   sharpen    0..100 nitidez
   *   autoLevels bool   mejorar contraste
   *   saturation -50..50
   * @returns {{width:number,height:number,data:Uint8ClampedArray}}
   */
  function enhance(img, opts) {
    const o = Object.assign({ scale: 2, denoise: 20, sharpen: 50, autoLevels: true, saturation: 0 }, opts);
    const width = img.width, height = img.height;
    const newWidth = Math.max(1, Math.round(width * o.scale));
    const newHeight = Math.max(1, Math.round(height * o.scale));

    let buf = toPremultipliedFloat(img);
    if (o.denoise > 0) buf = bilateral(buf, width, height, o.denoise);
    if (newWidth !== width || newHeight !== height) {
      buf = resampleLanczos(buf, width, height, newWidth, newHeight);
    }
    if (o.sharpen > 0) {
      const sigma = 0.7 + 0.35 * Math.max(1, o.scale);
      unsharpMask(buf, newWidth, newHeight, (o.sharpen / 100) * 1.6, sigma);
    }
    const data = fromPremultipliedFloat(buf, newWidth, newHeight);
    if (o.autoLevels) autoLevels(data);
    if (o.saturation) adjustSaturation(data, o.saturation);
    return { width: newWidth, height: newHeight, data };
  }

  const api = { enhance, resampleLanczos, toPremultipliedFloat, fromPremultipliedFloat };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Enhancer = api;
})(typeof self !== 'undefined' ? self : this);
