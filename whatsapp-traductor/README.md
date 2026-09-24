# 🌐 Traductor para WhatsApp Web

Extensión sencilla para Chrome / Edge / Brave que traduce los mensajes de
WhatsApp Web directamente en el chat.

## Qué hace

- **Traducir mensajes:** aparece un botón 🌐 al lado de cada mensaje. Un clic
  muestra la traducción debajo del texto (otro clic la oculta).
- **Seleccionar y traducir:** selecciona con el ratón cualquier parte de un
  mensaje y pulsa **🌐 Traducir**. La traducción aparece en un panel a la
  derecha de la pantalla (con historial y botón *Copiar*); ciérralo con ✕.
- **Traducir lo que escribes:** escribe tu respuesta en tu idioma y pulsa el
  botón **🌐→** (encima de la caja de texto) o **Ctrl+Shift+T**. El texto se
  reemplaza por la traducción, lista para enviar.
- **Detecta el idioma del contacto:** al traducir un mensaje recibido, recuerda
  su idioma para traducir tus respuestas a ese idioma automáticamente.
- **Traducción automática** (opcional) de todos los mensajes recibidos.

## Instalación (1 minuto)

1. Descarga esta carpeta `whatsapp-traductor`.
2. Abre `chrome://extensions` (en Edge: `edge://extensions`).
3. Activa **Modo de desarrollador** (arriba a la derecha).
4. Pulsa **Cargar descomprimida** y selecciona la carpeta `whatsapp-traductor`.
5. Abre (o recarga) https://web.whatsapp.com

Haz clic en el icono de la extensión para elegir tu idioma, el del contacto y
activar la traducción automática.

## Notas

- Usa el servicio gratuito de Google Translate; no necesita clave ni cuenta.
- Los textos de tus mensajes se envían a Google para traducirlos.
- Si WhatsApp cambia su página y los botones dejan de aparecer, habrá que
  actualizar los selectores en `content.js`.
