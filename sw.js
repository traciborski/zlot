// Service worker: cache aplikacji i modeli, żeby działała offline.
const CACHE = 'zlot-v6';
const ASSETS = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.webmanifest',
  'icon.svg',
  'icon-192.png',
  'icon-512.png',
  'vendor/face-api.esm.js',
  'vendor/models/tiny_face_detector_model-weights_manifest.json',
  'vendor/models/tiny_face_detector_model.bin',
  'vendor/models/ssd_mobilenetv1_model-weights_manifest.json',
  'vendor/models/ssd_mobilenetv1_model.bin',
  'vendor/models/face_landmark_68_model-weights_manifest.json',
  'vendor/models/face_landmark_68_model.bin',
  'vendor/models/face_recognition_model-weights_manifest.json',
  'vendor/models/face_recognition_model.bin',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Kod aplikacji: najpierw sieć (świeże wersje), modele: najpierw cache.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/vendor/')) {
    e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
    return;
  }
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
