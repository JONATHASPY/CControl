/*
 * Vectorizador de imágenes rasterizadas a SVG.
 *
 * Pasos:
 *   1. (Opcional) suavizado previo para reducir ruido.
 *   2. Cuantización de color con k-means (k-means++ con semilla fija).
 *   3. Fusión de manchas pequeñas con el color vecino dominante.
 *   4. Trazado de contornos por capas "apiladas" (de mayor a menor área):
 *      cada capa cubre también a las que van encima, así no quedan huecos
 *      entre colores.
 *   5. Simplificación de contornos (Ramer–Douglas–Peucker).
 *   6. Suavizado con curvas Bézier cuadráticas respetando las esquinas.
 *
 * Trabaja sobre objetos tipo ImageData: { width, height, data }.
 */
(function (factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else {
    // El código fuente de la fábrica permite crear un Web Worker sin archivos extra.
    api.factorySource = factory.toString();
    self.Vectorizer = api;
  }
})(function () {
  'use strict';

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // ---------------------------------------------------------------------------
  // 1. Suavizado previo (gaussiano separable sobre RGB).
  function blurRGB(img, sigma) {
    const { width, height, data } = img;
    const radius = Math.max(1, Math.ceil(sigma * 2.5));
    const kernel = new Float32Array(radius * 2 + 1);
    let sum = 0;
    for (let i = -radius; i <= radius; i++) {
      kernel[i + radius] = Math.exp(-(i * i) / (2 * sigma * sigma));
      sum += kernel[i + radius];
    }
    for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;

    const tmp = new Float32Array(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let r = 0, g = 0, b = 0;
        for (let k = -radius; k <= radius; k++) {
          const j = (y * width + clamp(x + k, 0, width - 1)) * 4;
          const w = kernel[k + radius];
          r += data[j] * w; g += data[j + 1] * w; b += data[j + 2] * w;
        }
        const o = (y * width + x) * 3;
        tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = b;
      }
    }
    const out = new Uint8ClampedArray(data.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let r = 0, g = 0, b = 0;
        for (let k = -radius; k <= radius; k++) {
          const j = (clamp(y + k, 0, height - 1) * width + x) * 3;
          const w = kernel[k + radius];
          r += tmp[j] * w; g += tmp[j + 1] * w; b += tmp[j + 2] * w;
        }
        const o = (y * width + x) * 4;
        out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = data[o + 3];
      }
    }
    return { width, height, data: out };
  }

  // ---------------------------------------------------------------------------
  // 2. Cuantización k-means en el espacio de color CIELAB, donde la distancia
  // se parece a la diferencia que percibe el ojo: los colores se agrupan
  // como los agruparía una persona.
  const SRGB_TO_LINEAR = new Float64Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  function labF(t) { return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116; }
  function rgbToLab(r, g, b, out, o) {
    const R = SRGB_TO_LINEAR[r], G = SRGB_TO_LINEAR[g], B = SRGB_TO_LINEAR[b];
    const fx = labF((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
    const fy = labF(0.2126 * R + 0.7152 * G + 0.0722 * B);
    const fz = labF((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
    out[o] = 116 * fy - 16;
    out[o + 1] = 500 * (fx - fy);
    out[o + 2] = 200 * (fy - fz);
  }

  function makeRandom(seed) {
    let s = seed >>> 0;
    return function () {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function quantize(img, k) {
    const { data } = img;
    const n = img.width * img.height;
    const labels = new Int32Array(n).fill(-1);

    const opaque = [];
    for (let p = 0; p < n; p++) if (data[p * 4 + 3] >= 128) opaque.push(p);
    if (opaque.length === 0) return { labels, palette: [] };

    // Muestra (hasta 40 000 píxeles) para el entrenamiento.
    const maxSamples = 40000;
    const step = Math.max(1, Math.floor(opaque.length / maxSamples));
    const sample = [];
    for (let i = 0; i < opaque.length; i += step) {
      const j = opaque[i] * 4;
      sample.push(0, 0, 0);
      rgbToLab(data[j], data[j + 1], data[j + 2], sample, sample.length - 3);
    }
    const m = sample.length / 3;
    k = Math.max(1, Math.min(k, m));

    // Inicialización k-means++.
    const rand = makeRandom(12345);
    const centers = new Float64Array(k * 3);
    const dist = new Float64Array(m).fill(Infinity);
    let first = Math.floor(rand() * m);
    centers[0] = sample[first * 3]; centers[1] = sample[first * 3 + 1]; centers[2] = sample[first * 3 + 2];
    for (let c = 1; c < k; c++) {
      let total = 0;
      const cr = centers[(c - 1) * 3], cg = centers[(c - 1) * 3 + 1], cb = centers[(c - 1) * 3 + 2];
      for (let i = 0; i < m; i++) {
        const dr = sample[i * 3] - cr, dg = sample[i * 3 + 1] - cg, db = sample[i * 3 + 2] - cb;
        const d = dr * dr + dg * dg + db * db;
        if (d < dist[i]) dist[i] = d;
        total += dist[i];
      }
      let pick = 0;
      if (total > 0) {
        let r = rand() * total;
        for (pick = 0; pick < m - 1; pick++) { r -= dist[pick]; if (r <= 0) break; }
      }
      centers[c * 3] = sample[pick * 3]; centers[c * 3 + 1] = sample[pick * 3 + 1]; centers[c * 3 + 2] = sample[pick * 3 + 2];
    }

    function nearest(r, g, b) {
      let best = 0, bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const dr = r - centers[c * 3], dg = g - centers[c * 3 + 1], db = b - centers[c * 3 + 2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD) { bestD = d; best = c; }
      }
      return best;
    }

    // Iteraciones de Lloyd sobre la muestra.
    const sums = new Float64Array(k * 4);
    for (let iter = 0; iter < 12; iter++) {
      sums.fill(0);
      for (let i = 0; i < m; i++) {
        const L = sample[i * 3], A = sample[i * 3 + 1], B = sample[i * 3 + 2];
        const c = nearest(L, A, B);
        sums[c * 4] += L; sums[c * 4 + 1] += A; sums[c * 4 + 2] += B; sums[c * 4 + 3]++;
      }
      let moved = 0;
      for (let c = 0; c < k; c++) {
        const cnt = sums[c * 4 + 3];
        if (cnt === 0) continue;
        for (let ch = 0; ch < 3; ch++) {
          const v = sums[c * 4 + ch] / cnt;
          moved += Math.abs(v - centers[c * 3 + ch]);
          centers[c * 3 + ch] = v;
        }
      }
      if (moved < 0.1) break;
    }

    // Asignación de todos los píxeles (con caché por color).
    const cache = new Map();
    const lab = [0, 0, 0];
    const finalSums = new Float64Array(k * 4);
    for (const p of opaque) {
      const j = p * 4;
      const key = (data[j] << 16) | (data[j + 1] << 8) | data[j + 2];
      let c = cache.get(key);
      if (c === undefined) {
        rgbToLab(data[j], data[j + 1], data[j + 2], lab, 0);
        c = nearest(lab[0], lab[1], lab[2]);
        cache.set(key, c);
      }
      labels[p] = c;
      finalSums[c * 4] += data[j]; finalSums[c * 4 + 1] += data[j + 1]; finalSums[c * 4 + 2] += data[j + 2];
      finalSums[c * 4 + 3]++;
    }

    // Paleta final = color medio real de cada grupo; elimina grupos vacíos.
    const remap = new Int32Array(k).fill(-1);
    const palette = [];
    for (let c = 0; c < k; c++) {
      const cnt = finalSums[c * 4 + 3];
      if (cnt === 0) continue;
      remap[c] = palette.length;
      palette.push([
        Math.round(finalSums[c * 4] / cnt),
        Math.round(finalSums[c * 4 + 1] / cnt),
        Math.round(finalSums[c * 4 + 2] / cnt),
      ]);
    }
    for (let p = 0; p < n; p++) if (labels[p] >= 0) labels[p] = remap[labels[p]];
    return { labels, palette };
  }

  // ---------------------------------------------------------------------------
  // 3. Fusión de manchas pequeñas (componentes 4-conexas).
  function mergeSmallRegions(labels, width, height, minArea) {
    if (minArea <= 1) return;
    const n = width * height;
    const comp = new Int32Array(n);
    const stack = new Int32Array(n);
    const pixels = new Int32Array(n);

    for (let pass = 0; pass < 3; pass++) {
      comp.fill(-1);
      const starts = [], sizes = [];
      let cursor = 0;
      for (let p = 0; p < n; p++) {
        if (comp[p] !== -1 || labels[p] < 0) continue;
        const id = starts.length;
        const lab = labels[p];
        starts.push(cursor);
        let sp = 0;
        stack[sp++] = p;
        comp[p] = id;
        while (sp > 0) {
          const q = stack[--sp];
          pixels[cursor++] = q;
          const x = q % width;
          if (x > 0 && comp[q - 1] === -1 && labels[q - 1] === lab) { comp[q - 1] = id; stack[sp++] = q - 1; }
          if (x < width - 1 && comp[q + 1] === -1 && labels[q + 1] === lab) { comp[q + 1] = id; stack[sp++] = q + 1; }
          if (q >= width && comp[q - width] === -1 && labels[q - width] === lab) { comp[q - width] = id; stack[sp++] = q - width; }
          if (q + width < n && comp[q + width] === -1 && labels[q + width] === lab) { comp[q + width] = id; stack[sp++] = q + width; }
        }
        sizes.push(cursor - starts[id]);
      }

      const small = [];
      for (let id = 0; id < sizes.length; id++) if (sizes[id] < minArea) small.push(id);
      if (small.length === 0) return;
      small.sort((a, b) => sizes[a] - sizes[b]);

      let changed = 0;
      const counts = new Map();
      for (const id of small) {
        const s = starts[id], e = s + sizes[id];
        const own = labels[pixels[s]];
        counts.clear();
        for (let i = s; i < e; i++) {
          const q = pixels[i];
          const x = q % width;
          const nbrs = [
            x > 0 ? q - 1 : -1,
            x < width - 1 ? q + 1 : -1,
            q >= width ? q - width : -1,
            q + width < n ? q + width : -1,
          ];
          for (const r of nbrs) {
            if (r < 0) continue;
            const l = labels[r];
            if (l >= 0 && l !== own) counts.set(l, (counts.get(l) || 0) + 1);
          }
        }
        let best = -1, bestCount = 0;
        for (const [l, c] of counts) if (c > bestCount) { bestCount = c; best = l; }
        if (best < 0) continue;
        for (let i = s; i < e; i++) labels[pixels[i]] = best;
        changed++;
      }
      if (changed === 0) return;
    }
  }

  // ---------------------------------------------------------------------------
  // 3b. Limpieza de bordes. Los bordes suavizados (antialiasing, JPEG) crean
  // franjas finas de colores intermedios que ensucian los contornos.
  // Un píxel de una franja fina (que desaparece con una apertura morfológica
  // 3x3) cuyo color real es una mezcla de dos regiones sólidas vecinas se
  // asigna a la más parecida. Las líneas finas reales (p. ej. una línea negra
  // sobre blanco, con un solo color vecino) se conservan.
  function cleanEdges(labels, img, palette, width, height) {
    const n = width * height;
    const data = img.data;
    // Erosión: el píxel y sus 8 vecinos tienen el mismo color.
    const interior = new Uint8Array(n);
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const p = y * width + x, l = labels[p];
        if (l < 0) continue;
        let ok = 1;
        for (let dy = -1; dy <= 1 && ok; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (labels[p + dy * width + dx] !== l) { ok = 0; break; }
          }
        }
        interior[p] = ok;
      }
    }
    // Dilatación: píxeles que pertenecen a una región de al menos 3 px de grosor.
    const solid = new Uint8Array(n);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x, l = labels[p];
        if (l < 0) continue;
        search:
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= width) continue;
            const q = yy * width + xx;
            if (interior[q] && labels[q] === l) { solid[p] = 1; break search; }
          }
        }
      }
    }

    const src = labels.slice();
    const cand = [];
    let changed = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        const own = src[p];
        if (own < 0 || solid[p]) continue;
        // Colores de las regiones sólidas cercanas (ventana 5x5).
        cand.length = 0;
        for (let dy = -2; dy <= 2; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          for (let dx = -2; dx <= 2; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= width) continue;
            const q = yy * width + xx;
            const l = src[q];
            if (l >= 0 && l !== own && solid[q] && cand.indexOf(l) < 0) cand.push(l);
          }
        }
        if (cand.length === 0) continue;
        const r = data[p * 4], g = data[p * 4 + 1], b = data[p * 4 + 2];
        let best = -1, bestErr = Infinity;
        if (cand.length === 1) {
          // Sólo un vecino: mezcla entre ese color y el propio de la franja?
          // Si el píxel se parece más al vecino que a su propio color, se une.
          const c = palette[cand[0]], o = palette[own];
          const dc = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
          const dO = (r - o[0]) ** 2 + (g - o[1]) ** 2 + (b - o[2]) ** 2;
          if (dc < dO) best = cand[0];
        } else {
          // Busca el par de colores vecinos del que el píxel es una mezcla.
          for (let i = 0; i < cand.length; i++) {
            const A = palette[cand[i]];
            for (let j = i + 1; j < cand.length; j++) {
              const B = palette[cand[j]];
              const ex = B[0] - A[0], ey = B[1] - A[1], ez = B[2] - A[2];
              const len2 = ex * ex + ey * ey + ez * ez;
              if (len2 === 0) continue;
              let t = ((r - A[0]) * ex + (g - A[1]) * ey + (b - A[2]) * ez) / len2;
              if (t < -0.1 || t > 1.1) continue;
              t = clamp(t, 0, 1);
              const fx = A[0] + ex * t - r, fy = A[1] + ey * t - g, fz = A[2] + ez * t - b;
              const err = (fx * fx + fy * fy + fz * fz) / len2;
              if (err < 0.06 && err < bestErr) { bestErr = err; best = t < 0.5 ? cand[i] : cand[j]; }
            }
          }
        }
        if (best >= 0) { labels[p] = best; changed++; }
      }
    }
    return changed;
  }

  // ---------------------------------------------------------------------------
  // 4. Trazado de contornos de una máscara binaria.
  // Los contornos siguen los bordes de los píxeles (en sentido horario en
  // coordenadas de pantalla: el interior queda a la derecha). Se usa la regla
  // de relleno "evenodd", así los agujeros funcionan automáticamente.
  function traceMask(inMask, width, height) {
    const W1 = width + 1;
    const head = new Int32Array(W1 * (height + 1)).fill(-1);
    const eFrom = [], eTo = [], eNext = [];

    function addEdge(from, to) {
      const e = eFrom.length;
      eFrom.push(from); eTo.push(to); eNext.push(head[from]);
      head[from] = e;
    }

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        if (!inMask(p)) continue;
        const tl = y * W1 + x, tr = tl + 1, bl = tl + W1, br = bl + 1;
        if (y === 0 || !inMask(p - width)) addEdge(tl, tr);
        if (x === width - 1 || !inMask(p + 1)) addEdge(tr, br);
        if (y === height - 1 || !inMask(p + width)) addEdge(br, bl);
        if (x === 0 || !inMask(p - 1)) addEdge(bl, tl);
      }
    }

    const used = new Uint8Array(eFrom.length);
    const loops = [];
    for (let start = 0; start < eFrom.length; start++) {
      if (used[start]) continue;
      const verts = [];
      let e = start;
      while (e >= 0 && !used[e]) {
        used[e] = 1;
        verts.push(eFrom[e]);
        const v = eTo[e];
        // Elige la siguiente arista. En vértices "silla" (dos salidas) gira a
        // la derecha, lo que separa píxeles que sólo se tocan en diagonal.
        const inDx = (eTo[e] % W1) - (eFrom[e] % W1);
        const inDy = Math.floor(eTo[e] / W1) - Math.floor(eFrom[e] / W1);
        let next = -1, fallback = -1;
        for (let c = head[v]; c >= 0; c = eNext[c]) {
          if (used[c]) continue;
          const outDx = (eTo[c] % W1) - (eFrom[c] % W1);
          const outDy = Math.floor(eTo[c] / W1) - Math.floor(eFrom[c] / W1);
          if (inDx * outDy - inDy * outDx > 0) { next = c; break; }
          fallback = c;
        }
        e = next >= 0 ? next : fallback;
      }
      const pts = new Array(verts.length * 2);
      for (let i = 0; i < verts.length; i++) {
        pts[i * 2] = verts[i] % W1;
        pts[i * 2 + 1] = (verts[i] / W1) | 0;
      }
      if (pts.length >= 6) loops.push(pts);
    }
    return loops;
  }

  // ---------------------------------------------------------------------------
  // 5a. Suavizado del contorno: promedia cada vértice con sus vecinos
  // (pesos 1-2-1). Convierte las "escaleras" de píxeles en líneas limpias y
  // sólo redondea las esquinas reales una fracción de píxel.
  // Los puntos sobre el borde de la imagen no se separan de él.
  function smoothLoop(pts, passes, width, height) {
    const n = pts.length / 2;
    if (n < 8) return pts;
    const lockX = new Uint8Array(n), lockY = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      lockX[i] = pts[i * 2] === 0 || pts[i * 2] === width ? 1 : 0;
      lockY[i] = pts[i * 2 + 1] === 0 || pts[i * 2 + 1] === height ? 1 : 0;
    }
    let cur = Float64Array.from(pts);
    let next = new Float64Array(cur.length);
    for (let it = 0; it < passes; it++) {
      for (let i = 0; i < n; i++) {
        const a = ((i + n - 1) % n) * 2, b = i * 2, c = ((i + 1) % n) * 2;
        next[b] = lockX[i] ? cur[b] : (cur[a] + 2 * cur[b] + cur[c]) / 4;
        next[b + 1] = lockY[i] ? cur[b + 1] : (cur[a + 1] + 2 * cur[b + 1] + cur[c + 1]) / 4;
      }
      const t = cur; cur = next; next = t;
    }
    return Array.from(cur);
  }

  // ---------------------------------------------------------------------------
  // 5b. Simplificación Ramer–Douglas–Peucker para polígonos cerrados.
  function rdp(pts, first, last, tol2, keep) {
    let maxD = 0, idx = -1;
    const ax = pts[first * 2], ay = pts[first * 2 + 1];
    const bx = pts[last * 2], by = pts[last * 2 + 1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    for (let i = first + 1; i < last; i++) {
      const px = pts[i * 2] - ax, py = pts[i * 2 + 1] - ay;
      let d;
      if (len2 === 0) d = px * px + py * py;
      else { const cr = px * dy - py * dx; d = (cr * cr) / len2; }
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol2 && idx > 0) {
      keep[idx] = 1;
      rdp(pts, first, idx, tol2, keep);
      rdp(pts, idx, last, tol2, keep);
    }
  }

  function simplifyClosed(pts, tolerance) {
    const idx = simplifyClosedIndices(pts, tolerance);
    const out = [];
    for (const i of idx) out.push(pts[i * 2], pts[i * 2 + 1]);
    return out;
  }

  // Devuelve los índices de los vértices que se conservan.
  function simplifyClosedIndices(pts, tolerance) {
    const n = pts.length / 2;
    const all = () => Array.from({ length: n }, (_, i) => i);
    if (n <= 4 || tolerance <= 0) return all();
    // Punto más lejano al primero para dividir el contorno en dos mitades.
    let far = 0, farD = -1;
    for (let i = 1; i < n; i++) {
      const dx = pts[i * 2] - pts[0], dy = pts[i * 2 + 1] - pts[1];
      const d = dx * dx + dy * dy;
      if (d > farD) { farD = d; far = i; }
    }
    const ext = pts.concat([pts[0], pts[1]]);
    const keep = new Uint8Array(n + 1);
    keep[0] = keep[far] = keep[n] = 1;
    const tol2 = tolerance * tolerance;
    rdp(ext, 0, far, tol2, keep);
    rdp(ext, far, n, tol2, keep);
    const out = [];
    for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
    return out.length >= 3 ? out : all();
  }

  // ---------------------------------------------------------------------------
  // 6. Construcción del "d" del path con curvas suaves y esquinas nítidas.
  function fmt(v) {
    const r = Math.round(v * 100) / 100;
    return String(r);
  }

  function loopToPath(pts, smooth, cornerCos) {
    const n = pts.length / 2;
    const P = (i) => [pts[((i + n) % n) * 2], pts[((i + n) % n) * 2 + 1]];
    if (!smooth) {
      let d = 'M' + fmt(pts[0]) + ' ' + fmt(pts[1]);
      for (let i = 1; i < n; i++) d += 'L' + fmt(pts[i * 2]) + ' ' + fmt(pts[i * 2 + 1]);
      return d + 'Z';
    }
    const mid = (i) => { const a = P(i), b = P(i + 1); return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; };
    const m0 = mid(n - 1);
    let d = 'M' + fmt(m0[0]) + ' ' + fmt(m0[1]);
    for (let i = 0; i < n; i++) {
      const prev = P(i - 1), cur = P(i), next = P(i + 1);
      const ax = prev[0] - cur[0], ay = prev[1] - cur[1];
      const bx = next[0] - cur[0], by = next[1] - cur[1];
      const cos = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1);
      const m = mid(i);
      // cos del ángulo interior: si es mayor que el umbral, el ángulo es agudo → esquina.
      if (cos > cornerCos) d += 'L' + fmt(cur[0]) + ' ' + fmt(cur[1]) + 'L' + fmt(m[0]) + ' ' + fmt(m[1]);
      else d += 'Q' + fmt(cur[0]) + ' ' + fmt(cur[1]) + ' ' + fmt(m[0]) + ' ' + fmt(m[1]);
    }
    return d + 'Z';
  }


  // ---------------------------------------------------------------------------
  // 6b. Ajuste de curvas Bézier cúbicas (algoritmo de Philip J. Schneider,
  // "An Algorithm for Automatically Fitting Digitized Curves", Graphics Gems).
  // Se ajustan curvas a los puntos del contorno con un error máximo dado; las
  // esquinas se respetan y en el resto de uniones la tangente es continua.
  function v2sub(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
  function v2add(a, b) { return [a[0] + b[0], a[1] + b[1]]; }
  function v2scale(a, s) { return [a[0] * s, a[1] * s]; }
  function v2dot(a, b) { return a[0] * b[0] + a[1] * b[1]; }
  function v2len(a) { return Math.hypot(a[0], a[1]); }
  function v2norm(a) { const l = v2len(a); return l > 1e-12 ? [a[0] / l, a[1] / l] : [0, 0]; }

  function bezierPoint(bez, t) {
    const mt = 1 - t, a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
    return [
      a * bez[0][0] + b * bez[1][0] + c * bez[2][0] + d * bez[3][0],
      a * bez[0][1] + b * bez[1][1] + c * bez[2][1] + d * bez[3][1],
    ];
  }

  function chordParams(P, first, last) {
    const u = [0];
    for (let i = first + 1; i <= last; i++) u.push(u[u.length - 1] + v2len(v2sub(P[i], P[i - 1])));
    const total = u[u.length - 1] || 1;
    return u.map((x) => x / total);
  }

  function generateBezier(P, first, last, u, t1, t2) {
    const p0 = P[first], p3 = P[last];
    let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
    for (let i = 0; i < u.length; i++) {
      const t = u[i], mt = 1 - t;
      const b0 = mt * mt * mt, b1 = 3 * mt * mt * t, b2 = 3 * mt * t * t, b3 = t * t * t;
      const a1 = v2scale(t1, b1), a2 = v2scale(t2, b2);
      c00 += v2dot(a1, a1); c01 += v2dot(a1, a2); c11 += v2dot(a2, a2);
      const tmp = v2sub(P[first + i], v2add(v2scale(p0, b0 + b1), v2scale(p3, b2 + b3)));
      x0 += v2dot(a1, tmp); x1 += v2dot(a2, tmp);
    }
    const det = c00 * c11 - c01 * c01;
    let alpha1 = 0, alpha2 = 0;
    if (Math.abs(det) > 1e-12) {
      alpha1 = (x0 * c11 - x1 * c01) / det;
      alpha2 = (c00 * x1 - c01 * x0) / det;
    }
    const segLen = v2len(v2sub(p3, p0));
    const eps = 1e-6 * segLen;
    if (!(alpha1 > eps) || !(alpha2 > eps) || alpha1 > segLen * 2 || alpha2 > segLen * 2) {
      alpha1 = alpha2 = segLen / 3; // heurística de Wu/Barsky
    }
    return [p0, v2add(p0, v2scale(t1, alpha1)), v2add(p3, v2scale(t2, alpha2)), p3];
  }

  function maxError(P, first, last, bez, u) {
    let max = 0, split = Math.floor((first + last) / 2);
    for (let i = first + 1; i < last; i++) {
      const d = v2sub(bezierPoint(bez, u[i - first]), P[i]);
      const e = v2dot(d, d);
      if (e >= max) { max = e; split = i; }
    }
    return [max, split];
  }

  // Un paso de Newton-Raphson para afinar el parámetro de cada punto.
  function reparameterize(P, first, bez, u) {
    const d1 = [v2scale(v2sub(bez[1], bez[0]), 3), v2scale(v2sub(bez[2], bez[1]), 3), v2scale(v2sub(bez[3], bez[2]), 3)];
    const d2 = [v2scale(v2sub(d1[1], d1[0]), 2), v2scale(v2sub(d1[2], d1[1]), 2)];
    return u.map((t, i) => {
      const mt = 1 - t;
      const q = bezierPoint(bez, t);
      const q1 = [mt * mt * d1[0][0] + 2 * mt * t * d1[1][0] + t * t * d1[2][0], mt * mt * d1[0][1] + 2 * mt * t * d1[1][1] + t * t * d1[2][1]];
      const q2 = [mt * d2[0][0] + t * d2[1][0], mt * d2[0][1] + t * d2[1][1]];
      const diff = v2sub(q, P[first + i]);
      const den = v2dot(q1, q1) + v2dot(diff, q2);
      if (Math.abs(den) < 1e-12) return t;
      return Math.min(1, Math.max(0, t - v2dot(diff, q1) / den));
    });
  }

  function fitCubic(P, first, last, t1, t2, err2, out, depth) {
    if (last - first === 1 || depth > 24) {
      const dist = v2len(v2sub(P[last], P[first])) / 3;
      out.push([P[first], v2add(P[first], v2scale(t1, dist)), v2add(P[last], v2scale(t2, dist)), P[last]]);
      return;
    }
    let u = chordParams(P, first, last);
    let bez = generateBezier(P, first, last, u, t1, t2);
    let [err, split] = maxError(P, first, last, bez, u);
    if (err < err2) { out.push(bez); return; }
    if (err < err2 * 4) {
      for (let i = 0; i < 4; i++) {
        u = reparameterize(P, first, bez, u);
        bez = generateBezier(P, first, last, u, t1, t2);
        [err, split] = maxError(P, first, last, bez, u);
        if (err < err2) { out.push(bez); return; }
      }
    }
    split = Math.min(last - 1, Math.max(first + 1, split));
    let center = v2norm(v2sub(P[split - 1], P[split + 1]));
    if (center[0] === 0 && center[1] === 0) center = v2norm(v2sub(P[split - 1], P[split]));
    fitCubic(P, first, split, t1, center, err2, out, depth + 1);
    fitCubic(P, split, last, v2scale(center, -1), t2, err2, out, depth + 1);
  }

  /**
   * Convierte un contorno cerrado en un path. `raw` son los vértices del
   * borde de píxeles y `flat` los mismos puntos ya suavizados (mismo orden).
   * Devuelve { d, nodes }.
   */
  function fitLoop(raw, flat, tolerance, cornerCos) {
    const n = flat.length / 2;
    const P = [];
    for (let i = 0; i < n; i++) P.push([flat[i * 2], flat[i * 2 + 1]]);
    // Vértices principales (RDP sobre el contorno sin suavizar) para
    // localizar las esquinas; en ellas se recupera la posición exacta.
    const key = simplifyClosedIndices(raw, Math.max(tolerance, 0.75));
    const m = key.length;
    const corners = [];
    for (let k = 0; k < m; k++) {
      // El ángulo se mide con puntos a unos píxeles de distancia a cada lado:
      // así un escalón de píxeles en una curva no cuenta como esquina, pero
      // una esquina real sí.
      const R = (i) => [raw[(((i % n) + n) % n) * 2], raw[(((i % n) + n) % n) * 2 + 1]];
      const i0 = key[k];
      const reach = Math.max(2, Math.min(Math.round(3 + tolerance * 2), Math.floor(n / 4)));
      const a = R(i0 - reach), b = R(i0), c = R(i0 + reach);
      const u = v2sub(a, b), v = v2sub(c, b);
      const cos = v2dot(u, v) / ((v2len(u) * v2len(v)) || 1);
      if (cos > cornerCos) corners.push(key[k]);
    }
    const isCorner = new Set(corners);
    for (const i of corners) P[i] = [raw[i * 2], raw[i * 2 + 1]];
    // Puntos de corte: todas las esquinas; si hay menos de dos, se añaden
    // vértices principales alejados (uniones suaves).
    let breaks = corners.slice();
    if (breaks.length < 2) {
      const extra = [key[0], key[Math.floor(m / 3)], key[Math.floor((2 * m) / 3)]];
      for (const e of extra) if (!isCorner.has(e) && breaks.indexOf(e) < 0) breaks.push(e);
      breaks.sort((x, y) => x - y);
    }
    const tangentAt = (i, forward) => {
      const at = (j) => P[((j % n) + n) % n];
      if (isCorner.has(i)) {
        // Tangente de un solo lado.
        return forward ? v2norm(v2sub(at(i + 2), at(i))) : v2norm(v2sub(at(i - 2), at(i)));
      }
      const t = v2norm(v2sub(at(i + 2), at(i - 2)));
      return forward ? t : v2scale(t, -1);
    };
    const err2 = Math.max(0.25, tolerance * tolerance);
    const segs = [];
    for (let b = 0; b < breaks.length; b++) {
      const s = breaks[b], e = breaks[(b + 1) % breaks.length];
      const len = e > s ? e - s : e + n - s;
      if (len <= 0) continue;
      const pts = [];
      for (let k = 0; k <= len; k++) pts.push(P[(s + k) % n]);
      if (pts.length === 2) { segs.push([pts[0], pts[0], pts[1], pts[1]]); continue; }
      fitCubic(pts, 0, pts.length - 1, tangentAt(s, true), tangentAt(e, false), err2, segs, 0);
    }
    if (segs.length === 0) return { d: '', nodes: 0 };
    let d = 'M' + fmt(segs[0][0][0]) + ' ' + fmt(segs[0][0][1]);
    for (const z of segs) {
      d += 'C' + fmt(z[1][0]) + ' ' + fmt(z[1][1]) + ' ' + fmt(z[2][0]) + ' ' + fmt(z[2][1]) + ' ' + fmt(z[3][0]) + ' ' + fmt(z[3][1]);
    }
    return { d: d + 'Z', nodes: segs.length };
  }

  function hex(c) {
    return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
  }

  // ---------------------------------------------------------------------------
  /**
   * Construye el SVG a partir de las capas. Se separa de vectorize() para
   * poder cambiar colores u ocultar capas (p. ej. el fondo) sin recalcular.
   * @param {{width:number,height:number,outWidth:number,outHeight:number,layers:Array}} result
   * @param {{colors?:string[], hidden?:boolean[]}} [edits]
   */
  function buildSvg(result, edits) {
    const e = edits || {};
    const body = [];
    result.layers.forEach((layer, i) => {
      if (e.hidden && e.hidden[i]) return;
      const color = (e.colors && e.colors[i]) || layer.color;
      body.push('<path fill="' + color + '" d="' + layer.d + '"/>');
    });
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + result.outWidth + '" height="' + result.outHeight +
      '" viewBox="0 0 ' + result.width + ' ' + result.height + '" fill-rule="evenodd">\n' + body.join('\n') + '\n</svg>\n';
  }

  /**
   * @param {{width:number,height:number,data:Uint8ClampedArray}} img
   * @param {object} opts
   *   colors      número de colores (2..64)
   *   minArea     tamaño mínimo de mancha en píxeles
   *   tolerance   tolerancia de simplificación en píxeles
   *   smooth      bool, usar curvas
   *   cornerAngle ángulo (grados) por debajo del cual un vértice es esquina
   *   blur        sigma del suavizado previo (0 = sin suavizado)
   *   cleanEdges  bool, quitar franjas finas de colores de transición
   *   outWidth / outHeight tamaño del SVG final (por defecto el de la imagen)
   *   onProgress  función (fracción 0..1, texto) opcional
   * @returns {{svg:string, layers:Array<{color:string,d:string,area:number}>,
   *            width:number, height:number, outWidth:number, outHeight:number,
   *            colors:number, nodes:number}}
   *   La primera capa es el fondo; el resto va de mayor a menor área. area es la fracción
   *   de la imagen que ocupa ese color.
   */
  function vectorize(img, opts) {
    const o = Object.assign({
      colors: 16, minArea: 10, tolerance: 0.8, smooth: true, cornerAngle: 100, blur: 0, cleanEdges: true,
      outWidth: img.width, outHeight: img.height, onProgress: null,
    }, opts);
    const progress = (f, text) => { if (o.onProgress) o.onProgress(f, text); };
    const { width, height } = img;
    progress(0, 'Preparando…');
    const src = o.blur > 0 ? blurRGB(img, o.blur) : img;
    progress(0.05, 'Agrupando colores…');
    const { labels, palette } = quantize(src, o.colors);
    progress(0.25, 'Limpiando bordes…');
    if (o.cleanEdges) {
      for (let i = 0; i < 2 && cleanEdges(labels, src, palette, width, height) > 0; i++);
    }
    progress(0.35, 'Eliminando manchas…');
    mergeSmallRegions(labels, width, height, o.minArea);

    // Área de cada color → orden de apilado (el más grande al fondo).
    const area = new Array(palette.length).fill(0);
    for (let p = 0; p < labels.length; p++) if (labels[p] >= 0) area[labels[p]]++;
    // La capa del fondo (el color que más aparece en el borde de la imagen)
    // va siempre la primera; el resto, de mayor a menor área. Así «quitar el
    // fondo» equivale a ocultar la primera capa.
    const border = new Array(palette.length).fill(0);
    const countBorder = (p) => { if (labels[p] >= 0) border[labels[p]]++; };
    for (let x = 0; x < width; x++) { countBorder(x); countBorder((height - 1) * width + x); }
    for (let y = 1; y < height - 1; y++) { countBorder(y * width); countBorder(y * width + width - 1); }
    let bg = -1;
    for (let i = 0; i < palette.length; i++) if (area[i] > 0 && (bg < 0 || border[i] > border[bg])) bg = i;
    const order = palette.map((_, i) => i).filter((i) => area[i] > 0 && i !== bg).sort((a, b) => area[b] - area[a]);
    if (bg >= 0) order.unshift(bg);
    const rank = new Int32Array(palette.length).fill(-1);
    order.forEach((lab, r) => { rank[lab] = r; });
    const pixRank = new Int32Array(labels.length);
    for (let p = 0; p < labels.length; p++) pixRank[p] = labels[p] >= 0 ? rank[labels[p]] : -1;

    const cornerCos = Math.cos((o.cornerAngle * Math.PI) / 180);
    const layers = [];
    let nodeCount = 0;
    for (let r = 0; r < order.length; r++) {
      progress(0.4 + 0.6 * (r / order.length), 'Trazando contornos (' + (r + 1) + '/' + order.length + ')…');
      const loops = traceMask((p) => pixRank[p] >= r, width, height);
      let d = '';
      for (const loop of loops) {
        const dense = o.tolerance > 0 ? smoothLoop(loop, 2, width, height) : loop;
        if (o.smooth && o.tolerance > 0 && dense.length >= 16) {
          const fitted = fitLoop(loop, dense, o.tolerance, cornerCos);
          nodeCount += fitted.nodes;
          d += fitted.d;
        } else {
          const simple = simplifyClosed(dense, o.tolerance);
          nodeCount += simple.length / 2;
          d += loopToPath(simple, false, cornerCos);
        }
      }
      if (!d) continue;
      layers.push({ color: hex(palette[order[r]]), d, area: area[order[r]] / labels.length });
    }
    progress(1, 'Listo');

    const result = {
      layers, width, height, outWidth: o.outWidth, outHeight: o.outHeight,
      colors: layers.length, nodes: nodeCount,
    };
    result.svg = buildSvg(result);
    return result;
  }

  const api = { vectorize, buildSvg, quantize, cleanEdges, mergeSmallRegions, traceMask, simplifyClosed };
  return api;
});
