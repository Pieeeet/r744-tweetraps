const CACHE = 'r744-tweetraps-v5';
const CORE = ['./', './index.html', './style.css', './app.js', './coolprop.js'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  if (event.data?.type !== 'CACHE_WASM') return;
  event.waitUntil(
    caches.open(CACHE).then(async cache => {
      const request = new Request(new URL('./coolprop.wasm', self.location.href).href);
      if (await cache.match(request)) return;
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response);
    })
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // The 8.8 MB WASM binary is cached on its first real request, avoiding a competing install-time download.
  if (url.pathname.endsWith('/coolprop.wasm')) {
    event.respondWith(
      caches.open(CACHE).then(async cache => {
        const cached = await cache.match(event.request);
        if (cached) return cached;
        const response = await fetch(event.request);
        if (response.ok) cache.put(event.request, response.clone());
        return response;
      })
    );
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response.ok) caches.open(CACHE).then(cache => cache.put(event.request, response.clone()));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
