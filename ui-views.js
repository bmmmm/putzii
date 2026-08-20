// SPDX-License-Identifier: GPL-3.0-or-later
// Übersicht (dashboard cards) + Verlauf (history list) rendering.
(function () {
  const PZ = (window.PZ = window.PZ || Object.create(null));
  const H = () => PZ.helpers;
  const M = () => PZ.model;
  const S = () => PZ.store;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // One-tap check-in from the overview card, as the remembered device
  // person. DOM-free so self-check can drive it. Mirrors ui-checkin.js
  // confirmCheckin step for step — change the two together.
  function instantCheckin(plan, area, nowMs, opts) {
    const o = opts || {};
    const person = S().resolveMe(plan, "");
    if (!person) return { status: "nome" };
    if (M().existsRecent(plan, area.id, person.id, nowMs)) return { status: "already", person };
    if (!o.force) {
      const recent = M().recentByAnyone(plan, area.id, nowMs);
      if (recent) return { status: "cooldown", recent, person };
    }
    const ev = S().newEvent(plan, area.id, person.id, nowMs);
    if (!S().appendEvents(plan, [ev])) return { status: "failed" };
    // Invariant 11: markDirty lives HERE, at the user mutation callsite —
    // never inside savePlan/appendEvents.
    if (PZ.sync && PZ.sync.connected(plan.planId)) PZ.sync.markDirty(plan.planId);
    const pending = S().getPending();
    if (pending && pending.planId === plan.planId && pending.areaId === area.id) {
      S().clearPending();
    }
    return { status: "ok", ev, person };
  }

  // Undo deliberately does NOT markDirty: events merge append-only
  // first-seen-wins, so a dirty push would just re-deliver the event —
  // same known limitation as c.html's undo button.
  function undoInstant(planId, evId) {
    const plan = S().loadPlan(planId);
    if (plan && S().removeEvent(plan, evId)) H().showToast("Eintrag entfernt.");
    PZ.ui.refresh();
  }

  function onInstantTap(planId, areaId) {
    // Always reload — refresh() has replaced the render-time plan object.
    const plan = S().loadPlan(planId);
    const area = plan && M().areaById(plan, areaId);
    if (!plan || !area) return;
    const now = Date.now();
    const res = instantCheckin(plan, area, now, {});
    if (res.status === "ok") {
      H().showToast(`${area.name} ✓ — ${res.person.name}`, {
        label: "Rückgängig",
        onClick: () => undoInstant(planId, res.ev.id),
      }, 60000);
      PZ.ui.refresh();
    } else if (res.status === "cooldown") {
      const who = M().personName(plan, res.recent.personId);
      const when = H().formatRelPast(M().effTs(res.recent.ts, now), now);
      H().showToast(`Bereits ${when} von ${who} erledigt.`, {
        label: "Trotzdem",
        onClick: () => {
          const fresh = S().loadPlan(planId);
          const freshArea = fresh && M().areaById(fresh, areaId);
          if (!fresh || !freshArea) return;
          const r2 = instantCheckin(fresh, freshArea, Date.now(), { force: true });
          if (r2.status === "ok") {
            H().showToast(`${freshArea.name} ✓ — ${r2.person.name}`, {
              label: "Rückgängig",
              onClick: () => undoInstant(planId, r2.ev.id),
            }, 60000);
          }
          PZ.ui.refresh();
        },
      });
    } else if (res.status === "already") {
      H().showToast("Schon eingetragen.");
      PZ.ui.refresh();
    } else if (res.status === "failed") {
      H().showToast("Speichern fehlgeschlagen — Speicher voll?");
    } else {
      // no usable identity after all — fall back to the picker page
      location.href = `c.html#c1.${planId}.${areaId}`;
    }
  }

  // Current-week duty card: "KW 34 · wer muss diese Woche was machen".
  // Read-only on purpose — the card summarises, the Wochen tab edits.
  function renderWeekCard(container, plan, now) {
    const weekKey = M().currentWeekKey(now);
    const byDay = M().eventsByDay(plan, now);
    const tasks = M().weekTasks(plan, weekKey, now, byDay);
    if (!tasks.length && !M().livePeople(plan).length) return;
    const card = el("div", "card week-card");
    const head = el("p", "week-card-head");
    head.appendChild(el("strong", "", H().formatWeekLabel(weekKey, weekKey)));
    head.appendChild(document.createTextNode(` · ${H().formatWeekRange(weekKey)}`));
    card.appendChild(head);
    if (tasks.length) {
      const list = el("ul", "week-card-tasks");
      for (const t of tasks) {
        const li = document.createElement("li");
        const who = t.personId ? M().personName(plan, t.personId) : "offen";
        const what = t.areaId ? (M().areaById(plan, t.areaId) || { name: "?" }).name : "putzen";
        li.textContent = `${who} → ${what} (${H().ISO_DOW_SHORT[t.day - 1]})${t.done ? " ✓" : ""}`;
        if (!t.personId) li.classList.add("muted");
        list.appendChild(li);
      }
      card.appendChild(list);
      const doneCount = tasks.filter((t) => t.done).length;
      card.appendChild(el("p", "muted", `${doneCount} von ${tasks.length} erledigt`));
      card.appendChild(PZ.uiWeeks.renderStrip(plan, M().weekById(plan, weekKey), weekKey, byDay, { disabled: true }));
    } else {
      card.appendChild(el("p", "muted", "Noch keine Putztage geplant — antippen zum Planen."));
    }
    // A div, not a button — it legally contains the tasks <ul>. Give it
    // the full button contract instead.
    card.setAttribute("role", "button");
    card.tabIndex = 0;
    card.setAttribute("aria-label", "Wochenplan öffnen");
    card.addEventListener("click", () => PZ.router.go("wochen"));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        PZ.router.go("wochen");
      }
    });
    container.appendChild(card);
  }

  function renderUebersicht() {
    const container = document.getElementById("cards-container");
    const empty = document.getElementById("empty-uebersicht");
    if (!container || !empty) return;
    container.textContent = "";
    const plan = S().loadActivePlan();
    const rows = plan ? M().dashboardRows(plan, Date.now()) : [];
    empty.hidden = rows.length > 0;
    if (!plan || !rows.length) return;
    const now = Date.now();
    renderWeekCard(container, plan, now);
    const me = S().resolveMe(plan, "");
    for (const row of rows) {
      const card = el("div", `card status-${row.status}`);
      const left = el("div");
      left.appendChild(el("p", "area-name", row.area.name));
      const due = `${H().formatDue(row.dueAt, now)} · ${H().formatDayShort(row.dueAt)}`;
      left.appendChild(el("p", "due-line", due));
      const lastText = row.lastEvent
        ? `Zuletzt: ${M().personName(plan, row.lastEvent.personId)}, ${H().formatRelPast(M().effTs(row.lastEvent.ts, now), now)}`
        : `Noch nie geputzt · alle ${row.area.intervalDays} Tage`;
      left.appendChild(el("p", "last-line", lastText));
      card.appendChild(left);
      if (me) {
        // Device knows who you are: check in right here, one tap.
        const btn = el("button", "btn btn-primary", "✓ Geputzt");
        btn.type = "button";
        btn.setAttribute("aria-label", `${row.area.name} als ${me.name} eintragen`);
        btn.addEventListener("click", () => onInstantTap(plan.planId, row.area.id));
        card.appendChild(btn);
      } else {
        // Same flow as the printed QR — the sticker is just a shortcut to this.
        const btn = el("a", "btn", "✓ Eintragen");
        btn.href = `c.html#c1.${plan.planId}.${row.area.id}`;
        card.appendChild(btn);
      }
      container.appendChild(card);
    }
  }

  function renderVerlauf() {
    const list = document.getElementById("history-list");
    const empty = document.getElementById("empty-verlauf");
    const filter = document.getElementById("filter-area");
    if (!list || !empty || !filter) return;
    const plan = S().loadActivePlan();
    const selected = filter.value;
    // Rebuild filter options: any area that has events or is live.
    const withEvents = new Set(plan ? plan.events.map((e) => e.areaId) : []);
    filter.textContent = "";
    const allOpt = el("option", "", "Alle");
    allOpt.value = "";
    filter.appendChild(allOpt);
    if (plan) {
      for (const a of plan.areas) {
        if (!a.deletedAt || withEvents.has(a.id)) {
          const opt = el("option", "", a.deletedAt ? `${a.name} (gelöscht)` : a.name);
          opt.value = a.id;
          filter.appendChild(opt);
        }
      }
    }
    filter.value = selected;
    if (filter.value !== selected) filter.value = "";

    list.textContent = "";
    const now = Date.now();
    const rows = plan ? M().historyRows(plan, filter.value, now) : [];
    empty.hidden = rows.length > 0;
    for (const row of rows.slice(0, 300)) {
      const li = document.createElement("li");
      const left = el("div");
      const who = el("span", "who", M().personName(plan, row.event.personId));
      left.appendChild(who);
      const area = M().areaById(plan, row.event.areaId);
      const areaLabel = area ? (area.deletedAt ? `${area.name} (gelöscht)` : area.name) : "Unbekannter Bereich";
      const areaSpan = el("span", area && !area.deletedAt ? "" : "deleted-area", ` — ${areaLabel}`);
      left.appendChild(areaSpan);
      if (row.count > 1) left.appendChild(el("span", "multi", ` ×${row.count}`));
      li.appendChild(left);
      li.appendChild(el("span", "when", H().formatDateTime(M().effTs(row.event.ts, now))));
      list.appendChild(li);
    }
  }

  function init() {
    const filter = document.getElementById("filter-area");
    if (filter) filter.addEventListener("change", renderVerlauf);
  }

  PZ.uiViews = { renderUebersicht, renderVerlauf, init, instantCheckin };
})();
