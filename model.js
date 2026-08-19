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
  };
})();
