// SPDX-License-Identifier: GPL-3.0-or-later
// Pure schedule logic — no DOM, no storage. Everything takes `nowMs` so the
// self-check can pin time.
(function () {
  const PZ = (window.PZ = window.PZ || Object.create(null));
  const H = () => PZ.helpers;

  const DAY_MS = 86400000;
  // Clamp for forward clock skew: an event stamped further than this into the
  // future is treated as "now + 12 h" at READ time — the log is never rewritten.
  const FUTURE_CLAMP_MS = 12 * 3600 * 1000;
  const HISTORY_COLLAPSE_MS = 30 * 60 * 1000;
  const IDEMPOTENT_MS = 10 * 60 * 1000;
  const COOLDOWN_MS = 6 * 3600 * 1000;

  function effTs(tsMs, nowMs) {
    return Math.min(tsMs, nowMs + FUTURE_CLAMP_MS);
  }

  function liveAreas(plan) {
    return plan.areas.filter((a) => !a.deletedAt);
  }

  function livePeople(plan) {
    return plan.people.filter((p) => !p.deletedAt);
  }

  function areaById(plan, areaId) {
    return plan.areas.find((a) => a.id === areaId) || null;
  }

  function personById(plan, personId) {
    return plan.people.find((p) => p.id === personId) || null;
  }

  function personName(plan, personId) {
    const p = personById(plan, personId);
    return p ? p.name : "Unbekannt";
  }

  // Map areaId -> latest event (by effective ts, tie-broken by event id).
  function lastCheckinByArea(plan, nowMs) {
    const map = new Map();
    for (const e of plan.events) {
      const prev = map.get(e.areaId);
      if (
        !prev ||
        effTs(e.ts, nowMs) > effTs(prev.ts, nowMs) ||
        (effTs(e.ts, nowMs) === effTs(prev.ts, nowMs) && H().cmpEventId(e.id, prev.id) > 0)
      ) {
        map.set(e.areaId, e);
      }
    }
    return map;
  }

  // "Soon" window before the due date: a quarter of the interval, clamped to
  // [0.5 d, 3 d] — a daily chore turns amber half a day early, a quarterly one
  // at most three days early.
  function soonWindowMs(intervalDays) {
    return Math.min(3 * DAY_MS, Math.max(0.5 * DAY_MS, 0.25 * intervalDays * DAY_MS));
  }

  // Status of one area. A never-cleaned area anchors on its createdAt so a
  // freshly added area is NOT instantly overdue.
  function areaStatus(area, lastEvent, nowMs) {
    const anchor = lastEvent ? effTs(lastEvent.ts, nowMs) : area.createdAt * 1000;
    const dueAt = anchor + area.intervalDays * DAY_MS;
    let status = "ok";
    if (nowMs >= dueAt) status = "overdue";
    else if (nowMs >= dueAt - soonWindowMs(area.intervalDays)) status = "soon";
    return { anchor, dueAt, status };
  }

  // Dashboard rows: live areas with status, sorted most-urgent first.
  function dashboardRows(plan, nowMs) {
    const last = lastCheckinByArea(plan, nowMs);
    const rank = { overdue: 0, soon: 1, ok: 2 };
    return liveAreas(plan)
      .map((area) => {
        const lastEvent = last.get(area.id) || null;
        return Object.assign({ area, lastEvent }, areaStatus(area, lastEvent, nowMs));
      })
      .sort((a, b) => rank[a.status] - rank[b.status] || a.dueAt - b.dueAt);
  }

  // History rows, newest first, optionally filtered by area. Same-area+person
  // events within a 30 min window collapse into one row with a count — two
  // devices recording the same real-world cleaning stay one line.
  function historyRows(plan, filterAreaId, nowMs) {
    const sorted = plan.events
      .filter((e) => !filterAreaId || e.areaId === filterAreaId)
      .slice()
      .sort((a, b) => H().compareEventsByTime(b, a));
    const rows = [];
    for (const e of sorted) {
      const prev = rows[rows.length - 1];
      if (
        prev &&
        prev.event.areaId === e.areaId &&
        prev.event.personId === e.personId &&
        effTs(prev.event.ts, nowMs) - effTs(e.ts, nowMs) <= HISTORY_COLLAPSE_MS
      ) {
        prev.count++;
        continue;
      }
      rows.push({ event: e, count: 1 });
    }
    return rows;
  }

  // Idempotency guard: same area + same person within the window?
  function existsRecent(plan, areaId, personId, nowMs) {
    return plan.events.some(
      (e) =>
        e.areaId === areaId &&
        e.personId === personId &&
        nowMs - e.ts >= -FUTURE_CLAMP_MS &&
        nowMs - effTs(e.ts, nowMs) <= IDEMPOTENT_MS,
    );
  }

  // Cooldown guard: latest check-in by ANYONE within the window, else null.
  function recentByAnyone(plan, areaId, nowMs) {
    const last = lastCheckinByArea(plan, nowMs).get(areaId);
    if (!last) return null;
    return nowMs - effTs(last.ts, nowMs) <= COOLDOWN_MS ? last : null;
  }

  function unsharedCount(plan, lastSharedAtMs) {
    return plan.events.filter((e) => e.ts > lastSharedAtMs).length;
  }

  // True when any raw event timestamp is implausibly far in the future — shown
  // as a warning chip in Verwalten (some device's clock is off).
  function hasFutureClock(plan, nowMs) {
    return plan.events.some((e) => e.ts > nowMs + FUTURE_CLAMP_MS);
  }

  // --- calendar-week duty plan ---

  function currentWeekKey(nowMs) {
    return H().isoWeekKey(new Date(Number.isFinite(nowMs) ? nowMs : Date.now()));
  }

  function weekById(plan, weekKey) {
    return (plan.weeks || []).find((w) => w.id === weekKey) || null;
  }

  // Bucket ALL events once per render: Map<dayNumber, event[]>. Both event and
  // cell reduce to the same integer local-day index, so day boundaries are
  // DST-proof by construction.
  function eventsByDay(plan, nowMs) {
    const map = new Map();
    for (const e of plan.events) {
      const dn = H().dayNumber(new Date(effTs(e.ts, nowMs)));
      const list = map.get(dn);
      if (list) list.push(e);
      else map.set(dn, [e]);
    }
    return map;
  }

  // Date of ISO weekday d (1-7) in the given week.
  function weekDayDate(weekKey, d) {
    const mon = H().weekStartDate(weekKey);
    if (!mon) return null;
    return new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + (d - 1));
  }

  // Normalized slot list of one weekday, or null when it is not a cleaning
  // day (absent key). `[["",""]]` → one unassigned slot.
  function daySlots(week, d) {
    const v = week && week.days ? week.days[String(d)] : null;
    if (!Array.isArray(v)) return null;
    return v.map((s) => ({ areaId: (s && s[0]) || "", personId: (s && s[1]) || "" }));
  }

  // Cell state matrix: none · extra (check-in without a plan, faint) · planned
  // · partial · done. Days with NAMED areas count done only when ALL named
  // areas have a check-in that day (naming is a scope statement — honesty over
  // optimism); named areas are intersected with live ones so a deleted area
  // cannot pin the day to "never done" (none left → any-check-in fallback).
  function dayCellState(plan, week, weekKey, d, byDay) {
    const mon = H().weekStartDate(weekKey);
    if (!mon) return { state: "none", done: 0, total: 0 };
    const dn = H().dayNumber(mon) + (d - 1);
    const evs = byDay.get(dn) || [];
    const slots = daySlots(week, d);
    if (!slots) return { state: evs.length ? "extra" : "none", done: 0, total: 0 };
    const liveIds = new Set(liveAreas(plan).map((a) => a.id));
    const named = [...new Set(slots.map((s) => s.areaId).filter((id) => id && liveIds.has(id)))];
    if (!named.length) {
      return { state: evs.length ? "done" : "planned", done: evs.length ? 1 : 0, total: 1 };
    }
    const done = named.filter((id) => evs.some((e) => e.areaId === id)).length;
    const state = done === named.length ? "done" : done > 0 ? "partial" : "planned";
    return { state, done, total: named.length };
  }

  // All tasks (slots) of a week, flattened for the person-grouped Übersicht
  // list. A task with a named area is done once that area has a check-in
  // anywhere in the week (someone covering for someone else still counts —
  // the history shows who); an unnamed task is done on any check-in that day.
  function weekTasks(plan, weekKey, nowMs, byDayOpt) {
    const week = weekById(plan, weekKey);
    if (!week) return [];
    const byDay = byDayOpt || eventsByDay(plan, nowMs);
    const mon = H().weekStartDate(weekKey);
    if (!mon) return [];
    const dn0 = H().dayNumber(mon);
    const weekEvents = [];
    for (let i = 0; i < 7; i++) weekEvents.push(...(byDay.get(dn0 + i) || []));
    const out = [];
    for (let d = 1; d <= 7; d++) {
      const slots = daySlots(week, d);
      if (!slots) continue;
      for (const s of slots) {
        const done = s.areaId
          ? weekEvents.some((e) => e.areaId === s.areaId)
          : (byDay.get(dn0 + (d - 1)) || []).length > 0;
        out.push({ day: d, areaId: s.areaId, personId: s.personId, done });
      }
    }
    return out;
  }

  // Fresh copy of the previous week's day/slot pattern, or null when there is
  // nothing to copy. Fresh objects — merged records are shallow copies.
  function copyPrevWeekDays(plan, weekKey) {
    const prev = weekById(plan, H().addWeeks(weekKey, -1));
    if (!prev || !prev.days || !Object.keys(prev.days).length) return null;
    const days = Object.create(null);
    for (let d = 1; d <= 7; d++) {
      const v = prev.days[String(d)];
      if (Array.isArray(v)) days[String(d)] = v.map((s) => [(s && s[0]) || "", (s && s[1]) || ""]);
    }
    return days;
  }

  // Config timestamps are SECONDS, lastSharedAt is ms — mind the boundary.
  function unsharedWeekCount(plan, lastSharedAtMs) {
    return (plan.weeks || []).filter((w) => w.updatedAt * 1000 > lastSharedAtMs).length;
  }

  PZ.model = {
    DAY_MS,
    FUTURE_CLAMP_MS,
    HISTORY_COLLAPSE_MS,
    IDEMPOTENT_MS,
    COOLDOWN_MS,
    effTs,
    liveAreas,
    livePeople,
    areaById,
    personById,
    personName,
    lastCheckinByArea,
    soonWindowMs,
    areaStatus,
    dashboardRows,
    historyRows,
    existsRecent,
    recentByAnyone,
    unsharedCount,
    hasFutureClock,
    currentWeekKey,
    weekById,
    eventsByDay,
    weekDayDate,
    daySlots,
    dayCellState,
    weekTasks,
    copyPrevWeekDays,
    unsharedWeekCount,
  };
})();
