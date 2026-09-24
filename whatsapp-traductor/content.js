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
