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
    // USER mutation callsite — not in saveWeek/savePlan (merge ping-pong).
    if (PZ.sync) PZ.sync.markDirty(plan.planId);
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

  // patchRow replaces the row's DOM, silently dropping focus to <body> —
  // stable data-focus keys let handlers restore it on the fresh nodes.
  function focusIn(weekKey, selector) {
    const target = document.querySelector(`.week-row[data-week="${weekKey}"] ${selector}`);
    if (target) target.focus({ preventScroll: true });
  }

  // Open/close is a pure UI action: no write, no dispatch — a stray tap
  // costs nothing. Patches BOTH affected rows (one editor app-wide);
  // safe to close any time because every chip tap commits immediately.
  function toggleEditor(plan, weekKey, d) {
    const prev = openEditor;
    const same = prev && prev.weekKey === weekKey && prev.day === d;
    openEditor = same ? null : { weekKey, day: d };
    if (prev && prev.weekKey !== weekKey) patchRow(plan, prev.weekKey);
    patchRow(plan, weekKey);
    if (same) focusIn(weekKey, `.day-cell[data-day="${d}"]`);
    else focusIn(weekKey, ".day-editor");
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
    // lastCurrentKey is set on the first Wochen render — the Übersicht
    // card can call this earlier, so fall back to the computed key.
    const currentKey = lastCurrentKey || M().currentWeekKey(Date.now());
    const strip = el("div", "week-strip");
    strip.setAttribute("role", "group");
    strip.setAttribute("aria-label", `Putztage ${H().formatWeekLabel(weekKey, currentKey)}`);
    for (let d = 1; d <= 7; d++) {
      const { state, done, total } = M().dayCellState(plan, week, weekKey, d, byDay);
      const cell = el("button", `day-cell state-${state}`);
      cell.type = "button";
      cell.dataset.day = String(d);
      if (opts && opts.onTap) {
        // Editable cell = a disclosure for the day editor, not a toggle.
        cell.setAttribute("aria-expanded", opts.openDay === d ? "true" : "false");
        if (opts.openDay === d) cell.setAttribute("aria-controls", `day-editor-${weekKey}-${d}`);
      } else {
        cell.setAttribute("aria-pressed", state === "none" || state === "extra" ? "false" : "true");
      }
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

  // Inline day editor: area chips + one person-chip row per named slot.
  // Every tap commits immediately — closing (cell tap / Escape) can never
  // discard anything, which is why there is no "Fertig" button.
  function renderEditor(plan, weekKey, d) {
    const week = M().weekById(plan, weekKey);
    const slots = M().daySlots(week, d) || [];
    const editor = el("div", "day-editor");
    editor.id = `day-editor-${weekKey}-${d}`;
    editor.tabIndex = -1; // programmatic focus target on open
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
    const isDay = slots.length > 0;
    const meP = S().resolveMe(plan, "");

    // Empty slot list deletes the day key: the chips ARE the truth — no
    // chip selected means "not a cleaning day".
    function commit(newSlots, focusKey) {
      const days = freshDays(M().weekById(plan, weekKey));
      if (newSlots.length) days[String(d)] = newSlots.map((s) => [s.areaId, s.personId]);
      else delete days[String(d)];
      if (saveDays(plan, weekKey, days)) {
        patchRow(plan, weekKey);
        if (focusKey) focusIn(weekKey, `[data-focus="${focusKey}"]`);
      }
    }

    // One row per named slot: area label + tappable person chips.
    function personChips(slot, allSlots, labelText) {
      const row = el("div", "slot-row");
      row.appendChild(el("span", "slot-row-label", labelText));
      const people = el("div", "slot-people");
      people.setAttribute("role", "radiogroup");
      people.setAttribute("aria-label", `Wer putzt: ${labelText}`);
      const mk = (id, name) => {
        const on = slot.personId === id;
        const chip = el("button", `chip${on ? " selected" : ""}`, name);
        chip.type = "button";
        chip.setAttribute("role", "radio");
        chip.setAttribute("aria-checked", on ? "true" : "false");
        chip.dataset.focus = `person:${slot.areaId}:${id}`;
        chip.addEventListener("click", () => {
          slot.personId = id;
          commit(allSlots, chip.dataset.focus);
        });
        return chip;
      };
      people.appendChild(mk("", "offen"));
      for (const p of M().livePeople(plan)) {
        people.appendChild(mk(p.id, meP && meP.id === p.id ? `${p.name} · ich` : p.name));
      }
      row.appendChild(people);
      return row;
    }

    const chips = el("div", "chips");
    // "Egal / alle": a generic cleaning day without named areas. Toggle —
    // deselecting it (or the last area chip) removes the day.
    const anySelected = isDay && !named.length;
    const anyChip = el("button", `chip${anySelected ? " selected" : ""}`, "Egal / alle");
    anyChip.type = "button";
    anyChip.setAttribute("aria-pressed", anySelected ? "true" : "false");
    anyChip.dataset.focus = "area:any";
    anyChip.addEventListener("click", () => {
      if (anySelected) commit([], "area:any");
      else commit([{ areaId: "", personId: named.length ? named[0].personId || "" : "" }], "area:any");
    });
    chips.appendChild(anyChip);

    for (const area of M().liveAreas(plan)) {
      const slot = named.find((s) => s.areaId === area.id);
      const chip = el("button", `chip${slot ? " selected" : ""}`, area.name);
      chip.type = "button";
      chip.setAttribute("aria-pressed", slot ? "true" : "false");
      chip.dataset.focus = `area:${area.id}`;
      chip.addEventListener("click", () => {
        if (slot) {
          commit(named.filter((s) => s !== slot), chip.dataset.focus);
        } else {
          // First named area absorbs the unnamed slot (and its person).
          const inherited = named.length === 0 && unnamed.length ? unnamed[0].personId : "";
          commit(named.concat([{ areaId: area.id, personId: inherited }]), chip.dataset.focus);
        }
      });
      chips.appendChild(chip);
    }
    editor.appendChild(chips);

    if (!isDay) {
      editor.appendChild(el("p", "muted", "Noch kein Putztag — Bereich wählen oder „Egal / alle“."));
      return editor;
    }

    if (named.length) {
      for (const slot of named) {
        const area = M().areaById(plan, slot.areaId);
        editor.appendChild(personChips(slot, slots, area ? area.name : "?"));
      }
    } else {
      editor.appendChild(personChips(unnamed[0], slots, "Wer putzt?"));
    }

    const actions = el("div", "day-editor-actions");
    const removeBtn = el("button", "btn btn-small btn-danger", "Tag entfernen");
    removeBtn.type = "button";
    removeBtn.addEventListener("click", () => {
      const days = freshDays(M().weekById(plan, weekKey));
      delete days[String(d)];
      openEditor = null;
      if (saveDays(plan, weekKey, days)) {
        patchRow(plan, weekKey);
        focusIn(weekKey, `.day-cell[data-day="${d}"]`);
      }
    });
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
        openDay: openEditor && openEditor.weekKey === weekKey ? openEditor.day : 0,
        // Any tap just toggles the editor — opening writes nothing, and
        // closing can't discard anything because every chip tap commits.
        onTap: readonly ? null : (d) => toggleEditor(plan, weekKey, d),
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
        const day = openEditor.day;
        openEditor = null;
        if (plan) {
          patchRow(plan, weekKey);
          focusIn(weekKey, `.day-cell[data-day="${day}"]`);
        }
      }
    });
  }

  // renderStrip is shared with the Übersicht card (read-only there).
  PZ.uiWeeks = { render, init, renderStrip };
})();
