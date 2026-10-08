const LUMIN_CACHE = "lumin-dental-shell-v194";
const LUMIN_SHELL = [
  "/",
  "/manifest.webmanifest",
  "/icons/dental-icon-v1-32.png",
  "/icons/dental-icon-v1-180.png",
  "/icons/dental-icon-v1-192.png",
  "/icons/dental-icon-v1-512.png",
  "/icons/dental-icon-v1-maskable-512.png",
  "/lumin-app.css",
  "/lumin-loading.css?v=1",
  "/lumin-theme.css?v=21",
  "/lumin-dashboard-motion.js?v=3",
  "/lumin-dashboard-motion.css?v=1",
  "/lumin-appointment-status.js?v=2",
  "/lumin-appointment-status.css?v=2",
  "/lumin-loyalty.js?v=5",
  "/lumin-finance-sync.js?v=2",
  "/lumin-cash-flow.js?v=1",
  "/lumin-patient-scans.js?v=5",
  "/lumin-patient-scans.css?v=4",
  "/lumin-scan-worker.js",
  "/lumin-scan-viewer.js?v=4",
  "/vendor/three/build/three.module.js",
  "/vendor/three/build/three.core.js",
  "/vendor/three/examples/jsm/loaders/OBJLoader.js",
  "/vendor/three/examples/jsm/loaders/MTLLoader.js",
  "/vendor/three/examples/jsm/controls/OrbitControls.js",
  "/vendor/fflate/esm/browser.js",
  "/lumin-cash-flow.css?v=1",
  "/lumin-finance-sync.css?v=2",
  "/lumin-storage-sync.js?v=15",
  "/lumin-storage-sync.css?v=8",
  "/lumin-patient-swipe.js?v=1",
  "/lumin-patients.js?v=4",
  "/lumin-chart-sync.js?v=1",
  "/lumin-chart-media.js?v=15",
  "/lumin-xray-rotation.js?v=1",
  "/lumin-xray-rotation.css?v=1",
  "/lumin-tooth-notes.js?v=3",
  "/lumin-tooth-notes.css?v=4",
  "/lumin-chart-appointments.js?v=1",
  "/lumin-chart-appointments.css?v=1",
  "/lumin-chart-dates.js?v=1",
  "/lumin-chart-dates.css?v=1",
  "/lumin-chart-media.css?v=8",
  "/lumin-media-teeth.js?v=2",
  "/lumin-media-teeth.css?v=1",
  "/lumin-patients.css?v=3",
  "/lumin-nav-motion.js?v=1",
  "/lumin-nav-motion.css?v=1",
  "/lumin-mobile-nav.js?v=2",
  "/lumin-mobile-nav.css?v=2",
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
