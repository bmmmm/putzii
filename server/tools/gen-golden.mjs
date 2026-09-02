// SPDX-License-Identifier: GPL-3.0-or-later
// Generate wire-codec golden data (Node side) for the Go parity test.
// Usage: node tools/gen-golden.mjs <outfile> [app-dir]
// - rawWire:       envelope of a deliberately DIRTY plan (unnormalized names,
//                  control chars, >40-unit names, emoji, junk rows)
// - canonicalWire: fixpoint — wireFromPlan(planFromWire(rawWire)), uncapped
// - fileExport:    the same plan through serializeFile
import fs from "node:fs";
import path from "node:path";
import { loadApp } from "./loadapp.mjs";

const outfile = process.argv[2];
const appDir = process.argv[3] || "..";
const PZ = loadApp(appDir);

const dirty = {
  v: 1,
  planId: "GoLdEn_1",
  name: "  Haushalt   2026  ",
  updatedAt: 1755600000,
  areas: [
    { id: "kche1", name: "Küche  unten ", intervalDays: 900, createdAt: 1755000000, updatedAt: 1755000001, deletedAt: 0 },
    { id: "bad22", name: "Bad", intervalDays: 0, createdAt: 1755000000, updatedAt: 1755000002, deletedAt: 1755100000 },
    { id: "emoji", name: "🧹 Flur mit sehr sehr sehr sehr langem Namen der weit über vierzig Einheiten geht", intervalDays: 7, createdAt: 1755000000, updatedAt: 1755000003, deletedAt: 0 },
  ],
  people: [
    { id: "sina7", name: "  Sina  M.  ", createdAt: 1755000000, updatedAt: 1755000000, deletedAt: 0 },
    { id: "timo3", name: "", createdAt: 1755000000, updatedAt: 1755000000, deletedAt: 0 },
  ],
  events: [
    { id: "abcde.1", areaId: "kche1", personId: "sina7", ts: Math.floor(Date.UTC(2026, 7, 18, 10, 5) / 60000) * 60000 },
    { id: "gtimo3.1", areaId: "bad22", personId: "timo3", ts: Math.floor(Date.UTC(2026, 7, 19, 9, 1) / 60000) * 60000 },
    { id: "abcde.2", areaId: "emoji", personId: "sina7", ts: Math.floor(Date.UTC(2026, 7, 17, 6, 30) / 60000) * 60000 },
  ],
  weeks: [
    {
      id: "2026-W34",
      days: { 1: [["kche1", "sina7"], ["bad22", ""]], 3: [["", ""]], 7: [["emoji", "timo3"]] },
      createdAt: 1755000000,
      updatedAt: 1755000010,
    },
    { id: "2026-W35", days: {}, createdAt: 1755000000, updatedAt: 1755000011 },
  ],
  seq: {},
};

const rawWire = PZ.share.wireFromPlan(dirty, dirty.events.length, false);
const cleaned = PZ.share.planFromWire(rawWire).plan;
const canonicalWire = PZ.share.wireFromPlan(cleaned, cleaned.events.length, false);
// prove the fixpoint before pinning it
const again = PZ.share.wireFromPlan(PZ.share.planFromWire(canonicalWire).plan, cleaned.events.length, false);
if (JSON.stringify(again) !== JSON.stringify(canonicalWire)) {
  console.error("canonicalWire is not a fixpoint — refusing to write golden");
  process.exit(1);
}
fs.mkdirSync(path.dirname(outfile), { recursive: true });
fs.writeFileSync(
  outfile,
  JSON.stringify(
    {
      v: 1,
      rawWire,
      canonicalWire,
      fileExport: JSON.parse(PZ.share.serializeFile(cleaned)),
      // How many slots the APP emits today. The Go side must agree, or a
      // silent slot-strip becomes possible in one direction.
      knownSlots: canonicalWire.length,
      // The refusal thresholds the app mirrors from the server. Pinned for
      // the same reason as knownSlots: two hand-kept copies drift, and the
      // drift only shows up as a 422 nobody can explain.
      serverCaps: PZ.share.SERVER_CAPS,
      // The exact bytes sync.js PUTs: b64url(gzip(wire)). Pinning it makes
      // the Go decoder test the real production path end to end, not a
      // Go-built lookalike.
      statePayload: await PZ.share.encodeStatePayload(cleaned),
    },
    null,
    1,
  ),
);
console.log(`golden written to ${outfile} (${canonicalWire.length} slots)`);
