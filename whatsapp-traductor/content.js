const DEFAULTS = { myLang: "es", theirLang: "en", autoTranslate: false };
let settings = { ...DEFAULTS };

chrome.storage.sync.get(DEFAULTS, (s) => {
  settings = s;
  scan();
});
chrome.storage.onChanged.addListener((changes) => {
  for (const [key, { newValue }] of Object.entries(changes)) settings[key] = newValue;
});

function translate(text, target) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "translate", text, target }, (res) => {
      if (res && res.ok) resolve(res);
      else reject(res ? res.error : chrome.runtime.lastError?.message);
    });
  });
}

// ---------- Mensajes recibidos/enviados: botón de traducir ----------

function getMessageText(msgEl) {
  const span = msgEl.querySelector(".copyable-text span.selectable-text, span.selectable-text");
  return span ? span.innerText.trim() : "";
}

async function translateMessage(msgEl, btn) {
  const existing = msgEl.querySelector(".wat-result");
  if (existing) { existing.remove(); return; }

  const text = getMessageText(msgEl);
  if (!text) return;

  const box = document.createElement("div");
  box.className = "wat-result";
  box.textContent = "Traduciendo…";
  (msgEl.querySelector(".copyable-text") || msgEl).appendChild(box);
  if (btn) btn.disabled = true;

  try {
    const res = await translate(text, settings.myLang);
    // Recuerda el idioma del contacto para cuando le respondas.
    if (msgEl.classList.contains("message-in") && res.detected && res.detected !== settings.myLang) {
      settings.theirLang = res.detected;
      chrome.storage.sync.set({ theirLang: res.detected });
    }
    box.textContent = res.text;
    box.title = `Idioma original: ${res.detected}`;
  } catch (e) {
    box.textContent = "Error al traducir: " + e;
    box.classList.add("wat-error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

function addButton(msgEl) {
  if (msgEl.dataset.watDone) return;
  if (!getMessageText(msgEl)) return;
  msgEl.dataset.watDone = "1";

  const btn = document.createElement("button");
  btn.className = "wat-btn";
  btn.textContent = "🌐";
  btn.title = "Traducir mensaje";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    translateMessage(msgEl, btn);
  });
  msgEl.appendChild(btn);

  if (settings.autoTranslate && msgEl.classList.contains("message-in")) {
    translateMessage(msgEl, btn);
  }
}

function scan() {
  document.querySelectorAll("div.message-in, div.message-out").forEach(addButton);
}

new MutationObserver(() => scan()).observe(document.body, { childList: true, subtree: true });

// ---------- Caja de texto: traducir lo que escribes ----------

function getComposer() {
  return document.querySelector('footer div[contenteditable="true"]');
}

function replaceComposerText(el, text) {
  el.focus();
  document.execCommand("selectAll", false, null);
  // Pegar funciona mejor con el editor de WhatsApp que insertText.
  const dt = new DataTransfer();
  dt.setData("text/plain", text);
  const pasted = el.dispatchEvent(
    new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })
  );
  if (pasted) document.execCommand("insertText", false, text); // si nadie manejó el pegado
}

async function translateComposer() {
  const el = getComposer();
  if (!el) return;
  const text = el.innerText.trim();
  if (!text) return;
  const btn = document.querySelector(".wat-compose-btn");
  if (btn) btn.textContent = "⏳";
  try {
    const res = await translate(text, settings.theirLang);
    replaceComposerText(el, res.text);
  } catch (e) {
    alert("Error al traducir: " + e);
  } finally {
    if (btn) btn.textContent = "🌐→";
  }
}

function addComposerButton() {
  const footer = document.querySelector("footer");
  if (!footer || footer.querySelector(".wat-compose-btn")) return;
  const btn = document.createElement("button");
  btn.className = "wat-compose-btn";
  btn.textContent = "🌐→";
  btn.title = "Traducir lo que escribí (Ctrl+Shift+T)";
  btn.addEventListener("click", translateComposer);
  footer.appendChild(btn);
}

new MutationObserver(addComposerButton).observe(document.body, { childList: true, subtree: true });

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "t") {
    e.preventDefault();
    translateComposer();
  }
}, true);

// ---------- Seleccionar texto y traducirlo en un panel lateral ----------

let selBtn = null;
let panel = null;

function getPanel() {
  if (panel) return panel;
  panel = document.createElement("div");
  panel.className = "wat-panel";
  panel.innerHTML = `
    <div class="wat-panel-head">
      <span>🌐 Traducciones</span>
      <button class="wat-panel-clear" title="Borrar todo">🗑</button>
      <button class="wat-panel-close" title="Cerrar">✕</button>
    </div>
    <div class="wat-panel-list"></div>`;
  panel.querySelector(".wat-panel-close").addEventListener("click", () => panel.classList.remove("wat-open"));
  panel.querySelector(".wat-panel-clear").addEventListener("click", () => {
    panel.querySelector(".wat-panel-list").innerHTML = "";
  });
  document.body.appendChild(panel);
  return panel;
}

async function translateToPanel(text) {
  const p = getPanel();
  p.classList.add("wat-open");

  const item = document.createElement("div");
  item.className = "wat-panel-item";
  const original = document.createElement("div");
  original.className = "wat-panel-original";
  original.textContent = text;
  const result = document.createElement("div");
  result.className = "wat-panel-result";
  result.textContent = "Traduciendo…";
  item.append(original, result);
  p.querySelector(".wat-panel-list").prepend(item);

  try {
    const res = await translate(text, settings.myLang);
    result.textContent = res.text;
    original.title = `Idioma original: ${res.detected}`;
    const copy = document.createElement("button");
    copy.className = "wat-panel-copy";
    copy.textContent = "Copiar";
    copy.addEventListener("click", () => {
      navigator.clipboard.writeText(res.text);
      copy.textContent = "✓ Copiado";
      setTimeout(() => (copy.textContent = "Copiar"), 1200);
    });
    item.appendChild(copy);
  } catch (e) {
    result.textContent = "Error al traducir: " + e;
    result.classList.add("wat-error");
  }
}

function hideSelButton() {
  if (selBtn) selBtn.style.display = "none";
}

function showSelButton(text, rect) {
  if (!selBtn) {
    selBtn = document.createElement("button");
    selBtn.className = "wat-sel-btn";
    selBtn.textContent = "🌐 Traducir";
    // Evita que el clic borre la selección antes de leerla.
    selBtn.addEventListener("mousedown", (e) => e.preventDefault());
    selBtn.addEventListener("click", () => {
      hideSelButton();
      translateToPanel(selBtn.dataset.text);
    });
    document.body.appendChild(selBtn);
  }
  selBtn.dataset.text = text;
  selBtn.style.display = "block";
  selBtn.style.top = `${Math.max(rect.top - 36, 4)}px`;
  selBtn.style.left = `${Math.min(rect.left + rect.width / 2 - 45, window.innerWidth - 110)}px`;
}

document.addEventListener("mouseup", (e) => {
  if (selBtn && selBtn.contains(e.target)) return;
  setTimeout(() => {
    const sel = window.getSelection();
    const text = sel ? sel.toString().trim() : "";
    const node = sel && sel.anchorNode;
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    // No mostrar el botón si se selecciona en la caja de texto o en el propio panel.
    if (!text || !el || el.closest('footer, [contenteditable="true"], .wat-panel')) {
      hideSelButton();
      return;
    }
    showSelButton(text, sel.getRangeAt(0).getBoundingClientRect());
  }, 0);
});

document.addEventListener("scroll", hideSelButton, true);
