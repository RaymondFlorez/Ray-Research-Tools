/* ============================================================================
   ALPHA MOVEMENT — SERVICE WORKER

   Offline strategy, by asset class:
     - App shell + static chunks : stale-while-revalidate
     - Library / product / pulse API : stale-while-revalidate (content is stable)
     - Session API : network-first (schedules must not be stale)
     - Media (video, audio) : cache-first, populated on explicit download only,
       so we never fill a device's storage without the athlete asking
   ========================================================================== */

const VERSION = "am-v1";
const SHELL_CACHE = `${VERSION}-shell`;
const DATA_CACHE = `${VERSION}-data`;
const MEDIA_CACHE = `${VERSION}-media`;

const SHELL_ASSETS = [
  "/",
  "/today",
  "/library",
  "/philosophy",
  "/offline",
  "/manifest.webmanifest",
  "/icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // Individually, so one missing route cannot fail the whole install.
      .then((cache) =>
        Promise.allSettled(SHELL_ASSETS.map((asset) => cache.add(asset))),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => !key.startsWith(VERSION))
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Media: cache-first, and only what was explicitly downloaded.
  if (/\.(mp4|webm|m4a|mp3)$/i.test(url.pathname)) {
    event.respondWith(cacheFirst(request, MEDIA_CACHE));
    return;
  }

  // Sessions must be fresh — a stale schedule is worse than no schedule.
  if (url.pathname.startsWith("/api/sessions")) {
    event.respondWith(networkFirst(request, DATA_CACHE));
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(staleWhileRevalidate(request, DATA_CACHE));
    return;
  }

  // Navigations: network first, falling back to the cached page, then /offline.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          return cached ?? (await caches.match("/offline")) ?? Response.error();
        }),
    );
    return;
  }

  event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
});

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(cacheName);
    cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw new Error("Offline and no cached response");
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cached = await caches.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response.ok) {
        caches.open(cacheName).then((cache) => cache.put(request, response.clone()));
      }
      return response;
    })
    .catch(() => cached);
  return cached ?? network;
}

/* --- Explicit media download, driven by the owned-library UI --------------- */

self.addEventListener("message", (event) => {
  const { type, urls } = event.data ?? {};

  if (type === "AM_DOWNLOAD" && Array.isArray(urls)) {
    event.waitUntil(
      caches
        .open(MEDIA_CACHE)
        .then((cache) => Promise.allSettled(urls.map((url) => cache.add(url)))),
    );
  }

  if (type === "AM_EVICT" && Array.isArray(urls)) {
    event.waitUntil(
      caches
        .open(MEDIA_CACHE)
        .then((cache) => Promise.all(urls.map((url) => cache.delete(url)))),
    );
  }
});

/* --- Push notifications (session reminders) -------------------------------- */

self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload = {};
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "Alpha Movement", body: event.data.text() };
  }

  event.waitUntil(
    self.registration.showNotification(payload.title ?? "Alpha Movement", {
      body: payload.body,
      icon: "/icon.svg",
      badge: "/icon.svg",
      tag: payload.tag ?? "session-reminder",
      data: { url: payload.url ?? "/sessions" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url ?? "/sessions";
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(target) && "focus" in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
