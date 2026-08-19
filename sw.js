const CACHE_NAME = 'laser-calc-v1';
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Cache-first for same-origin core assets; network falling back to cache for everything else
// (this lets font requests go to the network when online, but never breaks the app offline).
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const isSameOrigin = new URL(req.url).origin === self.location.origin;

  if (isSameOrigin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((resp) => {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          return resp;
        }).catch(() => cached);
      })
    );
  } else {
    event.respondWith(
      fetch(req).then((resp) => {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        return resp;
      }).catch(() => caches.match(req))
    );
  }
});
