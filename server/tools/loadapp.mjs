// SPDX-License-Identifier: GPL-3.0-or-later
// Load UNMODIFIED putzii browser modules (helpers/model/share.js) into a
// node:vm context with a bare `window` plus Node's web globals. DOM-heavy
// paths are lazy-at-call-time; the codec path never calls them.
//
// The app now lives in the SAME repo as the server, so there is no pinned
// commit any more: parity is checked against the working tree, in CI, on
// every push. A wire-format change and its Go counterpart land together or
// the build goes red.
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";

export function loadApp(appDir) {
  const sandbox = {
    window: null, // assigned below so window.PZ lands in the sandbox itself
    // Share Node's Date constructor with the vm realm: isoWeekKey guards with
    // `d instanceof Date`, and a Date built by tool code (Node realm) would
    // fail that check against the vm realm's own Date.
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
    console,
  };
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  for (const f of ["helpers.js", "model.js", "share.js"]) {
    const code = fs.readFileSync(path.join(appDir, f), "utf8");
    vm.runInContext(code, ctx, { filename: f });
  }
  return sandbox.PZ;
}
