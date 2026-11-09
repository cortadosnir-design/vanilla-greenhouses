// Caches the app shell so the site opens in the greenhouse without reception; API and weather calls are never cached.
const CACHE = 'vg-v5';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'logic.js', 'weather.js', 'config.js', 'manifest.webmanifest', 'icons/icon.svg', 'farm.svg'];
const NETWORK_WAIT = 4000; // on a weak signal, fall back to the cached shell instead of hanging

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cached = await caches.match(e.request, { ignoreSearch: true });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cached ? NETWORK_WAIT : 30000);
    try {
      // network first so a new deploy shows up on the next load
      const res = await fetch(e.request, { signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
      return res;
    } catch (err) {
      clearTimeout(timer);
      if (cached) return cached;
      throw err;
    }
  })());
});
