// SPDX-License-Identifier: GPL-3.0-or-later
(function () {
  if (!("serviceWorker" in navigator)) return;
  if (location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
    return;
  }

  // Capture whether a controller already exists BEFORE registering: on a fresh
  // first visit there is none, so the controllerchange below (fired by the new
  // SW's skipWaiting + clients.claim) must not prompt a reload mid-first-load.
  const hadController = !!navigator.serviceWorker.controller;
  let notified = false;

  function showUpdateToast() {
    if (notified || !document.body) return;
    notified = true;
    const bar = document.createElement("div");
    bar.setAttribute("role", "status");
    bar.className = "toast";
    bar.hidden = false;
    const text = document.createElement("span");
    text.textContent = "Neue Version verfügbar.";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn";
    btn.textContent = "Aktualisieren";
    btn.addEventListener("click", () => location.reload());
    bar.appendChild(text);
    bar.appendChild(btn);
    document.body.appendChild(bar);
  }

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    // Only notify when an EXISTING controller was replaced by a new deploy —
    // never on the first install. A toast (not an auto-reload) so we don't
    // interrupt an in-progress check-in.
    if (hadController) showUpdateToast();
  });

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch((err) => {
      console.warn("putzii: service worker registration failed", err);
    });
  });
})();
