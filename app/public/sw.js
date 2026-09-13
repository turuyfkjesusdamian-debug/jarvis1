// Minimal service worker — exists only so the browser considers the PWA
// installable. No offline caching: JARVIS needs a live server for every
// feature (tools, memory, chat), so caching responses would just serve
// stale data. Always fetch fresh from the network.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
