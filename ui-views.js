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
    card.addEventListener("click", () => PZ.router.go("wochen"));
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
      // Same flow as the printed QR — the sticker is just a shortcut to this.
      const btn = el("a", "btn", "✓ Eintragen");
      btn.href = `c.html#c1.${plan.planId}.${row.area.id}`;
      card.appendChild(btn);
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

  PZ.uiViews = { renderUebersicht, renderVerlauf, init };
})();
