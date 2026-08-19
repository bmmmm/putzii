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
| `share.js` | Wire codec (`#p1.` fragment), adaptive event cap, `mergePlans` — the heart |
| `store.js` | Plan docs in localStorage, event minting, atomic append + rollback |
| `model.js` | Pure due/status/history logic (everything takes `nowMs`) |
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
5. The fragment never reaches a server; no external requests at all
   (CSP `connect-src 'none'`). Never add a CDN/font/analytics reference.
6. Share URL budget 1800 chars (Signal). The UI must always show honest
   counts ("Teilt X von Y Einträgen") when history is capped.
7. Any APP_SHELL asset change requires a `VERSION` bump in
   `service-worker.js` — `scripts/check-sw-version.sh` / CI `sw-version`
   enforce it, including the "every page asset is in APP_SHELL" cross-check.
8. All registries are `Object.create(null)`/`Map` — `__proto__` ids must not
   pollute prototypes (self-check asserts it).

## Dev loop

```bash
python3 -m http.server 8080   # local dev
```

- Verify = `await PZ.selfCheck.run()` in the browser console → `{ok: true}`.
- **SW cache trap** (from db-wallet): after editing a file, the re-registering
  SW can re-cache the STALE copy via the browser HTTP cache. db-wallet's
  `fetch(file, {cache:"reload"})` workaround does NOT work here — CSP
  `connect-src 'none'` blocks page-context fetch (verified 2026-08-19). Fix:
  hard reload (Cmd+Shift+R), serve on a fresh port, or DevTools "Disable
  cache". Plain Cmd+R serves stale CSS/JS from the heuristic HTTP cache even
  without a SW.
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
