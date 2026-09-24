(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // Límites para no agotar la memoria del navegador.
  const MAX_SIDE = 8000;
  const MAX_PIXELS = 40e6;

  const state = {
    name: 'imagen',
    source: null,        // ImageData original
    sourceUrl: null,     // URL de la imagen original (para mostrarla)
    enhanced: null,      // ImageData mejorada
    enhancedBlob: null,
    enhancedUrl: null,
    vector: null,        // resultado de Vectorizer.vectorize (capas)
    edits: { colors: [], hidden: [] },
    svg: null,
    svgUrl: null,
  };

  // ---------------------------------------------------------------------------
  // Utilidades
  let toastTimer = 0;
  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
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
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No se pudo generar el PNG.'))), 'image/png'));
  }

  // Cuando la página se abre dentro de claude.ai, las descargas pasan por el
  // visor (pide confirmación). Fuera de él, se usa un enlace normal.
  const downloadsReady = window.claude && typeof window.claude.use === 'function'
    ? window.claude.use('downloads').catch(() => null)
    : Promise.resolve(null);

  async function download(blob, filename) {
    const saver = await downloadsReady;
    if (saver) {
      try {
        await saver.save({ filename, data: blob });
        toast('Archivo guardado: ' + filename);
      } catch (err) {
        if (err && err.code !== 'declined') toast('No se pudo guardar el archivo. Usa clic derecho → «Guardar imagen».');
      }
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
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
      img.onerror = () => reject(new Error('No se pudo leer la imagen. Prueba con un PNG o JPG.'));
      img.src = url;
    });
  }

  function setUrl(img, key, url) {
    if (state[key]) URL.revokeObjectURL(state[key]);
    state[key] = url;
    img.src = url;
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
  // Procesamiento en segundo plano (Web Worker). La página no se congela y
  // los trabajos se pueden cancelar. Si el navegador no permite workers, se
  // procesa en la página.
  function workerSource() {
    return 'self.Enhancer=(' + Enhancer.factorySource + ')();\n' +
      'self.Vectorizer=(' + Vectorizer.factorySource + ')();\n' +
      'self.onmessage=function(e){var m=e.data;' +
      'var progress=function(f,t){self.postMessage({type:"progress",f:f,t:t});};' +
      'try{var opts=Object.assign({},m.opts,{onProgress:progress});' +
      'if(m.kind==="enhance"){var r=Enhancer.enhance(m.img,opts);self.postMessage({type:"done",result:r},[r.data.buffer]);}' +
      'else{self.postMessage({type:"done",result:Vectorizer.vectorize(m.img,opts)});}}' +
      'catch(err){self.postMessage({type:"error",message:String(err&&err.message||err)});}};';
  }

  let workerUrl = null;
  let workersBroken = false;

  function runInPage(kind, img, opts, onProgress) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        try {
          const o = Object.assign({}, opts, { onProgress });
          resolve(kind === 'enhance' ? Enhancer.enhance(img, o) : Vectorizer.vectorize(img, o));
        } catch (err) { reject(err); }
      }, 30);
    });
  }

  // Cada tarea ("enhance" / "vector") tiene su propio worker; lanzar una tarea
  // nueva cancela la anterior del mismo tipo.
  const jobs = {};
  function runJob(kind, img, opts, onProgress) {
    cancelJob(kind);
    if (workersBroken || typeof Worker === 'undefined') return runInPage(kind, img, opts, onProgress);
    let worker;
    try {
      if (!workerUrl) workerUrl = URL.createObjectURL(new Blob([workerSource()], { type: 'text/javascript' }));
      worker = new Worker(workerUrl);
    } catch (err) {
      workersBroken = true;
      return runInPage(kind, img, opts, onProgress);
    }
    return new Promise((resolve, reject) => {
      const job = { worker, reject, started: false };
      jobs[kind] = job;
      worker.onmessage = (e) => {
        const m = e.data;
        job.started = true;
        if (m.type === 'progress') { onProgress(m.f, m.t); return; }
        worker.terminate();
        if (jobs[kind] === job) delete jobs[kind];
        if (m.type === 'done') resolve(m.result);
        else reject(new Error(m.message));
      };
      worker.onerror = (e) => {
        e.preventDefault();
        worker.terminate();
        if (jobs[kind] === job) delete jobs[kind];
        if (!job.started) {
          // El worker no llegó a arrancar (p. ej. bloqueado por la página): se
          // procesa en la página a partir de ahora.
          workersBroken = true;
          runInPage(kind, img, opts, onProgress).then(resolve, reject);
        } else {
          reject(new Error(e.message || 'Error al procesar la imagen.'));
        }
      };
      worker.postMessage({ kind, img: { width: img.width, height: img.height, data: img.data }, opts });
    });
  }

  function cancelJob(kind) {
    const job = jobs[kind];
    if (!job) return false;
    job.worker.terminate();
    delete jobs[kind];
    const err = new Error('cancelado');
    err.cancelled = true;
    job.reject(err);
    return true;
  }

  function showProgress(prefix, on) {
    $(prefix + '-progress').hidden = !on;
    if (on) { $(prefix + '-progress-bar').style.width = '0%'; $(prefix + '-progress-text').textContent = 'Procesando…'; }
  }
  function progressFor(prefix) {
    return (f, text) => {
      $(prefix + '-progress-bar').style.width = Math.round(f * 100) + '%';
      if (text) $(prefix + '-progress-text').textContent = text;
    };
  }

  // ---------------------------------------------------------------------------
  // Comparador antes/después con zoom
  function setupCompare(prefix) {
    const compare = $(prefix + '-compare');
    const split = $(prefix + '-split');
    const zoom = $(prefix + '-zoom');
    const setPos = (v) => {
      v = Math.max(0, Math.min(100, v));
      compare.style.setProperty('--pos', v + '%');
      split.value = v;
    };
    split.addEventListener('input', () => setPos(Number(split.value)));
    let dragging = false;
    const fromEvent = (e) => {
      const r = compare.getBoundingClientRect();
      setPos(((e.clientX - r.left) / r.width) * 100);
    };
    compare.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      compare.setPointerCapture(e.pointerId);
      fromEvent(e);
    });
    compare.addEventListener('pointermove', (e) => { if (dragging) fromEvent(e); });
    compare.addEventListener('pointerup', () => { dragging = false; });
    compare.addEventListener('pointercancel', () => { dragging = false; });
    zoom.addEventListener('input', () => {
      const stage = $(prefix + '-stage');
      // Mantiene centrado el punto que se estaba viendo.
      const cx = (stage.scrollLeft + stage.clientWidth / 2) / (stage.scrollWidth || 1);
      const cy = (stage.scrollTop + stage.clientHeight / 2) / (stage.scrollHeight || 1);
      compare.style.width = zoom.value + '%';
      $(prefix + '-zoom-v').textContent = zoom.value;
      stage.scrollLeft = cx * stage.scrollWidth - stage.clientWidth / 2;
      stage.scrollTop = cy * stage.scrollHeight - stage.clientHeight / 2;
    });
    setPos(50);
  }
  setupCompare('v');
  setupCompare('e');

  // ---------------------------------------------------------------------------
  // Carga de imágenes
  async function loadBlob(blob, name, sizeLabel) {
    const url = URL.createObjectURL(blob);
    let img;
    try {
      img = await loadImage(url);
    } catch (err) {
      URL.revokeObjectURL(url);
      toast(err.message);
      return false;
    }
    cancelJob('vector');
    cancelJob('enhance');
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    state.source = ctx.getImageData(0, 0, canvas.width, canvas.height);
    if (state.sourceUrl) URL.revokeObjectURL(state.sourceUrl);
    state.sourceUrl = url;
    state.name = (name || 'imagen').replace(/\.[^.]+$/, '') || 'imagen';
    state.enhanced = null;
    state.enhancedBlob = null;
    state.vector = null;
    state.svg = null;

    $('info').textContent = `${name} · ${canvas.width}×${canvas.height} px · ${sizeLabel}`;
    $('e-run').disabled = false;
    $('v-run').disabled = false;
    ['e-download', 'v-download', 'v-copy', 'v-download-png'].forEach((id) => { $(id).disabled = true; });
    $('e-status').textContent = '';
    $('v-status').textContent = '';
    $('v-palette-block').hidden = true;
    $('v-use-enhanced').checked = false;

    for (const prefix of ['v', 'e']) {
      $(prefix + '-before').src = url;
      $(prefix + '-after').src = url;
      $(prefix + '-compare').hidden = false;
      $(prefix + '-placeholder').hidden = true;
    }
    return true;
  }

  function loadFile(file) {
    if (!file || !file.type.startsWith('image/')) {
      toast('Ese archivo no es una imagen. Usa PNG, JPG, WebP, GIF o BMP.');
      return;
    }
    loadBlob(file, file.name || 'Imagen pegada', formatBytes(file.size)).then((ok) => {
      if (ok) runVector();
    });
  }

  const drop = $('drop');
  const fileInput = $('file');
  drop.addEventListener('click', (e) => { if (e.target.id !== 'sample') fileInput.click(); });
  drop.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target === drop) { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener('change', () => { loadFile(fileInput.files[0]); fileInput.value = ''; });
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
  });
  window.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item) loadFile(item.getAsFile());
  });

  // Imagen de ejemplo dibujada al vuelo y guardada como JPEG (con su ruido
  // de compresión), para probar ambas herramientas sin buscar un archivo.
  function makeSample() {
    const c = document.createElement('canvas');
    c.width = 640; c.height = 420;
    const x = c.getContext('2d');
    const sky = x.createLinearGradient(0, 0, 0, 420);
    sky.addColorStop(0, '#2b6c9e'); sky.addColorStop(0.6, '#f2a65a'); sky.addColorStop(1, '#f7d488');
    x.fillStyle = sky; x.fillRect(0, 0, 640, 420);
    x.fillStyle = '#fff3c4'; x.beginPath(); x.arc(470, 190, 62, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#5b4a7a';
    x.beginPath(); x.moveTo(0, 330); x.lineTo(150, 170); x.lineTo(260, 290); x.lineTo(360, 200); x.lineTo(520, 340); x.lineTo(640, 260); x.lineTo(640, 420); x.lineTo(0, 420); x.fill();
    x.fillStyle = '#2f2944';
    x.beginPath(); x.moveTo(0, 380); x.bezierCurveTo(160, 300, 320, 420, 640, 330); x.lineTo(640, 420); x.lineTo(0, 420); x.fill();
    x.fillStyle = '#ffffff';
    x.beginPath(); x.moveTo(150, 170); x.lineTo(185, 208); x.lineTo(165, 200); x.lineTo(150, 214); x.lineTo(132, 196); x.lineTo(118, 205); x.fill();
    x.fillStyle = '#ffffff';
    x.font = 'bold 44px system-ui, sans-serif';
    x.fillText('Atardecer', 36, 70);
    return new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.6));
  }

  $('sample').addEventListener('click', async (e) => {
    e.stopPropagation();
    const blob = await makeSample();
    if (await loadBlob(blob, 'ejemplo.jpg', formatBytes(blob.size))) {
      runVector();
      runEnhance();
    }
  });

  // ---------------------------------------------------------------------------
  // Pestañas
  function selectTab(name) {
    document.querySelectorAll('.tab').forEach((t) => {
      const active = t.dataset.tab === name;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', String(active));
      $('panel-' + t.dataset.tab).hidden = !active;
    });
  }
  document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => selectTab(tab.dataset.tab)));
  if (location.hash === '#mejorar') selectTab('enhance');

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
  const E_MODES = {
    photo:        { denoise: 25, sharpen: 45, sat: 5,  levels: true },
    old:          { denoise: 60, sharpen: 35, sat: 10, levels: true },
    illustration: { denoise: 10, sharpen: 70, sat: 0,  levels: true },
    screen:       { denoise: 0,  sharpen: 80, sat: 0,  levels: false },
  };
  const eOutputs = { denoise: bindOutput('e-denoise'), sharpen: bindOutput('e-sharpen'), sat: bindOutput('e-sat') };
  $('e-mode').addEventListener('change', (e) => {
    const m = E_MODES[e.target.value];
    if (!m) return;
    for (const k of Object.keys(eOutputs)) { $('e-' + k).value = m[k]; eOutputs[k](); }
    $('e-levels').checked = m.levels;
  });
  ['e-denoise', 'e-sharpen', 'e-sat', 'e-levels'].forEach((id) =>
    $(id).addEventListener('input', () => { $('e-mode').value = 'custom'; }));

  async function runEnhance() {
    if (!state.source) return;
    const src = state.source;
    let scale = Number($('e-scale').value);
    const maxScale = Math.min(MAX_SIDE / Math.max(src.width, src.height), Math.sqrt(MAX_PIXELS / (src.width * src.height)));
    let note = '';
    if (scale > maxScale) {
      scale = Math.max(1, Math.floor(maxScale * 100) / 100);
      note = ` · ampliación limitada a ×${scale} por memoria`;
    }
    showProgress('e', true);
    $('e-run').disabled = true;
    const t0 = performance.now();
    try {
      const out = await runJob('enhance', src, {
        scale,
        denoise: Number($('e-denoise').value),
        sharpen: Number($('e-sharpen').value),
        saturation: Number($('e-sat').value),
        autoLevels: $('e-levels').checked,
      }, progressFor('e'));
      if (state.source !== src) return;
      const data = new Uint8ClampedArray(out.data.buffer || out.data);
      const blob = await canvasToBlob(imageDataToCanvas({ width: out.width, height: out.height, data }));
      state.enhanced = new ImageData(data, out.width, out.height);
      state.enhancedBlob = blob;
      setUrl($('e-after'), 'enhancedUrl', URL.createObjectURL(blob));
      $('e-download').disabled = false;
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      $('e-status').textContent = `${src.width}×${src.height} → ${out.width}×${out.height} px · ${formatBytes(blob.size)} · ${secs} s${note}`;
      if ($('v-use-enhanced').checked) scheduleVector();
    } catch (err) {
      if (!err.cancelled) { console.error(err); $('e-status').textContent = 'Error: ' + err.message; }
    } finally {
      if (!jobs.enhance) { showProgress('e', false); $('e-run').disabled = !state.source; }
    }
  }
  $('e-run').addEventListener('click', runEnhance);
  $('e-cancel').addEventListener('click', () => { cancelJob('enhance'); $('e-status').textContent = 'Cancelado.'; });
  $('e-download').addEventListener('click', () => {
    if (state.enhancedBlob) download(state.enhancedBlob, `${state.name}-mejorada.png`);
  });

  // ---------------------------------------------------------------------------
  // Vectorizar
  const PRESETS = {
    logo:         { colors: 6,  size: 1000, speck: 20, tol: 1.0, blur: 0,   corner: 100, smooth: true },
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
  $('v-preset').addEventListener('change', (e) => { applyPreset(e.target.value); scheduleVector(); });
  applyPreset($('v-preset').value);

  // Opciones que requieren volver a vectorizar.
  ['v-colors', 'v-size', 'v-speck', 'v-tol', 'v-blur', 'v-corner', 'v-smooth', 'v-clean'].forEach((id) => {
    $(id).addEventListener('input', () => { $('v-preset').value = 'custom'; });
    $(id).addEventListener('change', scheduleVector);
  });
  $('v-use-enhanced').addEventListener('change', () => {
    if ($('v-use-enhanced').checked && !state.enhanced) {
      toast('Primero mejora la imagen en la pestaña «Mejorar calidad».');
    }
    scheduleVector();
  });
  // Quitar el fondo sólo oculta una capa: no hace falta recalcular.
  $('v-nobg').addEventListener('change', () => { if (state.vector) renderSvg(); });

  let vectorTimer = 0;
  function scheduleVector() {
    if (!state.source || !$('v-auto').checked) return;
    clearTimeout(vectorTimer);
    vectorTimer = setTimeout(runVector, 250);
  }

  async function runVector() {
    if (!state.source) return;
    const source = state.source;
    const useEnhanced = $('v-use-enhanced').checked && state.enhanced;
    const input = useEnhanced ? state.enhanced : source;
    showProgress('v', true);
    const t0 = performance.now();
    try {
      // Resolución de trabajo: reduce las imágenes grandes y amplía las
      // pequeñas (hasta ×4); trazar a más resolución da contornos más precisos.
      const target = Number($('v-size').value);
      const maxSide = Math.max(input.width, input.height);
      let factor = 1;
      if (maxSide > target) factor = target / maxSide;
      else if (maxSide < target * 0.8) factor = Math.min(4, target / maxSide);
      const work = factor === 1 ? input
        : resizeImageData(input, Math.max(1, Math.round(input.width * factor)), Math.max(1, Math.round(input.height * factor)));
      // El tamaño mínimo de mancha se indica en píxeles de la imagen de entrada.
      const minArea = Math.max(1, Math.round(Number($('v-speck').value) * factor * factor));

      const result = await runJob('vector', work, {
        colors: Number($('v-colors').value),
        minArea,
        tolerance: Number($('v-tol').value),
        blur: Number($('v-blur').value),
        cornerAngle: Number($('v-corner').value),
        smooth: $('v-smooth').checked,
        cleanEdges: $('v-clean').checked,
        outWidth: source.width,
        outHeight: source.height,
      }, progressFor('v'));
      if (state.source !== source) return;
      state.vector = result;
      state.edits = { colors: [], hidden: [] };
      state.vectorInfo = {
        secs: ((performance.now() - t0) / 1000).toFixed(1),
        from: useEnhanced ? ' · desde la imagen mejorada' : '',
      };
      renderPalette();
      renderSvg();
    } catch (err) {
      if (!err.cancelled) { console.error(err); $('v-status').textContent = 'Error: ' + err.message; }
    } finally {
      if (!jobs.vector) showProgress('v', false);
    }
  }

  function renderSvg() {
    const v = state.vector;
    const hidden = state.edits.hidden.slice();
    if ($('v-nobg').checked && v.layers.length > 1) hidden[0] = true;
    state.svg = Vectorizer.buildSvg(v, { colors: state.edits.colors, hidden });
    const blob = new Blob([state.svg], { type: 'image/svg+xml' });
    setUrl($('v-after'), 'svgUrl', URL.createObjectURL(blob));
    ['v-download', 'v-copy', 'v-download-png'].forEach((id) => { $(id).disabled = false; });
    const shown = v.layers.length - hidden.filter(Boolean).length;
    $('v-status').textContent =
      `${shown} colores · ${v.nodes.toLocaleString('es')} nodos · ${formatBytes(blob.size)} · ${state.vectorInfo.secs} s${state.vectorInfo.from}`;
    document.querySelectorAll('#v-palette .swatch').forEach((el, i) => el.classList.toggle('off', !!hidden[i]));
  }

  // Muestras de color editables: el cambio se aplica al instante.
  function renderPalette() {
    const box = $('v-palette');
    box.textContent = '';
    state.vector.layers.forEach((layer, i) => {
      const label = document.createElement('label');
      label.className = 'swatch';
      label.title = i === 0 ? 'Color de fondo' : 'Cambiar color';
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.style.background = layer.color;
      const meta = document.createElement('span');
      meta.className = 'meta';
      const hexEl = document.createElement('span');
      hexEl.textContent = layer.color.toUpperCase();
      const pct = document.createElement('span');
      pct.className = 'pct';
      const p = layer.area * 100;
      pct.textContent = (i === 0 ? 'fondo · ' : '') + (p >= 1 ? p.toFixed(0) : p.toFixed(1)) + '%';
      meta.append(hexEl, pct);
      const input = document.createElement('input');
      input.type = 'color';
      input.value = layer.color;
      input.setAttribute('aria-label', 'Color ' + (i + 1));
      input.addEventListener('input', () => {
        state.edits.colors[i] = input.value;
        chip.style.background = input.value;
        hexEl.textContent = input.value.toUpperCase();
        renderSvg();
      });
      label.append(chip, meta, input);
      box.appendChild(label);
    });
    $('v-palette-block').hidden = false;
  }

  $('v-run').addEventListener('click', runVector);
  $('v-cancel').addEventListener('click', () => { cancelJob('vector'); $('v-status').textContent = 'Cancelado.'; });

  $('v-download').addEventListener('click', () => {
    if (state.svg) download(new Blob([state.svg], { type: 'image/svg+xml' }), `${state.name}.svg`);
  });

  $('v-copy').addEventListener('click', () => {
    if (!state.svg) return;
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = state.svg;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      toast(ok ? 'Código SVG copiado.' : 'No se pudo copiar. Usa «Descargar SVG».');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(state.svg).then(() => toast('Código SVG copiado.'), fallback);
    } else {
      fallback();
    }
  });

  // Renderiza el SVG a PNG a mayor resolución (sin pérdida: es vectorial).
  $('v-download-png').addEventListener('click', async () => {
    if (!state.svg) return;
    const { outWidth: width, outHeight: height } = state.vector;
    let scale = Number($('v-png-scale').value);
    scale = Math.min(scale, 16384 / Math.max(width, height), Math.sqrt((MAX_PIXELS * 2) / (width * height)));
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
      toast('Error: ' + err.message);
    } finally {
      URL.revokeObjectURL(url);
    }
  });

  // Arranca con la imagen de ejemplo para que se vea qué hace la herramienta.
  $('sample').click();
})();
