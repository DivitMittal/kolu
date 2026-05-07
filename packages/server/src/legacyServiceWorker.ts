/**
 * One-release compatibility worker for clients that already installed Kolu's
 * old Workbox app-shell service worker. New builds do not register a service
 * worker, but old registrations still update from `/sw.js`; this script makes
 * that update delete the obsolete cache owner and navigate windows back to the
 * network-served app shell.
 */
export const LEGACY_SERVICE_WORKER = `
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    await self.registration.unregister();

    const cacheNames = await self.caches.keys();
    await Promise.all(cacheNames.map((cacheName) => self.caches.delete(cacheName)));

    const clients = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });
    await Promise.all(clients.map((client) => client.navigate(client.url)));
  })());
});
`.trim();
