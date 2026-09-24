// Hace la petición de traducción desde el service worker para evitar problemas de CORS.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== "translate") return;
  translate(msg.text, msg.target, msg.source || "auto")
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((err) => sendResponse({ ok: false, error: String(err) }));
  return true; // respuesta asíncrona
});

async function translate(text, target, source) {
  const url =
    "https://translate.googleapis.com/translate_a/single?client=gtx&dt=t" +
    `&sl=${encodeURIComponent(source)}&tl=${encodeURIComponent(target)}` +
    `&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const translated = data[0].map((part) => part[0]).join("");
  return { text: translated, detected: data[2] };
}
