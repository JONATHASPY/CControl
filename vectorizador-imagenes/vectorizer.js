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
(function (root) {
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
  // 2. Cuantización k-means.
  // Distancia con pesos aproximadamente perceptuales.
  const WR = 2, WG = 4, WB = 3;

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
      sample.push(data[j], data[j + 1], data[j + 2]);
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
        const d = WR * dr * dr + WG * dg * dg + WB * db * db;
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
        const d = WR * dr * dr + WG * dg * dg + WB * db * db;
        if (d < bestD) { bestD = d; best = c; }
      }
      return best;
    }

    // Iteraciones de Lloyd sobre la muestra.
    const sums = new Float64Array(k * 4);
    for (let iter = 0; iter < 12; iter++) {
      sums.fill(0);
      for (let i = 0; i < m; i++) {
        const r = sample[i * 3], g = sample[i * 3 + 1], b = sample[i * 3 + 2];
        const c = nearest(r, g, b);
        sums[c * 4] += r; sums[c * 4 + 1] += g; sums[c * 4 + 2] += b; sums[c * 4 + 3]++;
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
      if (moved < 0.5) break;
    }

    // Asignación de todos los píxeles (con caché por color).
    const cache = new Map();
    const finalSums = new Float64Array(k * 4);
    for (const p of opaque) {
      const j = p * 4;
      const key = (data[j] << 16) | (data[j + 1] << 8) | data[j + 2];
      let c = cache.get(key);
      if (c === undefined) { c = nearest(data[j], data[j + 1], data[j + 2]); cache.set(key, c); }
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
  function smoothLoop(pts, passes) {
    const n = pts.length / 2;
    if (n < 8) return pts;
    let cur = Float64Array.from(pts);
    let next = new Float64Array(cur.length);
    for (let it = 0; it < passes; it++) {
      for (let i = 0; i < n; i++) {
        const a = ((i + n - 1) % n) * 2, b = i * 2, c = ((i + 1) % n) * 2;
        next[b] = (cur[a] + 2 * cur[b] + cur[c]) / 4;
        next[b + 1] = (cur[a + 1] + 2 * cur[b + 1] + cur[c + 1]) / 4;
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
    const n = pts.length / 2;
    if (n <= 4 || tolerance <= 0) return pts;
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
    for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i * 2], pts[i * 2 + 1]);
    return out.length >= 6 ? out : pts;
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

  function hex(c) {
    return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
  }

  // ---------------------------------------------------------------------------
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
   * @returns {{svg:string, colors:number, paths:number, nodes:number}}
   */
  function vectorize(img, opts) {
    const o = Object.assign({
      colors: 16, minArea: 10, tolerance: 0.8, smooth: true, cornerAngle: 100, blur: 0, cleanEdges: true,
      outWidth: img.width, outHeight: img.height,
    }, opts);
    const { width, height } = img;
    const src = o.blur > 0 ? blurRGB(img, o.blur) : img;
    const { labels, palette } = quantize(src, o.colors);
    if (o.cleanEdges) {
      for (let i = 0; i < 2 && cleanEdges(labels, src, palette, width, height) > 0; i++);
    }
    mergeSmallRegions(labels, width, height, o.minArea);

    // Área de cada color → orden de apilado (el más grande al fondo).
    const area = new Array(palette.length).fill(0);
    for (let p = 0; p < labels.length; p++) if (labels[p] >= 0) area[labels[p]]++;
    const order = palette.map((_, i) => i).filter((i) => area[i] > 0).sort((a, b) => area[b] - area[a]);
    const rank = new Int32Array(palette.length).fill(-1);
    order.forEach((lab, r) => { rank[lab] = r; });
    const pixRank = new Int32Array(labels.length);
    for (let p = 0; p < labels.length; p++) pixRank[p] = labels[p] >= 0 ? rank[labels[p]] : -1;

    const cornerCos = Math.cos((o.cornerAngle * Math.PI) / 180);
    const body = [];
    let pathCount = 0, nodeCount = 0;
    for (let r = 0; r < order.length; r++) {
      const loops = traceMask((p) => pixRank[p] >= r, width, height);
      let d = '';
      for (const loop of loops) {
        const simple = simplifyClosed(o.tolerance > 0 ? smoothLoop(loop, 2) : loop, o.tolerance);
        nodeCount += simple.length / 2;
        d += loopToPath(simple, o.smooth, cornerCos);
      }
      if (!d) continue;
      pathCount++;
      body.push('<path fill="' + hex(palette[order[r]]) + '" d="' + d + '"/>');
    }

    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + o.outWidth + '" height="' + o.outHeight +
      '" viewBox="0 0 ' + width + ' ' + height + '" fill-rule="evenodd">\n' + body.join('\n') + '\n</svg>\n';
    return { svg, colors: order.length, paths: pathCount, nodes: nodeCount };
  }

  const api = { vectorize, quantize, cleanEdges, mergeSmallRegions, traceMask, simplifyClosed };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Vectorizer = api;
})(typeof self !== 'undefined' ? self : this);
