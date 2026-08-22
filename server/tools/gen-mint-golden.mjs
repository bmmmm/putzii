// SPDX-License-Identifier: GPL-3.0-or-later
// Generate check-in parity data (Node side) for the Go mint port.
// Usage: node tools/gen-mint-golden.mjs <outfile> [app-dir]
//
// The retired runner/mint.mjs is gone, but the semantics it borrowed live on
// in the app: model.existsRecent decides the idempotency window, and the
// helpers decide event-id ordering. Those are what the Go port must agree
// with — the cases below are generated FROM the app, never hand-written.
import fs from "node:fs";
import path from "node:path";
import { loadApp } from "./loadapp.mjs";

const outfile = process.argv[2];
const appDir = process.argv[3] || "..";
const PZ = loadApp(appDir);

const NOW = Date.UTC(2026, 7, 22, 10, 0, 0);
const MIN = 60000;
const HOUR = 3600000;

function planWith(ts) {
  return {
    v: 1,
    planId: "MintPln1",
    name: "Mint",
    updatedAt: 0,
    areas: [{ id: "kche1", name: "Küche", intervalDays: 7, createdAt: 0, updatedAt: 0, deletedAt: 0 }],
    people: [{ id: "sina7", name: "Sina", createdAt: 0, updatedAt: 0, deletedAt: 0 }],
    events: ts === null ? [] : [{ id: "gsina7.1", areaId: "kche1", personId: "sina7", ts }],
    weeks: [],
    seq: {},
  };
}

// Offsets probe both edges of the 10-minute window and both directions of
// clock skew around the 12-hour future clamp.
const offsets = [
  ["none", null],
  ["just now", 0],
  ["9 min ago", -9 * MIN],
  ["10 min ago (edge)", -10 * MIN],
  ["11 min ago", -11 * MIN],
  ["1 h ago", -HOUR],
  ["5 min ahead", 5 * MIN],
  ["11 h ahead", 11 * HOUR],
  ["12 h ahead (clamp edge)", 12 * HOUR],
  ["13 h ahead", 13 * HOUR],
  ["48 h ahead", 48 * HOUR],
  ["30 d ago", -30 * 24 * HOUR],
];

const existsRecent = offsets.map(([name, off]) => {
  const plan = planWith(off === null ? null : NOW + off);
  return {
    name,
    tsMs: off === null ? 0 : NOW + off,
    hasEvent: off !== null,
    same: PZ.model.existsRecent(plan, "kche1", "sina7", NOW),
    otherPerson: PZ.model.existsRecent(plan, "kche1", "timo3", NOW),
    otherArea: PZ.model.existsRecent(plan, "bad22", "sina7", NOW),
  };
});

const idSamples = [
  "abcde.1", "gsina7.z", "gsina7.10", "gsina7.11", "dev-key_9.2f",
  "nodot", "bad.0", ".1", "", "x.zzzz",
];
const eventIds = idSamples.map((id) => {
  const parsed = PZ.helpers.parseCompactEventId(id);
  return { id, ok: !!parsed, deviceKey: parsed ? parsed.deviceKey : "", seq: parsed ? parsed.seq : 0 };
});

const cmpPairs = [];
for (const a of idSamples) {
  for (const b of idSamples) {
    cmpPairs.push({ a, b, cmp: Math.sign(PZ.helpers.cmpEventId(a, b)) });
  }
}

// Formatting must round-trip: the Go port mints ids the app can read back.
const formatted = [1, 35, 36, 37, 1295, 1296].map((seq) => ({
  seq,
  id: PZ.helpers.formatCompactEventId("gsina7", seq),
}));

fs.mkdirSync(path.dirname(outfile), { recursive: true });
fs.writeFileSync(
  outfile,
  JSON.stringify({ v: 1, nowMs: NOW, existsRecent, eventIds, cmpPairs, formatted }, null, 1),
);
console.log(
  `mint golden written to ${outfile} (${existsRecent.length} windows, ${eventIds.length} ids, ${cmpPairs.length} pairs)`,
);
