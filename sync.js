// SPDX-License-Identifier: GPL-3.0-or-later
// Server sync state machine. States: off · idle · pulling · pushing ·
// queued · error{authfail|forbidden|notfound|keymismatch|conflict|toolarge|
// rejected|net}. `rejected` is a deterministic refusal of the content
// (events-dropped, wire-unknown-slots, …): a retry cannot fix it, so it is
// never shown as "wird nachgeholt" — only `net` (offline, 5xx, 429) queues.
// Triggers: boot, visibility (≤1/30 s), mutation (1.5 s debounce via
// markDirty — also from importPlan, the #p1./file import path), online,
// c.html post-check-in. THE invariant: a pull that merges remote data NEVER
// sets dirty — two clients would ping-pong forever.
//
// Writes are SYNCHRONOUS now: the server answers with the new rev, so the
// response IS the confirmation. What the GitHub-drop era needed — a pending
// nonce, health-tail polling, a timed single re-dispatch, a "sent" state —
// is gone. The nonce survives for one reason only: a retry after a dropped
// connection must reuse it, so the server's replay guard can answer "already
// applied" instead of writing twice.
//
// Conflicts are resolved on the CLIENT: the server refuses a stale write
// (409) rather than merging, we pull, mergePlans locally, and push again.
// That is why mergePlans stays exactly where it always was.
(function () {
  const PZ = (window.PZ = window.PZ || Object.create(null));
  const H = () => PZ.helpers;
  const S = () => PZ.store;
  const D = () => PZ.drop;
  const C = () => PZ.dropcrypto;

  const DEBOUNCE_MS = 1500;
  const VISIBILITY_MIN_MS = 30000;
  const STALE_HINT_AFTER = 3;
  // Matches the server's payload cap. The client never shrinks to fit: the
  // server overwrites rather than merges, so a truncated push would erase
  // history — it refuses one, and so do we, loudly.
  const PUSH_BUDGET_CHARS = 64 * 1024;
  // The only two failures a plain retry can still change: `conflict` is
  // resolved by the very next tick (pull, mergePlans, push) and `net` is what
  // the queue exists for. A Set, not an object literal — invariant 8.
  const RETRYABLE_ERRORS = new Set(["conflict", "net"]);
  // One re-attempt per tick. Enough for the two cases that actually happen
  // (someone else wrote first; a lost response) and bounded enough that a
  // persistent problem surfaces instead of looping.
  const PUSH_RETRIES = 1;

  // test seams
  let _fetch = (url, opts) => fetch(url, opts);
  let _now = () => Date.now();

  let state = "off";
  let errorKind = "";
  let errorReason = "";
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

  function auth(creds) {
    return { Authorization: "Bearer " + creds.token };
  }

  // Map a status to an error kind. 401 = the token is gone (revoked, rotated),
  // 403 = the token is real but scoped to check-ins only (a confirm link
  // pasted into the app) — different causes, different copy.
  function statusFail(status) {
    if (status === 401) return fail("authfail");
    if (status === 403) return fail("forbidden");
    return fail("net");
  }

  async function readJson(res) {
    try {
      return H().safeParse(await res.text()) || {};
    } catch (e) {
      return {};
    }
  }

  // Pull + decrypt + merge. NEVER sets dirty (see header). Returns the
  // plaintext rev, or 0 when no state exists on the server yet.
  async function pull(creds, rec) {
    let res;
    try {
      res = await _fetch(D().stateUrl(creds), { cache: "no-store", headers: auth(creds) });
    } catch (e) {
      throw fail("net");
    }
    if (res.status === 404) {
      // "no-state" is the normal cold start — the first push creates it.
      // "unknown-plan" means this server does not host our plan at all.
      const body = await readJson(res);
      if (body.error === "no-state") {
        rec.lastSyncAt = _now();
        return { rev: 0, empty: true };
      }
      throw fail("notfound");
    }
    if (res.status === 401 || res.status === 403) throw statusFail(res.status);
    if (!res.ok) throw fail("net");
    const file = C().parseStateFile(await res.text());
    if (!file) throw fail("net"); // torn read — a retry heals it
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
    rec.lastRev = Math.max(rec.lastRev, file.rev);
    rec.lastSyncAt = _now();
    return { rev: file.rev, summary };
  }

  // Push the WHOLE plan at the rev we just pulled. Returns {rev, replay}.
  //
  // rec.pendingNonce is REUSED across attempts so a retry after a dropped
  // connection is answered as a replay instead of being applied twice. A
  // replay answer confirms that EARLIER attempt, though — not necessarily
  // this content — so it must not clear dirty; the caller re-pushes with a
  // fresh nonce at the rev the earlier write produced.
  async function push(creds, rec, baseRev) {
    const plan = S().loadPlan(creds.planId);
    if (!plan) {
      rec.dirty = false; // nothing local to send — never spin on this
      return { rev: baseRev, replay: false };
    }
    const payload = await PZ.share.encodeStatePayload(plan);
    if (payload.length > PUSH_BUDGET_CHARS) throw fail("toolarge");
    const nonce = rec.pendingNonce || H().randomId(8);
    rec.pendingNonce = nonce;
    const pushedAt = _now();
    let res;
    try {
      res = await _fetch(D().stateUrl(creds), {
        method: "PUT",
        headers: Object.assign({ "Content-Type": "application/json" }, auth(creds)),
        body: JSON.stringify({ nonce, baseRev, payload }),
      });
    } catch (e) {
      throw fail("net");
    }
    if (res.status === 409) {
      const body = await readJson(res);
      const e = fail("conflict");
      e.rev = Number(body.rev) || 0;
      throw e;
    }
    if (res.status === 401 || res.status === 403) throw statusFail(res.status);
    if (!res.ok) {
      const body = await readJson(res);
      // Our plan outgrew a cap: a different fix than "try again later".
      // `caps` (too many events/areas/people/weeks) and `payload-size` (too
      // many bytes) are the same problem to the user — the plan has to get
      // smaller. The `rejected` copy would tell them to reload the app,
      // which changes nothing.
      if (res.status === 413 || body.error === "payload-size" || body.error === "caps")
        throw fail("toolarge");
      // Transient — the rate brake, a server hiccup, a body-less proxy
      // answer — may queue and retry.
      if (res.status === 429 || res.status >= 500 || !body.error) throw fail("net");
      // Everything else with a named reason (events-dropped, wire-unknown-
      // slots, no-plan, …) is a deterministic REFUSAL of this content. A
      // retry cannot fix it, so it must not hide behind "wird nachgeholt".
      const e = fail("rejected");
      e.reason = String(body.error);
      throw e;
    }
    const body = await readJson(res);
    rec.pendingNonce = "";
    rec.lastRev = Math.max(rec.lastRev, Number(body.rev) || baseRev);
    if (body.replay) return { rev: rec.lastRev, replay: true };
    // Clear dirty ONLY if no mutation arrived after the push started — the
    // pushed payload covers everything up to pushedAt, nothing later.
    if (rec.dirtySince <= pushedAt) rec.dirty = false;
    return { rev: rec.lastRev, replay: false };
  }

  // One-shot check-in for #k2. confirm links and the QR flow: no local plan,
  // no state machine — the SERVER mints the event. Resolves to
  // {minted, rev} once the write is durable; rejects with .kind on failure.
  async function checkinDispatch(creds, areaId) {
    const nonce = H().randomId(8);
    let res;
    try {
      res = await _fetch(D().checkinUrl(), {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, auth(creds)),
        body: JSON.stringify({
          planId: creds.planId,
          personId: creds.personId,
          areaId,
          nonce,
        }),
      });
    } catch (e) {
      throw fail("net");
    }
    if (res.status === 401 || res.status === 403) throw statusFail(res.status);
    const body = await readJson(res);
    if (!res.ok) throw fail(body.error === "unknown-area" ? "unknownarea" : "net");
    return { minted: !!body.minted, replay: !!body.replay, rev: Number(body.rev) || 0, nonce };
  }

  // The main entry. reason is for humans/tests; opts.planId overrides the
  // active plan (c.html knows its plan explicitly). Every status() here is
  // planId-scoped: the caller asked about THIS plan, so reporting the active
  // plan's record back would mislabel c.html's line.
  async function tick(reason, opts) {
    const planId = (opts && opts.planId) || activePlanId();
    if (!planId) return status(planId);
    const creds = D().getCreds(planId);
    if (!creds) {
      state = "off";
      errorKind = "";
      return status(planId);
    }
    if (running) return status(planId);
    running = true;
    const rec = loadSt(planId);
    try {
      state = "pulling";
      errorKind = "";
      errorReason = "";
      let pulled = await pull(creds, rec);
      for (let attempt = 0; rec.dirty; attempt++) {
        state = "pushing";
        try {
          const res = await push(creds, rec, pulled.rev);
          // A replay answer belongs to an earlier attempt whose response was
          // lost: pull the rev it produced and send this content properly.
          if (!res.replay || attempt >= PUSH_RETRIES) break;
        } catch (e) {
          // Someone else wrote in between: pull (which merges their work into
          // ours) and push again. Bounded — a persistent conflict surfaces.
          if (e.kind !== "conflict" || attempt >= PUSH_RETRIES) throw e;
        }
        state = "pulling";
        pulled = await pull(creds, rec);
      }
      state = rec.dirty ? "queued" : "idle";
    } catch (e) {
      errorKind = (e && e.kind) || "net";
      errorReason = (e && e.reason) || "";
      // offline with something to say = queued, not broken
      state = errorKind === "net" && rec.dirty ? "queued" : "error";
    } finally {
      saveSt(planId, rec);
      running = false;
      if (typeof PZ.sync.onChanged === "function") PZ.sync.onChanged(status(planId));
    }
    return status(planId);
  }

  // A share link (#p1.) or a file import, applied to the local plan. This is
  // a USER action, not a pull: the server never sent these events, so
  // marking dirty cannot ping-pong — and without it, imported history stayed
  // on this device forever while the badge showed a healthy server. Writes
  // the pre-merge backup so the caller can offer "Rückgängig". Callsite:
  // app.js applyRemotePlan. Returns null when the save failed (storage full).
  function importPlan(remotePlan, nowMs) {
    const now = Number.isFinite(nowMs) ? nowMs : _now();
    const local = S().loadPlan(remotePlan.planId);
    const knownBefore = !!local;
    if (local) S().saveBackup(local);
    const { plan, summary } = PZ.share.mergePlans(local, remotePlan, now);
    if (!S().savePlan(plan)) return null;
    S().registerPlan(plan.planId, true);
    // A plan this device did not have is news by definition (cold start via
    // a link after the #d2. handshake found no state on the server).
    const news = !knownBefore || Object.keys(summary).some((k) => summary[k] > 0);
    if (news && connected(plan.planId)) markDirty(plan.planId);
    return { plan, summary, knownBefore };
  }

  // "Rückgängig" after an import is honest only while the import has not
  // reached the server: once pushed, restoring the backup would be re-merged
  // by the next pull (append-only, first-seen-wins). The debounce is 1.5 s,
  // the undo toast stays for 8 s — so the caller asks. Connected and no
  // longer dirty means the push went through.
  function canUndoImport(planId) {
    const id = planId || activePlanId();
    return !connected(id) || !!loadSt(id).dirty;
  }

  // Mutation callsites (check-in, config edits, week edits, importPlan) —
  // NOT savePlan itself: a merge-triggered save must never mark dirty
  // (ping-pong).
  function markDirty(planId) {
    const id = planId || activePlanId();
    if (!id || !D().getCreds(id)) return;
    const rec = loadSt(id);
    rec.dirty = true;
    rec.dirtySince = _now();
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
      // the server's own word for a `rejected` push (events-dropped, …) —
      // for the console and the self-check, the UI copy stays one line
      reason: errorReason,
      dirty: !!(rec && rec.dirty),
      pending: !!(rec && rec.pendingNonce),
      lastRev: rec ? rec.lastRev : 0,
      lastSyncAt: rec ? rec.lastSyncAt : 0,
      stale: !!(rec && rec.staleCount >= STALE_HINT_AFTER),
    };
  }

  // May a "Jetzt synchronisieren" button change anything from here? Pressing
  // it on authfail/forbidden/keymismatch/notfound cannot — those need a NEW
  // link; `toolarge` needs thinning, and `rejected` is answered by the reload
  // that fixes it, which ticks on boot by itself. Offering the button anyway
  // teaches the household that the server is flaky when it is not.
  //
  // This predicate lives in sync.js, next to the states it judges, and not in
  // ui-share.js: the headless runner never loads UI modules, so the rule would
  // stay untested there forever.
  function dropSyncCanRetry(st) {
    if (!st || st.state === "off") return false;
    if (st.state === "error") return RETRYABLE_ERRORS.has(st.error);
    return true;
  }

  function disconnect(planId) {
    const id = planId || activePlanId();
    if (id) D().disconnect(id);
    state = "off";
    errorKind = "";
    errorReason = "";
    if (typeof PZ.sync.onChanged === "function") PZ.sync.onChanged(status(id));
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
    PUSH_BUDGET_CHARS,
    tick,
    checkinDispatch,
    importPlan,
    canUndoImport,
    markDirty,
    status,
    dropSyncCanRetry,
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
      errorReason = "";
      running = false;
      // A pending markDirty debounce would otherwise fire AFTER the fetch seam
      // is restored and tick a test plan against the real network.
      clearTimeout(debounceTimer);
      debounceTimer = 0;
      keyCache.encKey = "";
      keyCache.key = null;
    },
  };
})();
