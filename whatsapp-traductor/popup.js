const LANGS = {
  es: "Español", en: "Inglés", pt: "Portugués", fr: "Francés", it: "Italiano",
  de: "Alemán", nl: "Neerlandés", ru: "Ruso", uk: "Ucraniano", pl: "Polaco",
  tr: "Turco", ar: "Árabe", hi: "Hindi", zh: "Chino", ja: "Japonés", ko: "Coreano",
  gn: "Guaraní", ca: "Catalán", ro: "Rumano", el: "Griego", he: "Hebreo",
  id: "Indonesio", vi: "Vietnamita", th: "Tailandés",
};
const DEFAULTS = { myLang: "es", theirLang: "en", autoTranslate: false };

for (const id of ["myLang", "theirLang"]) {
  const sel = document.getElementById(id);
  for (const [code, name] of Object.entries(LANGS)) sel.add(new Option(name, code));
}

chrome.storage.sync.get(DEFAULTS, (s) => {
  for (const id of ["myLang", "theirLang"]) {
    const sel = document.getElementById(id);
    // Si el idioma detectado no está en la lista, lo añadimos.
    if (!LANGS[s[id]]) sel.add(new Option(s[id], s[id]));
    sel.value = s[id];
  }
  document.getElementById("autoTranslate").checked = s.autoTranslate;
});

function save() {
  chrome.storage.sync.set({
    myLang: document.getElementById("myLang").value,
    theirLang: document.getElementById("theirLang").value,
    autoTranslate: document.getElementById("autoTranslate").checked,
  }, () => {
    const el = document.getElementById("saved");
    el.textContent = "✓ Guardado";
    setTimeout(() => (el.textContent = ""), 1200);
  });
}
document.querySelectorAll("select, input").forEach((el) => el.addEventListener("change", save));
