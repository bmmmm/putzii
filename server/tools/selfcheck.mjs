// SPDX-License-Identifier: GPL-3.0-or-later
// Run the app's own suite (self-check.js) headlessly.
// Usage: node tools/selfcheck.mjs [app-dir]
//
// `await PZ.selfCheck.run()` in a browser console stays the primary way to
// verify the app. This runner exists so CI — and anyone without a browser —
// gets the same answer: the modules the suite needs (helpers, store, model,
// share, dropcrypto, drop, sync, router) touch no DOM outside
// sync.initTriggers, which the suite never calls. Everything they DO need is
// stubbed below: web storage and a location to derive the API base from.
//
// Sections guarded on a UI module (`PZ.uiViews`, …) skip themselves — those
// stay browser-only on purpose.
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";

const appDir = process.argv[2] || "..";

// Minimal Storage: the app only ever goes through helpers' safe wrappers,
// which already swallow exceptions, so behaviour here just has to be honest.
function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
    setItem: (k, v) => void map.set(String(k), String(v)),
    removeItem: (k) => void map.delete(String(k)),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

const sandbox = {
  window: null,
  // The vm realm needs Node's Date: isoWeekKey guards `d instanceof Date`.
  Date,
  crypto,
  TextEncoder,
  TextDecoder,
  Blob,
  Response,
  CompressionStream,
  DecompressionStream,
  URL,
  btoa,
  atob,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  console,
  localStorage: makeStorage(),
  // share.baseDirUrl() reads this; drop.apiBase() derives the API from it.
  location: { href: "https://putzii.test/index.html", pathname: "/index.html", hash: "", search: "" },
};
sandbox.window = sandbox;
const ctx = vm.createContext(sandbox);

const modules = [
  "helpers.js",
  "store.js",
  "model.js",
  "share.js",
  "router.js",
  "dropcrypto.js",
  "drop.js",
  "sync.js",
  "self-check.js",
];
for (const f of modules) {
  vm.runInContext(fs.readFileSync(path.join(appDir, f), "utf8"), ctx, { filename: f });
}

// PUTZII_SEED_ACTIVE=1 — the regression gate for Forgejo issue #1. This
// runner's store starts EMPTY, so the suite's promise "your own active plan
// survives" is structurally untestable here: with no active plan the sync
// section pins its own stand-in and every restore looks correct. Seed a real,
// connected, active plan first and assert afterwards that the suite gave it
// back byte for byte and left none of its own keys behind.
const seedActive = process.env.PUTZII_SEED_ACTIVE === "1";
const PZ = sandbox.PZ;
let seeded = null;
if (seedActive) {
  const plan = PZ.store.createPlan("Echter Haushalt"); // saves + activates
  if (!plan) throw new Error("seed: createPlan failed");
  PZ.drop.acceptCredentials({
    v: 2,
    planId: plan.planId,
    personId: "seed01",
    personName: "Seed",
    token: "s".repeat(22),
    encKey: PZ.helpers.base64UrlEncodeBytes(new Uint8Array(32).fill(9)),
  });
  const liveHandler = () => {}; // stands in for a mounted UI listener
  PZ.sync.onChanged = liveHandler;
  seeded = {
    planId: plan.planId,
    handler: liveHandler,
    index: sandbox.localStorage.getItem(PZ.store.K.plans),
    plan: sandbox.localStorage.getItem(PZ.store.K.plan(plan.planId)),
    creds: sandbox.localStorage.getItem(PZ.store.K.drop(plan.planId)),
  };
  console.log(`seeded active plan ${plan.planId} before the suite`);
}

const result = await sandbox.PZ.selfCheck.run();

if (seeded) {
  const failures = [];
  const idxNow = sandbox.localStorage.getItem(PZ.store.K.plans);
  const idx = PZ.store.loadPlanIndex();
  if (idxNow !== seeded.index) failures.push(`plan index changed: ${seeded.index} → ${idxNow}`);
  if (idx.active !== seeded.planId) failures.push(`active plan is ${idx.active}, not ${seeded.planId}`);
  if (sandbox.localStorage.getItem(PZ.store.K.plan(seeded.planId)) !== seeded.plan)
    failures.push("the seeded plan document was modified");
  if (sandbox.localStorage.getItem(PZ.store.K.drop(seeded.planId)) !== seeded.creds)
    failures.push("the seeded credentials were modified");
  if (PZ.sync.onChanged !== seeded.handler) failures.push("sync.onChanged was not given back");
  // No key of the suite's own plan ids may outlive the run.
  const leftovers = [];
  for (let i = 0; i < sandbox.localStorage.length; i++) {
    const k = sandbox.localStorage.key(i);
    if (/SELFDRP0|SELFACT0|SELFCHK0/.test(k)) leftovers.push(k);
  }
  if (leftovers.length) failures.push(`self-check keys left behind: ${leftovers.join(", ")}`);
  if (failures.length) {
    console.error(`FAIL — the suite disturbed the device's own plan:`);
    for (const f of failures) console.error("  " + f);
    process.exit(1);
  }
  console.log("seeded active plan survived the suite untouched");
}

if (!result.ok) {
  console.error(`FAIL — ${result.errors.length} check(s):`);
  for (const e of result.errors) console.error("  " + e);
  process.exit(1);
}
console.log(`self-check ok — ${result.checks} checks`);
