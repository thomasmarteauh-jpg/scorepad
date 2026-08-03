// Bump this string any time index.html, style.css, app.js, or the icons
// change. Doing so retires the old cache on activate; fetches are
// network-first, so a running app picks up new files on its next load.
// Bump APP_VERSION in app.js to match — Settings compares the two to show
// whether a device has finished updating.
const CACHE_VERSION = "v19";
const CACHE_NAME = `scorepad-cache-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
  "https://unpkg.com/dexie@3/dist/dexie.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        // Cache each file independently so one failure (e.g. no network
        // reaching the CDN) doesn't block the rest from being cached.
        Promise.all(PRECACHE_URLS.map((url) => cache.add(url).catch(() => {})))
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

// Network-first, falling back to the cache when offline.
//
// This used to be cache-first, which meant an installed app could keep serving
// an old version indefinitely: nothing ever re-checked the network, so updates
// only landed if the browser happened to notice a new service worker. Trying
// the network first keeps the app current while still working fully offline.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() =>
        caches.match(event.request).then((cached) => {
          if (cached) return cached;
          // Offline on a fresh navigation: hand back the app shell.
          if (event.request.mode === "navigate") return caches.match("./index.html");
          return Response.error();
        })
      )
  );
});
