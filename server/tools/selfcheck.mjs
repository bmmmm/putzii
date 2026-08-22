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

const result = await sandbox.PZ.selfCheck.run();
if (!result.ok) {
  console.error(`FAIL — ${result.errors.length} check(s):`);
  for (const e of result.errors) console.error("  " + e);
  process.exit(1);
}
console.log(`self-check ok — ${result.checks} checks`);
