# putzii — Agent Guide

Cleaning-schedule PWA: vanilla HTML/CSS/JS, no build step, no dependencies
(qrcodegen.js is vendored), plus an OPTIONAL self-hosted Go server in
`server/` that serves the very same app files. UI German, code English.

The app works with no server at all — `#p1.` links stay the full offline
path. The server is a peer that never sleeps, not a source of truth for the
link path. It replaced the retired `bmmmm/putzii-drop` relay (GitHub Actions
+ Pages); the why, and what was built differently, is in
`docs/rebuild-plan.md`.

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
| `dropcrypto.js` | AES-256-GCM state crypto — core line-identical with `server/internal/dropcrypto` (CI-pinned by three-way vectors) |
| `drop.js` | `#d2.` credential links, `#k2.` confirm links (no encKey, check-in scoped token), per-plan cred storage, API URL builders |
| `sync.js` | Server sync state machine (off/idle/…/queued/error), injectable `_fetch`/`_now` seams |
| `server/` | Go server + admin CLI — see `server/README.md` |
| `ui-weeks.js` | Wochen tab: endless KW list, day-cell strip, inline slot editor (index-only) |
| `ui-checkin.js` + `c.html` | QR check-in mini page incl. cold path (no plan on device) + `#k2.` confirm page (server-minted, no local plan) |
| `app.js` | index boot: hash classify, merge-on-open, pending banner |
| `router.js` | Hash prefixes: `p1./p1u.` share, `c1.<planId>.<areaId>` check-in, `d2.`/`k2.` server links, `d1.`/`k1.` → `legacy`, routes |
| `self-check.js` | In-browser suite: `await PZ.selfCheck.run()` in the console |

## Invariants — do not break

1. Events are append-only: union by id, **first-seen-wins** — a link can add
   history, never rewrite it. Undo = local hard-delete pre-share only.
2. Config (areas/people) merges LWW by **strict** `updatedAt >`; ties keep
   local. `createdAt` takes the minimum. Soft-delete via `deletedAt`.
3. Event `ts` is minute-quantized at creation (wire round-trip lossless).
4. Event ids are `<deviceKey>.<seq-base36>` — compare seq NUMERICALLY
   (`cmpEventId`), lexical compare breaks at base36 width boundaries.
5. The `#p1.`/`#c1.`/`#d2.` fragment never reaches a server. CSP is
   `connect-src 'self'` — the app talks ONLY to the origin that served it,
   which is why `drop.js` DERIVES the API base from `location` instead of
   carrying it in the link. Never widen it; never add a CDN/font/analytics
   reference. Consequence, on purpose: server sync works only on the copy the
   household's own server serves; the GitHub Pages copy stays the offline
   (`#p1.`) app.
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
11. Server sync: a pull that merges remote data NEVER sets dirty (two clients
   would ping-pong). `markDirty` lives at USER mutation callsites
   (saveAndRefresh, saveDays, confirmCheckin) — never inside
   savePlan/saveWeek. Writes are synchronous: the PUT response IS the
   confirmation, and dirty clears only if no mutation arrived after the push
   started (`dirtySince <= pushedAt`). A `replay:true` answer confirms an
   EARLIER attempt, not the current content — it re-pushes with a fresh
   nonce instead of clearing dirty.
12. The service worker must never answer requests outside its own scope, nor
   anything under `<scope>api/`, nor `cache:"no-store"` requests — all three
   bypasses live at the top of the fetch handler. The API is same-origin, so
   a cache-first hit would freeze the plan state forever.
13. The server OVERWRITES rather than merges, which is only safe while the
   event log is append-only. So: `sync.js` pushes the FULL plan and never
   shrinks to fit (the 64 kB budget is a refusal threshold, not a target),
   and the server refuses a push that lost events (`events-dropped`).
   Conflicts come back as 409 + current rev and are resolved CLIENT-side —
   pull, `mergePlans`, push again. That is why the merge stays in `share.js`.
14. App↔Go parity is a BUILD property, not a pinned commit: CI regenerates
   every golden file (crypto vectors both directions, the wire canonical
   envelope, the exact payload `sync.js` PUTs, and the check-in semantics
   from `model.existsRecent`) from the working tree and asserts Go against
   them. A wire change without its Go counterpart goes red in the same push.
   An envelope with MORE slots than the binary knows is fatal
   (`wire-unknown-slots`), never silently stripped.

## Dev loop

```bash
python3 -m http.server 8080                       # app only (link path)
# with sync — the server serves these same files:
go build -C server -o /tmp/putzii-server ./cmd/putzii-server
/tmp/putzii-server plan init --app-base http://localhost:8080
/tmp/putzii-server serve --app . --listen :8080
```

- Verify = `await PZ.selfCheck.run()` in the browser console → `{ok: true}`,
  or headless: `node server/tools/selfcheck.mjs .` (what CI runs; it stubs
  storage + `location`, so DOM-only sections skip themselves).
- Server side: `go test ./...` in `server/`. Run both under `TZ=UTC` too —
  Sunday 22:30 UTC is already Monday in Berlin, i.e. the NEXT ISO week.
- **httptest.NewServer does not work in a sandboxed session** (no listen
  sockets). The API suite drives the handler through `httptest.NewRecorder`
  instead — keep it that way, it is hermetic in CI as well.
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
