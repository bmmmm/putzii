// SPDX-License-Identifier: GPL-3.0-or-later
// Teilen: share links, QR, file export/import, unshared badge, QR print sheet.
//
// navigator.share() needs TRANSIENT USER ACTIVATION and Safari consumes it on
// any await — so share URLs are precomputed asynchronously whenever data
// changes, and the click handlers below call navigator.share() synchronously
// with the cached string.
(function () {
  const PZ = (window.PZ = window.PZ || Object.create(null));
  const H = () => PZ.helpers;
  const M = () => PZ.model;
  const S = () => PZ.store;

  const cache = { planId: "", team: null, view: null };
  let computeToken = 0;
  let pendingImport = null;

  async function recompute() {
    const token = ++computeToken;
    const plan = S().loadActivePlan();
    if (!plan) {
      cache.planId = "";
      cache.team = null;
      cache.view = null;
      return;
    }
    const [team, view] = await Promise.all([
      PZ.share.buildShareUrl(plan, { viewer: false }),
      PZ.share.buildShareUrl(plan, { viewer: true }),
    ]);
    if (token !== computeToken) return; // a newer recompute superseded us
    cache.planId = plan.planId;
    cache.team = team;
    cache.view = view;
    renderTeilenStats();
  }

  function markShared() {
    const plan = S().loadActivePlan();
    if (plan) S().setLastSharedAt(plan.planId, Date.now());
    updateBadge();
  }

  function clipboardFallback(url) {
    navigator.clipboard
      .writeText(url)
      .then(() => {
        markShared();
        H().showToast("Link kopiert ✓");
      })
      .catch(() => {
        const ta = document.getElementById("share-fallback");
        if (!ta) return;
        ta.hidden = false;
        ta.value = url;
        ta.focus();
        ta.select();
        H().showToast("Link manuell kopieren (markiert).");
      });
  }

  // MUST stay synchronous up to the navigator.share() call.
  function shareVia(kind) {
    const entry = cache[kind];
    if (!entry) {
      H().showToast("Link wird noch berechnet — gleich nochmal tippen.");
      recompute();
      return;
    }
    if (entry.band === "red") {
      H().showToast("Plan zu groß für einen Link — bitte als Datei exportieren.");
      return;
    }
    const payload = {
      title: "putzii",
      text: kind === "view" ? "Putzplan ansehen" : "Unser Putzplan",
      url: entry.url,
    };
    if (navigator.share && (!navigator.canShare || navigator.canShare(payload))) {
      navigator
        .share(payload)
        .then(markShared)
        .catch((e) => {
          if (!e || e.name !== "AbortError") clipboardFallback(entry.url);
        });
    } else {
      clipboardFallback(entry.url);
    }
  }

  function renderTeilenStats() {
    const statsEl = document.getElementById("share-stats");
    if (!statsEl) return;
    const entry = cache.team;
    if (!entry) {
      statsEl.textContent = "";
      return;
    }
    let text = `Teilt ${entry.sharedEvents} von ${entry.totalEvents} Einträgen`;
    if (entry.totalWeeks > 0) text += ` · ${entry.sharedWeeks} von ${entry.totalWeeks} Wochen`;
    text += ` · Link: ${entry.url.length} Zeichen.`;
    if (entry.band === "amber") text += " Zu groß für QR — Link oder Datei nutzen.";
    if (entry.band === "red") text += " Zu groß für einen Link — Datei nutzen.";
    statsEl.textContent = text;
  }

  function renderTeilen() {
    renderTeilenStats();
    renderDropStatus();
    const wrap = document.getElementById("share-qr-wrap");
    if (wrap) wrap.hidden = true;
    const ta = document.getElementById("share-fallback");
    if (ta) ta.hidden = true;
    const preview = document.getElementById("import-preview");
    if (preview) preview.hidden = true;
    if (!cache.team) recompute();
  }

  function showTeamQr() {
    const wrap = document.getElementById("share-qr-wrap");
    const note = document.getElementById("share-qr-note");
    const canvas = document.getElementById("share-qr-canvas");
    const entry = cache.team;
    if (!entry) {
      H().showToast("Link wird noch berechnet — gleich nochmal tippen.");
      recompute();
      return;
    }
    if (entry.band !== "green") {
      wrap.hidden = false;
      canvas.hidden = true;
      note.textContent = "Link zu groß für einen QR-Code — teile ihn als Link oder Datei.";
      return;
    }
    try {
      // Big payload → ECC low keeps the module count scannable on screens.
      H().drawQrToCanvas(canvas, entry.url, {
        maxPx: Math.min(360, Math.max(220, window.innerWidth - 48)),
        ecc: "low",
      });
      canvas.hidden = false;
      note.textContent = "Team-Link zum Abscannen von einem anderen Handy.";
      wrap.hidden = false;
    } catch (e) {
      H().showToast("QR konnte nicht erzeugt werden.");
    }
  }

  function slugify(name) {
    return (
      String(name || "plan")
        .toLowerCase()
        .replace(/[äöüß]/g, (c) => ({ ä: "ae", ö: "oe", ü: "ue", ß: "ss" })[c])
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 30) || "plan"
    );
  }

  function exportFile() {
    const plan = S().loadActivePlan();
    if (!plan) return;
    const d = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const blob = new Blob([PZ.share.serializeFile(plan)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `putzii-${slugify(plan.name)}-${date}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function onImportFile(file) {
    file
      .text()
      .then((text) => {
        const imported = PZ.share.parseFile(text);
        if (!imported) {
          H().showToast("Keine gültige putzii-Datei.");
          return;
        }
        pendingImport = imported;
        const local = S().loadPlan(imported.planId);
        const previewText = document.getElementById("import-preview-text");
        if (local) {
          // Dry-run merge for honest numbers; nothing is saved here.
          const { summary } = PZ.share.mergePlans(local, imported, Date.now());
          previewText.textContent =
            `„${imported.name}": ${summary.newAreas} neue Bereiche · ${summary.newPeople} neue Personen · ` +
            `${summary.newEvents} neue Einträge · ${summary.changedAreas + summary.changedPeople} Änderungen.`;
        } else {
          previewText.textContent = `Neuer Plan „${imported.name}" mit ${imported.events.length} Einträgen wird angelegt.`;
        }
        document.getElementById("import-preview").hidden = false;
      })
      .catch(() => H().showToast("Datei konnte nicht gelesen werden."));
  }

  function applyImport() {
    if (!pendingImport) return;
    PZ.app.applyRemotePlan(pendingImport, { viewer: false });
    pendingImport = null;
    document.getElementById("import-preview").hidden = true;
  }

  function renderQrSheet() {
    const sheet = document.getElementById("qr-sheet");
    if (!sheet) return;
    sheet.textContent = "";
    const plan = S().loadActivePlan();
    if (!plan) return;
    for (const area of M().liveAreas(plan)) {
      const tile = document.createElement("div");
      tile.className = "qr-tile";
      const canvas = document.createElement("canvas");
      try {
        // Version-4 QR at scale 16 ≈ 656 px, CSS-sized to 40 mm → ~416 dpi.
        H().drawQrToCanvas(canvas, PZ.share.checkinUrl(plan.planId, area.id), { scale: 16 });
      } catch (e) {
        continue;
      }
      tile.appendChild(canvas);
      const areaP = document.createElement("p");
      areaP.className = "tile-area";
      areaP.textContent = area.name;
      tile.appendChild(areaP);
      const planP = document.createElement("p");
      planP.className = "tile-plan";
      planP.textContent = `putzii · ${plan.name}`;
      tile.appendChild(planP);
      sheet.appendChild(tile);
    }
  }

  function updateBadge() {
    const btn = document.getElementById("btn-share-header");
    const count = document.getElementById("share-badge-count");
    if (!btn || !count) return;
    const plan = S().loadActivePlan();
    if (!plan || (!plan.events.length && !plan.areas.length)) {
      btn.hidden = true;
      return;
    }
    btn.hidden = false;
    // With a HEALTHY server the counter disappears — the server distributes
    // updates, nagging would lie. In error/off/queued the old behavior
    // returns unchanged: the fallback must not feel broken.
    const drop = PZ.sync ? PZ.sync.status(plan.planId) : { state: "off" };
    const healthy = ["idle", "pulling", "pushing"].includes(drop.state);
    if (healthy) {
      count.hidden = true;
      return;
    }
    // Week planning must nudge a re-share just like check-ins do.
    const sharedAt = S().getLastSharedAt(plan.planId);
    const n = M().unsharedCount(plan, sharedAt) + M().unsharedWeekCount(plan, sharedAt);
    count.hidden = n === 0;
    count.textContent = n > 0 ? `· ${n} neu` : "";
  }

  // --- server section on the Teilen tab ---

  // One line per state the sync machine can be in. Every branch names a
  // CAUSE the household can act on — "nicht erreichbar" is the last resort,
  // not the default.
  const DROP_ERROR_TEXT = {
    authfail: "Zugang abgelaufen — neuen Zugangs-Link anfordern.",
    forbidden: "Dieser Link darf nur Erledigt-Meldungen senden — persönlichen Zugangs-Link öffnen.",
    keymismatch: "Schlüssel passt nicht — Link erneuern.",
    notfound: "Dieser Server kennt den Plan nicht — Zugangs-Link prüfen.",
    conflict: "Jemand anderes war schneller — beim nächsten Versuch wird zusammengeführt.",
    toolarge: "Plan zu groß zum Senden — alte Einträge im Server-Log ausdünnen.",
    rejected: "Server hat den Stand abgelehnt — App auf allen Geräten neu laden, dann synchronisieren.",
  };

  function dropStatusText(st) {
    let text;
    if (st.state === "off") {
      text = "Kein Server verbunden — öffne deinen persönlichen Zugangs-Link.";
    } else if (st.state === "error") {
      text = DROP_ERROR_TEXT[st.error] || "Server nicht erreichbar.";
    } else if (st.state === "queued") {
      text = "Änderungen werden nachgeholt, sobald der Server erreichbar ist.";
    } else if (st.state === "pulling" || st.state === "pushing") {
      text = "Synchronisiere…";
    } else {
      text = st.dirty ? "Server verbunden — lokale Änderungen ausstehend." : "Server ✓ synchron.";
    }
    if (st.stale) text += " Server antwortet mit altem Stand.";
    return text;
  }

  function renderDropStatus() {
    const statusEl = document.getElementById("drop-status");
    if (!statusEl) return;
    const st = PZ.sync.status();
    statusEl.textContent = dropStatusText(st);
    const connected = st.state !== "off";
    const syncBtn = document.getElementById("btn-drop-sync");
    const discBtn = document.getElementById("btn-drop-disconnect");
    if (syncBtn) syncBtn.hidden = !connected;
    if (discBtn) discBtn.hidden = !connected;
  }

  function notifyDataChanged() {
    updateBadge();
    recompute();
  }

  function init() {
    document.getElementById("btn-share-team").addEventListener("click", () => shareVia("team"));
    document.getElementById("btn-share-view").addEventListener("click", () => shareVia("view"));
    document.getElementById("btn-share-header").addEventListener("click", () => shareVia("team"));
    document.getElementById("btn-share-qr").addEventListener("click", showTeamQr);
    document.getElementById("btn-export-file").addEventListener("click", exportFile);
    document.getElementById("btn-import-apply").addEventListener("click", applyImport);
    document.getElementById("btn-import-cancel").addEventListener("click", () => {
      pendingImport = null;
      document.getElementById("import-preview").hidden = true;
    });
    document.getElementById("import-file").addEventListener("change", (ev) => {
      if (ev.target.files && ev.target.files[0]) onImportFile(ev.target.files[0]);
      ev.target.value = "";
    });
    document.getElementById("btn-print").addEventListener("click", () => window.print());
    const dropSync = document.getElementById("btn-drop-sync");
    if (dropSync) {
      dropSync.addEventListener("click", () => {
        PZ.sync.tick("manual");
        renderDropStatus();
      });
    }
    const dropDisc = document.getElementById("btn-drop-disconnect");
    if (dropDisc) {
      dropDisc.addEventListener("click", () => {
        PZ.sync.disconnect();
        H().showToast("Drop getrennt — der Plan bleibt auf diesem Gerät.");
        renderDropStatus();
        updateBadge();
      });
    }
    notifyDataChanged();
  }

  PZ.uiShare = {
    init,
    renderTeilen,
    renderQrSheet,
    updateBadge,
    notifyDataChanged,
    shareVia,
    renderDropStatus,
  };
})();
