const LUMIN_CACHE = "lumin-dental-shell-v205";
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
  "/lumin-theme.css?v=22",
  "/lumin-backgrounds.css?v=1",
  "/lumin-dashboard-motion.js?v=3",
  "/lumin-dashboard-motion.css?v=1",
  "/lumin-whatsapp-actions.js?v=2",
  "/lumin-whatsapp-actions.css?v=2",
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
  "/lumin-chart-media.js?v=17",
  "/lumin-xray-rotation.js?v=1",
  "/lumin-xray-rotation.css?v=1",
  "/lumin-tooth-notes.js?v=3",
  "/lumin-tooth-notes.css?v=4",
  "/lumin-chart-appointments.js?v=3",
  "/lumin-clinical-actions.js?v=4",
  "/lumin-quotation-model.js?v=1",
  "/lumin-tooth-anatomy.js?v=1",
  "/lumin-quotation-view.js?v=1",
  "/lumin-quotations.js?v=1",
  "/lumin-quotations.css?v=1",
  "/lumin-clinical-actions.css?v=4",
  "/lumin-specialty-picker.js?v=3",
  "/assets/specialties-3d/dental-general.webp?v=2",
  "/assets/specialties-3d/dental-diagnosis.webp?v=2",
  "/assets/specialties-3d/dental-preventive.webp?v=2",
  "/assets/specialties-3d/dental-restorative.webp?v=2",
  "/assets/specialties-3d/dental-endodontics.webp?v=2",
  "/assets/specialties-3d/dental-crown.webp?v=2",
  "/assets/specialties-3d/dental-prosthodontics.webp?v=2",
  "/assets/specialties-3d/dental-implantology.webp?v=2",
  "/assets/specialties-3d/dental-periodontics.webp?v=2",
  "/assets/specialties-3d/dental-cosmetics.webp?v=2",
  "/assets/specialties-3d/dental-surgery.webp?v=2",
  "/assets/specialties-3d/dental-orthodontics.webp?v=2",
  "/assets/specialties-3d/dental-pediatric.webp?v=2",
  "/assets/specialties-3d/dental-imaging.webp?v=2",
  "/assets/specialties-3d/dental-oral-medicine.webp?v=2",
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

  // Public quotation navigations must never fall back to the clinic login or an offline copy.
  if (url.pathname.endsWith("/quotation.html")) {
    event.respondWith(fetch(request, { cache: "no-store" }).catch(() => new Response(
      '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Quotation unavailable</title><p>Connect to the internet to open this quotation. / اتصل بالإنترنت لفتح عرض الأسعار.</p>',
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
    )));
    return;
  }

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
