# AI Driving HUD · AR Road Assistant

Aplicación web de **asistencia a la conducción en tiempo real**, pensada para
ejecutarse **100% local** en Android de alto rendimiento (Snapdragon de gama
alta, GPU móvil, varios núcleos). Sin nube, sin backend remoto y sin APIs
externas obligatorias: todo el procesamiento ocurre en el dispositivo.

> ⚠️ **Asistencia experimental.** No sustituye la atención del conductor ni los
> sistemas del vehículo. Úsala sólo como apoyo y de forma segura.

## Qué hace

- 📷 **Cámara trasera en máxima calidad** disponible (4K/2K/1080p, negociada con
  el dispositivo) vía `getUserMedia`, con pipeline optimizado para evitar
  *frame drops*.
- 🚗 **Detección de vehículos** en tiempo real on-device (TensorFlow.js +
  COCO-SSD *lite*, con detector intercambiable por YOLOv5/YOLOv8 → TF.js Graph /
  ONNX-WASM).
- 🧩 **Tracking multi-objeto** estilo **SORT** (centroid + **filtro de Kalman** +
  asociación IOU) con IDs temporales estables. Cajas suaves por interpolación
  temporal.
- 🧭 **Fusión de sensores**: GPS (velocidad real), acelerómetro (aceleración),
  giroscopio (orientación) y brújula (rumbo) combinados con un **filtro
  complementario** para estabilizar la velocidad del usuario.
- 📐 **Estimación de distancia y velocidad relativa**: profundidad por modelo
  *pinhole* (ancho típico del vehículo + escala de la caja), **optical flow**
  Lucas-Kanade para el movimiento global de la escena, y **velocidad de cierre**.
- 🔮 **Predicción y riesgo**: trayectoria proyectada 1–3 s, distancia de
  seguridad (regla de los 2 s) y **alertas por tiempo a colisión (TTC)**.
- 💡 **Detección de luces** (faros/pilotos) por brillo/contraste para mejorar la
  distancia de noche.
- 🖥️ **HUD sci-fi** renderizado en **WebGL2** (vídeo con tono adaptativo
  día/noche + cajas con *glow* y trayectorias curvas) y overlay **Canvas2D** para
  texto nítido.
- 🔊 **Alertas sonoras** con **Web Audio API** (tonos bajo/medio/crítico, baja
  latencia).
- ⚙️ **Optimización**: inferencia en **Web Worker**, render con
  `requestAnimationFrame`, **throttling adaptativo** de IA (8–30 fps) y
  **reducción dinámica de resolución** bajo carga, todo sin bloquear el hilo
  principal.

## Privacidad (por diseño)

Sólo se realiza **detección genérica de objetos tipo vehículo**. **No** hay
reconocimiento de personas, **ni** lectura de matrículas/placas, **ni**
identificación de identidades, **ni** recolección o transmisión de datos: el
vídeo y la posición se procesan en memoria y de forma efímera en el dispositivo.

## Ejecutar

En el propio Android (p. ej. con **Termux**):

```bash
git clone <este-repo> && cd ideal-funicular
sh serve.sh 8080          # o: python -m http.server 8080
```

Abre **http://localhost:8080** en Chrome (Android) y pulsa **INICIAR HUD**.
`localhost` es contexto seguro, así que la cámara y los sensores funcionan sin
HTTPS. Para abrir desde otro equipo necesitarás servir por HTTPS.

> **Funciona en cualquier servidor estático.** La app se carga como un único
> *bundle* clásico (`app.bundle.js`), no como módulos ES, así que se ejecuta
> aunque el servidor entregue los `.js` con un MIME incorrecto (algo habitual en
> servidores de archivos de Android). Hasta el Web Worker de IA y las librerías
> se cargan vía `fetch()` + `Blob`, que ignoran el MIME del servidor.

### Desarrollo (editar el código)

El código fuente vive en `js/` como módulos ES. Tras editarlo, regenera el
bundle que sirve la app:

```bash
node build.mjs      # reescribe app.bundle.js a partir de js/*
```

`build.mjs` no tiene dependencias: concatena los módulos, quita `import/export`
y los envuelve en una IIFE. El worker (`js/vision/detector.worker.js`) se sirve
tal cual y se carga de forma robusta frente al MIME.

Para **offline desde el primer arranque**, vendoriza las librerías: ver
[`vendor/README.md`](vendor/README.md). El Service Worker cachea el shell para
arranques posteriores sin red.

## Arquitectura (módulos desacoplados)

```
js/
├── main.js                  Orquestador: capt.→inferencia→tracking→fusión→
│                            estimación→predicción→render→alertas
├── config.js                Parámetros del pipeline
├── camera/CameraCapture.js  getUserMedia, negociación de resolución, grabs
├── vision/
│   ├── detector.worker.js   Inferencia en Web Worker (TF.js/COCO-SSD)
│   ├── VisionEngine.js      Interfaz main↔worker, throttling y descarte
│   └── LightDetector.js     Faros/pilotos por brillo y contraste
├── tracking/
│   ├── KalmanFilter.js      Kalman de caja (velocidad constante)
│   └── SortTracker.js       SORT: predicción + IOU + ciclo de vida
├── sensors/SensorFusion.js  GPS+IMU+brújula con filtro complementario
├── estimation/MotionEstimator.js  Distancia, optical flow, cierre, TTC
├── prediction/PredictionEngine.js Trayectoria, distancia segura, riesgo
├── audio/AlertSystem.js     Tonos Web Audio por nivel de riesgo
├── ui/HudRenderer.js        WebGL2 (vídeo+geometría) + overlay Canvas2D
└── util/                    math (EMA, IOU, Catmull-Rom…), PerfMonitor
```

### Etapas y cadencias

| Etapa            | Hilo            | Cadencia                         |
|------------------|-----------------|----------------------------------|
| Captura          | main            | a demanda (grabs reducidos)      |
| Inferencia IA    | Web Worker      | 8–30 fps adaptativo              |
| Tracking/estim.  | main (ligero)   | por detección                    |
| Render HUD       | main (rAF)      | hasta 60 fps, interpolando cajas |
| Sensores         | eventos         | nativa del dispositivo           |

El `PerfMonitor` mide el tiempo de frame y ajusta automáticamente el FPS de IA y
la resolución de inferencia (320/416/512) para mantener la UI fluida.

## Personalización

Casi todo es ajustable en [`js/config.js`](js/config.js): resoluciones,
umbrales de detección, parámetros de Kalman/IOU, anchos físicos por tipo de
vehículo, horizontes de predicción, umbrales de TTC y de día/noche, cooldowns de
audio y presupuesto de frame.
