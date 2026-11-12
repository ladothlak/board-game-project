/* Service worker: offline caching + stale-while-revalidate for API GETs.
 *
 * Only small, safe-to-stale responses are cached (API JSON). HTML documents,
 * PDFs, and images are deliberately NOT cached here: the file route already
 * sends ETag + Cache-Control so the browser's HTTP cache covers them, and
 * caching multi-MB rulebooks or HTML in Cache Storage would blow the quota
 * and risk serving stale pages offline.
 */
const CACHE_NAME = "parlor-v3";
const ASSETS = ["/", "/manifest.json"];
const MAX_CACHE_BYTES = 20 * 1024 * 1024; // total budget for this cache
const MAX_ENTRY_BYTES = 512 * 1024; // per-response cap

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

/** A response is cacheable if it's a small success payload (API JSON). */
function isCacheable(res) {
  if (res.status !== 200) return false;
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("pdf") || type.startsWith("image/")) return false;
  const len = Number(res.headers.get("content-length") ?? 0);
  return len <= MAX_ENTRY_BYTES;
}

/** Approximate total bytes currently in the cache. */
async function cacheBytes() {
  const cache = await caches.open(CACHE_NAME);
  let total = 0;
  for (const key of await cache.keys()) {
    const res = await cache.match(key);
    total += (await res.arrayBuffer()).byteLength;
  }
  return total;
}

/** Evict oldest entries until the cache is back under ~80% of the budget. */
async function evictIfNeeded() {
  if ((await cacheBytes()) < MAX_CACHE_BYTES) return;
  const cache = await caches.open(CACHE_NAME);
  const keys = await cache.keys(); // insertion order in most browsers
  for (const key of keys) {
    if ((await cacheBytes()) < MAX_CACHE_BYTES * 0.8) break;
    await cache.delete(key);
  }
}

self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET" || !request.url.startsWith(self.location.origin)) return;

  // Let the browser handle everything we don't cache: HTML documents, PDFs,
  // images (all covered by HTTP caching via ETag/Cache-Control).
  if (request.destination === "document") return;

  e.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        // Stale-while-revalidate: serve cache immediately, refresh in background.
        fetch(request)
          .then((res) => {
            if (isCacheable(res)) {
              const clone = res.clone();
              caches.open(CACHE_NAME).then(async (c) => {
                await evictIfNeeded();
                c.put(request, clone);
              });
            }
          })
          .catch(() => {});
        return cached;
      }

      // No cache: fetch and store.
      return fetch(request)
        .then((res) => {
          if (isCacheable(res)) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(async (c) => {
              await evictIfNeeded();
              c.put(request, clone);
            });
          }
          return res;
        })
        .catch(() => new Response("Offline", { status: 503 }));
    })
  );
});
