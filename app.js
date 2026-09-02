// SPDX-License-Identifier: GPL-3.0-or-later
// index.html boot: hash classification, merge-on-open, pending banner,
// view-mode gating, central refresh.
(function () {
  const PZ = (window.PZ = window.PZ || Object.create(null));
  const H = () => PZ.helpers;
  const S = () => PZ.store;

  let currentRoute = "uebersicht";

  function viewMode() {
    const idx = S().loadPlanIndex();
    return idx.active ? S().getUiMode(idx.active) : "";
  }

  function applyViewModeChrome() {
    const isView = viewMode() === "view";
    document.querySelectorAll("[data-hide-in-view-mode]").forEach((el) => {
      el.hidden = isView;
    });
  }

  function refresh(routeName) {
    if (routeName) currentRoute = routeName;
    applyViewModeChrome();
    PZ.uiShare.updateBadge();
    renderPendingBanner();
    switch (currentRoute) {
      case "uebersicht":
        PZ.uiViews.renderUebersicht();
        break;
      case "wochen":
        PZ.uiWeeks.render();
        break;
      case "verlauf":
        PZ.uiViews.renderVerlauf();
        break;
      case "verwalten":
        PZ.uiManage.render();
        break;
      case "teilen":
        PZ.uiShare.renderTeilen();
        break;
      case "qr":
        PZ.uiShare.renderQrSheet();
        break;
    }
    PZ.uiShare.notifyDataChanged();
  }

  function renderPendingBanner() {
    const banner = document.getElementById("banner-pending");
    if (!banner) return;
    const pending = S().getPending();
    const plan = pending ? S().loadPlan(pending.planId) : null;
    const area = plan ? plan.areas.find((a) => a.id === pending.areaId && !a.deletedAt) : null;
    if (!area) {
      banner.hidden = true;
      return;
    }
    document.getElementById("banner-pending-text").textContent = `Offener Check-in: ${area.name}`;
    document.getElementById("banner-pending-link").href = `c.html#c1.${pending.planId}.${pending.areaId}`;
    banner.hidden = false;
  }

  // Central merge application for share links AND file imports. The merge
  // itself lives in sync.importPlan (it writes the pre-merge backup and marks
  // the plan dirty on a connected server); this is the UI around it.
  function applyRemotePlan(remotePlan, opts) {
    const res = PZ.sync.importPlan(remotePlan, Date.now());
    if (!res) {
      H().showToast("Speichern fehlgeschlagen — Speicher voll?");
      return null;
    }
    const { plan, summary, knownBefore } = res;
    // The viewer flag only ever DOWNGRADES a plan this device did not already
    // know — an admin opening their own view link keeps their full UI.
    if (opts && opts.viewer && !knownBefore) S().setUiMode(plan.planId, "view");
    const parts = [];
    if (summary.newEvents) parts.push(`${summary.newEvents} neue Einträge`);
    if (summary.newAreas) parts.push(`${summary.newAreas} neue Bereiche`);
    if (summary.changedAreas) parts.push(`${summary.changedAreas} Bereiche geändert`);
    if (summary.newPeople) parts.push(`${summary.newPeople} neue Personen`);
    if (summary.newWeeks) parts.push(`${summary.newWeeks} neue Wochen`);
    if (summary.changedWeeks) parts.push(`${summary.changedWeeks} Wochen geändert`);
    if (summary.changedName) parts.push("Name geändert");
    const msg = parts.length ? `Zusammengeführt: ${parts.join(", ")}` : "Plan ist schon aktuell.";
    if (knownBefore && parts.length) {
      H().showToast(msg, {
        label: "Rückgängig",
        onClick: () => {
          // Once the import reached the server, a local revert would only be
          // re-merged by the next pull — say so instead of pretending.
          if (!PZ.sync.canUndoImport(plan.planId)) {
            H().showToast("Rückgängig nicht mehr möglich — der Stand ist schon beim Server.");
            return;
          }
          const backup = S().loadBackup(plan.planId);
          if (backup && S().savePlan(backup)) {
            S().clearBackup(plan.planId);
            refresh();
            H().showToast("Merge rückgängig gemacht.");
          } else {
            H().showToast("Rückgängig nicht mehr möglich.");
          }
        },
      });
    } else {
      H().showToast(knownBefore ? msg : `Plan „${plan.name}" übernommen ✓`);
    }
    refresh();
    return summary;
  }

  async function handleShareFragment(frag) {
    try {
      const { plan, viewer } = await PZ.share.decodeShareFragment(frag);
      applyRemotePlan(plan, { viewer });
    } catch (e) {
      if (e && e.code === "version") {
        H().showToast("Link stammt aus einer neueren putzii-Version — App neu laden.");
      } else {
        H().showToast("Link konnte nicht gelesen werden.");
      }
    }
    // Strip the payload: a reload must not re-merge, and the URL bar should
    // not keep showing 1600 chars of base64.
    PZ.router.replaceHash("uebersicht");
    PZ.router.showView("uebersicht");
  }

  // A #d2. link carries the write token AND the state key: strip it from the
  // URL bar BEFORE any await — nothing may keep showing or re-processing it.
  function handleDropFragment(frag) {
    PZ.router.replaceHash("teilen");
    const creds = PZ.drop.parseCredentialFragment(frag);
    if (!creds) {
      H().showToast("Zugangs-Link konnte nicht gelesen werden.");
      PZ.router.showView("uebersicht");
      return;
    }
    if (!PZ.drop.acceptCredentials(creds)) {
      H().showToast("Speichern fehlgeschlagen — Speicher voll?");
      PZ.router.showView("uebersicht");
      return;
    }
    S().registerPlan(creds.planId, true);
    // The link is personal: remember who this device belongs to.
    const plan = S().loadPlan(creds.planId);
    if (plan && plan.people.some((p) => p.id === creds.personId)) {
      S().setMe(creds.planId, creds.personId);
    }
    PZ.router.showView("teilen");
    PZ.sync.tick("drop-link", { planId: creds.planId }).then(() => {
      const me = S().loadPlan(creds.planId);
      if (me && me.people.some((p) => p.id === creds.personId)) {
        S().setMe(creds.planId, creds.personId);
      }
      // The toast waits for the first round trip: "verbunden" before any
      // fetch happened was a promise, not a fact. The Teilen tab names the
      // exact cause; this only says whether the plan arrived.
      // Same "healthy" set as the badge: `queued` is a FAILED round trip
      // with old local changes waiting, not a connection.
      const st = PZ.sync.status(creds.planId);
      if (["idle", "pulling", "pushing"].includes(st.state)) {
        H().showToast(`Server verbunden — du bist ${creds.personName} ✓`);
      } else if (st.state === "queued" || st.error === "net") {
        H().showToast("Zugang gespeichert — Server gerade nicht erreichbar, wird nachgeholt.", null, 8000);
      } else {
        H().showToast("Zugang gespeichert — der Server lehnt ab, Details unter Teilen.", null, 8000);
      }
      refresh();
    });
  }

  function handleHash() {
    const c = PZ.router.classifyHash(location.hash);
    switch (c.kind) {
      case "share":
        handleShareFragment(c.frag);
        break;
      case "drop":
        handleDropFragment(c.frag);
        break;
      case "checkin":
        // Area QRs land on c.html; someone hand-typed this here — forward.
        location.replace(`c.html#c1.${c.planId}.${c.areaId}`);
        break;
      case "confirm":
        // k2 confirm links target c.html — forward, fragment intact.
        location.replace(`c.html#${c.frag}`);
        break;
      case "legacy":
        // A link from the retired GitHub drop. Drop the payload from the URL
        // bar first — it still carries a token — then say what to do.
        PZ.router.replaceHash("uebersicht");
        H().showToast("Dieser Link gehört zur alten GitHub-Version — bitte einen neuen Zugangs-Link anfordern.", null, 8000);
        PZ.router.showView("uebersicht");
        break;
      case "route": {
        const name = c.name === "verwalten" && viewMode() === "view" ? "uebersicht" : c.name;
        PZ.router.showView(name);
        break;
      }
      default:
        PZ.router.replaceHash("uebersicht");
        PZ.router.showView("uebersicht");
    }
  }

  function boot() {
    S().ensureSchema();
    PZ.onRouteShown = refresh;
    PZ.uiViews.init();
    PZ.uiWeeks.init();
    PZ.uiManage.init();
    PZ.uiShare.init();
    window.addEventListener("hashchange", handleHash);
    PZ.sync.initTriggers();
    PZ.sync.onChanged = () => {
      PZ.uiShare.renderDropStatus();
      PZ.uiShare.updateBadge();
    };
    handleHash();
    PZ.sync.tick("boot");
  }

  PZ.app = { applyRemotePlan, refresh };
  PZ.ui = { refresh };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
