// SPDX-License-Identifier: GPL-3.0-or-later
// Wochen tab: endless forward list of calendar weeks, one tappable Mo–So
// strip per row, inline per-day editor assigning areas × people (slots).
// index.html only — c.html never loads this file.
(function () {
  const PZ = (window.PZ = window.PZ || Object.create(null));
  const H = () => PZ.helpers;
  const M = () => PZ.model;
  const S = () => PZ.store;

  const INITIAL_WEEKS = 8;
  const APPEND_WEEKS = 8;
  const MAX_WEEKS = 156; // 3 years — runaway-DOM backstop

  // Module state: list length survives re-renders so scroll position holds.
  let loadedCount = INITIAL_WEEKS;
  let lastPlanId = "";
  let lastCurrentKey = "";
  let openEditor = null; // {weekKey, day} — one editor open app-wide
  let observer = null;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function isReadonly(plan) {
    return S().getUiMode(plan.planId) === "view";
  }

  // Fresh deep copy of a week's days object (merged records are shallow
  // copies — never mutate in place).
  function freshDays(week) {
    const days = Object.create(null);
    if (week && week.days) {
      for (let d = 1; d <= 7; d++) {
        const v = week.days[String(d)];
        if (Array.isArray(v)) days[String(d)] = v.map((s) => [(s && s[0]) || "", (s && s[1]) || ""]);
      }
    }
    return days;
  }

  function saveDays(plan, weekKey, days) {
    if (!S().saveWeek(plan, weekKey, days)) {
      H().showToast("Speichern fehlgeschlagen — Speicher voll?");
      return false;
    }
    PZ.uiShare.notifyDataChanged();
    return true;
  }

  // Patch a single row in place — a full list rebuild on every tap is visible
  // jank and loses scroll position.
  function patchRow(plan, weekKey) {
    const row = document.querySelector(`.week-row[data-week="${weekKey}"]`);
    if (!row) return;
    const now = Date.now();
    row.replaceWith(renderRow(plan, weekKey, M().eventsByDay(plan, now), now));
  }

  // "Timo: Küche, Bad · Sina: Bad · 2 offen"
  function summaryText(plan, weekKey, tasks) {
    if (!tasks.length) return "";
    const parts = [];
    const seen = new Map();
    let open = 0;
    for (const t of tasks) {
      if (!t.personId) {
        open++;
        continue;
      }
      const name = M().personName(plan, t.personId);
      const label = t.areaId ? (M().areaById(plan, t.areaId) || { name: "?" }).name : "putzen";
      if (!seen.has(name)) seen.set(name, new Set());
      seen.get(name).add(label);
    }
    for (const [name, areas] of seen) parts.push(`${name}: ${[...areas].join(", ")}`);
    if (open) parts.push(`${open} offen`);
    return parts.join(" · ");
  }

  function cellLabel(weekKey, d, state) {
    const date = M().weekDayDate(weekKey, d);
    const stateText = {
      none: "kein Putztag",
      extra: "Check-in ohne Planung",
      planned: "Putztag, offen",
      partial: "Putztag, teilweise erledigt",
      done: "Putztag, erledigt",
    }[state];
    return `${H().ISO_DOW_LONG[d - 1]} ${date ? `${String(date.getDate()).padStart(2, "0")}.${String(date.getMonth() + 1).padStart(2, "0")}.` : ""} — ${stateText}`;
  }

  // Read-only 7-cell strip, shared with the Übersicht card.
  function renderStrip(plan, week, weekKey, byDay, opts) {
    const strip = el("div", "week-strip");
    strip.setAttribute("role", "group");
    strip.setAttribute("aria-label", `Putztage ${H().formatWeekLabel(weekKey, lastCurrentKey)}`);
    for (let d = 1; d <= 7; d++) {
      const { state, done, total } = M().dayCellState(plan, week, weekKey, d, byDay);
      const cell = el("button", `day-cell state-${state}`);
      cell.type = "button";
      cell.dataset.day = String(d);
      cell.setAttribute("aria-pressed", state === "none" || state === "extra" ? "false" : "true");
      cell.setAttribute("aria-label", cellLabel(weekKey, d, state));
      const date = M().weekDayDate(weekKey, d);
      cell.appendChild(el("span", "day-dow", H().ISO_DOW_SHORT[d - 1]));
      cell.appendChild(el("span", "day-num", date ? String(date.getDate()) : ""));
      const mark =
        state === "done" ? "✓" : state === "partial" ? `${done}/${total}` : state === "extra" ? "✓" : "";
      cell.appendChild(el("span", "day-mark", mark));
      if (opts && opts.disabled) cell.disabled = true;
      if (opts && opts.onTap) cell.addEventListener("click", () => opts.onTap(d, state));
      strip.appendChild(cell);
    }
    return strip;
  }

  function renderEditor(plan, weekKey, d) {
    const week = M().weekById(plan, weekKey);
    const slots = M().daySlots(week, d) || [];
    const editor = el("div", "day-editor");
    const date = M().weekDayDate(weekKey, d);
    editor.appendChild(
      el(
        "p",
        "day-editor-title",
        `${H().ISO_DOW_LONG[d - 1]}, ${date ? `${String(date.getDate()).padStart(2, "0")}.${String(date.getMonth() + 1).padStart(2, "0")}.` : ""} — Aufgaben`,
      ),
    );

    const named = slots.filter((s) => s.areaId);
    const unnamed = slots.filter((s) => !s.areaId);

    function commit(newSlots) {
      const days = freshDays(M().weekById(plan, weekKey));
      days[String(d)] = newSlots.map((s) => [s.areaId, s.personId]);
      if (saveDays(plan, weekKey, days)) patchRow(plan, weekKey);
    }

    // Person select for one slot — "offen" default, live people only.
    function personSelect(slot, allSlots) {
      const select = document.createElement("select");
      select.className = "slot-person";
      const openOpt = el("option", "", "offen");
      openOpt.value = "";
      select.appendChild(openOpt);
      for (const p of M().livePeople(plan)) {
        const opt = el("option", "", p.name);
        opt.value = p.id;
        select.appendChild(opt);
      }
      select.value = slot.personId;
      if (select.value !== slot.personId) select.value = "";
      select.addEventListener("change", () => {
        slot.personId = select.value;
        commit(allSlots);
      });
      return select;
    }

    const chips = el("div", "chips");
    // "Egal / alle" — exactly when no named slots exist.
    const anyChip = el("button", `chip${named.length ? "" : " selected"}`, "Egal / alle");
    anyChip.type = "button";
    anyChip.addEventListener("click", () => {
      if (!named.length) return; // already the state
      commit([{ areaId: "", personId: named[0].personId || "" }]);
    });
    chips.appendChild(anyChip);
    if (!named.length && unnamed.length) chips.appendChild(personSelect(unnamed[0], slots));

    for (const area of M().liveAreas(plan)) {
      const slot = named.find((s) => s.areaId === area.id);
      const wrap = el("span", "chip-wrap");
      const chip = el("button", `chip${slot ? " selected" : ""}`, area.name);
      chip.type = "button";
      chip.setAttribute("aria-pressed", slot ? "true" : "false");
      chip.addEventListener("click", () => {
        if (slot) {
          const rest = slots.filter((s) => s !== slot);
          // Removing the last named area keeps the day as an unassigned
          // cleaning day — "Tag entfernen" is the explicit way out.
          commit(rest.length ? rest : [{ areaId: "", personId: "" }]);
        } else {
          // First named area absorbs the unnamed slot (and its person).
          const inherited = named.length === 0 && unnamed.length ? unnamed[0].personId : "";
          const keep = slots.filter((s) => s.areaId);
          commit(keep.concat([{ areaId: area.id, personId: inherited }]));
        }
      });
      wrap.appendChild(chip);
      if (slot) wrap.appendChild(personSelect(slot, slots));
      chips.appendChild(wrap);
    }
    editor.appendChild(chips);

    const actions = el("div", "day-editor-actions");
    const closeBtn = el("button", "btn btn-small", "Fertig");
    closeBtn.type = "button";
    closeBtn.addEventListener("click", () => {
      openEditor = null;
      patchRow(plan, weekKey);
    });
    const removeBtn = el("button", "btn btn-small btn-danger", "Tag entfernen");
    removeBtn.type = "button";
    removeBtn.addEventListener("click", () => {
      const days = freshDays(M().weekById(plan, weekKey));
      delete days[String(d)];
      openEditor = null;
      if (saveDays(plan, weekKey, days)) patchRow(plan, weekKey);
    });
    actions.appendChild(closeBtn);
    actions.appendChild(removeBtn);
    editor.appendChild(actions);
    return editor;
  }

  function renderRow(plan, weekKey, byDay, now) {
    const readonly = isReadonly(plan);
    const week = M().weekById(plan, weekKey);
    const li = el("li", `week-row${weekKey === lastCurrentKey ? " week-current" : ""}`);
    li.dataset.week = weekKey;

    const head = el("div", "week-head");
    head.appendChild(el("span", "week-kw", H().formatWeekLabel(weekKey, lastCurrentKey)));
    head.appendChild(el("span", "week-range", H().formatWeekRange(weekKey)));
    const tasks = M().weekTasks(plan, weekKey, now, byDay);
    const summary = summaryText(plan, weekKey, tasks);
    if (summary) head.appendChild(el("span", "week-summary muted", summary));
    else if (!readonly && M().copyPrevWeekDays(plan, weekKey)) {
      const copyBtn = el("button", "btn btn-small", "Vorwoche kopieren");
      copyBtn.type = "button";
      copyBtn.addEventListener("click", () => {
        const days = M().copyPrevWeekDays(plan, weekKey);
        if (days && saveDays(plan, weekKey, days)) patchRow(plan, weekKey);
      });
      head.appendChild(copyBtn);
    }
    li.appendChild(head);

    li.appendChild(
      renderStrip(plan, week, weekKey, byDay, {
        disabled: readonly,
        onTap: readonly
          ? null
          : (d, state) => {
              if (state === "none" || state === "extra") {
                const days = freshDays(M().weekById(plan, weekKey));
                days[String(d)] = [["", ""]];
                openEditor = null;
                if (saveDays(plan, weekKey, days)) patchRow(plan, weekKey);
              } else {
                // Tapping an active day ALWAYS opens the editor — a silent
                // toggle-off would discard assignments; removal lives inside.
                openEditor =
                  openEditor && openEditor.weekKey === weekKey && openEditor.day === d
                    ? null
                    : { weekKey, day: d };
                render();
              }
            },
      }),
    );

    if (!readonly && openEditor && openEditor.weekKey === weekKey) {
      li.appendChild(renderEditor(plan, weekKey, openEditor.day));
    }
    return li;
  }

  function render() {
    const list = document.getElementById("weeks-list");
    const moreBtn = document.getElementById("weeks-more");
    if (!list || !moreBtn) return;
    const plan = S().loadActivePlan();
    list.textContent = "";
    if (!plan) {
      list.appendChild(el("li", "empty-state", "Noch kein Plan — lege unter Verwalten los."));
      moreBtn.hidden = true;
      return;
    }
    const now = Date.now();
    const currentKey = M().currentWeekKey(now);
    if (plan.planId !== lastPlanId || currentKey !== lastCurrentKey) {
      loadedCount = INITIAL_WEEKS;
      openEditor = null;
      lastPlanId = plan.planId;
      lastCurrentKey = currentKey;
    }
    const byDay = M().eventsByDay(plan, now);
    let key = currentKey;
    for (let i = 0; i < loadedCount && key; i++) {
      list.appendChild(renderRow(plan, key, byDay, now));
      key = H().addWeeks(key, 1);
    }
    const atCap = loadedCount >= MAX_WEEKS;
    moreBtn.hidden = false;
    moreBtn.disabled = atCap;
    moreBtn.textContent = atCap ? "So weit reicht die Planung." : "Mehr Wochen";
  }

  function appendMore() {
    if (loadedCount >= MAX_WEEKS) return;
    loadedCount = Math.min(MAX_WEEKS, loadedCount + APPEND_WEEKS);
    render();
  }

  function init() {
    const moreBtn = document.getElementById("weeks-more");
    moreBtn.addEventListener("click", appendMore);
    // The sentinel IS the button: IntersectionObserver drives the same code
    // path the click does — works without IO, keyboard- and SR-reachable.
    if ("IntersectionObserver" in window) {
      observer = new IntersectionObserver(
        (entries) => {
          const visible = entries.some((e) => e.isIntersecting);
          const wochenShown = !document.getElementById("view-wochen").hidden;
          if (visible && wochenShown && !moreBtn.disabled) appendMore();
        },
        { rootMargin: "200px" },
      );
      observer.observe(moreBtn);
    }
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && openEditor) {
        const plan = S().loadActivePlan();
        const weekKey = openEditor.weekKey;
        openEditor = null;
        if (plan) patchRow(plan, weekKey);
      }
    });
  }

  // renderStrip is shared with the Übersicht card (read-only there).
  PZ.uiWeeks = { render, init, renderStrip };
})();
