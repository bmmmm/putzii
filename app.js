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

  // Central merge application for share links AND file imports. Writes a
  // pre-merge backup so the summary toast can offer "Rückgängig".
  function applyRemotePlan(remotePlan, opts) {
    const local = S().loadPlan(remotePlan.planId);
    const knownBefore = !!local;
    if (local) S().saveBackup(local);
    const { plan, summary } = PZ.share.mergePlans(local, remotePlan, Date.now());
    if (!S().savePlan(plan)) {
      H().showToast("Speichern fehlgeschlagen — Speicher voll?");
      return null;
    }
    S().registerPlan(plan.planId, true);
    // The viewer flag only ever DOWNGRADES a plan this device did not already
    // know — an admin opening their own view link keeps their full UI.
    if (opts && opts.viewer && !knownBefore) S().setUiMode(plan.planId, "view");
    const parts = [];
    if (summary.newEvents) parts.push(`${summary.newEvents} neue Einträge`);
    if (summary.newAreas) parts.push(`${summary.newAreas} neue Bereiche`);
    if (summary.changedAreas) parts.push(`${summary.changedAreas} Bereiche geändert`);
    if (summary.newPeople) parts.push(`${summary.newPeople} neue Personen`);
    const msg = parts.length ? `Zusammengeführt: ${parts.join(", ")}` : "Plan ist schon aktuell.";
    if (knownBefore && parts.length) {
      H().showToast(msg, {
        label: "Rückgängig",
        onClick: () => {
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

  function handleHash() {
    const c = PZ.router.classifyHash(location.hash);
    switch (c.kind) {
      case "share":
        handleShareFragment(c.frag);
        break;
      case "checkin":
        // Area QRs land on c.html; someone hand-typed this here — forward.
        location.replace(`c.html#c1.${c.planId}.${c.areaId}`);
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
    PZ.uiManage.init();
    PZ.uiShare.init();
    window.addEventListener("hashchange", handleHash);
    handleHash();
  }

  PZ.app = { applyRemotePlan, refresh };
  PZ.ui = { refresh };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
