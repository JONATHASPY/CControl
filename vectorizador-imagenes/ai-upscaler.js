/*
 * Ampliación con inteligencia artificial (superresolución).
 *
 * Usa una red neuronal RRDN entrenada como GAN con el conjunto DIV2K
 * (modelo "gans" de UpscalerJS / idealo ISR, licencia MIT) que se ejecuta
 * con TensorFlow.js en la tarjeta gráfica del navegador (WebGL).
 * A diferencia de la ampliación clásica, la red reconstruye bordes y
 * texturas nítidas que la interpolación sólo puede difuminar, y además
 * limpia los artefactos de compresión JPEG. Siempre amplía ×4; para otros
 * tamaños se reduce después el resultado.
 *
 * La imagen se procesa por bloques (con margen solapado para que no se vean
 * las uniones), así funciona con imágenes grandes y se puede cancelar.
 */
(function () {
  'use strict';

  // Primero la copia local (funciona sin internet); si no está disponible,
  // se descarga de jsDelivr.
  const TF_SOURCES = [
    'vendor/tf.min.js',
    'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js',
  ];
  const TILE = 96;   // tamaño de bloque (en píxeles de entrada)
  const PAD = 10;    // margen de contexto alrededor de cada bloque

  // El modelo (topología + pesos en base64) va en un .js: se carga con una
  // etiqueta <script> (funciona incluso abriendo index.html con doble clic)
  // o, si la página no permite ese script, leyendo el mismo archivo con fetch.
  const MODEL_FILE = 'models/esrgan-gans-x4.js';
  const MODEL_GLOBAL = 'ESRGAN_GANS_X4';
  const SCALE = 4;

  let tfPromise = null;

  // Capas propias del modelo GAN (RRDN): se registran una vez.
  let customRegistered = false;
  function registerCustomLayers(tf) {
    if (customRegistered) return;
    customRegistered = true;
    const pick = (inputs) => (Array.isArray(inputs) ? inputs[0] : inputs);
    class MultiplyBeta extends tf.layers.Layer {
      constructor(config) { super(config || {}); this.beta = 0.2; }
      call(inputs) { return tf.mul(pick(inputs), this.beta); }
      static get className() { return 'MultiplyBeta'; }
    }
    class PixelShuffle4x extends tf.layers.Layer {
      constructor(config) { super(config || {}); }
      computeOutputShape(s) { return [s[0], s[1] == null ? null : s[1] * 4, s[2] == null ? null : s[2] * 4, 3]; }
      call(inputs) { return tf.depthToSpace(pick(inputs), 4, 'NHWC'); }
      static get className() { return 'PixelShuffle4x'; }
    }
    tf.serialization.registerClass(MultiplyBeta);
    tf.serialization.registerClass(PixelShuffle4x);
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { s.remove(); reject(new Error('No se pudo cargar ' + src)); };
      document.head.appendChild(s);
    });
  }

  function loadTf() {
    if (!tfPromise) {
      tfPromise = (async () => {
        for (const src of TF_SOURCES) {
          if (window.tf) break;
          try { await loadScript(src); } catch (e) { /* se prueba la siguiente */ }
        }
        const tf = window.tf;
        if (!tf) throw new Error('No se pudo cargar el motor de IA. Comprueba tu conexión a internet.');
        try {
          if (!(await tf.setBackend('webgl'))) throw new Error('sin WebGL');
        } catch (e) {
          await tf.setBackend('cpu');
        }
        await tf.ready();
        return tf;
      })().catch((err) => { tfPromise = null; throw err; });
    }
    return tfPromise;
  }

  async function readModelFile() {
    if (!window[MODEL_GLOBAL]) {
      try { await loadScript(MODEL_FILE); } catch (e) { /* se prueba con fetch */ }
    }
    if (window[MODEL_GLOBAL]) return window[MODEL_GLOBAL];
    const res = await fetch(MODEL_FILE);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    return JSON.parse(text.slice(text.indexOf('=') + 1, text.lastIndexOf(';')));
  }

  function base64ToBuffer(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  let modelPromise = null;
  function loadModel(tf) {
    if (!modelPromise) {
      registerCustomLayers(tf);
      modelPromise = (async () => {
        const m = await readModelFile();
        const model = await tf.loadLayersModel(tf.io.fromMemory({
          modelTopology: m.modelTopology,
          weightSpecs: m.weightSpecs,
          weightData: base64ToBuffer(m.weights),
          format: m.format,
          generatedBy: m.generatedBy,
          convertedBy: m.convertedBy,
        }));
        m.weights = null; // libera la copia en texto
        return model;
      })().catch((err) => {
        modelPromise = null;
        throw new Error('No se pudo cargar el modelo de IA (' + err.message + ').');
      });
    }
    return modelPromise;
  }

  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

  /**
   * @param {{width:number,height:number,data:Uint8ClampedArray}} img
   * Amplía ×4.
   * @param {{onProgress?:(f:number,text:string)=>void, isCancelled?:()=>boolean}} [opts]
   * @returns {Promise<{width:number,height:number,data:Uint8ClampedArray, backend:string}>}
   */
  async function upscale(img, opts) {
    const scale = SCALE;
    const o = opts || {};
    const progress = (f, t) => { if (o.onProgress) o.onProgress(f, t); };
    const cancelled = () => o.isCancelled && o.isCancelled();

    progress(0, 'Cargando el motor de IA…');
    const tf = await loadTf();
    progress(0.02, 'Cargando el modelo de IA…');
    const model = await loadModel(tf);
    const range = 1; // la red trabaja con valores 0..1

    const { width: W, height: H, data } = img;
    const OW = W * scale, OH = H * scale;
    const out = new Uint8ClampedArray(OW * OH * 4);

    const cols = Math.ceil(W / TILE), rows = Math.ceil(H / TILE);
    const total = cols * rows;
    let done = 0;
    const t0 = performance.now();

    for (let ty = 0; ty < H; ty += TILE) {
      for (let tx = 0; tx < W; tx += TILE) {
        if (cancelled()) { const e = new Error('cancelado'); e.cancelled = true; throw e; }
        const x0 = Math.max(0, tx - PAD), y0 = Math.max(0, ty - PAD);
        const x1 = Math.min(W, tx + TILE + PAD), y1 = Math.min(H, ty + TILE + PAD);
        const w = x1 - x0, h = y1 - y0;
        const buf = new Float32Array(w * h * 3);
        const k = range / 255;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const s = ((y0 + y) * W + (x0 + x)) * 4, d = (y * w + x) * 3;
            buf[d] = data[s] * k; buf[d + 1] = data[s + 1] * k; buf[d + 2] = data[s + 2] * k;
          }
        }
        const result = tf.tidy(() => model.predict(tf.tensor4d(buf, [1, h, w, 3])));
        const pix = await result.data();
        result.dispose();

        // Copia sólo la parte central del bloque (sin el margen).
        const cx0 = tx - x0, cy0 = ty - y0;
        const cw = Math.min(TILE, W - tx), ch = Math.min(TILE, H - ty);
        const rw = w * scale;
        const inv = 255 / range;
        for (let y = 0; y < ch * scale; y++) {
          const srcRow = (cy0 * scale + y) * rw + cx0 * scale;
          const dstRow = (ty * scale + y) * OW + tx * scale;
          for (let x = 0; x < cw * scale; x++) {
            const s = (srcRow + x) * 3, d = (dstRow + x) * 4;
            out[d] = pix[s] * inv; out[d + 1] = pix[s + 1] * inv; out[d + 2] = pix[s + 2] * inv; out[d + 3] = 255;
          }
        }

        done++;
        const elapsed = (performance.now() - t0) / 1000;
        const left = Math.max(0, Math.round((elapsed / done) * (total - done)));
        progress(0.05 + 0.95 * (done / total),
          'IA: bloque ' + done + ' de ' + total + (done > 1 && left > 0 ? ' · faltan ~' + left + ' s' : ''));
        await nextFrame();
      }
    }

    // Transparencia: se amplía el canal alfa con Lanczos (la red sólo ve RGB).
    let hasAlpha = false;
    for (let i = 3; i < data.length; i += 4) if (data[i] < 255) { hasAlpha = true; break; }
    if (hasAlpha && window.Enhancer) {
      const alphaOnly = { width: W, height: H, data: new Uint8ClampedArray(data.length) };
      for (let i = 0; i < data.length; i += 4) {
        alphaOnly.data[i] = alphaOnly.data[i + 1] = alphaOnly.data[i + 2] = 255;
        alphaOnly.data[i + 3] = data[i + 3];
      }
      const up = window.Enhancer.enhance(alphaOnly, { scale, denoise: 0, sharpen: 0, autoLevels: false, saturation: 0 });
      for (let i = 3; i < out.length; i += 4) out[i] = up.data[i];
    }

    return { width: OW, height: OH, data: out, backend: tf.getBackend() };
  }

  window.AIUpscaler = { upscale, preload: loadTf, SCALE };
})();
