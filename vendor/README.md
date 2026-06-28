# Vendor (librerías locales para ejecución 100% offline)

La app funciona con dos estrategias de carga, en este orden:

1. **Local (offline real):** si existen los archivos de esta carpeta, el worker
   de visión los usa sin tocar la red.
2. **CDN (fallback):** si no están, intenta descargarlos de jsdelivr la primera
   vez (y el Service Worker los cachea para siguientes arranques).

Para un dispositivo **sin conexión desde el primer arranque**, descarga aquí:

```
vendor/
├── tf.min.js          # TensorFlow.js  (@tensorflow/tfjs@4.20.0)
└── coco-ssd.min.js    # modelo COCO-SSD (@tensorflow-models/coco-ssd@2.2.3)
```

## Descarga rápida

Con red disponible (desde un PC o el propio Termux):

```bash
cd vendor
curl -L -o tf.min.js       https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.20.0/dist/tf.min.js
curl -L -o coco-ssd.min.js https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js
```

> COCO-SSD descarga además los pesos del modelo desde Google Storage la primera
> vez. Para 100% offline, sirve también esos pesos localmente y ajusta el
> `modelUrl` en `js/vision/detector.worker.js` (`cocoSsd.load({ modelUrl })`).

## Sustituir por YOLOv5 / YOLOv8 (opcional, mayor precisión)

El worker expone un contrato de detector intercambiable
(`init()` + `detect(imageData) → [{box,label,score}]`). Para usar YOLO:

- Exporta el modelo a **TF.js Graph Model** o a **ONNX** (onnxruntime-web/WASM).
- Coloca los archivos del modelo en `vendor/yolo/`.
- Implementa el pre/post-proceso (letterbox + NMS) y devuelve cajas
  normalizadas con la etiqueta de clase de vehículo.

La interfaz del resto del pipeline (tracking, estimación, predicción, HUD) no
cambia: sólo se alimenta de `{box, label, score}`.
