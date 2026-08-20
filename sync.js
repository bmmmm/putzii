// SPDX-License-Identifier: GPL-3.0-or-later
// GitHub-drop sync state machine. States: off · idle · pulling · pushing ·
// sent · queued · error{authfail|notfound|keymismatch|net}. Triggers: boot,
// visibility (≤1/30 s), mutation (1.5 s debounce via markDirty), online,
// c.html post-check-in. THE invariant: a pull that merges remote data NEVER
// sets dirty — two clients would ping-pong forever.
//
// Write confirmation: dispatch answers 204 immediately, the state file lands
// 30–90 s later → remember pendingNonce; the next pulls look for it in the
// health tail → dirty clears. 3 pulls / 5 min without it → ONE re-dispatch,
// then "queued".
(function () {
  const PZ = (window.PZ = window.PZ || Object.create(null));
  const H = () => PZ.helpers;
  const S = () => PZ.store;
  const D = () => PZ.drop;
  const C = () => PZ.dropcrypto;

  const DEBOUNCE_MS = 1500;
  const VISIBILITY_MIN_MS = 30000;
  const CONFIRM_MIN_PULLS = 3;
  const CONFIRM_WINDOW_MS = 5 * 60000;
  const STALE_HINT_AFTER = 3;
  const PUSH_BUDGET_CHARS = 64 * 1024;

  // test seams
  let _fetch = (url, opts) => fetch(url, opts);
  let _now = () => Date.now();

  let state = "off";
  let errorKind = "";
  let running = false;
  let debounceTimer = 0;
  let lastVisibilityTick = 0;
  const keyCache = { encKey: "", key: null };

  function loadSt(planId) {
    const obj = H().safeParse(H().safeLocalStorageGetItem(S().K.dropstate(planId)));
    return Object.assign(
      {
        dirty: false,
        dirtySince: 0,
        pendingNonce: "",
        pendingAt: 0,
        pullsSincePush: 0,
        redispatched: false,
        lastRev: 0,
        staleCount: 0,
        lastSyncAt: 0,
      },
      obj || {},
    );
  }

  function saveSt(planId, rec) {
    H().safeLocalStorageSetItem(S().K.dropstate(planId), JSON.stringify(rec));
  }

  function activePlanId() {
    return S().loadPlanIndex().active;
  }

  async function getKey(creds) {
    if (keyCache.encKey !== creds.encKey || !keyCache.key) {
      keyCache.key = await C().importStateKey(H().base64UrlDecodeBytes(creds.encKey));
      keyCache.encKey = creds.encKey;
    }
    return keyCache.key;
  }

  function fail(kind) {
    const e = new Error(kind);
    e.kind = kind;
    return e;
  }

  // Pull + decrypt + merge. NEVER sets dirty (see header). Returns the
  // plaintext rev, or 0 when the state file does not exist yet.
  async function pull(creds, rec) {
    let res;
    try {
      res = await _fetch(D().stateUrl(creds), { cache: "no-store" });
    } catch (e) {
      throw fail("net");
    }
    if (res.status === 404) throw fail("notfound");
    if (!res.ok) throw fail("net");
    const file = C().parseStateFile(await res.text());
    if (!file) throw fail("net"); // torn deploy — a retry heals it
    let plain;
    try {
      plain = await C().decryptState(await getKey(creds), creds.planId, file.iv, file.ct);
    } catch (e) {
      throw fail("keymismatch");
    }
    const remotePlan = await PZ.share.decodeStatePayload(plain);
    const local = S().loadPlan(creds.planId);
    const { plan, summary } = PZ.share.mergePlans(local, remotePlan, _now());
    if (!S().savePlan(plan)) throw fail("net");
    S().registerPlan(plan.planId, false);
    if (file.rev < rec.lastRev) rec.staleCount++;
    else rec.staleCount = 0;
    rec.lastRev = Math.max(rec.lastRev, file.rev); // rev never goes down
    rec.lastSyncAt = _now();
    return { rev: file.rev, summary };
  }

  async function nonceConfirmed(creds, nonce) {
    let res;
    try {
      res = await _fetch(D().healthUrl(creds), { cache: "no-store" });
    } catch (e) {
      return false;
    }
    if (!res.ok) return false;
    const health = H().safeParse(await res.text());
    return !!(health && Array.isArray(health.tail) && health.tail.some((t) => t && t.nonce === nonce));
  }

  async function dispatch(creds, rec) {
    const plan = S().loadPlan(creds.planId);
    if (!plan) return;
    const fitted = await PZ.share.fitPayload(
      plan,
      PUSH_BUDGET_CHARS,
      (cap, weeks) => PZ.share.encodeStatePayload(plan, cap, weeks),
      _now(),
    );
    const nonce = H().randomId(8);
    let res;
    try {
      res = await _fetch(D().dispatchUrl(creds), {
        method: "POST",
        headers: {
          Authorization: "Bearer " + creds.pat,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ref: "main",
          inputs: {
            mode: "envelope",
            planId: creds.planId,
            personId: creds.personId,
            token: creds.token,
            nonce,
            payload: fitted.frag,
            clientRev: String(rec.lastRev || 0),
          },
        }),
      });
    } catch (e) {
      throw fail("net");
    }
    if (res.status === 204) {
      rec.pendingNonce = nonce;
      rec.pendingAt = _now();
      rec.pullsSincePush = 0;
      return;
    }
    // fine-grained PATs answer 404 for repos they cannot reach
    if (res.status === 401 || res.status === 403 || res.status === 404) throw fail("authfail");
    throw fail("net");
  }

  // One-shot check-in dispatch for #k1. confirm links: no local plan, no
  // state machine — the WORKFLOW mints the event (mode=checkin). Returns the
  // nonce; confirmation = the nonce appearing in the health tail (awaitNonce).
  async function checkinDispatch(creds, areaId) {
    const nonce = H().randomId(8);
    let res;
    try {
      res = await _fetch(D().dispatchUrl(creds), {
        method: "POST",
        headers: {
          Authorization: "Bearer " + creds.pat,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ref: "main",
          inputs: {
            mode: "checkin",
            planId: creds.planId,
            personId: creds.personId,
            token: creds.token,
            nonce,
            payload: areaId,
          },
        }),
      });
    } catch (e) {
      throw fail("net");
    }
    if (res.status === 204) return nonce;
    // fine-grained PATs answer 404 for repos they cannot reach
    if (res.status === 401 || res.status === 403 || res.status === 404) throw fail("authfail");
    throw fail("net");
  }

  // Poll the health tail until the nonce appears. Defaults cover the measured
  // dispatch→pages latency (~35 s) with headroom; opts are test seams.
  async function awaitNonce(creds, nonce, opts) {
    const tries = (opts && opts.tries) || 24;
    const delayMs = opts && opts.delayMs !== undefined ? opts.delayMs : 5000;
    for (let i = 0; i < tries; i++) {
      if (await nonceConfirmed(creds, nonce)) return true;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
    return false;
  }

  // The main entry. reason is for humans/tests; opts.planId overrides the
  // active plan (c.html knows its plan explicitly).
  async function tick(reason, opts) {
    const planId = (opts && opts.planId) || activePlanId();
    if (!planId) return status();
    const creds = D().getCreds(planId);
    if (!creds) {
      state = "off";
      errorKind = "";
      return status();
    }
    if (running) return status();
    running = true;
    const rec = loadSt(planId);
    try {
      state = "pulling";
      errorKind = "";
      await pull(creds, rec);
      if (rec.pendingNonce) {
        rec.pullsSincePush++;
        if (await nonceConfirmed(creds, rec.pendingNonce)) {
          // clear dirty ONLY if no mutation arrived after the dispatch — the
          // pushed payload covers everything up to pendingAt, nothing later.
          if (rec.dirtySince <= rec.pendingAt) rec.dirty = false;
          rec.pendingNonce = "";
          rec.pendingAt = 0;
          rec.pullsSincePush = 0;
          rec.redispatched = false;
        } else if (
          rec.pullsSincePush >= CONFIRM_MIN_PULLS &&
          _now() - rec.pendingAt > CONFIRM_WINDOW_MS
        ) {
          if (!rec.redispatched) {
            rec.redispatched = true; // exactly ONE re-dispatch
            state = "pushing";
            await dispatch(creds, rec);
          } else {
            state = "queued";
          }
        }
      }
      if (rec.dirty && !rec.pendingNonce) {
        state = "pushing";
        await dispatch(creds, rec);
      }
      if (state !== "queued") state = rec.pendingNonce ? "sent" : "idle";
    } catch (e) {
      errorKind = (e && e.kind) || "net";
      // offline with something to say = queued, not broken
      state = errorKind === "net" && rec.dirty ? "queued" : "error";
    } finally {
      saveSt(planId, rec);
      running = false;
      if (typeof PZ.sync.onChanged === "function") PZ.sync.onChanged(status());
    }
    return status();
  }

  // Mutation callsites (check-in, config edits, week edits) — NOT savePlan
  // itself: a merge-triggered save must never mark dirty (ping-pong).
  function markDirty(planId) {
    const id = planId || activePlanId();
    if (!id || !D().getCreds(id)) return;
    const rec = loadSt(id);
    rec.dirty = true;
    rec.dirtySince = _now();
    rec.redispatched = false;
    saveSt(id, rec);
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => tick("mutation", { planId: id }), DEBOUNCE_MS);
  }

  function connected(planId) {
    const id = planId || activePlanId();
    return !!(id && D().getCreds(id));
  }

  function status(planId) {
    const id = planId || activePlanId();
    const rec = id ? loadSt(id) : null;
    return {
      state: connected(id) ? state : "off",
      error: errorKind,
      dirty: !!(rec && rec.dirty),
      pending: !!(rec && rec.pendingNonce),
      lastRev: rec ? rec.lastRev : 0,
      lastSyncAt: rec ? rec.lastSyncAt : 0,
      stale: !!(rec && rec.staleCount >= STALE_HINT_AFTER),
    };
  }

  function disconnect(planId) {
    const id = planId || activePlanId();
    if (id) D().disconnect(id);
    state = "off";
    errorKind = "";
    if (typeof PZ.sync.onChanged === "function") PZ.sync.onChanged(status());
  }

  function initTriggers() {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      const t = _now();
      if (t - lastVisibilityTick < VISIBILITY_MIN_MS) return;
      lastVisibilityTick = t;
      tick("visibility");
    });
    window.addEventListener("online", () => tick("online"));
  }

  PZ.sync = {
    tick,
    checkinDispatch,
    awaitNonce,
    markDirty,
    status,
    connected,
    disconnect,
    initTriggers,
    onChanged: null,
    _setFetch(fn) {
      _fetch = fn;
    },
    _setNow(fn) {
      _now = fn || (() => Date.now());
    },
    _reset() {
      state = "off";
      errorKind = "";
      running = false;
      keyCache.encKey = "";
      keyCache.key = null;
    },
  };
})();
