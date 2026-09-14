const LUMIN_CACHE = "lumin-dental-shell-v49";
const LUMIN_SHELL = [
  "/",
  "/manifest.webmanifest",
  "/icons/dental-icon-v1-32.png",
  "/icons/dental-icon-v1-180.png",
  "/icons/dental-icon-v1-192.png",
  "/icons/dental-icon-v1-512.png",
  "/icons/dental-icon-v1-maskable-512.png",
  "/lumin-app.css",
  "/lumin-theme.css?v=11",
  "/lumin-loyalty.js?v=5",
  "/vendor/lucide.min.js",
  "/vendor/supabase.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(LUMIN_CACHE)
      .then((cache) => Promise.allSettled(LUMIN_SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("lumin-dental-shell-") && key !== LUMIN_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") void self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/push/onesignal/") ||
    url.pathname.endsWith("OneSignalSDKWorker.js") ||
    url.pathname.includes("OneSignal")
  ) return;

  if (url.pathname === "/app-version.json") {
    event.respondWith(fetch(request, { cache: "no-store" }));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          void caches.open(LUMIN_CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(async () => (await caches.match(request)) || (await caches.match("/")))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          void caches.open(LUMIN_CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
      return cached || network;
    })
  );
});
