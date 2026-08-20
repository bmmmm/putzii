// SPDX-License-Identifier: GPL-3.0-or-later
const VERSION = "putzii-v2.2-2026-08-21a";
const APP_SHELL = [
  "./",
  "./index.html",
  "./c.html",
  "./style.css",
  "./print.css",
  "./manifest.json",
  "./favicon.svg",
  "./qrcodegen.js",
  "./helpers.js",
  "./store.js",
  "./model.js",
  "./share.js",
  "./router.js",
  "./ui-weeks.js",
  "./ui-views.js",
  "./ui-manage.js",
  "./ui-share.js",
  "./ui-checkin.js",
  "./app.js",
  "./dropcrypto.js",
  "./drop.js",
  "./sync.js",
  "./self-check.js",
  "./sw-register.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Never touch requests outside our own directory: the drop state lives on
  // the SAME origin (…github.io/putzii-drop/) and a cache-first hit would
  // freeze it forever. Scope-based, so any same-origin drop path is safe.
  if (!url.pathname.startsWith(new URL(self.registration.scope).pathname)) return;
  // Explicit no-store (the sync read path) must never come from a cache.
  if (req.cache === "no-store") return;

  const isHtml = req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html");

  if (isHtml) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // Only cache a genuine same-origin 200 — never poison the app shell
          // with a 404, an opaque response, or a captive-portal login page.
          if (res && res.status === 200 && res.type === "basic") {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match("./index.html"))),
    );
    return;
  }

  event.respondWith(
    caches
      .match(req)
      .then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res && res.status === 200 && res.type === "basic") {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        });
      })
      // A cache-miss while offline would otherwise reject the whole respondWith.
      .catch(() => new Response("", { status: 503, statusText: "Offline" })),
  );
});
