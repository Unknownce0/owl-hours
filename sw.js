/* Owl Hours service worker.
   The app is one HTML file plus icons, and all coursework lives in localStorage,
   so caching the shell is enough to make it work with no signal at all. */
const CACHE = 'owl-hours-1.0.3';
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', e => {
  // Deliberately no skipWaiting() here: the new build waits until the user
  // presses Reload, so the page never swaps out from under them mid-use.
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* The page asks the parked worker to take over when the user hits Reload. */
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Anything off-origin (a sync URL, a font) goes straight to the network.
  if (url.origin !== self.location.origin) return;

  // Network-first for the app itself so a redeploy is picked up promptly,
  // falling back to cache when offline.
  e.respondWith(
    fetch(req)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
  );
});
