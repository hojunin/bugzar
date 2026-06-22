# `@bugzar/viewer` — milestone design & implementation plan

**Spec:** [2026-06-18-replay-viewer-design.md](../specs/2026-06-18-replay-viewer-design.md)
**Process:** designs + test code for ALL milestones written FIRST (empty-shell
files + behavior-red tests); 3-reviewer unanimous gate; implement LAST.

## Package layout

```
packages/viewer/
  package.json          @bugzar/viewer (private)
  index.html            #root + module script
  vite.config.ts        react plugin, port 5373
  vitest.config.ts      happy-dom env
  tsconfig.json
  src/
    main.tsx            createRoot → <App/>
    App.tsx             params → load → render state machine
    report/
      params.ts         parseReportParams(search) → ReportParams | ParamsError
      schema-version.ts checkSchemaVersion(reported) → 'ok'|'older'|'newer'|'unknown'
      load-report.ts    loadReport(params) → Promise<ReportLoad>   (parallel, partial-tolerant)
      mode.ts           reportMode(data) → 'session' | 'design'
      types.ts          ReportData, ReportLoad, ReportParams, AssetName, DesignElement
    design/
      DesignView.tsx    design-report view: imageless annotation cards (selector·tag·component·note)
    player/
      Player.tsx        wraps rrweb `Replayer` (mounts into a ref); props {events, onTime, seekRef}
      Controls.tsx      thin control bar: play/pause · scrubber(+markers) · speed · skip-inactive
      use-replayer.ts   Replayer lifecycle + rAF clock → current time
    panels/
      filters.ts        pure: searchConsole/searchNetwork/…  + matchesQuery
      timeline.ts       pure: activeIndex / isFuture / snapshotAt / barGeometry
      markers.ts        pure: errorMarkers(report) / nextErrorTime / prevErrorTime (VM10)
      ConsolePanel.tsx  NetworkPanel.tsx  StoragePanel.tsx  ResourcesPanel.tsx  StatePanel.tsx
      tabs.ts           pure: visibleTabs(report) → Tab[]   (State tab gated on data)
    ui/
      MetaHeader.tsx  Tabs.tsx  SearchBox.tsx
      states.tsx      <Loading/> <LoadError/> <VersionMismatch/> <NeedParams/>
    styles.ts         injected CSS (dark theme, bugzarv- prefix)
  src/__tests__/        (red contract tests — see per-VM plan)
```

Deps: `react`, `react-dom`, `rrweb` (the `Replayer`; already a workspace dep at
2.0.0-alpha.20), `@bugzar/shared` (workspace). Dev: `vite`, `@vitejs/plugin-react`,
`vitest`, `@testing-library/react`, `happy-dom`, `typescript`, `@types/react(-dom)`.

## Data model (`report/types.ts`)

```ts
import type {
  ConsoleEntry, NetworkEntryPayload, StorageSnapshotPayload,
  ResourceTimingEntry, StateSnapshot, SessionMeta, WebVitals, RrwebEvent,
} from '@bugzar/shared';

export type AssetName =
  | 'meta' | 'events' | 'console' | 'network' | 'storage' | 'resources' | 'state' | 'vitals' | 'design';

export type ReportMode = 'session' | 'design';
export interface DesignElement {
  selector: string; tagName: string; textContent: string; cssClasses: string;
  rect: { x: number; y: number; width: number; height: number };
  componentName?: string; userNote: string;   // SDK maps note → userNote on upload
}

export interface ReportParams { endpoint: string; id: string; }     // normalized (no trailing /)
export type ParamsError = { error: 'missing-endpoint' | 'missing-id' };

/** Meta as uploaded by the SDK: SessionMeta + the stamped contract version. */
export type ReportMeta = SessionMeta & { schemaVersion?: number; mode?: string; source?: string };

export interface ReportData {
  meta: ReportMeta | null;
  events: RrwebEvent[];
  console: ConsoleEntry[];
  network: NetworkEntryPayload[];
  storage: StorageSnapshotPayload[];
  resources: ResourceTimingEntry[];
  state: StateSnapshot[];
  vitals: WebVitals;
  design: DesignElement[];   // design-mode annotations (empty for a session report)
}

export interface ReportLoad {
  data: ReportData;
  /** which assets failed to load (404/parse) — panel shows empty, view still renders */
  failed: AssetName[];
  version: 'ok' | 'older' | 'newer' | 'unknown';
}
```

All entries already share a `tFromStart` (console/network/storage/state) or
`startTime` (resources); the player maps `0…meta.durationMs`. Absolute time =
`meta.startedAt + tFromStart`.

---

## Milestones (design + test contract). Implement LAST, in this order.

### VM1 — Schema-version contract  *(spans @bugzar/shared + SDK + viewer)*
- `@bugzar/shared`: `export const SCHEMA_VERSION = 1;`
- SDK **both upload paths** stamp it (design reports are versioned too):
  `uploadBundle`'s `meta` gains `schemaVersion`; `uploadDesign`'s meta becomes
  `{ url, mode: 'design', source: 'sdk', schemaVersion }`. `uploadDesign` runs in
  the browser, so `url` is read from `location.href` at upload time (no signature
  change) — giving the design view a captured URL to show.
- viewer `schema-version.ts`: `checkSchemaVersion(reported: number | undefined)`
  → `reported === SCHEMA_VERSION ? 'ok' : reported == null ? 'unknown' : reported < SCHEMA_VERSION ? 'older' : 'newer'`.
- **Tests:** viewer `schema-version.test.ts` (4 cases). SDK `schema-version.test.ts`
  asserts BOTH `uploadBundle` and `uploadDesign` PUT a `meta.json` with
  `schemaVersion === SCHEMA_VERSION`.

### VM2 — Scaffold + data layer
- `params.ts`: `parseReportParams(search)` → strips trailing `/` from endpoint;
  returns `ParamsError` when either is missing.
- `load-report.ts`: `loadReport({endpoint,id})` fetches the 8 assets in parallel
  from `${endpoint}/reports/${id}/<name>.json`; each rejection/parse-fail →
  push to `failed`, default that slot (`[]` / `{}` / `null`); reads
  `meta.schemaVersion` → `checkSchemaVersion`.
- `App.tsx` state machine: no-params → `<NeedParams/>`; loading → `<Loading/>`;
  **wholesale failure** (every slot failed, i.e. `failed.length === ASSET_NAMES.length`
  — bad endpoint/id) → `<LoadError/>`; version `older`/`newer` → `<VersionMismatch/>`;
  else → main view. NOTE: a valid **design** report legitimately 404s its ~7
  session slots — that is NOT wholesale failure (meta + design loaded), so it
  routes to the design view, not LoadError. `reportMode` then picks the view.
- **Tests:** `params.test.ts` (missing/normalize); `load-report.test.ts` (mock
  fetch: all-ok; one 404 tolerated; bad endpoint → all failed; version surfaced);
  `App.test.tsx` (each state renders).

### VM3 — Player (raw `Replayer` + custom controls)
- `use-replayer.ts`: `new Replayer(events, { root, skipInactive, mouseTail:false })`;
  a rAF loop reads `getCurrentTime()` while playing → `onTime(ms)`; exposes
  `play(offset?)` / `pause()` / `seek(ms)` (= `pause(ms)` or `play(ms)`) /
  `getMetaData()`. Teardown (`replayer.destroy()`) on unmount.
- **Guard:** `Replayer` throws for `events.length < 2`. `Player` renders the empty
  state (no construction) when `events.length < 2` — short/aborted recordings and
  a missing `events.json` degrade gracefully; the sidebar panels still render.
- `Controls.tsx`: play/pause toggle, a scrubber `<input range>` (0…totalTime)
  with markers as positioned overlay ticks (VM10 fills the ticks), speed
  (1/2/4/8×, `setConfig({speed})`), skip-inactive toggle.
- `Player.tsx`: composes the above; empty `events` → "No DOM events recorded".
- **Tests:** `Player.test.tsx` (empty state for 0 and for <2 events with NO
  construction; constructs the Replayer for ≥2 events) — `rrweb`'s `Replayer`
  mocked via `vi.mock`, mock includes `destroy()`. App-level component tests that
  render `<Player>` also mock `rrweb` so they never hit the real Replayer.

### VM4 — Console panel
- rows: `level` badge · joined `args` · `tFromStart`; `error` → accent row;
  `stack` expandable. Search filters joined args (case-insensitive).
- **Tests:** `filters.test.ts::searchConsole`; `ConsolePanel.test.tsx` (error
  highlight, search narrows rows, count badge).

### VM5 — Network panel
- rows: `method` · `url` · `status` · `durationMs`; `status>=400 || error` →
  accent. Row-expand: request/response headers + body (already masked). Search
  matches method/url/status.
- **Tests:** `filters.test.ts::searchNetwork`; `NetworkPanel.test.tsx` (≥400
  highlight, expand shows body, search).

### VM6 — Storage panel
- snapshot picker = the `StorageSnapshotPayload` at/just-before the playhead
  (`timeline.ts::snapshotAt`); renders local/session/cookies key→value.
- **Tests:** `timeline.test.ts::snapshotAt` (picks ≤ t, none → first/empty);
  `StoragePanel.test.tsx` (renders selected snapshot).

### VM7 — Resources panel (M5)
- waterfall: one bar per `ResourceTimingEntry`, x/width from
  `startTime`/`duration` scaled to panel; columns name·type·size·protocol.
- `timeline.ts::barGeometry(entry, scale)` pure.
- **Tests:** `timeline.test.ts::barGeometry`; `ResourcesPanel.test.tsx` (renders
  bars, columns).

### VM8 — State panel (M6, conditional)
- `tabs.ts::visibleTabs(report)` includes `state` ONLY when `state.length > 0`.
- panel: snapshot picker (like storage) → JSON tree of `data`.
- **Tests:** `tabs.test.ts` (state hidden when empty, shown when present);
  `StatePanel.test.tsx` (renders tree of a snapshot).

### VM9 — Report mode + Design view
- `mode.ts::reportMode(data)` → `'design'` when `meta.mode === 'design'` (fallback:
  `design.length > 0 && events.length === 0`), else `'session'`.
- `load-report.ts` also fetches `design.json` → `data.design: DesignElement[]`
  (`ASSET_NAMES` includes `design`; conformance-guarded by `assets.test.ts`).
- `DesignView.tsx`: a card per element — selector (monospace) · tag · `componentName`
  (when present) · `userNote`. No player/timeline. `App` routes design reports here
  instead of the player+sidebar.
- **Tests:** `mode.test.ts` (session/design/fallback/default); `DesignView.test.tsx`
  (card per element with selector + note + component); `App.test.tsx` design-report
  case renders the cards.

### VM10 — Timeline sync  *(band is v2 — NOT here)*
- `timeline.ts::activeIndex(entries, t)` = last entry with `tFromStart <= t`;
  `isFuture(entry, t)` dims future rows; current row emphasized + auto-scrolled.
- click row → `seek(tFromStart)`. Player `onTime` drives highlight.
- **Tests:** `timeline.test.ts::activeIndex`/`isFuture` (boundaries: t=0, exact,
  past-end); click→seek wiring in a panel test.

### VM11 — Scrubber markers + jump-to-error  *(the raw-Replayer payoff)*
- `markers.ts::errorMarkers(report)` → sorted `{ t, kind: 'console'|'network' }[]`
  from console `level==='error'` + network `status>=400 || error`.
- `markers.ts::nextErrorTime(markers, t)` / `prevErrorTime(markers, t)` → the next
  / previous marker time (or null at the ends).
- `Controls.tsx` overlays a tick per marker on the scrubber (x from
  `t/totalTime`); prev/next-error buttons `seek` to those times.
- **Tests:** `markers.test.ts` (errorMarkers selection + ordering;
  next/prevErrorTime boundaries incl. exact-on-marker and past-last); marker tick
  x-position; prev/next seek wiring.

### VM12 — Deploy + README
- `vite build` → `dist`. README: `?endpoint=&id=` usage + `wrangler pages deploy
  dist`. Note CORS already `*`; reports are public-by-URL.
- **Verify:** `pnpm --filter @bugzar/viewer build` succeeds; `assets.test.ts`
  conformance (ASSET_NAMES = the captured data slots, drift-guarded).

### VM13 — e2e smoke  *(browser; written + run during implementation)*
- `@playwright/test` in the viewer package; two committed fixture reports under
  `e2e/fixture/reports/<id>/…` served by `vite preview`: a **session** report
  (`{meta,events,console,network,…}.json` — an error console entry + a 500 network
  row + minimal valid rrweb events) and a **design** report (`{meta(mode:design),
  design}.json` — a couple of annotated elements).
- Spec `e2e/viewer.spec.ts`: for the session id, assert (a) the replay iframe
  mounts, (b) the Console tab shows the error, (c) the Network tab shows the failed
  request, (d) a scrubber error marker is present; for the design id, assert the
  annotation cards (selector + note) render.
- The deployed Worker report (e.g. `…workers.dev` + a real id) is the manual
  fallback for ad-hoc checks.
- **Why implement-last:** an e2e needs the real viewer; it is the final gate that
  the whole pipeline (SDK upload → R2 → viewer render) works end to end.

---

## Gate (after all designs + tests are written, before implementation)

3 reviewers, distinct lenses — **(a) contract fidelity** (do tests match the
spec + the real `@bugzar/shared`/SDK shapes?), **(b) feasibility** (can the shells be
implemented as specified? rrweb-player API, CORS, happy-dom?), **(c) UX/scope**
(is v1 coherent; is anything missing or over-built?). Cross-vote; a finding blocks
ONLY if all 3 agree; loop until none remain.

## Loop protocol (implementation, last)

Per milestone: implement the shell → `pnpm --filter @bugzar/viewer typecheck` +
`vitest run <files>` green → atomic commit. After VM1–VM10 green: `pnpm -r test`
(no regression, incl. the SDK `meta.schemaVersion` change) + `vite build` + a
real-browser smoke against the deployed Worker report used earlier.

## Constraints

- VM1 touches `@bugzar/shared` (+1 const) and the SDK `uploadBundle` (+1 meta field)
  — both additive, no Worker change. Don't regress existing SDK tests.
- No react-flow; timeline band + SDK reportUrl rewiring are v2.
- Match repo conventions: workspace deps, biome, vitest+happy-dom, `bugzarv-` CSS
  prefix (avoid clashing with the host-less viewer's own page).
