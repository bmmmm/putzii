# putzii — Agent Guide

Serverless cleaning-schedule PWA. Vanilla HTML/CSS/JS, no build step, no
backend, no dependencies (qrcodegen.js is vendored). UI German, code English.

## Identity

- `origin` = the private Forgejo (source of truth; host and owner live in
  `~/.env`, never in tracked files)
- `github` = public mirror `github.com/bmmmm/putzii` — push BOTH remotes,
  never merge PRs on the GitHub UI (Dependabot: fix locally, push both).
- Deploys to GitHub Pages from `main` via `.github/workflows/pages.yml`:
  https://bmmmm.github.io/putzii/ — a SUBPATH, so every asset reference must
  stay relative (`style.css`, never `/style.css`).

## Architecture (read in this order)

| File | Role |
|---|---|
| `share.js` | Wire codec (`#p1.` fragment), adaptive `fitPayload`, week window, `mergePlans`, `encode/decodeStatePayload` — the heart |
| `store.js` | Plan docs in localStorage, event minting, atomic append + rollback, `saveWeek` |
| `model.js` | Pure due/status/history logic + KW duty plan (everything takes `nowMs`) |
| `dropcrypto.js` | AES-256-GCM state crypto — core line-identical with putzii-drop's runner (CI-pinned) |
| `drop.js` | `#d1.` credential links, per-plan cred storage, drop URL builders |
| `sync.js` | Drop sync state machine (off/idle/…/queued/error), injectable `_fetch`/`_now` seams |
| `ui-weeks.js` | Wochen tab: endless KW list, day-cell strip, inline slot editor (index-only) |
| `ui-checkin.js` + `c.html` | QR check-in mini page incl. cold path (no plan on device) |
| `app.js` | index boot: hash classify, merge-on-open, pending banner |
| `router.js` | Hash prefixes: `p1./p1u.` share, `c1.<planId>.<areaId>` check-in, routes |
| `self-check.js` | In-browser suite: `await PZ.selfCheck.run()` in the console |

## Invariants — do not break

1. Events are append-only: union by id, **first-seen-wins** — a link can add
   history, never rewrite it. Undo = local hard-delete pre-share only.
2. Config (areas/people) merges LWW by **strict** `updatedAt >`; ties keep
   local. `createdAt` takes the minimum. Soft-delete via `deletedAt`.
3. Event `ts` is minute-quantized at creation (wire round-trip lossless).
4. Event ids are `<deviceKey>.<seq-base36>` — compare seq NUMERICALLY
   (`cmpEventId`), lexical compare breaks at base36 width boundaries.
5. The `#p1.`/`#c1.`/`#d1.` fragment never reaches a server. Since v2 the
   ONLY allowed network calls are the GitHub drop's: CSP `connect-src 'self'
   https://api.github.com https://*.github.io` (api = workflow dispatch,
   *.github.io = encrypted state pull — also covers local dev and foreign
   households running their own drop). Never widen it further; never add a
   CDN/font/analytics reference.
6. Share URL budget 1800 chars (Signal). The UI must always show honest
   counts ("Teilt X von Y Einträgen") when history is capped.
7. Any APP_SHELL asset change requires a `VERSION` bump in
   `service-worker.js` — `scripts/check-sw-version.sh` / CI `sw-version`
   enforce it, including the "every page asset is in APP_SHELL" cross-check.
8. All registries are `Object.create(null)`/`Map` — `__proto__` ids must not
   pollute prototypes (self-check asserts it).
9. Week records (`plan.weeks[]`): `id` IS the ISO week key (`"2026-W34"`,
   pad2 — lexicographic order must equal chronological order), `days` keyed
   "1"–"7" with `[areaId, personId]` slots. LWW like other config; NO
   `deletedAt` — an empty record with a newer `updatedAt` is the tombstone.
   Week edits must write a FRESH days object (merged records are shallow
   copies). ISO week math is hand-rolled in helpers.js — deliberately no
   weeksInYear(); `weekStartDate` validates keys by round-trip.
10. The wire envelope's slots are APPEND-ONLY (weeks = index 9, no version
   bump): never reorder or retype an existing index; new data goes at the
   end. Bump WIRE_VERSION only for structurally incompatible changes.
11. Drop sync: a pull that merges remote data NEVER sets dirty (two clients
   would ping-pong). `markDirty` lives at USER mutation callsites
   (saveAndRefresh, saveDays, confirmCheckin) — never inside
   savePlan/saveWeek. Write confirmation = nonce in the drop's health tail;
   dirty clears only if no mutation arrived after the dispatch
   (`dirtySince <= pendingAt`).
12. The service worker must never answer requests outside its own scope
   (the drop state lives on the SAME origin) nor `cache:"no-store"`
   requests — both bypasses live at the top of the fetch handler.
13. Drop pin coupling: putzii-drop executes `share.js`/`model.js`/
   `helpers.js` (+ `dropcrypto.js` parity) at a PINNED commit. Any change
   to these files ends with `dropii pin --ref <sha>` in the SAME unit of
   work. A stale runner refuses envelopes with wire slots it doesn't know
   (fatal `wire-unknown-slots` — never silently strips them), and the
   drop's daily `driftcheck` workflow tests against putzii@main.

## Dev loop

```bash
python3 -m http.server 8080   # local dev
```

- Verify = `await PZ.selfCheck.run()` in the browser console → `{ok: true}`.
- **SW cache trap** (from db-wallet): after editing a file, the re-registering
  SW can re-cache the STALE copy via the browser HTTP cache. db-wallet's
  `fetch(file, {cache:"reload"})` workaround was not usable here while CSP
  was `connect-src 'none'` (verified 2026-08-19; since v2 'self' would allow
  it, but the robust fixes below remain the convention). Fix: hard reload
  (Cmd+Shift+R), serve on a fresh port, or DevTools "Disable cache". Plain
  Cmd+R serves stale CSS/JS from the heuristic HTTP cache even without a SW.
- Native dialogs (`alert`/`confirm`) freeze automation — the app never uses
  them; keep it that way.
- No sitemap.xml on purpose: the app is `noindex` (robots meta is what works
  on a project subpath; robots.txt is inert there).

## Conventions

- SPDX header `GPL-3.0-or-later` in every source file (not in vendored
  `qrcodegen.js` — MIT, keep its header intact).
- Namespace: one `window.PZ` root, IIFE modules, lazy `PZ.x` lookups at call
  time — only init order is load-bearing (script order in the HTML).
- Commits/comments English; UI copy German.
