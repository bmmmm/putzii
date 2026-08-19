// SPDX-License-Identifier: GPL-3.0-or-later
// Wire codec + merge. The capability link carries the whole plan in the URL
// FRAGMENT — it never reaches any server. Everything here is pure except for
// the base-URL helper.
(function () {
  const PZ = (window.PZ = window.PZ || Object.create(null));
  const H = () => PZ.helpers;

  // WIRE CONTRACT: the envelope is a positional array and its slots are
  // APPEND-ONLY — never reorder or retype an existing index; new data goes at
  // the end (weeks landed as index 9 without a version bump: old decoders
  // ignore trailing elements and still merge everything they know, new
  // decoders treat a missing element as empty). Bump WIRE_VERSION only for a
  // structurally incompatible change.
  const WIRE_VERSION = 1;
  const FLAG_VIEWER = 1;
  // Signal caps messages at ~2000 chars — 1800 leaves headroom for share-sheet
  // decoration. Above 4000 we refuse the URL and force file export.
  const URL_BUDGET_GREEN = 1800;
  const URL_BUDGET_AMBER = 4000;
  const SHARE_EVENT_CAP = 200;
  // Week window on the wire: current−1 (a Monday-morning sync must not lose
  // the week that just ended) through current+SHARE_WEEK_HORIZON = 26 records,
  // measured at +347…+404 chars — no adaptive shrinking needed normally.
  const SHARE_WEEK_HORIZON = 24;
  const WIRE_MAX_WEEKS = 400;
  const WIRE_MAX_DAY_SLOTS = 20;
  const MIN_EVENT_TS = Date.UTC(2020, 0, 1);
  const MAX_FUTURE_MS = 30 * 86400000;

  // Base URL of the app without filename/hash/search: share links open the
  // directory (served as index.html) to keep them as short as possible.
  function baseDirUrl() {
    const u = new URL(location.href);
    u.hash = "";
    u.search = "";
    u.pathname = u.pathname.replace(/(index|c)\.html$/, "");
    return u.href;
  }

  function checkinUrl(planId, areaId) {
    return `${baseDirUrl()}c.html#c1.${planId}.${areaId}`;
  }

  // Select the events worth sharing: the newest `cap` overall, plus the latest
  // event of every live area (its due-date anchor must never fall off the wire).
  function selectShareEvents(plan, cap) {
    const sorted = plan.events.slice().sort((a, b) => H().compareEventsByTime(b, a));
    const picked = sorted.slice(0, cap);
    const pickedIds = new Set(picked.map((e) => e.id));
    const anchored = new Set();
    const liveAreaIds = new Set(plan.areas.filter((a) => !a.deletedAt).map((a) => a.id));
    for (const e of sorted) {
      if (liveAreaIds.has(e.areaId) && !anchored.has(e.areaId)) {
        anchored.add(e.areaId);
        if (!pickedIds.has(e.id)) {
          picked.push(e);
          pickedIds.add(e.id);
        }
      }
    }
    return picked;
  }

  // Week records inside the current share window (string compare — pad2 keys
  // sort chronologically). Pure: the caller supplies nowMs.
  function selectShareWeeks(plan, nowMs, horizon) {
    const cur = H().isoWeekKey(new Date(nowMs));
    const lo = H().addWeeks(cur, -1) || cur;
    const h = Number.isFinite(horizon) ? horizon : SHARE_WEEK_HORIZON;
    const hi = H().addWeeks(cur, h) || cur;
    return (plan.weeks || []).filter((w) => w.id >= lo && w.id <= hi);
  }

  // Positional-array envelope. Config (areas/people) always ships completely —
  // including soft-deleted records, so deletions propagate. Only events are
  // capped and weeks windowed. Ids stay ids (not indices): self-describing
  // beats ~8 gzipped bytes. `weeks` defaults to ALL weeks (what a round-trip
  // wants); buildShareUrl passes the time window.
  function wireFromPlan(plan, cap, viewer, weeks) {
    const events = selectShareEvents(plan, cap);
    const tBaseMin = events.length ? Math.min(...events.map((e) => Math.floor(e.ts / 60000))) : 0;
    return [
      WIRE_VERSION,
      plan.planId,
      plan.name,
      plan.updatedAt,
      tBaseMin,
      plan.areas.map((a) => [a.id, a.name, a.intervalDays, a.createdAt, a.updatedAt, a.deletedAt || 0]),
      plan.people.map((p) => [p.id, p.name, p.createdAt, p.updatedAt, p.deletedAt || 0]),
      events.map((e) => [e.id, e.areaId, e.personId, Math.floor(e.ts / 60000) - tBaseMin]),
      viewer ? FLAG_VIEWER : 0,
      (weeks || plan.weeks || []).map((w) => [w.id, w.days, w.createdAt, w.updatedAt]),
    ];
  }

  // Sanitize a wire `days` object. Only keys "1".."7" are ever read or
  // written, so "__proto__" can never land as a key; slots become clean
  // [areaId, personId] string pairs.
  function decodeDays(raw) {
    const out = Object.create(null);
    if (!raw || typeof raw !== "object") return out;
    for (let d = 1; d <= 7; d++) {
      const v = raw[String(d)];
      if (!Array.isArray(v)) continue;
      out[String(d)] = v
        .filter((s) => Array.isArray(s))
        .slice(0, WIRE_MAX_DAY_SLOTS)
        .map((s) => [
          typeof s[0] === "string" ? s[0].slice(0, 32) : "",
          typeof s[1] === "string" ? s[1].slice(0, 32) : "",
        ]);
    }
    return out;
  }

  function decodeWeeks(rows) {
    if (!Array.isArray(rows)) return [];
    return rows
      .filter((r) => Array.isArray(r) && typeof r[0] === "string" && H().weekStartDate(r[0]))
      .slice(0, WIRE_MAX_WEEKS)
      .map((r) => ({
        id: r[0],
        days: decodeDays(r[1]),
        createdAt: num(r[2], 0),
        updatedAt: num(r[3], 0),
      }));
  }

  function num(x, fallback) {
    return Number.isFinite(x) ? x : fallback;
  }

  // Structural decode. Throws {code:"version"} on an unknown wire version so
  // the UI can say "Link stammt aus einer neueren Version" instead of "kaputt".
  function planFromWire(arr) {
    if (!Array.isArray(arr) || arr.length < 8) throw new Error("bad wire shape");
    if (arr[0] !== WIRE_VERSION) {
      const err = new Error("unknown wire version");
      err.code = "version";
      throw err;
    }
    const [, planId, name, updatedAt, tBaseMin, areas, people, events] = arr;
    if (typeof planId !== "string" || !planId) throw new Error("bad planId");
    if (!Array.isArray(areas) || !Array.isArray(people) || !Array.isArray(events)) {
      throw new Error("bad wire lists");
    }
    const plan = {
      v: 1,
      planId,
      name: H().normalizeName(name) || "Putzplan",
      updatedAt: num(updatedAt, 0),
      areas: areas
        .filter((r) => Array.isArray(r) && typeof r[0] === "string" && r[0])
        .map((r) => ({
          id: r[0],
          name: H().normalizeName(r[1]) || "Bereich",
          intervalDays: Math.min(365, Math.max(1, num(r[2], 7))),
          createdAt: num(r[3], 0),
          updatedAt: num(r[4], 0),
          deletedAt: num(r[5], 0),
        })),
      people: people
        .filter((r) => Array.isArray(r) && typeof r[0] === "string" && r[0])
        .map((r) => ({
          id: r[0],
          name: H().normalizeName(r[1]) || "Unbekannt",
          createdAt: num(r[2], 0),
          updatedAt: num(r[3], 0),
          deletedAt: num(r[4], 0),
        })),
      events: events
        .filter((r) => Array.isArray(r) && typeof r[0] === "string")
        .map((r) => ({
          id: r[0],
          areaId: typeof r[1] === "string" ? r[1] : "",
          personId: typeof r[2] === "string" ? r[2] : "",
          ts: (num(tBaseMin, 0) + num(r[3], 0)) * 60000,
        })),
      weeks: decodeWeeks(arr[9]), // absent on pre-v1.1 payloads → []
      seq: {},
    };
    const flags = num(arr[8], 0);
    return { plan, viewer: !!(flags & FLAG_VIEWER) };
  }

  function validEvent(e, nowMs) {
    return (
      !!H().parseCompactEventId(e.id) &&
      typeof e.areaId === "string" &&
      e.areaId.length > 0 &&
      Number.isFinite(e.ts) &&
      e.ts >= MIN_EVENT_TS &&
      e.ts <= nowMs + MAX_FUTURE_MS
    );
  }

  // LWW for one config record: strictly-greater updatedAt wins, ties keep
  // LOCAL — an equal-second remote must not clobber a just-edited local record.
  // createdAt takes the minimum so a resurrection can't reset due-date anchors.
  function mergeRecord(local, remote) {
    const winner = remote.updatedAt > local.updatedAt ? remote : local;
    const merged = Object.assign({}, winner);
    merged.createdAt = Math.min(local.createdAt || Infinity, remote.createdAt || Infinity);
    if (!Number.isFinite(merged.createdAt)) merged.createdAt = 0;
    return { merged, changed: winner === remote };
  }

  function mergeRecordList(localList, remoteList) {
    const byId = new Map(localList.map((r) => [r.id, r]));
    const out = localList.slice();
    let added = 0;
    let changed = 0;
    for (const r of remoteList) {
      const mine = byId.get(r.id);
      if (!mine) {
        byId.set(r.id, r);
        out.push(r);
        added++;
        continue;
      }
      const { merged, changed: c } = mergeRecord(mine, r);
      if (c) {
        out[out.indexOf(mine)] = merged;
        changed++;
      } else if (merged.createdAt !== mine.createdAt) {
        out[out.indexOf(mine)] = merged;
      }
      byId.set(r.id, merged);
    }
    return { list: out, added, changed };
  }

  // Pure merge: never mutates its inputs, returns a fresh plan + a summary.
  // Events are union-by-id with FIRST-SEEN-WINS — a hostile or corrupt link can
  // only add history, never rewrite it.
  function mergePlans(local, remote, nowMs) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    if (local && local.planId !== remote.planId) {
      const err = new Error("planId mismatch");
      err.code = "planIdMismatch";
      throw err;
    }
    const base = local || {
      v: 1,
      planId: remote.planId,
      name: "",
      updatedAt: 0,
      areas: [],
      people: [],
      events: [],
      weeks: [],
      seq: {},
    };
    const areas = mergeRecordList(base.areas, remote.areas);
    const people = mergeRecordList(base.people, remote.people);
    const weeks = mergeRecordList(base.weeks || [], remote.weeks || []);
    const known = new Set(base.events.map((e) => e.id));
    const events = base.events.slice();
    let newEvents = 0;
    for (const e of remote.events) {
      if (known.has(e.id)) continue; // first-seen-wins: never overwrite payloads
      if (!validEvent(e, now)) continue;
      known.add(e.id);
      events.push(e);
      newEvents++;
    }
    events.sort((a, b) => H().compareEventsByTime(a, b));
    const seq = Object.assign({}, base.seq);
    const plan = {
      v: 1,
      planId: base.planId,
      name: remote.updatedAt > base.updatedAt && remote.name ? remote.name : base.name || remote.name,
      updatedAt: Math.max(base.updatedAt, remote.updatedAt),
      areas: areas.list,
      people: people.list,
      events,
      weeks: weeks.list,
      seq,
    };
    return {
      plan,
      summary: {
        newEvents,
        newAreas: areas.added,
        changedAreas: areas.changed,
        newPeople: people.added,
        changedPeople: people.changed,
        newWeeks: weeks.added,
        changedWeeks: weeks.changed,
      },
    };
  }

  async function encodeWire(wire) {
    const json = JSON.stringify(wire);
    if (typeof CompressionStream === "undefined") {
      return "p1u." + H().base64UrlEncodeBytes(H().utf8Encode(json));
    }
    const gz = await H().gzipCompress(H().utf8Encode(json));
    return "p1." + H().base64UrlEncodeBytes(gz);
  }

  // Build the full share URL with the adaptive event cap: shrink by 0.7 until
  // the URL fits the green budget or only the per-area anchors remain; if
  // STILL over budget, shrink the week window. Returns the honest counts so
  // the UI can always say "Teilt X von Y Einträgen · N von M Wochen".
  async function buildShareUrl(plan, opts) {
    const viewer = !!(opts && opts.viewer);
    const base = baseDirUrl();
    const now = Date.now();
    let weeks = selectShareWeeks(plan, now);
    let cap = SHARE_EVENT_CAP;
    const overBudget = (f) => base.length + 1 + f.length > URL_BUDGET_GREEN;
    let frag = await encodeWire(wireFromPlan(plan, cap, viewer, weeks));
    let shared = selectShareEvents(plan, cap).length;
    for (let i = 0; i < 8 && overBudget(frag) && cap > 0; i++) {
      cap = Math.floor(cap * 0.7);
      frag = await encodeWire(wireFromPlan(plan, cap, viewer, weeks));
      shared = selectShareEvents(plan, cap).length;
      if (cap === 0) break;
    }
    for (const h of [12, 6, 2, 0]) {
      if (!overBudget(frag)) break;
      weeks = selectShareWeeks(plan, now, h);
      frag = await encodeWire(wireFromPlan(plan, cap, viewer, weeks));
    }
    const url = `${base}#${frag}`;
    const band = url.length <= URL_BUDGET_GREEN ? "green" : url.length <= URL_BUDGET_AMBER ? "amber" : "red";
    return {
      url,
      band,
      sharedEvents: shared,
      totalEvents: plan.events.length,
      sharedWeeks: weeks.length,
      totalWeeks: (plan.weeks || []).length,
    };
  }

  // Decode a "#p1./#p1u." fragment payload (without the leading "#").
  async function decodeShareFragment(frag) {
    let json;
    if (frag.startsWith("p1.")) {
      const gz = H().base64UrlDecodeBytes(frag.slice(3));
      json = H().utf8Decode(await H().gzipDecompress(gz));
    } else if (frag.startsWith("p1u.")) {
      json = H().utf8Decode(H().base64UrlDecodeBytes(frag.slice(4)));
    } else {
      throw new Error("not a share fragment");
    }
    const wire = JSON.parse(json);
    return planFromWire(wire);
  }

  const FILE_FORMAT = "putzii-plan";

  function serializeFile(plan) {
    return JSON.stringify({ format: FILE_FORMAT, v: 1, plan }, null, 1);
  }

  function parseFile(text) {
    const obj = H().safeParse(text);
    if (!obj || obj.format !== FILE_FORMAT || !obj.plan || typeof obj.plan !== "object") return null;
    const p = obj.plan;
    if (typeof p.planId !== "string" || !p.planId) return null;
    // Re-run the structural cleanup by round-tripping through the wire codec
    // shapes: build a plan object with the same validation rules.
    return {
      v: 1,
      planId: p.planId,
      name: H().normalizeName(p.name) || "Putzplan",
      updatedAt: num(p.updatedAt, 0),
      areas: Array.isArray(p.areas)
        ? p.areas
            .filter((a) => a && typeof a.id === "string" && a.id)
            .map((a) => ({
              id: a.id,
              name: H().normalizeName(a.name) || "Bereich",
              intervalDays: Math.min(365, Math.max(1, num(a.intervalDays, 7))),
              createdAt: num(a.createdAt, 0),
              updatedAt: num(a.updatedAt, 0),
              deletedAt: num(a.deletedAt, 0),
            }))
        : [],
      people: Array.isArray(p.people)
        ? p.people
            .filter((x) => x && typeof x.id === "string" && x.id)
            .map((x) => ({
              id: x.id,
              name: H().normalizeName(x.name) || "Unbekannt",
              createdAt: num(x.createdAt, 0),
              updatedAt: num(x.updatedAt, 0),
              deletedAt: num(x.deletedAt, 0),
            }))
        : [],
      events: Array.isArray(p.events)
        ? p.events.filter((e) => e && typeof e.id === "string" && typeof e.areaId === "string")
        : [],
      // parseFile is a field WHITELIST — forgetting a new field here silently
      // drops it on every file import. Weeks reuse the wire sanitizer.
      weeks: decodeWeeks(
        Array.isArray(p.weeks)
          ? p.weeks.map((w) => (w && typeof w === "object" ? [w.id, w.days, w.createdAt, w.updatedAt] : null))
          : [],
      ),
      seq: {},
    };
  }

  PZ.share = {
    WIRE_VERSION,
    URL_BUDGET_GREEN,
    URL_BUDGET_AMBER,
    SHARE_EVENT_CAP,
    SHARE_WEEK_HORIZON,
    baseDirUrl,
    checkinUrl,
    selectShareEvents,
    selectShareWeeks,
    wireFromPlan,
    planFromWire,
    mergePlans,
    buildShareUrl,
    decodeShareFragment,
    serializeFile,
    parseFile,
  };
})();
