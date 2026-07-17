/* RWC Caribbean — Service Worker
   Strategy: network-first for the app shell so a fresh deploy is always
   picked up when the app is opened; cache fallback for offline use.
   Bump CACHE_VERSION on each deploy to force clients to update. */

const CACHE_VERSION = 'rwc-2026-06-26-57';
const CACHE_NAME = 'rwc-cache-' + CACHE_VERSION;

// Core assets to pre-cache (the single-file app).
const CORE = [
  './',
  './index.html'
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
    // cache:'reload' bypasses the browser/CDN HTTP cache so a fresh deploy is
    // always fetched from the server (GitHub Pages serves HTML with a max-age,
    // which would otherwise let "network-first" return stale HTML for minutes).
    event.respondWith(
      fetch(req, { cache: 'reload' }).then((res) => {
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

/* ═══ WEATHER ALERTS — background notifications (no server required) ═══
   periodicsync (Chrome/Edge/Android, installed PWA): the browser wakes this
   worker roughly hourly; we check live conditions and raise a local
   notification when something significant is happening. Deduped via Cache
   Storage so the same alert isn't repeated. iOS has no periodicsync and true
   closed-app push needs a push server — the app-side checker covers iOS while
   the app (or installed PWA) is open. */
const ALERT_CACHE = 'rwc-alert-state';

async function checkWeatherAlerts() {
  try {
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=12.19&longitude=-68.96' +
      '&current=wind_gusts_10m,wind_speed_10m,weather_code,precipitation' +
      '&hourly=precipitation_probability&forecast_days=1&timezone=auto&wind_speed_unit=kn';
    const r = await fetch(url);
    if (!r.ok) return;
    const j = await r.json();
    const alerts = [];
    const cur = j.current || {};
    if (cur.wind_gusts_10m >= 30) alerts.push('Strong wind: gusts ' + Math.round(cur.wind_gusts_10m) + ' kt');
    if (cur.weather_code >= 95) alerts.push('Thunderstorm activity near Curacao');
    else if (cur.weather_code >= 80 && cur.precipitation >= 2) alerts.push('Heavy showers now (' + cur.precipitation + ' mm)');
    const h = new Date().getHours();
    const pops = ((j.hourly && j.hourly.precipitation_probability) || []).slice(h, h + 3);
    const pop = Math.max(0, ...pops.map(Number).filter(isFinite));
    if (pop >= 70) alerts.push('High rain chance next hours: ' + Math.round(pop) + '%');
    try {
      const s = await fetch('https://www.nhc.noaa.gov/CurrentStorms.json');
      if (s.ok) {
        const sj = await s.json();
        const act = (sj.activeStorms || []).filter(x => /AL/i.test(x.id || ''));
        if (act.length) alerts.push('Active Atlantic tropical system: ' + act.map(x => x.name).join(', '));
      }
    } catch (e) {}

    const key = alerts.join('|');
    const cache = await caches.open(ALERT_CACHE);
    const prev = await cache.match('last');
    const prevTxt = prev ? await prev.text() : '';
    if (alerts.length && key !== prevTxt) {
      await self.registration.showNotification('RWC Weather Alert', {
        body: alerts.join('\n'),
        icon: './icon-192.png',
        badge: './icon-192.png',
        tag: 'rwc-wx-alert',
        renotify: true,
        data: { url: './' }
      });
    }
    await cache.put('last', new Response(key));
  } catch (e) {}
}

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'rwc-wx-alerts') event.waitUntil(checkWeatherAlerts());
});

/* One-shot sync fallback (fires when connectivity returns) */
self.addEventListener('sync', (event) => {
  if (event.tag === 'rwc-wx-alerts-once') event.waitUntil(checkWeatherAlerts());
});

/* Real Web Push (future: requires a push server posting to the subscription) */
self.addEventListener('push', (event) => {
  let body = 'Weather update';
  try { body = event.data ? event.data.text() : body; } catch (e) {}
  event.waitUntil(self.registration.showNotification('RWC Caribbean', {
    body, icon: './icon-192.png', badge: './icon-192.png', tag: 'rwc-push', data: { url: './' }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return clients.openWindow('./');
  }));
});

/* App-side trigger: the page pings this while open (covers iOS, which has no
   periodicsync) so alerts still fire from the shared checker + dedupe. */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'check-alerts') checkWeatherAlerts();
});
