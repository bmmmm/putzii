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
        weeks: [],
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

    // --- ISO week math (expected values verified against Python isocalendar) ---
    const wk = (y, m, d) => H().isoWeekKey(new Date(y, m, d));
    check("KW today anchor", wk(2026, 7, 19) === "2026-W34"); // Mi 19.08.2026
    check("KW jan1 thursday", wk(2026, 0, 1) === "2026-W01");
    check("KW year tail", wk(2025, 11, 28) === "2025-W52"); // So
    check("KW early monday", wk(2025, 11, 29) === "2026-W01"); // Mo → next ISO year
    check("KW 53 exists 2026", wk(2026, 11, 28) === "2026-W53"); // Mo
    check("KW newyear in old year", wk(2027, 0, 1) === "2026-W53"); // Fr
    check("KW sunday of W53", wk(2027, 0, 3) === "2026-W53");
    check("KW first 2027", wk(2027, 0, 4) === "2027-W01");
    check("KW 2021 boundary", wk(2021, 0, 1) === "2020-W53"); // Fr
    check("KW dst spring", wk(2026, 2, 29) === "2026-W13");
    check("KW dst autumn", wk(2026, 9, 25) === "2026-W43");
    check("addWeeks 53->01", H().addWeeks("2026-W53", 1) === "2027-W01");
    check("addWeeks 01->53 back", H().addWeeks("2027-W01", -1) === "2026-W53");
    check("addWeeks 52->01", H().addWeeks("2025-W52", 1) === "2026-W01");
    check("weekStartDate rejects fake W53", H().weekStartDate("2027-W53") === null);
    check("weekStartDate accepts real W53", H().weekStartDate("2026-W53") !== null);
    check(
      "weekStartDate rejects junk",
      H().weekStartDate("2026-W00") === null &&
        H().weekStartDate("2026-W54") === null &&
        H().weekStartDate("x") === null,
    );
    {
      // Round-trip sweep across DST switches and three year boundaries.
      let sweepOk = true;
      let k = "2025-W01";
      for (let i = 0; i < 160; i++) {
        if (H().isoWeekKey(H().weekStartDate(k)) !== k) {
          sweepOk = false;
          break;
        }
        k = H().addWeeks(k, 1);
      }
      check("week key roundtrip sweep", sweepOk);
    }
    check("week range same month", H().formatWeekRange("2026-W34") === "17.–23.08.");
    check("week range month crossing", H().formatWeekRange("2026-W36") === "31.08.–06.09.");
    check(
      "week keys sort chronologically",
      "2026-W09" < "2026-W10" && "2026-W10" < "2026-W53" && "2026-W53" < "2027-W01",
    );
    check("week label plain", H().formatWeekLabel("2026-W09", "2026-W34") === "KW 9");
    check("week label foreign year", H().formatWeekLabel("2027-W01", "2026-W34") === "KW 1 · 2027");

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

    // --- weeks: model matrix, merge, wire, sanitizing ---
    {
      // Own pinned clock: Wed 2026-08-19 12:40 CEST. (The `wNow` above is
      // 2025 — fine for the offset-based checks, wrong for KW pins.)
      const wNow = 1787136000000;
      const wNowMin = Math.floor(wNow / 60000);
      const wkKey = "2026-W34";
      const mkWeek = (id, days, over) =>
        Object.assign({ id, days, createdAt: 1700000000, updatedAt: 1700000000 }, over || {});
      const wPlan = mkPlan({
        areas: [
          mkArea("aw01", "Küche", 7),
          mkArea("aw02", "Bad", 7),
          mkArea("aw03", "Alt", 7, { deletedAt: 1700000001 }),
        ],
        people: [mkPerson("pw01", "Timo"), mkPerson("pw02", "Sina")],
        weeks: [
          mkWeek(wkKey, { 3: [["aw01", "pw01"], ["aw02", "pw02"]], 5: [["", ""]], 6: [["aw03", "pw01"]] }),
        ],
        events: [mkEvent("dw.1", "aw01", "pw01", wNowMin - 60)], // Küche, same Wednesday
      });
      check("week key matches pinned wNow", M().currentWeekKey(wNow) === wkKey);
      const byDay = M().eventsByDay(wPlan, wNow);
      const wRec = M().weekById(wPlan, wkKey);
      check("cell partial (1 of 2 named)", M().dayCellState(wPlan, wRec, wkKey, 3, byDay).state === "partial");
      check("cell planned unnamed friday", M().dayCellState(wPlan, wRec, wkKey, 5, byDay).state === "planned");
      check(
        "cell deleted-area fallback planned",
        M().dayCellState(wPlan, wRec, wkKey, 6, byDay).state === "planned",
      );
      check("cell none monday", M().dayCellState(wPlan, wRec, wkKey, 1, byDay).state === "none");
      // Second named area cleaned the same day → done; Monday check-in without
      // a plan → extra.
      const wPlan2 = mkPlan(Object.assign({}, wPlan, {
        events: wPlan.events.concat([
          mkEvent("dw.2", "aw02", "pw02", wNowMin - 30),
          mkEvent("dw.3", "aw01", "pw01", wNowMin - 2 * 24 * 60), // Monday
        ]),
      }));
      const byDay2 = M().eventsByDay(wPlan2, wNow);
      check("cell done (all named)", M().dayCellState(wPlan2, wRec, wkKey, 3, byDay2).state === "done");
      check("cell extra monday", M().dayCellState(wPlan2, wRec, wkKey, 1, byDay2).state === "extra");
      const tasks = M().weekTasks(wPlan, wkKey, wNow, byDay);
      check("weekTasks count", tasks.length === 4);
      check(
        "weekTasks done semantics",
        tasks.find((t) => t.areaId === "aw01").done === true &&
          tasks.find((t) => t.areaId === "aw02").done === false &&
          tasks.find((t) => !t.areaId && t.day === 5).done === false,
      );
      const copied = M().copyPrevWeekDays(wPlan, "2026-W35");
      check("copyPrevWeek copies", copied && deepEqual(copied["3"], [["aw01", "pw01"], ["aw02", "pw02"]]));
      if (copied) copied["3"][0][0] = "MUTATED";
      check("copyPrevWeek is fresh", wRec.days["3"][0][0] === "aw01");
      check("copyPrevWeek null on empty", M().copyPrevWeekDays(wPlan, "2026-W40") === null);
      check(
        "unsharedWeekCount sec/ms boundary",
        M().unsharedWeekCount(wPlan, 0) === 1 && M().unsharedWeekCount(wPlan, wNow) === 0,
      );

      // merge: strict-> LWW on week records; weeks-less remote keeps local weeks
      const newerWeek = mkPlan({ weeks: [mkWeek(wkKey, { 2: [["aw01", "pw02"]] }, { updatedAt: 1700000200 })] });
      const wm1 = PZ.share.mergePlans(wPlan, newerWeek, wNow);
      check(
        "week LWW newer remote wins",
        deepEqual(wm1.plan.weeks[0].days, { 2: [["aw01", "pw02"]] }) && wm1.summary.changedWeeks === 1,
      );
      const tieWeek = mkPlan({ weeks: [mkWeek(wkKey, { 2: [["aw01", "pw02"]] })] });
      check(
        "week LWW tie keeps local",
        PZ.share.mergePlans(wPlan, tieWeek, wNow).plan.weeks[0].days["3"] !== undefined,
      );
      check("weeks-less remote keeps local weeks", PZ.share.mergePlans(wPlan, mkPlan({}), wNow).plan.weeks.length === 1);

      // wire roundtrip incl. weeks; legacy 9-element payload → weeks []
      const wWire = PZ.share.wireFromPlan(wPlan, 200, false);
      const wDecoded = PZ.share.planFromWire(wWire);
      check("wire weeks roundtrip", deepEqual(wDecoded.plan.weeks, wPlan.weeks));
      const legacy = PZ.share.planFromWire(wWire.slice(0, 9));
      check("legacy payload → empty weeks", Array.isArray(legacy.plan.weeks) && legacy.plan.weeks.length === 0);

      // hostile days object: only keys 1..7 read, junk filtered, __proto__ dead
      const hostileWire = PZ.share.wireFromPlan(
        mkPlan({ weeks: [mkWeek(wkKey, JSON.parse('{"__proto__":[["x","y"]],"3":"junk","4":[["ok","p"],"junk",["a"]]}'))] }),
        200,
        false,
      );
      const hostileDecoded = PZ.share.planFromWire(hostileWire).plan.weeks[0];
      check(
        "hostile days sanitized",
        hostileDecoded.days["3"] === undefined &&
          deepEqual(hostileDecoded.days["4"], [["ok", "p"], ["a", ""]]) &&
          Object.prototype.x === undefined,
      );
      check(
        "wire rejects fake week keys",
        PZ.share.planFromWire(PZ.share.wireFromPlan(mkPlan({ weeks: [mkWeek("2027-W53", {})] }), 200, false)).plan
          .weeks.length === 0,
      );

      // share window: current−1 … current+horizon
      const windowPlan = mkPlan({
        weeks: [mkWeek("2026-W32", {}), mkWeek("2026-W33", {}), mkWeek(wkKey, {}), mkWeek("2027-W10", {})],
      });
      // default horizon 24: hi = 2027-W05, so 2027-W10 and 2026-W32 fall out
      const win = PZ.share.selectShareWeeks(windowPlan, wNow).map((w) => w.id);
      check("share window default", deepEqual(win, ["2026-W33", "2026-W34"]));
      check("share window horizon 0", deepEqual(PZ.share.selectShareWeeks(windowPlan, wNow, 0).map((w) => w.id), ["2026-W33", "2026-W34"]));

      // store: saveWeek persists + prunes far past
      cleanup();
      const storePlan = mkPlan({ weeks: [mkWeek("2020-W05", { 1: [["", ""]] })] });
      check("saveWeek persists", S().savePlan(storePlan) && S().saveWeek(storePlan, "2026-W40", { 2: [["", ""]] }));
      const reloaded = S().loadPlan(SC_PLAN);
      check(
        "saveWeek pruned far past",
        reloaded && reloaded.weeks.some((w) => w.id === "2026-W40") && !reloaded.weeks.some((w) => w.id === "2020-W05"),
      );
      cleanup();
    }

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
      check("classify drop", PZ.router.classifyHash("#d2.abc").kind === "drop");
      check("classify confirm", PZ.router.classifyHash("#k2.abc").kind === "confirm");
      // v1 links must be NAMED, not lumped in with junk — that is what lets
      // the UI say "alter Link" during the cutover.
      check(
        "classify legacy",
        PZ.router.classifyHash("#d1.abc").kind === "legacy" &&
          PZ.router.classifyHash("#k1.abc").kind === "legacy",
      );
    }

    // --- server sync: crypto, d2/k2 links, state payload, sync machine ---
    // Runs entirely against a fetch stub — the suite needs NO network.
    if (PZ.drop && PZ.sync && PZ.dropcrypto && typeof crypto !== "undefined" && crypto.subtle) {
      const DP = "SELFDRP0";
      const FOREIGN = "SELFACT0"; // stands in for the user's real active plan
      const dropCleanup = () => {
        H().safeLocalStorageRemoveItem(S().K.plan(DP));
        H().safeLocalStorageRemoveItem(S().K.backup(DP)); // importPlan writes it
        H().safeLocalStorageRemoveItem(S().K.drop(DP));
        H().safeLocalStorageRemoveItem(S().K.dropstate(DP));
      };
      dropCleanup();
      const planIndexBefore = H().safeLocalStorageGetItem(S().K.plans);
      const onChangedBefore = PZ.sync.onChanged;
      // A live UI handler must not be fed this suite's plan states.
      PZ.sync.onChanged = null;
      // Everything below runs inside try/finally: `importPlan` ACTIVATES the
      // plan it merges, so between here and the restore the device's active
      // plan is this suite's stand-in. A throw in between must not leave a
      // real device booting into SELFDRP0 — the finally puts the index back
      // whatever happens.
      //
      // Every sync call below names DP explicitly, so a silent fallback to the
      // ACTIVE plan must report the wrong record. On a device that already has
      // a plan that is reality; on an empty store we pin a stand-in so the
      // guarantee is tested there too.
      try {
        if (!S().loadPlanIndex().active) {
          S().savePlanIndex({ active: FOREIGN, ids: [FOREIGN] });
        }

        const keyBytes = new Uint8Array(32).map((_, i) => (i * 13 + 7) & 255);
        const encKey = H().base64UrlEncodeBytes(keyBytes);
        const creds = {
          v: 2,
          planId: DP,
          personId: "scp1",
          personName: "Testy",
          token: "t".repeat(22),
          encKey,
        };
        const frag = (prefix, arr) =>
          prefix + H().base64UrlEncodeBytes(H().utf8Encode(JSON.stringify(arr)));

        // d2 link round-trip + junk
        const parsedCreds = PZ.drop.parseCredentialFragment(
          frag("d2.", [2, DP, "scp1", "Testy", creds.token, encKey]),
        );
        check("d2 roundtrip", parsedCreds && deepEqual(parsedCreds, creds));
        check(
          "d2 junk rejected",
          PZ.drop.parseCredentialFragment("d2.!!!") === null &&
            PZ.drop.parseCredentialFragment(frag("d2.", [3, DP, "scp1", "T", "t", encKey])) === null &&
            PZ.drop.parseCredentialFragment(frag("d2.", [2, DP, "scp1", "T", "t"])) === null &&
            PZ.drop.parseCredentialFragment("p1.abc") === null,
        );
        // A v1 link must be recognisable as OLD, not merely unparsable.
        check(
          "legacy links detected, never parsed",
          PZ.drop.isLegacyFragment("d1.abc") &&
            PZ.drop.isLegacyFragment("k1.abc") &&
            !PZ.drop.isLegacyFragment("d2.abc") &&
            PZ.drop.parseCredentialFragment("d1.abc") === null &&
            PZ.drop.parseCheckinFragment("k1.abc") === null,
        );

        // k2 confirm link: round-trip (no encKey travels), label fallback, junk
        const parsedK2 = PZ.drop.parseCheckinFragment(
          frag("k2.", [2, DP, "scp1", "Testy", "c".repeat(22), [["da2k", "Küche"], ["db3m", ""]]]),
        );
        check(
          "k2 roundtrip",
          parsedK2 &&
            parsedK2.planId === DP &&
            parsedK2.personId === "scp1" &&
            parsedK2.personName === "Testy" &&
            parsedK2.token === "c".repeat(22) &&
            parsedK2.encKey === undefined &&
            deepEqual(parsedK2.areas, [
              { areaId: "da2k", label: "Küche" },
              { areaId: "db3m", label: "db3m" },
            ]),
        );
        // The confirm link must not be able to carry read access at all: there
        // is no slot for a key, and the token in it is a different secret.
        check("k2 carries no key", !JSON.stringify(parsedK2).includes(encKey.slice(0, 16)));
        const k2With = (areas) =>
          PZ.drop.parseCheckinFragment(frag("k2.", [2, DP, "scp1", "T", "c".repeat(22), areas]));
        check(
          "k2 junk rejected",
          PZ.drop.parseCheckinFragment("k2.!!!") === null &&
            PZ.drop.parseCheckinFragment("d2.abc") === null &&
            k2With([]) === null &&
            k2With([["DA_01!", "x"]]) === null &&
            k2With(Array.from({ length: 13 }, () => ["da2k", "x"])) === null,
        );

        // credential storage + disconnect cleanup
        check("creds store roundtrip", PZ.drop.acceptCredentials(creds) && deepEqual(Object.assign({}, PZ.drop.getCreds(DP), { addedAt: 0 }), Object.assign({}, creds, { addedAt: 0 })));
        PZ.drop.disconnect(DP);
        check("disconnect cleans up", PZ.drop.getCreds(DP) === null && H().safeLocalStorageGetItem(S().K.dropstate(DP)) === null);
        PZ.drop.acceptCredentials(creds);

        // API URLs are DERIVED from the serving origin — never from the link.
        // That is what keeps CSP at connect-src 'self'.
        check(
          "api urls stay same-origin",
          PZ.drop.stateUrl(creds).startsWith(PZ.share.baseDirUrl() + "api/") &&
            PZ.drop.stateUrl(creds).endsWith("/state/" + DP) &&
            PZ.drop.healthUrl(creds).endsWith("/health/" + DP) &&
            PZ.drop.checkinUrl().endsWith("/api/checkin"),
        );

        // dropcrypto: roundtrip, tamper, AAD binding
        const stateKey = await PZ.dropcrypto.importStateKey(keyBytes);
        const plainMsg = H().utf8Encode("drop state bytes");
        const encd = await PZ.dropcrypto.encryptState(stateKey, DP, plainMsg);
        check(
          "dropcrypto roundtrip",
          H().utf8Decode(await PZ.dropcrypto.decryptState(stateKey, DP, encd.iv, encd.ct)) === "drop state bytes",
        );
        const tampered = encd.ct.slice();
        tampered[0] ^= 1;
        await throws("dropcrypto tamper throws", () => PZ.dropcrypto.decryptState(stateKey, DP, encd.iv, tampered));
        await throws("dropcrypto AAD binds planId", () => PZ.dropcrypto.decryptState(stateKey, "OTHER", encd.iv, encd.ct));
        const stateText = JSON.stringify({
          v: 1,
          alg: "A256GCM",
          iv: H().base64UrlEncodeBytes(encd.iv),
          ct: H().base64UrlEncodeBytes(encd.ct),
          rev: 4,
          at: "2026-08-20T12:00:00.000Z",
        });
        const parsedState = PZ.dropcrypto.parseStateFile(stateText);
        check("statefile roundtrip", parsedState && parsedState.rev === 4 && parsedState.ct.length === encd.ct.length);
        check("statefile rejects junk", PZ.dropcrypto.parseStateFile("{}") === null && PZ.dropcrypto.parseStateFile("x") === null);

        // uncapped state payload: 300 events (> SHARE_EVENT_CAP) survive
        const bigDropPlan = mkPlan({
          planId: DP,
          areas: [mkArea("da01", "Küche", 7)],
          people: [mkPerson("dp01", "Testy")],
          events: Array.from({ length: 300 }, (_, i) => mkEvent(`dd.${(i + 1).toString(36)}`, "da01", "dp01", 29785000 + i)),
        });
        const payloadB64 = await PZ.share.encodeStatePayload(bigDropPlan);
        const payloadPlan = await PZ.share.decodeStatePayload(H().base64UrlDecodeBytes(payloadB64));
        check("state payload uncapped", payloadPlan.events.length === 300);

        // fitPayload: tiny budget shrinks but per-area anchors survive
        const fitted = await PZ.share.fitPayload(bigDropPlan, 500, (cap, weeks) =>
          PZ.share.encodeStatePayload(bigDropPlan, cap, weeks),
        );
        check("fitPayload shrinks with anchors", fitted.sharedEvents >= 1 && fitted.sharedEvents < 300);

        // --- sync state machine against a fetch stub ---
        let fakeNow = 1787136000000;
        PZ.sync._setNow(() => fakeNow);
        const remoteEvent = mkEvent("gdrop.1", "da01", "dp01", 29785500);
        const remotePlan = mkPlan({
          planId: DP,
          areas: [mkArea("da01", "Küche", 7)],
          people: [mkPerson("dp01", "Testy")],
          events: [remoteEvent],
        });
        async function makeStateBody(plan, rev, key) {
          const gz = await H().gzipCompress(
            H().utf8Encode(JSON.stringify(PZ.share.wireFromPlan(plan, plan.events.length, false))),
          );
          const enc = await PZ.dropcrypto.encryptState(key || stateKey, DP, gz);
          return JSON.stringify({
            v: 1,
            alg: "A256GCM",
            iv: H().base64UrlEncodeBytes(enc.iv),
            ct: H().base64UrlEncodeBytes(enc.ct),
            rev,
            at: "2026-08-20T12:00:00.000Z",
          });
        }
        // The stub speaks the SERVER protocol: GET/PUT /api/state, POST
        // /api/checkin. Writes answer synchronously — there is no tail to poll.
        const env = {
          rev: 5,
          stateBody: await makeStateBody(remotePlan, 5),
          stateStatus: 200,
          stateError: "no-state",
          putStatus: 200,
          putError: "", // body.error for a non-200 PUT; "auth" when empty
          conflictsLeft: 0,
          replaysLeft: 0,
          puts: [],
          checkins: [],
          checkinStatus: 200,
          checkinBody: { minted: true, rev: 6 },
          netFail: false,
          fetchOpts: [],
        };
        const reply = (status, body) => ({
          ok: status >= 200 && status < 300,
          status,
          text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
        });
        PZ.sync._reset();
        PZ.sync._setFetch(async (url, opts) => {
          env.fetchOpts.push({ url, opts });
          if (env.netFail) throw new TypeError("offline");
          if (url === PZ.drop.stateUrl(creds)) {
            if (opts && opts.method === "PUT") {
              env.puts.push(JSON.parse(opts.body));
              if (env.conflictsLeft > 0) {
                env.conflictsLeft--;
                return reply(409, { error: "conflict", rev: env.rev });
              }
              if (env.putStatus !== 200) return reply(env.putStatus, { error: env.putError || "auth" });
              if (env.replaysLeft > 0) {
                env.replaysLeft--;
                return reply(200, { rev: env.rev, at: "", replay: true, changed: false, counts: {} });
              }
              env.rev++;
              return reply(200, { rev: env.rev, at: "", replay: false, changed: true, counts: {} });
            }
            if (env.stateStatus === 404) return reply(404, { error: env.stateError });
            if (env.stateStatus !== 200) return reply(env.stateStatus, { error: "auth" });
            return reply(200, env.stateBody);
          }
          if (url === PZ.drop.checkinUrl()) {
            env.checkins.push(JSON.parse(opts.body));
            if (env.checkinStatus !== 200) return reply(env.checkinStatus, { error: "auth" });
            return reply(200, env.checkinBody);
          }
          if (url === PZ.drop.healthUrl(creds)) return reply(200, { rev: env.rev, at: "", tail: [] });
          throw new Error("unexpected url " + url);
        });

        // pull merges, never dirties, never pushes
        let st = await PZ.sync.tick("test-pull", { planId: DP });
        const pulledPlan = S().loadPlan(DP);
        check("sync pull merges remote", pulledPlan && pulledPlan.events.some((e) => e.id === "gdrop.1"));
        check("sync pull never dirty", st.state === "idle" && st.dirty === false && env.puts.length === 0);
        check(
          "sync pull uses no-store",
          env.fetchOpts.every((f) => !f.opts || f.opts.method || f.opts.cache === "no-store"),
        );
        // Every request must carry the bearer token — the server refuses
        // anonymous reads, so a missing header is a silent 401 in production.
        check(
          "every request is authenticated",
          env.fetchOpts.every(
            (f) => f.opts && f.opts.headers && f.opts.headers.Authorization === "Bearer " + creds.token,
          ),
        );
        // The report must describe the plan that was ASKED about — c.html renders
        // its status line straight from this value while another plan is active.
        check(
          "sync tick reports the requested plan, not the active one",
          S().loadPlanIndex().active !== DP && deepEqual(st, PZ.sync.status(DP)) && st.state === "idle",
        );

        // mutation → PUT with the right body shape; dirty clears on the answer
        PZ.sync.markDirty(DP);
        st = await PZ.sync.tick("test-push", { planId: DP });
        check("sync push writes once", env.puts.length === 1 && st.state === "idle" && st.dirty === false);
        const put = env.puts[0] || {};
        check(
          "put body shape",
          /^[a-z2-9]{8}$/.test(put.nonce) &&
            put.baseRev === 5 &&
            typeof put.payload === "string" &&
            put.payload.length > 0 &&
            // the token belongs in the header, not the body
            put.token === undefined,
        );
        // The push is UNCAPPED: overwrite semantics make a shrunk payload a
        // data-loss bug, so the budget is a refusal threshold, not a target.
        // The value itself has ONE home (share.js SERVER_CAPS, pinned against
        // Go); asserting a literal here would just add a third copy.
        check(
          "push budget reads the single capped source",
          PZ.sync.PUSH_BUDGET_CHARS === PZ.share.SERVER_CAPS.maxPayloadChars,
        );

        // 409 → pull (which merges the other side in), push again. Converges
        // inside ONE tick: mergePlans lives on the client, so the server never
        // has to reconcile anything.
        env.puts.length = 0;
        env.stateBody = await makeStateBody(remotePlan, 20);
        env.conflictsLeft = 1;
        PZ.sync.markDirty(DP);
        st = await PZ.sync.tick("test-conflict", { planId: DP });
        check(
          "sync resolves a conflict by re-pulling",
          env.puts.length === 2 &&
            env.puts[1].baseRev === 20 &&
            st.dirty === false &&
            st.state === "idle",
        );

        // a PERSISTENT conflict must surface, not loop
        env.puts.length = 0;
        env.conflictsLeft = 99;
        PZ.sync.markDirty(DP);
        st = await PZ.sync.tick("test-conflict-hard", { planId: DP });
        check(
          "persistent conflict surfaces",
          st.state === "error" && st.error === "conflict" && env.puts.length === 2 && st.dirty === true,
        );
        env.conflictsLeft = 0;

        // A replay answer confirms an EARLIER attempt, not this content: it
        // must trigger a fresh push with a new nonce, never a false "synchron".
        env.puts.length = 0;
        env.replaysLeft = 1;
        PZ.sync.markDirty(DP);
        st = await PZ.sync.tick("test-replay", { planId: DP });
        check(
          "replay answer triggers a fresh push, not a false confirm",
          env.puts.length === 2 &&
            env.puts[0].nonce !== env.puts[1].nonce &&
            st.dirty === false &&
            st.state === "idle",
        );

        // cold start: no state on the server yet → the first push creates it
        H().safeLocalStorageRemoveItem(S().K.dropstate(DP));
        env.puts.length = 0;
        env.stateStatus = 404;
        env.stateError = "no-state";
        PZ.sync.markDirty(DP);
        st = await PZ.sync.tick("test-cold", { planId: DP });
        check(
          "cold start pushes at baseRev 0",
          env.puts.length === 1 && env.puts[0].baseRev === 0 && st.state === "idle",
        );
        // …but a server that does not host this plan is an error, not a cold start
        env.stateError = "unknown-plan";
        st = await PZ.sync.tick("test-unknown-plan", { planId: DP });
        check("unknown plan → notfound", st.state === "error" && st.error === "notfound");
        env.stateStatus = 200;

        // rev monotony + stale detection
        H().safeLocalStorageRemoveItem(S().K.dropstate(DP));
        env.stateBody = await makeStateBody(remotePlan, 9);
        await PZ.sync.tick("t", { planId: DP });
        const recBefore = H().safeParse(H().safeLocalStorageGetItem(S().K.dropstate(DP)));
        env.stateBody = await makeStateBody(remotePlan, 3); // older than known rev
        await PZ.sync.tick("t", { planId: DP });
        await PZ.sync.tick("t", { planId: DP });
        st = await PZ.sync.tick("t", { planId: DP });
        const recAfter = H().safeParse(H().safeLocalStorageGetItem(S().K.dropstate(DP)));
        check(
          "sync rev never sinks + stale hint",
          recBefore && recAfter && recAfter.lastRev >= recBefore.lastRev && st.stale === true,
        );

        // error mapping: keymismatch, auth, scope, offline-queue
        H().safeLocalStorageRemoveItem(S().K.dropstate(DP));
        const wrongKey = await PZ.dropcrypto.importStateKey(new Uint8Array(32).map((_, i) => i + 1));
        env.stateBody = await makeStateBody(remotePlan, 7, wrongKey);
        st = await PZ.sync.tick("t", { planId: DP });
        check("sync wrong key → keymismatch", st.state === "error" && st.error === "keymismatch");
        env.stateBody = await makeStateBody(remotePlan, 7);
        env.netFail = true;
        st = await PZ.sync.tick("t", { planId: DP });
        check("sync net fail clean → error", st.state === "error" && st.error === "net");
        PZ.sync.markDirty(DP);
        st = await PZ.sync.tick("t", { planId: DP });
        check("sync net fail dirty → queued", st.state === "queued");
        env.netFail = false;
        env.stateStatus = 401;
        st = await PZ.sync.tick("t", { planId: DP });
        check("sync 401 → authfail", st.state === "error" && st.error === "authfail");
        // 403 = a check-in-scoped token pasted into the app: a DIFFERENT cause
        // than a revoked token, and the copy has to say so.
        env.stateStatus = 403;
        st = await PZ.sync.tick("t", { planId: DP });
        check("sync 403 → forbidden", st.state === "error" && st.error === "forbidden");
        env.stateStatus = 200;

        // --- a share-link / file import on a CONNECTED plan must reach the
        // server: a user action, not a pull (the server never sent these
        // events, so no ping-pong). Before, imported history stayed on this
        // device forever while the badge showed a healthy server. ---
        H().safeLocalStorageRemoveItem(S().K.dropstate(DP));
        env.puts.length = 0;
        st = await PZ.sync.tick("test-import-base", { planId: DP });
        const activeBefore = S().loadPlanIndex().active;
        const importSrc = mkPlan({
          planId: DP,
          areas: [mkArea("da01", "Küche", 7)],
          people: [mkPerson("dp01", "Testy")],
          events: [mkEvent("gimp.1", "da01", "dp01", 29785550)],
        });
        const imp = PZ.sync.importPlan(importSrc, fakeNow);
        check(
          "importPlan merges and reports the news",
          st.dirty === false &&
            !!imp &&
            imp.knownBefore === true &&
            imp.summary.newEvents === 1 &&
            S().loadPlan(DP).events.some((e) => e.id === "gimp.1"),
        );
        check("import on a connected plan marks dirty", PZ.sync.status(DP).dirty === true);
        st = await PZ.sync.tick("test-import-push", { planId: DP });
        const importPut = env.puts[0];
        const importPushed = importPut
          ? await PZ.share.decodeStatePayload(H().base64UrlDecodeBytes(importPut.payload))
          : null;
        check(
          "import is pushed with the imported event",
          env.puts.length === 1 &&
            !!importPushed &&
            importPushed.events.some((e) => e.id === "gimp.1") &&
            st.state === "idle" &&
            st.dirty === false,
        );
        const impAgain = PZ.sync.importPlan(importSrc, fakeNow);
        check(
          "import without news stays clean",
          !!impAgain && impAgain.summary.newEvents === 0 && PZ.sync.status(DP).dirty === false,
        );
        // A rename-only link is news too: the name is plan-level, no record
        // counter sees it — without changedName it never reached the server.
        const renamedSrc = mkPlan({
          planId: DP,
          name: "Neues Zuhause",
          updatedAt: 1700000001,
          areas: [mkArea("da01", "Küche", 7)],
          people: [mkPerson("dp01", "Testy")],
        });
        const impRename = PZ.sync.importPlan(renamedSrc, fakeNow);
        check(
          "rename-only import counts as news",
          !!impRename &&
            impRename.summary.changedName === 1 &&
            impRename.summary.newEvents === 0 &&
            S().loadPlan(DP).name === "Neues Zuhause" &&
            PZ.sync.status(DP).dirty === true,
        );
        // Undo is honest only until the import reached the server: the debounce
        // fires after 1.5 s, the undo toast lives 8 s.
        check("import undo allowed before the push", PZ.sync.canUndoImport(DP) === true);
        st = await PZ.sync.tick("test-rename-push", { planId: DP });
        check(
          "import undo refused once pushed",
          st.state === "idle" && st.dirty === false && PZ.sync.canUndoImport(DP) === false,
        );
        // importPlan activates the plan like a link open does — put the
        // stand-in back so the rest of the suite keeps its "not active" premise.
        const idxAfterImport = S().loadPlanIndex();
        idxAfterImport.active = activeBefore;
        S().savePlanIndex(idxAfterImport);

        // --- refusals are not "queued": a 4xx with a named reason is
        // deterministic, a retry cannot fix it. 429 (the rate brake) can. ---
        env.puts.length = 0;
        env.putStatus = 422;
        env.putError = "events-dropped";
        PZ.sync.markDirty(DP);
        st = await PZ.sync.tick("test-rejected", { planId: DP });
        check(
          "refused push → rejected, not queued",
          st.state === "error" &&
            st.error === "rejected" &&
            st.reason === "events-dropped" &&
            st.dirty === true &&
            env.puts.length === 1,
        );
        env.putError = "payload-size";
        st = await PZ.sync.tick("test-toolarge", { planId: DP });
        check("payload-size refusal → toolarge", st.state === "error" && st.error === "toolarge");
        // `caps` is the count-based sibling of payload-size (api.go returns
        // it for events/areas/people/weeks over the limit). It used to fall
        // through to `rejected`, whose copy says "reload the app" — an
        // instruction that cannot help.
        env.putError = "caps";
        st = await PZ.sync.tick("test-caps", { planId: DP });
        check("caps refusal → toolarge, not rejected", st.state === "error" && st.error === "toolarge");
        env.putStatus = 429;
        env.putError = "rate";
        env.puts.length = 0;
        st = await PZ.sync.tick("test-rate", { planId: DP });
        check("rate brake while dirty → queued", st.state === "queued" && st.dirty === true);
        // The nonce contract from push(): an attempt that failed KEEPS its
        // nonce, so the retry is answered as a replay instead of being
        // applied twice. `status().pending` is the live field that says so —
        // pinned here through the machine, not through a synthetic record.
        const queuedNonce = env.puts.length === 1 ? env.puts[0].nonce : "";
        check("a queued push keeps its nonce pending", st.pending === true && !!queuedNonce);
        env.putStatus = 200;
        env.putError = "";
        env.puts.length = 0;
        st = await PZ.sync.tick("test-drain", { planId: DP });
        check("queued work drains once the server accepts", st.state === "idle" && st.dirty === false);
        check(
          "the retry reuses that nonce, and success clears it",
          env.puts.length === 1 && env.puts[0].nonce === queuedNonce && st.pending === false,
        );

        // A plan already over a COUNT cap never asks: the server would refuse
        // it with exactly this answer (`caps` → 422), so the round-trip buys
        // nothing. Proven by the absence of a PUT, not by the status alone.
        // Placed after the queue checks on purpose — it deliberately leaves a
        // dirty, unsendable plan behind, and the state machine is restored by
        // savePlan + the _reset() below rather than by the next check.
        env.puts.length = 0;
        const capsSafe = S().loadPlan(DP);
        const capsOver = JSON.parse(JSON.stringify(capsSafe));
        const overBy = PZ.share.SERVER_CAPS.maxEvents + 1 - capsOver.events.length;
        for (let i = 0; i < overBy; i++) {
          capsOver.events.push({
            id: `capsdev.${i.toString(36)}`,
            areaId: "da01",
            personId: "dp01",
            ts: 1787047500000,
          });
        }
        S().savePlan(capsOver);
        PZ.sync.markDirty(DP);
        st = await PZ.sync.tick("test-caps-local", { planId: DP });
        check(
          "a plan over the event cap is refused without a round-trip",
          st.state === "error" && st.error === "toolarge" && env.puts.length === 0 && st.dirty === true,
        );
        S().savePlan(capsSafe);

        // k2 confirm flow: one-shot check-in, confirmed by the RESPONSE — no
        // local plan involved, the stub records the exact wire body.
        env.netFail = false;
        const k2res = await PZ.sync.checkinDispatch(parsedK2, "da2k");
        const k2body = env.checkins[0] || {};
        check(
          "checkin body shape",
          env.checkins.length === 1 &&
            k2body.planId === DP &&
            k2body.personId === "scp1" &&
            k2body.areaId === "da2k" &&
            /^[a-z2-9]{8}$/.test(k2body.nonce) &&
            k2body.token === undefined,
        );
        check("checkin confirms synchronously", k2res.minted === true && k2res.rev === 6);
        env.checkinBody = { minted: false, replay: false, rev: 6 };
        const k2again = await PZ.sync.checkinDispatch(parsedK2, "da2k");
        check("idempotent checkin reports minted:false", k2again.minted === false);
        env.checkinStatus = 403;
        await throws("checkin 403 → forbidden", () => PZ.sync.checkinDispatch(parsedK2, "da2k"));
        env.checkinStatus = 401;
        await throws("checkin 401 → authfail", () => PZ.sync.checkinDispatch(parsedK2, "da2k"));
        env.checkinStatus = 200;

        // no creds → off
        PZ.sync._reset();
        PZ.drop.disconnect(DP);
        st = await PZ.sync.tick("t", { planId: DP });
        check("sync without creds → off", st.state === "off");
        check("import undo always allowed without a server", PZ.sync.canUndoImport(DP) === true);

      } catch (e) {
        // A crash here is ONE failed check, not the end of the suite: the ~100
        // checks after this block still get to run and report.
        check(`sync section threw: ${(e && e.message) || e}`, false);
      } finally {
        // restore reality
        PZ.sync._setFetch((url, opts) => fetch(url, opts));
        PZ.sync._setNow(null);
        PZ.sync._reset();
        PZ.sync.onChanged = onChangedBefore;
        dropCleanup();
        if (planIndexBefore === null) H().safeLocalStorageRemoveItem(S().K.plans);
        else H().safeLocalStorageSetItem(S().K.plans, planIndexBefore);
      }
    }

    // --- the Teilen tab's server line: when is a retry worth offering, and
    // what does the household actually read? The predicate lives in sync.js
    // (testable headlessly), the German words in ui-share.js — the runner
    // loads that module for exactly this section. ---
    if (PZ.sync && PZ.sync.dropSyncCanRetry) {
      const R = PZ.sync.dropSyncCanRetry;
      check("retry: no state at all → nothing to press", R(null) === false);
      check("retry: no server → button gone", R({ state: "off" }) === false);
      check("retry: connected and idle → offered", R({ state: "idle" }) === true);
      check("retry: queued → offered", R({ state: "queued" }) === true);
      // The two transient failures: pressing again genuinely helps.
      check("retry: conflict → the next tick merges", R({ state: "error", error: "conflict" }) === true);
      check("retry: net → offered", R({ state: "error", error: "net" }) === true);
      // The deterministic ones: pressing again repeats the same answer.
      for (const kind of ["authfail", "forbidden", "keymismatch", "notfound", "toolarge", "rejected"]) {
        check(`retry: ${kind} needs a different action, not a retry`, R({ state: "error", error: kind }) === false);
      }
      check("retry: an unknown error kind is not offered either", R({ state: "error", error: "zzz" }) === false);
    }

    if (PZ.uiShare && PZ.uiShare.dropStatusText) {
      const T = PZ.uiShare.dropStatusText;
      const NOW = 1756800000000;
      check(
        "copy: connected but never synced says so",
        T({ state: "idle", lastSyncAt: 0 }, NOW).includes("Noch nie synchronisiert."),
      );
      check(
        "copy: the last sync is a relative time",
        T({ state: "idle", lastSyncAt: NOW - 3 * 3600000 }, NOW).includes("Zuletzt synchronisiert: vor 3 Std."),
      );
      // Both found by the browser cross-check, not by the headless run.
      check(
        "copy: an abbreviated time does not double the period",
        !T({ state: "idle", dirty: false, lastSyncAt: NOW - 5 * 60000 }, NOW).includes(".."),
      );
      check(
        "copy: never synced does not also claim ✓ synchron",
        T({ state: "idle", dirty: false, lastSyncAt: 0 }, NOW) ===
          "Server verbunden. Noch nie synchronisiert.",
      );
      check(
        "copy: without a server there is no sync time",
        !T({ state: "off", lastSyncAt: 0 }, NOW).includes("synchronisiert"),
      );
      check(
        "copy: an error names its cause AND the last sync",
        (() => {
          const t = T({ state: "error", error: "authfail", lastSyncAt: NOW - 86400000 }, NOW);
          return t.includes("Zugangs-Link") && t.includes("gestern");
        })(),
      );
      check(
        "copy: a stale server keeps both hints",
        (() => {
          const t = T({ state: "idle", stale: true, lastSyncAt: NOW - 60000 }, NOW);
          return t.includes("altem Stand") && t.includes("gerade eben");
        })(),
      );
      // The other half of the caps fix: mapping it to `toolarge` only helps
      // if that copy asks for something different than `rejected` does.
      // Pinned as text, because the mapping alone would look correct while
      // both lines said "reload".
      check(
        "copy: too large asks to thin out, never to reload",
        (() => {
          const t = T({ state: "error", error: "toolarge", lastSyncAt: 0 }, NOW);
          return t.includes("ausdünnen") && !t.includes("neu laden");
        })(),
      );
    }

    // c.html's server line under a fresh check-in.
    if (PZ.uiCheckin && PZ.uiCheckin.dropLineText) {
      const L = PZ.uiCheckin.dropLineText;
      // The regression: both in-flight states fell through every branch and
      // left the placeholder standing after the sync had finished.
      check("checkin line: pulling is named", L({ state: "pulling" }) === "Server: wird abgeglichen…");
      check("checkin line: pushing is named", L({ state: "pushing" }) === "Server: wird gesendet…");
      check("checkin line: synced", L({ state: "idle", dirty: false }).includes("ist bei allen"));
      check(
        "checkin line: idle but dirty is waiting on the debounce",
        L({ state: "idle", dirty: true }) === "Server: wird gleich gesendet…",
      );
      check("checkin line: queued", L({ state: "queued" }).includes("nachgeholt"));
      check(
        "checkin line: a refusal says the entry is safe locally",
        L({ state: "error", error: "rejected" }).includes("neu laden"),
      );
      check(
        "checkin line: any other error keeps the reassurance",
        L({ state: "error", error: "net" }).includes("lokal gesichert"),
      );
    }

    // --- device identity: resolveMe ---
    {
      const plan = mkPlan({
        people: [mkPerson("pa01", "Anna"), mkPerson("pb02", "Bea", { deletedAt: 1700000001 })],
      });
      S().savePlan(plan);
      check("resolveMe: nothing set → null", S().resolveMe(plan, "") === null);
      S().setMe(SC_PLAN, "pa01");
      const viaMe = S().resolveMe(plan, "");
      check("resolveMe: remembered me → person", !!viaMe && viaMe.id === "pa01");
      const viaDeadCreds = S().resolveMe(plan, "pb02");
      check("resolveMe: deleted creds fall through to me", !!viaDeadCreds && viaDeadCreds.id === "pa01");
      S().setMe(SC_PLAN, "pb02");
      check("resolveMe: deleted me → null", S().resolveMe(plan, "") === null);
      S().setMe(SC_PLAN, "ghost");
      check("resolveMe: unknown me → null", S().resolveMe(plan, "") === null);
      plan.people.push(mkPerson("pc03", "Cem"));
      S().setMe(SC_PLAN, "pa01");
      const viaCreds = S().resolveMe(plan, "pc03");
      check("resolveMe: live creds outrank me", !!viaCreds && viaCreds.id === "pc03");
      S().setMe(SC_PLAN, "");
    }

    // --- one-tap check-in: instantCheckin minting path ---
    if (PZ.uiViews && PZ.uiViews.instantCheckin) {
      const IC_NOW = 1799999999999; // fixed clock — model takes nowMs everywhere
      const area = mkArea("scar1", "Küche", 7);
      const mkFresh = () =>
        mkPlan({ areas: [area], people: [mkPerson("pa01", "Anna"), mkPerson("pd04", "Timo")] });
      let plan = mkFresh();
      S().savePlan(plan);
      check("instant: no me → nome", PZ.uiViews.instantCheckin(plan, area, IC_NOW, {}).status === "nome");
      S().setMe(SC_PLAN, "pa01");
      const ok1 = PZ.uiViews.instantCheckin(plan, area, IC_NOW, {});
      check("instant: ok with me", ok1.status === "ok" && ok1.person.id === "pa01");
      check("instant: ts minute-quantized", ok1.status === "ok" && ok1.ev.ts % 60000 === 0);
      check(
        "instant: event id carries this device key",
        ok1.status === "ok" &&
          H().parseCompactEventId(ok1.ev.id) &&
          ok1.ev.id.startsWith(`${S().getDeviceKey()}.`),
      );
      check(
        "instant: event persisted",
        S().loadPlan(SC_PLAN).events.some((e) => e.id === ok1.ev.id),
      );
      check(
        "instant: repeat inside window → already",
        PZ.uiViews.instantCheckin(S().loadPlan(SC_PLAN), area, IC_NOW + 60000, {}).status === "already",
      );
      // Someone ELSE cleaned 1h ago → cooldown; force overrides; 7h → free.
      plan = mkFresh();
      plan.events = [mkEvent("scdev.1", "scar1", "pd04", Math.floor((IC_NOW - 3600000) / 60000))];
      S().savePlan(plan);
      const cold = PZ.uiViews.instantCheckin(plan, area, IC_NOW, {});
      check("instant: 1h-old foreign event → cooldown", cold.status === "cooldown" && cold.recent.personId === "pd04");
      const forced = PZ.uiViews.instantCheckin(S().loadPlan(SC_PLAN), area, IC_NOW, { force: true });
      check("instant: force overrides cooldown", forced.status === "ok");
      plan = mkFresh();
      plan.events = [mkEvent("scdev.2", "scar1", "pd04", Math.floor((IC_NOW - 7 * 3600000) / 60000))];
      S().savePlan(plan);
      check(
        "instant: 7h-old event → no cooldown",
        PZ.uiViews.instantCheckin(plan, area, IC_NOW, {}).status === "ok",
      );
      // Quota failure must roll back — nothing half-written.
      plan = mkFresh();
      S().savePlan(plan);
      const evCountBefore = plan.events.length;
      const realSet = PZ.helpers.safeLocalStorageSetItem;
      PZ.helpers.safeLocalStorageSetItem = () => false; // simulate quota failure
      const failed = PZ.uiViews.instantCheckin(plan, area, IC_NOW, {});
      PZ.helpers.safeLocalStorageSetItem = realSet;
      check("instant: quota failure → failed", failed.status === "failed");
      check("instant: rollback keeps plan.events intact", plan.events.length === evCountBefore);
      // Undo path: removeEvent deletes the minted event again.
      const plan2 = S().loadPlan(SC_PLAN);
      const ok2 = PZ.uiViews.instantCheckin(plan2, area, IC_NOW, {});
      check(
        "instant: undo removes the event",
        ok2.status === "ok" &&
          S().removeEvent(S().loadPlan(SC_PLAN), ok2.ev.id) === true &&
          !S().loadPlan(SC_PLAN).events.some((e) => e.id === ok2.ev.id),
      );
      S().setMe(SC_PLAN, "");
    }

    cleanup();
    const result = { ok: errors.length === 0, checks, errors };
    console.log(`putzii self-check: ${checks - errors.length}/${checks} ok`, errors.length ? errors : "");
    return result;
  }

  PZ.selfCheck = { run };
})();
