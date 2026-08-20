const CACHE_NAME = 'laser-calc-v4';
const CORE_ASSETS = [
  './',
  './index.html',
  './encomendas.html',
  './definicoes.html',
  './shared.js',
  './shared.css',
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

// Same-origin app files: network-first, so a new deploy is picked up on the very next
// load instead of being stuck behind an old cached copy. Cache is only the offline fallback.
// Google Fonts: cache-first, since they're static and rarely change — saves bandwidth.
// Everything else (Supabase API calls, or any other dynamic cross-origin data): never
// intercepted or cached — always hits the network fresh, so saved orders / counters never
// get stuck showing a stale cached response.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (!req.url.startsWith('http')) return; // ignore chrome-extension:// and other unsupported schemes

  const url = new URL(req.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isGoogleFont = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';

  if (isSameOrigin) {
    event.respondWith(
      fetch(req).then((resp) => {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        return resp;
      }).catch(() => caches.match(req))
    );
  } else if (isGoogleFont) {
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
  }
  // else: leave untouched (no event.respondWith) — browser handles it normally,
  // always fresh from network. This covers Supabase and any other API calls.
});
