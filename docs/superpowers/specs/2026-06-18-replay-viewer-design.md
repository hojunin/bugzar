# Replay Viewer (`@bugzar/viewer`) — design spec

**Date:** 2026-06-18 · **Status:** draft (awaiting spec-review gate)
**Process:** full gate — this spec + per-milestone designs + test code are written
FIRST; implementation is LAST; each phase passes only on a unanimous 3-reviewer
gate. (Same process as the M4–M6 SDK work.)

## 1. Problem & goal

The SDK uploads a full QA bundle to the Worker — rrweb DOM events **plus**
console, network, storage, vitals, resources (M5), and app-state (M6) — and every
slice is stored in R2 as a separate JSON asset. But the page the SDK generates at
`<endpoint>/r/<id>` ([replay-html.ts](../../../packages/sdk/src/replay-html.ts))
only loads `events.json` and plays the rrweb DOM replay. **The console / network /
storage / resources / state data is captured and stored but never shown** — there
is no DevTools-like view.

**Goal:** a standalone web app that, given a report, reads all of its JSON assets
and renders a DevTools-style viewer — rrweb replay on the left, inspectable data
panels on the right — synced to the replay timeline.

**Key principle (data ⊥ viewer):** the viewer is a separate, independently
deployed static app. It owns no data; it reads a report's assets over HTTP and
renders them. Any Worker that serves the `/reports/:id/*.json` contract can be
viewed.

## 2. Architecture

```
┌────────────────────────────┐   GET *.json (CORS *)   ┌──────────────────────────┐
│  @bugzar/viewer (static SPA)    │ ───────────────────────▶│  any bugzar-backend Worker   │
│  Cloudflare Pages            │                         │  R2: events/console/...   │
│  reads + renders, no backend │ ◀───────────────────────│  /reports/:id/*.json      │
└────────────────────────────┘                         └──────────────────────────┘
```

The Worker already returns `Access-Control-Allow-Origin: *`, so the viewer (a
different origin than the Worker) fetches assets cross-origin with no extra setup.

## 3. Stack & package

- New workspace package **`packages/viewer`** (`@bugzar/viewer`, private).
- **React + Vite** static SPA (matches the SDK/example stack). No SSR, no backend.
- Reuses canonical capture types from **`@bugzar/shared`** (`ConsoleEntry`,
  `NetworkEntryPayload`, `StorageSnapshotPayload`, `ResourceTimingEntry`,
  `StateSnapshot`, `SessionMeta`, `WebVitals`, `RrwebEvent`) — single source of
  truth, no re-declaration.
- **`rrweb`'s `Replayer`** directly (not `rrweb-player`). The player widget only
  adds a fixed control bar; we want to **own the timeline** so the scrubber can
  carry event markers and a single playhead drives the panels (see §7). `rrweb`
  is already a workspace dep (capture-core records with it); using its `Replayer`
  avoids the `rrweb-player` Svelte runtime. We build a thin control bar
  (play/pause · scrubber · speed · skip-inactive) over `Replayer`'s
  `play(offset)` / `pause()` / `getCurrentTime()` / `getMetaData()` API + a rAF
  clock. `Replayer` **requires ≥2 events** (it throws otherwise), so the Player
  guards `events.length < 2` and renders the empty state instead of constructing
  it — covering short/aborted recordings and a missing `events.json`. The
  extension's `export-viewer.ts` is a **UX reference only** (vanilla,
  extension-coupled — not imported).

## 4. Input & data flow

The viewer locates a report from URL query params:

```
https://<viewer-host>/?endpoint=https://bugzar-backend.<sub>.workers.dev&id=<reportId>
```

- `endpoint` — the Worker base URL. `id` — the report id.
- On load it fetches, **in parallel**, from `<endpoint>/reports/<id>/`:
  `meta.json`, `events.json`, `console.json`, `network.json`, `storage.json`,
  `resources.json`, `state.json`, `design.json`.
- **Two report modes.** The SDK produces either a recorded **session** (rrweb +
  data slots) or a **design** report (Pick/click annotations → `design.json`, no
  rrweb). The viewer picks the mode from `meta.mode === 'design'` (fallback:
  annotations present + no events) and renders the matching view (§5). The
  irrelevant slots simply 404 and are ignored.
- Each asset is **independently optional**: a `404`/parse failure for one slot
  degrades that panel to empty, it does NOT fail the whole view. `events.json` is
  the one "primary" asset — if it is missing, the replay pane shows an empty
  state but the data panels still render.
- **States:** missing `endpoint`/`id` → a short "how to open a report" message;
  loading → skeleton; total fetch failure (e.g. bad endpoint) → an error with the
  attempted URL; partial → render what loaded.

### Schema version (data ⊥ viewer must stay aligned)

The capture schema can evolve, so the data carries an explicit version and the
viewer refuses to silently mis-render an incompatible report.

- A single **`SCHEMA_VERSION`** constant lives in **`@bugzar/shared`** — the one
  source of truth shared by producer and consumer.
- The **SDK** stamps it into the uploaded `meta.json` as `schemaVersion`
  (`uploadBundle` already writes `meta` with `mode`/`source`; this adds one
  field). No Worker change — the Worker just stores it.
- The **viewer** imports `SCHEMA_VERSION` and compares it to the report's
  `meta.schemaVersion`:
  - equal → render normally;
  - report older / newer than the viewer supports → a clear **version-mismatch**
    state ("captured with schema vX; this viewer supports vY") instead of a
    broken render. (Compatibility policy: exact-major match for v1; widen later.)
- So the three versions the user called out stay in lockstep: SDK app ↔
  `meta.schemaVersion` in R2 ↔ viewer renderer, all keyed off the shared constant.

## 5. Layout & UI

Left rrweb player + right sidebar tabs, with a synced timeline band beneath the
player (the at-a-glance "한눈에" layer):

```
┌──────────────────────────────────────────────────────────┐
│  meta header: url · captured-at · duration · viewport      │
├────────────────────────────────┬─────────────────────────┤
│                                │ Console(2) Network(3) ... │  ← tabs + count badges
│        rrweb replay            ├─────────────────────────┤
│        (DOM player)            │ [ search ]                │
│                                │ ┌─────────────────────┐  │
│                                │ │ entry rows          │  │
│  ▶ ──────●─────────── 0:15     │ │ (level/status/...)  │  │
├────────────────────────────────┤ └─────────────────────┘  │
│ timeline band (lanes) — v2:    │                          │
│  console ▮  ▮▮     ▮            │                          │
│  network    ▮▮▮       ▮  ▮      │                          │
└────────────────────────────────┴─────────────────────────┘
```

> The bottom **timeline band is deferred to v2** (see §7). v1 ships
> player + sidebar + in-panel timeline sync.

- **Theme:** dark, matching the existing slim replay page palette
  (`#18181b` / `#e4e4e7`). Responsive: on narrow widths the sidebar collapses
  under the player.
- **meta header:** `meta.url`, captured-at (`startedAt`), `durationMs`, viewport;
  optional small vitals chips (LCP/CLS/INP/TTFB) — **no dedicated Vitals panel**.

### Design-mode view

A **design report** replaces the player+sidebar with a **DesignView**: an
imageless card per annotated element from `design.json` — selector (monospace),
tag, React `componentName` (when present), and the reviewer's `userNote`. (Same
content the SDK's review drawer + the extension's design-viewer show; UX
reference only.) No player, no timeline — design reports carry no rrweb. The meta
header still shows the captured URL.

## 6. Panels

Tabs render with a **count badge**. Each row carries a timestamp derived from
`tFromStart`. A shared **search box** filters the active tab. Each panel's
data-shaping (filter, sort, display-mapping) is **pure and unit-tested**; the
rendering is component-tested with `@testing-library/react`.

| Tab | Source | Shown | Notes |
|-----|--------|-------|-------|
| **Console** (core) | `console.json` | level · message · `tFromStart` · stack (expand) | `level === 'error'` rows highlighted. |
| **Network** (core) | `network.json` | method · url · status · durationMs; row → request/response headers + body | `status >= 400` (and `error`) highlighted. Bodies already masked at capture. |
| **Storage** (core) | `storage.json` | per-snapshot local/session/cookies key→value | Snapshots are point-in-time; selector to pick the snapshot at/just-before the playhead. |
| **Resources** (M5) | `resources.json` | name · initiatorType · duration · transferSize · nextHopProtocol | A simple waterfall (bars by `startTime`/`duration`). Always present. |
| **State** (M6) | `state.json` | `tFromStart` → JSON tree of the dehydrated snapshot | **Conditional tab:** only rendered when `state.json` has ≥1 entry (state is opt-in via the host's `captureState`, e.g. `tanstackQueryState`). |

## 7. Timeline sync & timeline band

- The rrweb player exposes the current playhead time. Absolute time of an entry =
  `meta.startedAt + entry.tFromStart`; the player timeline is `0…durationMs`.
- **Highlight:** entries at/just-before the current playhead are emphasized in
  their panel; entries in the "future" are dimmed.
- **Click-to-seek:** clicking an entry seeks the player to that entry's time.
- **Scrubber event markers (v1 — needs the raw `Replayer`):** the control bar's
  scrubber renders ticks for notable moments — console **errors** and **failed
  requests** (`status>=400`/`error`) — positioned by time, so "when did it break"
  is visible at a glance. (Not possible with `rrweb-player`'s fixed scrubber.)
- **Jump-to-error (v1):** prev/next-error controls seek the player to the
  previous/next error marker, for fast triage.
- **Timeline band — DEFERRED to v2** (the "한눈에" overview): horizontal lanes
  (console / network / storage / resources) with a dot/tick per event positioned
  by time; a moving playhead cursor; hover-preview; click-seek. Pure SVG/canvas —
  **no react-flow** (rejected: poor fit for 100s–1000s of time-ordered events, and
  causal edges are not captured, only inferable). v1 ships the in-panel sync above;
  the band is the first v2 addition.

## 8. Deploy

- `pnpm --filter @bugzar/viewer build` → static `dist/`.
- **Cloudflare Pages**: `wrangler pages deploy dist` (or Pages Git integration).
  No Worker, no server code. Documented in the package README.
- CORS already permits the Pages origin (`Allow-Origin: *`).

## 9. Milestones (gate process — spec/design/tests first, implement LAST)

| # | Milestone | Verify |
|---|-----------|--------|
| **VM1** | Schema-version contract (`SCHEMA_VERSION` in `@bugzar/shared`; SDK `uploadBundle` stamps `meta.schemaVersion`; viewer compat-check helper) | match → ok, older/newer → mismatch; SDK upload-test asserts the stamped field |
| **VM2** | Scaffold + data layer (Vite/React pkg, query parse, parallel asset fetch, loading/error/partial/**version-mismatch** states, meta header) | parse + fetch-orchestration unit tests; states render-test |
| **VM3** | Player pane — wrap `rrweb` `Replayer` + thin control bar (play/pause, scrubber, speed, skip-inactive); expose play/seek/current-time | mounts with events; empty-state when no events; control actions drive the replayer |
| **VM4** | Console panel (rows, error highlight, search) | filter/format pure tests; renders mock console |
| **VM5** | Network panel (rows, ≥400 highlight, detail expand, search) | filter/format pure tests; renders mock network |
| **VM6** | Storage panel (snapshot picker, key/value) | snapshot-at-time selection pure test |
| **VM7** | Resources panel (M5 waterfall) | bar-geometry pure test; renders mock resources |
| **VM8** | State panel (M6, conditional tab) | tab hidden when `state` empty, shown + tree when present |
| **VM9** | **Report mode + Design view** (detect session vs design; render annotation cards for design reports) | `reportMode` pure test (session/design/fallback); DesignView renders a card per element (selector + userNote + component) |
| **VM10** | Timeline sync (highlight + click-seek; **no band — that's v2**) | "active entries at time T" pure test; seek wiring |
| **VM11** | Scrubber markers + jump-to-error (errors + failed requests as ticks; prev/next-error seek) | marker-position pure test; `nextErrorTime(markers, t)` / `prevErrorTime`; seek wiring |
| **VM12** | Deploy config + README (Pages) | `vite build` succeeds; README documents deploy + `?endpoint=&id=` |
| **VM13** | **e2e smoke** (browser, implement-last) | session fixture → replay iframe + Console/Network panels render; design fixture → annotation cards render |

**e2e (must pass at the end):** beyond the unit suite, a real-browser e2e drives
the built viewer against a served report and asserts the player + data panels
render. Approach: `@playwright/test` (added to the viewer package), serving a
committed fixture report (`e2e/fixture/reports/<id>/*.json`) via `vite preview`
so the run is deterministic + CI-able; the live deployed Worker report is the
manual fallback. Written + run during implementation (it needs the real viewer).

## 10. Constraints & out of scope

- **No backend changes** — the Worker contract (`/reports/:id/*.json`, CORS `*`)
  is reused as-is. (The schema version is stamped by the SDK into `meta`; the
  Worker only stores it.)
- **No new capture** — the viewer only reads existing assets; it adds no data.
- **Out of scope (v2 / follow-on):** the bottom **timeline band** (§7); pointing
  the SDK's `reportUrl` / "View replay" at this viewer; auth/access control on
  reports (today reports are public-by-URL); a dedicated Vitals panel; the
  per-error causal mini-graph (react-flow) idea.

## 11. Spec-review resolutions (2026-06-18)

1. **Timeline band → deferred to v2.** v1 = player + sidebar + in-panel sync.
2. **Input model = `?endpoint=&id=` query params, plus an explicit schema
   version** carried in the data (`meta.schemaVersion`, keyed off
   `@bugzar/shared` `SCHEMA_VERSION`) so SDK ↔ uploaded JSON ↔ viewer stay aligned
   (§4 "Schema version"). The viewer shows a version-mismatch state rather than
   mis-rendering.
3. **Display redaction = rely on capture-time masking.** The SDK already masks
   credential headers / JWTs / sensitive keys before upload; the viewer renders
   as-is (no second redaction pass).
