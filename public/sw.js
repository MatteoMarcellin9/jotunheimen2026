// Service Worker — Jotunheimen 2026
// Strategia:
//  - Pagine e asset statici (app shell): cache-first, aggiornati in background
//  - API (/api/*): network-first, con fallback all'ultima risposta salvata in cache
//    così offline si vede l'ultimo stato scaricato (programma, checklist, scelte, mappa)

const VERSION = 'jot-v1';
const SHELL_CACHE = `${VERSION}-shell`;
const DATA_CACHE = `${VERSION}-data`;

// risorse dell'app da precaricare (guscio + asset che servono offline)
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/gruppo.html',
  '/offline.html',
  '/manifest.webmanifest',
  '/assets/track.json',
  '/assets/elevation.png',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
  '/assets/apple-touch-icon.png',
  '/assets/hero_fiordo.jpg',
  '/assets/hero_tenda.jpg',
  '/assets/bg_fiordo.jpg',
  '/assets/bg_panorama.jpg',
  '/assets/bg_tenda.jpg',
  '/assets/bg_bergen_snow.jpg',
  '/assets/bg_bergen_color.jpg',
  '/assets/bg_orso.jpg',
  '/assets/bg_aurora.jpg',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(cache =>
      // addAll fallisce tutto se una sola risorsa fallisce: le aggiungo singolarmente e tollero errori
      Promise.allSettled(SHELL_ASSETS.map(url => cache.add(url).catch(() => null)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => !k.startsWith(VERSION)).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return; // POST (scritture) non si cacheano: passano diretti in rete

  const url = new URL(req.url);

  // API: network-first con fallback cache (solo le GET pubbliche/stato)
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(DATA_CACHE).then(c => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(req).then(hit => hit || new Response(
        JSON.stringify({ offline: true, error: 'Sei offline: mostro gli ultimi dati scaricati.' }),
        { headers: { 'Content-Type': 'application/json' } }
      )))
    );
    return;
  }

  // tile della mappa: cache-first, così le zone già viste restano offline
  if (url.hostname.includes('tile.opentopomap.org')) {
    event.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        const copy = res.clone();
        caches.open(DATA_CACHE).then(c => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => new Response('', { status: 504 })))
    );
    return;
  }

  // navigazione pagine: network-first, fallback alla pagina in cache, poi offline.html
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(SHELL_CACHE).then(c => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(req).then(hit => hit || caches.match('/offline.html')))
    );
    return;
  }

  // tutto il resto (asset statici): cache-first, aggiorna in background
  event.respondWith(
    caches.match(req).then(hit => {
      const fetchPromise = fetch(req).then(res => {
        const copy = res.clone();
        caches.open(SHELL_CACHE).then(c => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => hit);
      return hit || fetchPromise;
    })
  );
});
