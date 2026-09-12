// Offline app-shell cache for the Karimu Field Audit PWA.
//
// Field audits happen with practically no connectivity (rural Tanzania),
// so this has to make the app fully usable offline once it has been
// opened online at least once — not just "degrade gracefully".
//
// Two strategies, split by what's actually safe to do with each:
//   - /_next/static/* (JS/CSS chunks): filenames are content-hashed by
//     the build, so a given URL's bytes never change. Cache-first: if we
//     have it, serve it instantly with zero network round-trip (this is
//     what makes tapping a button work immediately in airplane mode,
//     instead of waiting on a fetch that's doomed to fail). Falls back to
//     network only on a first-ever miss, and caches whatever comes back.
//   - Everything else same-origin (the "/" app shell, icons, manifest):
//     network-first so an online volunteer always gets the latest build,
//     but raced against a short timeout and an immediate cache fallback,
//     so a dead or very slow connection never leaves a tap hanging —
//     it falls back to the cached shell right away.
// /api/* is never touched here — those are the live sync writes and must
// always hit the real network, pass-or-fail, with no cached substitute.
const CACHE = "karimu-audit-shell-v2";
const NETWORK_TIMEOUT_MS = 2500;

self.addEventListener("install", (event) => {
  // Try to warm the cache with the current shell right away, so even a
  // device that installs the app and immediately loses signal (e.g. mid
  // sync-out to a remote site) has *something* cached. Best-effort only —
  // if this fails (e.g. install itself happened offline) the runtime
  // fetch handler below still populates the cache on the next successful
  // online load.
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.add("/").catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // never intercept POST /api/sync etc.
  const url = new URL(req.url);
  if (url.pathname.startsWith("/api/")) return; // always hit the network
  if (url.origin !== self.location.origin) return; // leave Google Fonts alone

  const isImmutableAsset = url.pathname.startsWith("/_next/static/");

  if (isImmutableAsset) {
    // Cache-first: instant and fully offline-safe once seen once.
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
          return res;
        });
      })
    );
    return;
  }

  // Network-first (raced against a short timeout so a dead/very slow
  // connection falls back immediately instead of hanging the tap),
  // updating the cache on every successful online fetch.
  event.respondWith(
    withTimeout(fetch(req), NETWORK_TIMEOUT_MS)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match("/")))
  );
});
