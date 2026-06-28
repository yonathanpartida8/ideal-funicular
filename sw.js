/**
 * Service Worker — caché del shell de la app para ejecución offline.
 * Estrategia: cache-first para los recursos propios y vendor (modelos/libs),
 * con red como respaldo. Sube CACHE_VERSION al cambiar archivos.
 */
const CACHE_VERSION = 'ai-hud-v1';
const APP_SHELL = [
  './',
  './index.html',
  './css/hud.css',
  './js/config.js',
  './js/main.js',
  './js/util/math.js',
  './js/util/PerfMonitor.js',
  './js/camera/CameraCapture.js',
  './js/vision/VisionEngine.js',
  './js/vision/detector.worker.js',
  './js/vision/LightDetector.js',
  './js/tracking/KalmanFilter.js',
  './js/tracking/SortTracker.js',
  './js/sensors/SensorFusion.js',
  './js/estimation/MotionEstimator.js',
  './js/prediction/PredictionEngine.js',
  './js/audio/AlertSystem.js',
  './js/ui/HudRenderer.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_VERSION).then((c) =>
      // No fallar la instalación si algún recurso opcional no está aún.
      Promise.allSettled(APP_SHELL.map((u) => c.add(u)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        // Cachea vendor (tf.js / modelos) de forma oportunista.
        if (res.ok && (req.url.includes('/vendor/') || req.url.startsWith(self.location.origin))) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => hit);
    })
  );
});
