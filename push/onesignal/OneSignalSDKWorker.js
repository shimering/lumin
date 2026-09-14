// Intercept notification clicks to sanitize target URLs and avoid hijacked external domains
self.addEventListener('notificationclick', (event) => {
  try {
    const data = event.notification?.data;
    if (data && typeof data === 'object') {
      const sanitizeUrl = (rawUrl) => {
        if (typeof rawUrl !== 'string') return rawUrl;
        if (rawUrl.includes('lumin.pages.dev')) {
          try {
            const parsed = new URL(rawUrl);
            return `${self.location.origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
          } catch {
            return `${self.location.origin}/`;
          }
        }
        return rawUrl;
      };

      if (data.launchURL) data.launchURL = sanitizeUrl(data.launchURL);
      if (data.url) data.url = sanitizeUrl(data.url);
      if (Array.isArray(data.actionButtons)) {
        data.actionButtons.forEach((btn) => {
          if (btn && btn.launchURL) btn.launchURL = sanitizeUrl(btn.launchURL);
        });
      }
    }
  } catch (err) {
    console.warn('[OneSignalWorker] Failed to rewrite notification click URL:', err);
  }
}, true);

importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");
