/* RWC Caribbean — Service Worker
   Strategy: network-first for the app shell so a fresh deploy is always
   picked up when the app is opened; cache fallback for offline use.
   Bump CACHE_VERSION on each deploy to force clients to update. */

const CACHE_VERSION = 'rwc-2026-09-04-7';
const CACHE_NAME = 'rwc-cache-' + CACHE_VERSION;

// Core assets to pre-cache (the single-file app).
const CORE = [
  './',
  './index.html',
  './rwc_caribbean.html'
];

// Install: pre-cache the shell, then activate immediately.
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE).catch(() => {}))
  );
});

// Activate: drop old caches and take control of open pages right away.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k.startsWith('rwc-cache-') && k !== CACHE_NAME)
            .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Allow the page to tell a waiting SW to activate now.
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

// Fetch strategy:
//  - Navigation / HTML  → network-first (always get the newest deploy), cache fallback.
//  - Other GET requests → cache-first with background refresh (fast + fresh).
//  - Cross-origin live data (APIs, tiles) → pass straight through to the network.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // Let live data / map tiles / APIs hit the network directly (never cached here).
  if (!sameOrigin) return;

  const isHTML = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').includes('text/html');

  if (isHTML) {
    // Network-first: newest HTML wins; fall back to cache offline.
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(req).then((m) => m || caches.match('./index.html')))
    );
    return;
  }

  // Same-origin static asset: cache-first, refresh in background.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
