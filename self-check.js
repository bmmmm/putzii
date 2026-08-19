// SPDX-License-Identifier: GPL-3.0-or-later
// In-browser test suite: `await PZ.selfCheck.run()` → {ok, checks, errors}.
// Works only on plan objects with reserved self-check ids and cleans up its
// own localStorage keys — real plans are never touched.
(function () {
  const PZ = (window.PZ = window.PZ || Object.create(null));
  const H = () => PZ.helpers;
  const M = () => PZ.model;
  const S = () => PZ.store;

  const SC_PLAN = "SELFCHK0";

  function deepEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  function mkArea(id, name, intervalDays, over) {
    return Object.assign(
      { id, name, intervalDays, createdAt: 1700000000, updatedAt: 1700000000, deletedAt: 0 },
      over || {},
    );
  }

  function mkPerson(id, name, over) {
    return Object.assign(
      { id, name, createdAt: 1700000000, updatedAt: 1700000000, deletedAt: 0 },
      over || {},
    );
  }

  function mkEvent(id, areaId, personId, tsMin) {
    return { id, areaId, personId, ts: tsMin * 60000 };
  }

  function mkPlan(over) {
    return Object.assign(
      {
        v: 1,
        planId: SC_PLAN,
        name: "Selfcheck WG",
        updatedAt: 1700000000,
        areas: [],
        people: [],
        events: [],
        seq: {},
      },
      over || {},
    );
  }

  function cleanup() {
    H().safeLocalStorageRemoveItem(S().K.plan(SC_PLAN));
    H().safeLocalStorageRemoveItem(S().K.backup(SC_PLAN));
    H().safeLocalStorageRemoveItem(S().K.me(SC_PLAN));
    H().safeLocalStorageRemoveItem(S().K.shared(SC_PLAN));
  }

  async function run() {
    const errors = [];
    let checks = 0;

    function check(name, cond) {
      checks++;
      if (!cond) errors.push(name);
    }

    async function throws(name, fn, code) {
      checks++;
      try {
        await fn();
        errors.push(`${name} (did not throw)`);
      } catch (e) {
        if (code && (!e || e.code !== code)) errors.push(`${name} (wrong code: ${e && e.code})`);
      }
    }

    // --- helpers ---
    const ids = Array.from({ length: 50 }, () => H().randomId(8)).join("");
    check("randomId alphabet", [...ids].every((c) => H().ID_ALPHABET.includes(c)));
    check("randomPlanId shape", /^[A-Za-z0-9_-]{8}$/.test(H().randomPlanId()));

    const umlauts = "Küche äöü ß — €🧹";
    check(
      "base64url utf8 roundtrip",
      H().utf8Decode(H().base64UrlDecodeBytes(H().base64UrlEncodeBytes(H().utf8Encode(umlauts)))) ===
        umlauts,
    );

    if (typeof CompressionStream !== "undefined") {
      const big = new Uint8Array(64 * 1024); // compresses tiny, inflates large
      const gz = await H().gzipCompress(big);
      check("gzip roundtrip", deepEqual(Array.from(await H().gzipDecompress(gz)), Array.from(big)));
      await throws("gunzip bomb capped", () => H().gzipDecompress(gz, 1024));
    }

    check("cmpEventId base36 boundary", H().cmpEventId("dev.z", "dev.10") < 0); // seq 35 < 36
    check("cmpEventId device tiebreak", H().cmpEventId("aaa.5", "bbb.2") < 0);
    check(
      "compareEventsByTime tie",
      H().compareEventsByTime({ id: "d.1", ts: 5 }, { id: "d.2", ts: 5 }) < 0,
    );

    check("normalizeName strips controls", H().normalizeName("A\u0000B\u001fC") === "ABC");
    check("normalizeName collapses ws", H().normalizeName("  a \n b  ") === "a b");
    check("normalizeName caps 40", H().normalizeName("x".repeat(60)).length === 40);

    check("PZ root null-prototype", Object.getPrototypeOf(PZ) === null);

    // --- store: quota rollback ---
    cleanup();
    const qPlan = mkPlan({
      areas: [mkArea("aa11", "Küche", 7)],
      people: [mkPerson("pp11", "Anna")],
      events: [mkEvent("dev.1", "aa11", "pp11", 29400000)],
    });
    check("savePlan works", S().savePlan(qPlan));
    const beforeJson = JSON.stringify(qPlan.events);
    const realSet = PZ.helpers.safeLocalStorageSetItem;
    PZ.helpers.safeLocalStorageSetItem = () => false; // simulate quota failure
    const ev = S().newEvent(qPlan, "aa11", "pp11", Date.now());
    const appended = S().appendEvents(qPlan, [ev]);
    PZ.helpers.safeLocalStorageSetItem = realSet;
    check("appendEvents fails on quota", appended === false);
    check("appendEvents rollback intact", JSON.stringify(qPlan.events) === beforeJson);

    // --- store: two-tab id collision re-mint ---
    const tabA = S().loadPlan(SC_PLAN);
    const deviceKey = S().getDeviceKey();
    const colliding = {
      id: `${deviceKey}.1`,
      areaId: "aa11",
      personId: "pp11",
      ts: Math.floor(Date.now() / 60000) * 60000,
    };
    // Persist a same-id event as "the other tab", then append ours.
    tabA.events.push({ id: `${deviceKey}.1`, areaId: "aa11", personId: "pp11", ts: 29406000 * 60000 });
    check("persist tab-b state", S().savePlan(tabA));
    const tabB = mkPlan({ areas: tabA.areas, people: tabA.people, events: [] });
    check("collision append ok", S().appendEvents(tabB, [colliding]));
    check("collision re-minted", colliding.id !== `${deviceKey}.1`);
    check(
      "collision kept both",
      tabB.events.filter((e) => e.id === `${deviceKey}.1`).length === 1 &&
        tabB.events.some((e) => e.id === colliding.id),
    );
    cleanup();

    // --- model boundaries (pinned clock) ---
    const DAY = M().DAY_MS;
    const now = 1755600000000; // fixed
    const freshArea = mkArea("ar01", "Bad", 7, { createdAt: Math.floor(now / 1000) });
    check("new area not overdue", M().areaStatus(freshArea, null, now).status === "ok");

    const weekArea = mkArea("ar02", "Küche", 7);
    const evAt = (offsetMs) => ({ id: "d.1", areaId: "ar02", personId: "p", ts: now - offsetMs });
    check("exactly due -> overdue", M().areaStatus(weekArea, evAt(7 * DAY), now).status === "overdue");
    check("1min before due -> soon", M().areaStatus(weekArea, evAt(7 * DAY - 60000), now).status === "soon");
    check("fresh checkin -> ok", M().areaStatus(weekArea, evAt(1 * DAY), now).status === "ok");
    check("soon window clamp low", M().soonWindowMs(1) === 0.5 * DAY);
    check("soon window clamp high", M().soonWindowMs(100) === 3 * DAY);
    check("soon window quarter", M().soonWindowMs(8) === 2 * DAY);
    check("effTs clamps future", M().effTs(now + 48 * 3600000, now) === now + 12 * 3600000);

    const collapsePlan = mkPlan({
      areas: [mkArea("ar03", "Flur", 7)],
      events: [
        mkEvent("d.1", "ar03", "p1", 29260000),
        mkEvent("d.2", "ar03", "p1", 29260020), // 20 min later → collapses
        mkEvent("d.3", "ar03", "p1", 29260070), // 50 min after d.2 → own row
      ],
    });
    const rows = M().historyRows(collapsePlan, "", now);
    check("history collapse 30min", rows.length === 2 && rows[1].count === 2);

    const idemPlan = mkPlan({
      events: [{ id: "d.9", areaId: "ar04", personId: "p1", ts: now - 5 * 60000 }],
    });
    check("idempotent within 10min", M().existsRecent(idemPlan, "ar04", "p1", now));
    check("idempotent other person free", !M().existsRecent(idemPlan, "ar04", "p2", now));
    check("cooldown catches anyone", !!M().recentByAnyone(idemPlan, "ar04", now));
    const oldPlan = mkPlan({
      events: [{ id: "d.9", areaId: "ar04", personId: "p1", ts: now - 7 * 3600000 }],
    });
    check("cooldown expires 6h", M().recentByAnyone(oldPlan, "ar04", now) === null);

    // --- wire codec ---
    const nowMin = Math.floor(now / 60000);
    const wirePlan = mkPlan({
      areas: [mkArea("ar05", "Küche äöü", 7), mkArea("ar06", "Alt", 14, { deletedAt: 1700000001 })],
      people: [mkPerson("pe01", "Anna"), mkPerson("pe02", "Béla")],
      events: [
        mkEvent("dv1.1", "ar05", "pe01", nowMin - 10000),
        mkEvent("dv1.2", "ar06", "pe02", nowMin - 5000), // deleted area, still on wire
      ],
    });
    const wire = PZ.share.wireFromPlan(wirePlan, 200, true);
    const decoded = PZ.share.planFromWire(wire);
    check("wire viewer flag", decoded.viewer === true);
    check("wire areas roundtrip", deepEqual(decoded.plan.areas, wirePlan.areas));
    check("wire people roundtrip", deepEqual(decoded.plan.people, wirePlan.people));
    const sortEv = (l) => l.slice().sort((a, b) => H().compareEventsByTime(a, b));
    check("wire events roundtrip", deepEqual(sortEv(decoded.plan.events), sortEv(wirePlan.events)));
    check("wire name roundtrip", decoded.plan.name === wirePlan.name);

    await throws("wire v2 refused", () => PZ.share.planFromWire([2, "x", "y", 0, 0, [], [], []]), "version");

    // --- adaptive cap: 500 events, 10 areas, per-area anchors survive ---
    const bigAreas = Array.from({ length: 10 }, (_, i) => mkArea(`ba${i}${i}`, `Bereich ${i}`, 7));
    const bigEvents = [];
    for (let i = 0; i < 500; i++) {
      bigEvents.push(mkEvent(`dv2.${(i + 1).toString(36)}`, bigAreas[i % 10].id, "pe01", nowMin - 20000 + i * 37));
    }
    const bigPlan = mkPlan({ areas: bigAreas, people: [mkPerson("pe01", "Anna")], events: bigEvents });
    const built = await PZ.share.buildShareUrl(bigPlan, {});
    check("big plan fits green budget", built.band === "green" && built.url.length <= PZ.share.URL_BUDGET_GREEN);
    check("share counts honest", built.sharedEvents <= 500 && built.totalEvents === 500);
    const decodedBig = await PZ.share.decodeShareFragment(built.url.split("#")[1]);
    const latestByArea = M().lastCheckinByArea(bigPlan, now);
    const decodedIds = new Set(decodedBig.plan.events.map((e) => e.id));
    check(
      "per-area anchors on wire",
      bigAreas.every((a) => decodedIds.has(latestByArea.get(a.id).id)),
    );

    // --- merge semantics ---
    const localPlan = mkPlan({
      areas: [mkArea("ar07", "Küche", 7, { updatedAt: 1700000100 })],
      people: [mkPerson("pe03", "Anna")],
      events: [mkEvent("da.1", "ar07", "pe03", nowMin - 100)],
    });
    // first-seen-wins: same id, different payload → local payload survives
    const hostile = mkPlan({
      events: [mkEvent("da.1", "ar07", "OTHER", nowMin - 100)],
    });
    const m1 = PZ.share.mergePlans(localPlan, hostile, now);
    check(
      "events first-seen-wins",
      m1.plan.events.find((e) => e.id === "da.1").personId === "pe03" && m1.summary.newEvents === 0,
    );

    // LWW strict: equal updatedAt keeps local
    const tieRemote = mkPlan({ areas: [mkArea("ar07", "Kueche NEU", 7, { updatedAt: 1700000100 })] });
    check(
      "LWW tie keeps local",
      PZ.share.mergePlans(localPlan, tieRemote, now).plan.areas[0].name === "Küche",
    );
    const newerRemote = mkPlan({ areas: [mkArea("ar07", "Kochbereich", 7, { updatedAt: 1700000200 })] });
    check(
      "LWW newer remote wins",
      PZ.share.mergePlans(localPlan, newerRemote, now).plan.areas[0].name === "Kochbereich",
    );
    // delete-vs-edit resolves by updatedAt
    const delRemote = mkPlan({
      areas: [mkArea("ar07", "Küche", 7, { updatedAt: 1700000300, deletedAt: 1700000300 })],
    });
    check(
      "later delete wins",
      PZ.share.mergePlans(localPlan, delRemote, now).plan.areas[0].deletedAt === 1700000300,
    );
    // createdAt takes the minimum
    const oldCreated = mkPlan({ areas: [mkArea("ar07", "Küche", 7, { createdAt: 1600000000 })] });
    check(
      "createdAt min",
      PZ.share.mergePlans(localPlan, oldCreated, now).plan.areas[0].createdAt === 1600000000,
    );
    // unknown areaId survives, invalid events rejected
    const mixedRemote = mkPlan({
      events: [
        mkEvent("db.1", "ghost", "pe03", nowMin - 50),
        { id: "not an id!", areaId: "ar07", personId: "pe03", ts: now },
        mkEvent("db.2", "ar07", "pe03", 1000), // 1971 → below MIN_EVENT_TS
        { id: "db.3", areaId: "ar07", personId: "pe03", ts: now + 60 * 86400000 }, // too far future
      ],
    });
    const m2 = PZ.share.mergePlans(localPlan, mixedRemote, now);
    check("unknown-area event kept", m2.plan.events.some((e) => e.areaId === "ghost"));
    check("invalid events rejected", m2.summary.newEvents === 1);

    await throws(
      "planId mismatch refused",
      () => PZ.share.mergePlans(localPlan, mkPlan({ planId: "OTHERPL1" }), now),
      "planIdMismatch",
    );

    // __proto__ as a record id must not pollute Object.prototype
    const evil = mkPlan({ areas: [mkArea("__proto__", "evil", 7)] });
    PZ.share.mergePlans(localPlan, evil, now);
    check("no prototype pollution", !("polluted" in {}) && Object.prototype.name === undefined);

    // --- file format ---
    const fileText = PZ.share.serializeFile(wirePlan);
    const parsed = PZ.share.parseFile(fileText);
    check("file roundtrip", parsed && parsed.planId === wirePlan.planId && parsed.events.length === 2);
    check("file rejects junk", PZ.share.parseFile('{"format":"x"}') === null);

    // --- hash classification (router on index, local subset on c.html) ---
    if (PZ.router) {
      check("classify route", PZ.router.classifyHash("#verlauf").kind === "route");
      check("classify share", PZ.router.classifyHash("#p1.abc").kind === "share");
      check("classify checkin", deepEqual(PZ.router.classifyHash("#c1.AbC123-_.k3f9"), { kind: "checkin", planId: "AbC123-_", areaId: "k3f9" }));
      check("classify bad checkin", PZ.router.classifyHash("#c1.x.<img>").kind === "unknown");
      check("classify oversized", PZ.router.classifyHash("#" + "p1." + "a".repeat(600000)).kind === "unknown");
    }

    cleanup();
    const result = { ok: errors.length === 0, checks, errors };
    console.log(`putzii self-check: ${checks - errors.length}/${checks} ok`, errors.length ? errors : "");
    return result;
  }

  PZ.selfCheck = { run };
})();
