// SPDX-License-Identifier: GPL-3.0-or-later
(function () {
  const PZ = (window.PZ = window.PZ || Object.create(null));
  const H = () => PZ.helpers;

  const K = {
    schema: "putzii:v",
    device: "putzii:device",
    plans: "putzii:plans",
    plan: (id) => `putzii:plan:${id}`,
    me: (id) => `putzii:me:${id}`,
    shared: (id) => `putzii:shared:${id}`,
    uimode: (id) => `putzii:uimode:${id}`,
    pending: "putzii:pending",
    backup: (id) => `putzii:backup:${id}`,
  };

  const LOCAL_EVENT_CAP = 2000;
  const PENDING_TTL_MS = 24 * 3600 * 1000;
  const BACKUP_TTL_MS = 10 * 60 * 1000;

  // Memory fallback so a dead localStorage (private mode edge cases) still
  // yields a stable key for this page load instead of a new one per call.
  let memDeviceKey = "";

  function getDeviceKey() {
    const stored = H().safeLocalStorageGetItem(K.device);
    if (stored && /^[a-z2-9]{5}$/.test(stored)) return stored;
    if (memDeviceKey) return memDeviceKey;
    const key = H().randomId(5);
    if (!H().safeLocalStorageSetItem(K.device, key)) memDeviceKey = key;
    return key;
  }

  function ensureSchema() {
    if (!H().safeLocalStorageGetItem(K.schema)) {
      H().safeLocalStorageSetItem(K.schema, "1");
    }
  }

  function loadPlanIndex() {
    const obj = H().safeParse(H().safeLocalStorageGetItem(K.plans));
    const idx = Object.create(null);
    idx.active = obj && typeof obj.active === "string" ? obj.active : "";
    idx.ids = obj && Array.isArray(obj.ids) ? obj.ids.filter((x) => typeof x === "string") : [];
    return idx;
  }

  function savePlanIndex(idx) {
    return H().safeLocalStorageSetItem(K.plans, JSON.stringify({ active: idx.active, ids: idx.ids }));
  }

  function registerPlan(planId, makeActive) {
    const idx = loadPlanIndex();
    if (!idx.ids.includes(planId)) idx.ids.push(planId);
    if (makeActive || !idx.active) idx.active = planId;
    savePlanIndex(idx);
  }

  function setActivePlan(planId) {
    const idx = loadPlanIndex();
    if (idx.ids.includes(planId)) {
      idx.active = planId;
      savePlanIndex(idx);
    }
  }

  function validPlanShape(p) {
    return (
      p &&
      typeof p === "object" &&
      typeof p.planId === "string" &&
      p.planId.length > 0 &&
      Array.isArray(p.areas) &&
      Array.isArray(p.people) &&
      Array.isArray(p.events)
    );
  }

  // Every plan read goes through this: plans persisted by older builds lack
  // newer keys (e.g. `weeks` before v1.1) and would crash the first render.
  function normalizePlan(p) {
    if (!validPlanShape(p)) return null;
    if (!p.seq || typeof p.seq !== "object") p.seq = {};
    if (!Array.isArray(p.weeks)) p.weeks = [];
    return p;
  }

  function loadPlan(planId) {
    if (!planId) return null;
    return normalizePlan(H().safeParse(H().safeLocalStorageGetItem(K.plan(planId))));
  }

  function loadActivePlan() {
    return loadPlan(loadPlanIndex().active);
  }

  function savePlan(plan) {
    return H().safeLocalStorageSetItem(K.plan(plan.planId), JSON.stringify(plan));
  }

  function nowSec() {
    return Math.floor(Date.now() / 1000);
  }

  function createPlan(name) {
    const plan = {
      v: 1,
      planId: H().randomPlanId(),
      name: H().normalizeName(name) || "Putzplan",
      updatedAt: nowSec(),
      areas: [],
      people: [],
      events: [],
      weeks: [],
      seq: {},
    };
    if (!savePlan(plan)) return null;
    registerPlan(plan.planId, true);
    return plan;
  }

  function maxSeqForDevice(plan, deviceKey) {
    let max = Number(plan.seq && plan.seq[deviceKey]) || 0;
    for (const e of plan.events) {
      const parsed = H().parseCompactEventId(e && e.id);
      if (parsed && parsed.deviceKey === deviceKey && parsed.seq > max) max = parsed.seq;
    }
    return max;
  }

  // Mint a check-in event. ts is quantized to the whole minute at creation so
  // the wire codec's minute-delta round-trip is lossless and every device holds
  // byte-identical events.
  function newEvent(plan, areaId, personId, nowMs) {
    const deviceKey = getDeviceKey();
    const seq = maxSeqForDevice(plan, deviceKey) + 1;
    return {
      id: H().formatCompactEventId(deviceKey, seq),
      areaId,
      personId,
      ts: Math.floor((Number.isFinite(nowMs) ? nowMs : Date.now()) / 60000) * 60000,
    };
  }

  // Sort newest-first and keep LOCAL_EVENT_CAP, but never drop the newest
  // event of a live (non-deleted) area — it anchors that area's due date.
  function trimEvents(plan) {
    if (plan.events.length <= LOCAL_EVENT_CAP) return;
    const sorted = plan.events.slice().sort((a, b) => H().compareEventsByTime(b, a));
    const liveAreas = new Set(plan.areas.filter((a) => !a.deletedAt).map((a) => a.id));
    const keep = new Set();
    for (const e of sorted) {
      if (liveAreas.has(e.areaId)) {
        keep.add(e.id);
        liveAreas.delete(e.areaId);
      }
    }
    const out = [];
    for (const e of sorted) {
      if (out.length >= LOCAL_EVENT_CAP && !keep.has(e.id)) continue;
      out.push(e);
    }
    plan.events = out;
  }

  // Atomic append with two-tab reconcile: re-read the persisted plan first and
  // union its events in (dedup by id, first-seen-wins), re-mint our new events
  // on id collision, then save. On save failure the in-memory plan is restored
  // byte-identically and false is returned.
  function appendEvents(plan, events) {
    const before = { events: plan.events, seq: plan.seq };
    plan.events = plan.events.slice();
    plan.seq = Object.assign({}, plan.seq);
    try {
      const persisted = loadPlan(plan.planId);
      const known = new Map(plan.events.map((e) => [e.id, e]));
      if (persisted) {
        for (const e of persisted.events) {
          if (!known.has(e.id)) {
            known.set(e.id, e);
            plan.events.push(e);
          }
        }
      }
      const deviceKey = getDeviceKey();
      for (const ev of events) {
        while (known.has(ev.id)) {
          // Another tab used this id — re-mint ours one past the max.
          ev.id = H().formatCompactEventId(deviceKey, maxSeqForDevice(plan, deviceKey) + 1);
        }
        known.set(ev.id, ev);
        plan.events.push(ev);
        const parsed = H().parseCompactEventId(ev.id);
        if (parsed) plan.seq[parsed.deviceKey] = parsed.seq;
      }
      trimEvents(plan);
      if (!savePlan(plan)) throw new Error("save failed");
      return true;
    } catch (e) {
      plan.events = before.events;
      plan.seq = before.seq;
      return false;
    }
  }

  // Undo: hard-delete a just-created event (V1 has no tombstones — documented).
  function removeEvent(plan, eventId) {
    const idx = plan.events.findIndex((e) => e.id === eventId);
    if (idx < 0) return false;
    const beforeEvents = plan.events;
    plan.events = plan.events.slice(0, idx).concat(plan.events.slice(idx + 1));
    if (!savePlan(plan)) {
      plan.events = beforeEvents;
      return false;
    }
    return true;
  }

  const WEEK_KEEP_PAST = 8;
  const LOCAL_WEEK_CAP = 400;

  // Drop week records far in the past (Verlauf covers history) and cap the
  // total; keys sort chronologically as strings (pad2 invariant).
  function pruneWeeks(plan) {
    const cutoff = H().addWeeks(H().isoWeekKey(new Date()), -WEEK_KEEP_PAST);
    if (cutoff) plan.weeks = plan.weeks.filter((w) => w.id >= cutoff);
    if (plan.weeks.length > LOCAL_WEEK_CAP) {
      plan.weeks = plan.weeks.slice().sort((a, b) => H().cmpStr(a.id, b.id)).slice(-LOCAL_WEEK_CAP);
    }
  }

  // Upsert one week's plan. `days` must be a FRESH object (mergeRecord copies
  // records shallowly — in-place mutation would alias merged state). An empty
  // days object with a newer updatedAt is the tombstone; there is no deletedAt.
  function saveWeek(plan, weekId, days) {
    if (!H().weekStartDate(weekId)) return false;
    const now = nowSec();
    const existing = plan.weeks.find((w) => w.id === weekId);
    if (existing) {
      existing.days = days;
      existing.updatedAt = now;
    } else {
      plan.weeks.push({ id: weekId, days, createdAt: now, updatedAt: now });
    }
    plan.updatedAt = now;
    pruneWeeks(plan);
    return savePlan(plan);
  }

  function getMe(planId) {
    return H().safeLocalStorageGetItem(K.me(planId)) || "";
  }

  function setMe(planId, personId) {
    H().safeLocalStorageSetItem(K.me(planId), personId);
  }

  function getUiMode(planId) {
    return H().safeLocalStorageGetItem(K.uimode(planId)) === "view" ? "view" : "";
  }

  function setUiMode(planId, mode) {
    if (mode === "view") H().safeLocalStorageSetItem(K.uimode(planId), "view");
    else H().safeLocalStorageRemoveItem(K.uimode(planId));
  }

  function getLastSharedAt(planId) {
    const obj = H().safeParse(H().safeLocalStorageGetItem(K.shared(planId)));
    return obj && Number.isFinite(obj.lastSharedAt) ? obj.lastSharedAt : 0;
  }

  function setLastSharedAt(planId, tsMs) {
    H().safeLocalStorageSetItem(K.shared(planId), JSON.stringify({ lastSharedAt: tsMs }));
  }

  function setPending(planId, areaId) {
    H().safeLocalStorageSetItem(K.pending, JSON.stringify({ planId, areaId, at: Date.now() }));
  }

  function getPending() {
    const obj = H().safeParse(H().safeLocalStorageGetItem(K.pending));
    if (!obj || typeof obj.planId !== "string" || typeof obj.areaId !== "string") return null;
    if (!Number.isFinite(obj.at) || Date.now() - obj.at > PENDING_TTL_MS) {
      clearPending();
      return null;
    }
    return obj;
  }

  function clearPending() {
    H().safeLocalStorageRemoveItem(K.pending);
  }

  // Single-slot pre-merge snapshot backing the merge "Rückgängig" toast.
  function saveBackup(plan) {
    H().safeLocalStorageSetItem(K.backup(plan.planId), JSON.stringify({ at: Date.now(), plan }));
  }

  function loadBackup(planId) {
    const obj = H().safeParse(H().safeLocalStorageGetItem(K.backup(planId)));
    if (!obj || !validPlanShape(obj.plan)) return null;
    if (!Number.isFinite(obj.at) || Date.now() - obj.at > BACKUP_TTL_MS) return null;
    return normalizePlan(obj.plan);
  }

  function clearBackup(planId) {
    H().safeLocalStorageRemoveItem(K.backup(planId));
  }

  PZ.store = {
    K,
    LOCAL_EVENT_CAP,
    getDeviceKey,
    ensureSchema,
    loadPlanIndex,
    savePlanIndex,
    registerPlan,
    setActivePlan,
    loadPlan,
    loadActivePlan,
    savePlan,
    createPlan,
    normalizePlan,
    pruneWeeks,
    saveWeek,
    maxSeqForDevice,
    newEvent,
    appendEvents,
    removeEvent,
    trimEvents,
    getMe,
    setMe,
    getUiMode,
    setUiMode,
    getLastSharedAt,
    setLastSharedAt,
    setPending,
    getPending,
    clearPending,
    saveBackup,
    loadBackup,
    clearBackup,
    nowSec,
  };
})();
