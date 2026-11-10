/* Service worker: offline caching + stale-while-revalidate for API GETs. */
const CACHE_NAME = "parlor-v2";
const ASSETS = ["/", "/search-index.json", "/manifest.json"];

self.addEventListener("install", (e) => {
  e.preventDefault();
  caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.preventDefault();
  caches.keys().then((keys) => {
    Promise.all(
      keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
    ).then(() => self.clients.claim());
  });
});

self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET" || !request.url.startsWith(self.location.origin)) return;

  const isApi = request.url.includes("/api/");

  e.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        // Stale-while-revalidate: serve cache immediately, refresh in background.
        if (isApi) {
          fetch(request)
            .then((res) => {
              if (res.status === 200) {
                caches.open(CACHE_NAME).then((c) => c.put(request, res.clone()));
              }
            })
            .catch(() => {});
        }
        return cached;
      }

      // No cache: fetch and store.
      return fetch(request)
        .then((res) => {
          if (res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(request, clone));
          }
          return res;
        })
        .catch(() => new Response("Offline", { status: 503 }));
    })
  );
});
