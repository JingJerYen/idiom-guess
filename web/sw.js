// Minimal service worker: makes the site installable and keeps the app shell available when
// the network is down. Everything else (API, hashed assets) goes straight to the network, so a
// new deploy is picked up immediately.
const SHELL = "shell-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.add("./")).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (req.mode === "navigate") {
    // Network first; the cached shell is only a fallback for offline starts.
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put("./", copy)).catch(() => undefined);
          return res;
        })
        .catch(() => caches.match("./")),
    );
  }
});
