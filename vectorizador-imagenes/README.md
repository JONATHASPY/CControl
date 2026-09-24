# 🖼️ Vectorizador y Mejorador de Imágenes

Aplicación web sencilla que **convierte imágenes a vectores (SVG)** y
**mejora su calidad** (ampliación, reducción de ruido y nitidez).

Todo se procesa en tu navegador: no hace falta instalar nada, funciona sin
conexión y tus imágenes no se suben a ningún servidor.

## Cómo usarla

1. Abre `index.html` con Chrome, Edge, Firefox o Safari (doble clic).
   Se abre con una imagen de ejemplo ya procesada.
2. Arrastra una imagen, pégala con **Ctrl+V** o pulsa *elige un archivo*.
3. Elige la pestaña:

En ambas pestañas puedes arrastrar sobre la imagen para comparar
**original / resultado** y usar el **zoom** (hasta 800 %) para revisar los
detalles. El procesamiento corre en segundo plano: la página no se congela,
ves el progreso y puedes **cancelar**.

### ✨ Mejorar calidad

Hay dos métodos:

- **Inteligencia artificial (recomendado):** una red neuronal (ESRGAN/RRDN
  entrenada como GAN) reconstruye bordes y texturas nítidas al ampliar. Se
  ejecuta en la tarjeta gráfica del navegador con TensorFlow.js. Tarda de
  unos segundos a un minuto según el tamaño y el equipo; verás el progreso y
  el tiempo restante.
- **Rápido (sin IA):** ampliación clásica, instantánea.

| Opción | Qué hace |
| --- | --- |
| **Tipo de imagen** | Ajustes recomendados para foto, foto antigua, ilustración o captura de pantalla. |
| **Ampliar ×1–×4** | Aumenta la resolución con remuestreo Lanczos-3 (más nítido que el reescalado normal). |
| **Reducir ruido** | Filtro bilateral: suaviza el grano y los artefactos JPEG conservando los bordes. |
| **Nitidez** | Máscara de enfoque sobre la luminancia (realza detalles sin halos de color). |
| **Saturación** | Colores más vivos (+) o más apagados (−). |
| **Mejorar contraste** | Estira automáticamente los niveles de la imagen. |

Usa el deslizador sobre la imagen para comparar **antes / después** y
descarga el resultado en PNG.

### ✏️ Vectorizar (SVG)

Convierte la imagen en formas vectoriales: el SVG se puede ampliar a
**cualquier tamaño sin perder calidad** (ideal para logos, iconos, dibujos o
para imprimir en grande).

- **Preajustes:** logo, ilustración, fotografía o blanco y negro.
- **Colores:** cuántos colores tendrá el resultado (2–64).
- **Detalle:** resolución a la que se analiza la imagen (más = más fiel, más pesado).
- **Eliminar manchas:** quita puntitos y ruido menores de ese tamaño.
- **Simplificación:** más alta = menos nodos y archivo más ligero.
- **Suavizar entrada:** útil con fotos o JPEG con ruido.
- **Esquinas nítidas:** ángulos menores que este valor se mantienen en punta; el resto se redondea con curvas.
- **Limpiar bordes:** elimina los halos de colores intermedios que deja el antialiasing.
- **Quitar el fondo:** deja transparente el color que ocupa el borde de la imagen.
- **Partir de la imagen mejorada:** primero mejora la imagen y luego vectoriza el resultado.
- **Actualizar al cambiar opciones:** el SVG se recalcula solo al mover un control.
- **Colores del SVG:** haz clic en cualquier color de la paleta para cambiarlo al instante.

Descarga el **SVG**, copia su código o descarga un **PNG de alta resolución** (×1 a ×8) renderizado
desde el vector, perfecto para ampliar logos pequeños sin pixelado.

### La IA y el archivo `index.html`

Por seguridad, los navegadores no dejan que una página abierta con doble
clic (`file://`) lea el modelo de IA. Si abres `index.html` directamente,
la mejora usará el método rápido. Para usar la IA en tu equipo, abre la
carpeta con un servidor local, por ejemplo:

```
npx http-server vectorizador-imagenes
```

y entra en la dirección que muestra (normalmente http://127.0.0.1:8080).

## Cómo funciona

- `enhancer.js` — filtro bilateral → Lanczos-3 → unsharp mask → niveles/saturación.
- `vectorizer.js` — cuantización de color k-means en espacio CIELAB → limpieza
  de bordes y manchas → trazado de contornos por capas apiladas (sin huecos
  entre colores) → detección de esquinas → ajuste de curvas Bézier cúbicas
  (algoritmo de Schneider).
- `ai-upscaler.js` — superresolución ×4 con IA, por bloques solapados.
- `app.js` — interfaz, carga de imágenes y descargas.

## Licencias de terceros

- `vendor/tf.min.js`: TensorFlow.js 4.22.0, © Google LLC, licencia Apache 2.0.
- `models/esrgan-gans-x4/`: modelo «gans» de UpscalerJS (`@upscalerjs/esrgan-legacy`),
  pesos de idealo/image-super-resolution; licencia MIT (ver `models/LICENSE-upscalerjs.txt`).

> Nota: la mejora usa algoritmos clásicos de procesamiento de imagen, no
> inteligencia artificial. No "inventa" detalles que no existen, pero da una
> ampliación limpia y nítida. Para la máxima calidad en logos y dibujos,
> vectoriza la imagen y exporta el PNG a la resolución que necesites.
