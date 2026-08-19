// SPDX-License-Identifier: GPL-3.0-or-later
// Single source of truth for hash classification (reserved prefixes) and view
// switching on index.html. Payload decoding lives in share.js; app.js decides
// what to do with each kind.
(function () {
  const PZ = (window.PZ = window.PZ || Object.create(null));
  const H = () => PZ.helpers;

  const ROUTES = ["uebersicht", "wochen", "verlauf", "verwalten", "teilen", "qr"];

  // Classify without decoding: cheap, sync, and it enforces the size cap
  // before any parsing can happen.
  function classifyHash(rawHash) {
    const frag = String(rawHash || "").replace(/^#/, "");
    if (!frag) return { kind: "empty" };
    if (frag.length > H().MAX_HASH_CHARS) return { kind: "unknown" };
    if (frag.startsWith("p1.") || frag.startsWith("p1u.")) return { kind: "share", frag };
    if (frag.startsWith("c1.")) {
      const m = frag.match(/^c1\.([A-Za-z0-9_-]{1,32})\.([a-z2-9]{1,16})$/);
      if (!m) return { kind: "unknown" };
      return { kind: "checkin", planId: m[1], areaId: m[2] };
    }
    if (ROUTES.includes(frag)) return { kind: "route", name: frag };
    return { kind: "unknown" };
  }

  function showView(name) {
    for (const r of ROUTES) {
      const section = document.getElementById(`view-${r}`);
      if (section) section.hidden = r !== name;
    }
    document.querySelectorAll(".tabs a[data-route]").forEach((a) => {
      a.classList.toggle("active", a.dataset.route === name);
    });
    if (typeof PZ.onRouteShown === "function") PZ.onRouteShown(name);
  }

  function go(name) {
    if (location.hash !== `#${name}`) location.hash = `#${name}`;
    else showView(name);
  }

  // Drop a payload fragment from the address bar (so a reload cannot re-merge
  // and the URL stops showing 1600 chars of base64) without adding history.
  function replaceHash(name) {
    history.replaceState(null, "", `${location.pathname}${name ? "#" + name : ""}`);
  }

  PZ.router = { ROUTES, classifyHash, showView, go, replaceHash };
})();
