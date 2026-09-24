(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // Límites para no agotar la memoria del navegador.
  const MAX_SIDE = 8000;
  const MAX_PIXELS = 40e6;

  const state = {
    name: 'imagen',
    source: null,      // ImageData original
    sourceUrl: null,   // URL de la imagen original (para mostrarla)
    enhanced: null,    // ImageData mejorada
    enhancedBlob: null,
    svg: null,
    svgSize: null,
  };

  // ---------------------------------------------------------------------------
  // Utilidades
  function setBusy(on, text) {
    $('busy').hidden = !on;
    if (text) $('busy-text').textContent = text;
  }

  // Deja que el navegador pinte el indicador antes de un cálculo pesado.
  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 20)));
  }

  function imageDataToCanvas(img) {
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const data = img.data instanceof Uint8ClampedArray ? img.data : new Uint8ClampedArray(img.data);
    canvas.getContext('2d').putImageData(new ImageData(data, img.width, img.height), 0, 0);
    return canvas;
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No se pudo generar el PNG'))), 'image/png'));
  }

  function download(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('No se pudo leer la imagen'));
      img.src = url;
    });
  }

  // Redimensiona con el escalado de alta calidad del navegador.
  function resizeImageData(img, width, height) {
    const src = imageDataToCanvas(img);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height);
  }

  // ---------------------------------------------------------------------------
  // Carga de imágenes
  async function loadFile(file) {
    if (!file || !file.type.startsWith('image/')) {
      alert('Ese archivo no es una imagen.');
      return;
    }
    const url = URL.createObjectURL(file);
    try {
      const img = await loadImage(url);
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      if (state.sourceUrl) URL.revokeObjectURL(state.sourceUrl);
      state.source = ctx.getImageData(0, 0, canvas.width, canvas.height);
      state.sourceUrl = url;
      state.name = (file.name || 'imagen').replace(/\.[^.]+$/, '') || 'imagen';
      state.enhanced = null;
      state.enhancedBlob = null;
      state.svg = null;

      $('info').textContent = `${file.name || 'Imagen pegada'} · ${canvas.width}×${canvas.height} px · ${formatBytes(file.size)}`;
      $('e-run').disabled = false;
      $('v-run').disabled = false;
      $('e-download').disabled = true;
      $('v-download').disabled = true;
      $('v-download-png').disabled = true;
      $('e-status').textContent = '';
      $('v-status').textContent = '';

      // Vista previa inicial.
      $('e-before').src = url;
      $('e-after').src = url;
      $('e-compare').hidden = false;
      $('e-placeholder').hidden = true;
      $('v-original').src = url;
      $('v-result').removeAttribute('src');
      $('v-side').hidden = false;
      $('v-placeholder').hidden = true;
    } catch (err) {
      URL.revokeObjectURL(url);
      alert(err.message);
    }
  }

  const drop = $('drop');
  const fileInput = $('file');
  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
  fileInput.addEventListener('change', () => { loadFile(fileInput.files[0]); fileInput.value = ''; });
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => loadFile(e.dataTransfer.files[0]));
  // Soltar en cualquier parte de la página también funciona.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });
  window.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item) loadFile(item.getAsFile());
  });

  // ---------------------------------------------------------------------------
  // Pestañas
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => {
        const active = t === tab;
        t.classList.toggle('active', active);
        t.setAttribute('aria-selected', String(active));
        $('panel-' + t.dataset.tab).hidden = !active;
      });
    });
  });

  // Muestra el valor de cada deslizador junto a su etiqueta.
  function bindOutput(id, decimals) {
    const input = $(id), out = $(id + '-v');
    const update = () => { out.textContent = decimals ? Number(input.value).toFixed(decimals) : input.value; };
    input.addEventListener('input', update);
    update();
    return update;
  }

  // ---------------------------------------------------------------------------
  // Mejorar calidad
  bindOutput('e-denoise');
  bindOutput('e-sharpen');
  bindOutput('e-sat');

  const slider = $('e-slider');
  function updateCompare() {
    const v = slider.value;
    $('e-before-wrap').style.clipPath = `inset(0 ${100 - v}% 0 0)`;
    $('e-compare').style.setProperty('--pos', v + '%');
  }
  slider.addEventListener('input', updateCompare);
  updateCompare();

  $('e-run').addEventListener('click', async () => {
    if (!state.source) return;
    const src = state.source;
    let scale = Number($('e-scale').value);
    const maxScale = Math.min(MAX_SIDE / Math.max(src.width, src.height), Math.sqrt(MAX_PIXELS / (src.width * src.height)));
    let note = '';
    if (scale > maxScale) {
      scale = Math.max(1, Math.floor(maxScale * 100) / 100);
      note = ` (ampliación limitada a ×${scale} para no agotar la memoria)`;
    }
    setBusy(true, 'Mejorando la imagen…');
    await nextFrame();
    try {
      const t0 = performance.now();
      const out = Enhancer.enhance(src, {
        scale,
        denoise: Number($('e-denoise').value),
        sharpen: Number($('e-sharpen').value),
        saturation: Number($('e-sat').value),
        autoLevels: $('e-levels').checked,
      });
      const canvas = imageDataToCanvas(out);
      const blob = await canvasToBlob(canvas);
      state.enhanced = new ImageData(out.data, out.width, out.height);
      state.enhancedBlob = blob;
      $('e-after').src = URL.createObjectURL(blob);
      $('e-download').disabled = false;
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      $('e-status').textContent = `Listo en ${secs} s: ${src.width}×${src.height} → ${out.width}×${out.height} px · ${formatBytes(blob.size)}${note}`;
    } catch (err) {
      console.error(err);
      $('e-status').textContent = 'Error: ' + err.message;
    } finally {
      setBusy(false);
    }
  });

  $('e-download').addEventListener('click', () => {
    if (state.enhancedBlob) download(state.enhancedBlob, `${state.name}-mejorada.png`);
  });

  // ---------------------------------------------------------------------------
  // Vectorizar
  const PRESETS = {
    logo:         { colors: 6,  size: 1000, speck: 20, tol: 1.2, blur: 0,   corner: 100, smooth: true },
    illustration: { colors: 16, size: 1000, speck: 10, tol: 0.8, blur: 0.4, corner: 100, smooth: true },
    photo:        { colors: 32, size: 1000, speck: 6,  tol: 0.8, blur: 1.0, corner: 120, smooth: true },
    bw:           { colors: 2,  size: 1200, speck: 15, tol: 0.8, blur: 0.5, corner: 100, smooth: true },
  };

  const vOutputs = {
    colors: bindOutput('v-colors'),
    size: bindOutput('v-size'),
    speck: bindOutput('v-speck'),
    tol: bindOutput('v-tol', 1),
    blur: bindOutput('v-blur', 1),
    corner: bindOutput('v-corner'),
  };

  function applyPreset(name) {
    const p = PRESETS[name];
    if (!p) return;
    for (const key of Object.keys(vOutputs)) {
      $('v-' + key).value = p[key];
      vOutputs[key]();
    }
    $('v-smooth').checked = p.smooth;
  }
  $('v-preset').addEventListener('change', (e) => applyPreset(e.target.value));
  applyPreset($('v-preset').value);
  ['v-colors', 'v-size', 'v-speck', 'v-tol', 'v-blur', 'v-corner', 'v-smooth', 'v-clean'].forEach((id) =>
    $(id).addEventListener('input', () => { $('v-preset').value = 'custom'; }));

  $('v-run').addEventListener('click', async () => {
    if (!state.source) return;
    const useEnhanced = $('v-use-enhanced').checked && state.enhanced;
    const input = useEnhanced ? state.enhanced : state.source;
    setBusy(true, 'Vectorizando…');
    await nextFrame();
    try {
      const t0 = performance.now();
      // Resolución de trabajo: reduce las imágenes grandes y amplía las
      // pequeñas (hasta ×4); trazar a más resolución da contornos más precisos.
      const target = Number($('v-size').value);
      const maxSide = Math.max(input.width, input.height);
      let factor = 1;
      if (maxSide > target) factor = target / maxSide;
      else if (maxSide < target * 0.8) factor = Math.min(4, target / maxSide);
      const work = factor === 1 ? input
        : resizeImageData(input, Math.max(1, Math.round(input.width * factor)), Math.max(1, Math.round(input.height * factor)));
      // El tamaño mínimo de mancha se indica en píxeles de la imagen original.
      const minArea = Math.max(1, Math.round(Number($('v-speck').value) * factor * factor));

      const result = Vectorizer.vectorize(work, {
        colors: Number($('v-colors').value),
        minArea,
        tolerance: Number($('v-tol').value),
        blur: Number($('v-blur').value),
        cornerAngle: Number($('v-corner').value),
        smooth: $('v-smooth').checked,
        cleanEdges: $('v-clean').checked,
        outWidth: state.source.width,
        outHeight: state.source.height,
      });
      state.svg = result.svg;
      state.svgSize = { width: state.source.width, height: state.source.height };
      const blob = new Blob([result.svg], { type: 'image/svg+xml' });
      const old = $('v-result').src;
      $('v-result').src = URL.createObjectURL(blob);
      if (old && old.startsWith('blob:')) URL.revokeObjectURL(old);
      $('v-download').disabled = false;
      $('v-download-png').disabled = false;
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      $('v-status').textContent =
        `Listo en ${secs} s · ${result.colors} colores · ${result.nodes.toLocaleString()} nodos · ${formatBytes(blob.size)}` +
        (useEnhanced ? ' · desde la imagen mejorada' : '');
    } catch (err) {
      console.error(err);
      $('v-status').textContent = 'Error: ' + err.message;
    } finally {
      setBusy(false);
    }
  });

  $('v-download').addEventListener('click', () => {
    if (state.svg) download(new Blob([state.svg], { type: 'image/svg+xml' }), `${state.name}.svg`);
  });

  // Renderiza el SVG a PNG a mayor resolución (sin pérdida: es vectorial).
  $('v-download-png').addEventListener('click', async () => {
    if (!state.svg) return;
    let scale = Number($('v-png-scale').value);
    const { width, height } = state.svgSize;
    scale = Math.min(scale, 16384 / Math.max(width, height), Math.sqrt(MAX_PIXELS * 2 / (width * height)));
    setBusy(true, 'Generando PNG…');
    await nextFrame();
    const url = URL.createObjectURL(new Blob([state.svg], { type: 'image/svg+xml' }));
    try {
      const img = await loadImage(url);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      download(await canvasToBlob(canvas), `${state.name}-${canvas.width}x${canvas.height}.png`);
    } catch (err) {
      console.error(err);
      $('v-status').textContent = 'Error: ' + err.message;
    } finally {
      URL.revokeObjectURL(url);
      setBusy(false);
    }
  });
})();
