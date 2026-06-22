# Bugzar Embeddable SDK — Design Spec

- **Date:** 2026-06-17
- **Status:** M1–M3 implemented & verified on `feat/embeddable-sdk` → planning M4–M6.
- **Branch:** `feat/embeddable-sdk`
- **Reference:** [agentation](https://github.com/benjitaylor/agentation) — install/mount/build model is mirrored.

## Problem / Goal

Today Bugzar ships only as a Chrome MV3 extension. Make the capture + report
capability **installable as an npm package** that any React frontend drops in as
`<Bugzar />`, mirroring agentation's developer experience. The extension stays
unchanged — this is a **dual target from one monorepo**, not a rewrite.

## Why this is feasible (investigation findings)

- The capture engine (`extension/src/host/*`: rrweb, console, network, storage,
  vitals) has **zero `chrome.*` calls** — pure DOM/window instrumentation.
- The backend wire contract is **100% HTTP/JSON** — client-agnostic.
- Most extension complexity exists *because it is an extension* (offscreen doc,
  service worker, content↔SW bridge). In a single-page SDK that plumbing
  **collapses** rather than being ported.

## Decisions (locked)

| Topic | Decision |
|---|---|
| Framework | **React only** (peer dep), like agentation. `<Bugzar/>`. |
| Output model | **Callbacks-first + optional `endpoint`.** Default `onSubmit(bundle)`; `endpoint` → Worker upload (M2+). |
| Distribution | npm package via **tsup** → ESM+CJS+dts, `external: [react, react-dom]`, `"use client"` banner, build-time style injection. |
| Video | **Dropped.** rrweb DOM replay substitutes; `tabCapture`/`offscreen` are not ported. |
| Auth / Jira | **Server-side** (M4). The browser SDK never holds Atlassian tokens. |
| Sequencing | **M1 vertical slice first.** |

## Architecture (target)

```
packages/
├─ capture-core/  [new, private]  extracted host/* — framework-agnostic, dep: rrweb
│                                  createRecorder() → ReportBundle
├─ sdk/           [new, publishable]  React <Bugzar/>, consumes capture-core, tsup build
├─ extension/     [behavior unchanged]  host/index.ts now consumes @bugzar/capture-core
└─ backend/       [unchanged in M1]   grows POST /publish + GET /jira/epics in M4
```

Only `packages/sdk` is published to npm; `capture-core` and `shared` are private
workspace packages bundled into the SDK dist by tsup.

## Data model

```ts
interface ReportBundle {
  events: eventWithTime[];          // rrweb
  console: ConsoleEntry[];
  network: NetworkEntryPayload[];
  storage: StorageSnapshotPayload[];
  vitals: WebVitals;
  meta: {
    url: string; userAgent: string;
    viewport: { width: number; height: number };
    startedAt: number; endedAt: number; durationMs: number;
  };
}
```

## Roadmap

| Milestone | Status | Content |
|---|---|---|
| **M1** | ✅ done | capture-core extraction + `packages/sdk` + `<Bugzar/>` + bug-mode record→stop→`onSubmit(bundle)` + demo SPA |
| **M2** | ✅ done | optional `endpoint` → Worker upload → shareable replay URL (slim viewer; backend serves rrweb-player same-origin under the `/r/:id` CSP) |
| **M3** | ✅ done | in-page design element picker → `onAnnotate(DesignAnnotation[])` (reused chrome-free selector core + React component-name detection; metadata-only) |
| **M4** | planned | Jira server-side publish + AI draft + richer UI parity (+ optional design-report endpoint upload, metadata-only design viewer) |
| **M5** | planned | Enhanced network capture — Service Worker + first-party server cooperation toward DevTools-Network fidelity (see *Enhanced network capture*) |
| **M6** | planned | App-state capture — TanStack Query / Redux / Zustand snapshot + timeline via `captureState` (see *App-state capture*) |

M4–M6 implementation plan + open forks: [`../plans/2026-06-17-sdk-m4-m6-plan.md`](../plans/2026-06-17-sdk-m4-m6-plan.md).

## M1 scope

**In:**
- `packages/capture-core`: relocate the 5 capture modules + their tests
  (behavior-invariant); add `createRecorder()` orchestrator returning an
  in-memory `ReportBundle`. Verify gate: extension suite **and** capture-core
  suite green.
- `packages/sdk`: tsup build (ESM+CJS+dts, peer-dep react, `"use client"`,
  SCSS→head style injection), publish-ready `package.json`.
- `<Bugzar/>`: floating FAB → `recorder.start()` → REC pill (timer) → stop →
  `recorder.stop()` → `onSubmit(bundle, meta)` + no-config fallback (download
  bundle JSON). `mask` default on. SSR-safe (guards on `document`).
- Demo Vite React app consuming `@bugzar/sdk` via workspace link.

**Out (later milestones):** design picker, endpoint upload, Jira, AI draft, rich
Tailwind/Radix UI, options/settings UI, telemetry.

## Public API (M1)

```tsx
<Bugzar
  onStart?={() => void}
  onStop?={(bundle: ReportBundle) => void}
  onSubmit?={(bundle: ReportBundle, meta: SessionMeta) => void}
  mask?={boolean}              // default true
  position?={'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'}
  theme?={'light' | 'dark' | 'auto'}
/>
```

Exports: `Bugzar`, `type ReportBundle`, `type ConsoleEntry`,
`type NetworkEntryPayload`, `type StorageSnapshotPayload`.

## Verification

- **capture-core:** moved vitest (console-patch, rrweb-recorder, storage-snapshot)
  green under happy-dom.
- **extension:** `pnpm --filter @bugzar/extension test` green (host rewired to
  `@bugzar/capture-core`).
- **sdk:** vitest + Testing Library — mount renders the FAB; start/stop yields a
  non-empty bundle (fake timers); `onSubmit` fires.
- **demo:** manual smoke — interact (clicks/console/fetch), stop, downloaded
  bundle has non-empty `events`/`console`/`network`.

## Tradeoffs / risks

- **Not zero-dep** (rrweb is the irreducible payload) — unlike agentation.
  **Measured core ≈ 117KB gzip** (rrweb-dominated, not SDK glue). The only real
  shrink lever is rrweb (record-only / lazy-load) — tracked, not in M4–M6. M5/M6
  helpers ship as separate subpath entries so the core doesn't grow.
- **Build-time style injection, not Shadow DOM** — mirrors agentation; revisit if
  CSS leakage appears in a real host.
- **M1 UI is minimal hand-rolled CSS**; rich popup parity is deferred (M4 fork:
  port Tailwind/Radix popup vs rebuild dependency-light).
- **Global double-patch**: a host app may also wrap `fetch`/`console`. The
  capture patches are idempotent and restore originals on stop; revisit ordering
  if conflicts surface in a real host.

## Capability parity & gaps vs the extension

The SDK is **not a perfect port** of the extension. The differences come from the
browser security boundary between an *extension* and an *in-page script*, not from
missing effort. Grouped by recoverability:

### ❌ Fundamentally lost (the in-page model cannot do it)

| Capability | Extension | SDK | Why unrecoverable |
|---|---|---|---|
| Universal capture | records *any* page in the browser (incl. sites you don't own) | only apps that mount `<Bugzar/>` | an in-page script only reaches its own page |
| Host-app crash | independent of the app → records white-screen / boot failure | part of the app → dies with it | content script at `document_start` vs being inside the app tree |
| Per-user Jira auth | `chrome.identity` → each QA logs in as themselves, reporter = real person, zero backend secrets | chrome.identity unavailable → server-side publish (usually a shared service account) | chrome.identity is extension-only |
| Zero-integration ubiquity | install once, works on every tab, app unchanged | per-app install/render required | flip side of "works in any app" |

### ⚠️ Degraded but recoverable with trade-offs

| Capability | Extension | SDK today | Recovery (cost) |
|---|---|---|---|
| Pixel video | `chrome.tabCapture` WebM (canvas/WebGL/`<video>`/cross-origin iframe/native UI) | rrweb DOM replay only | `getDisplayMedia()` (per-use prompt, whole screen) or rrweb canvas recording (heavy, imperfect) |
| Continuity across hard navigation | offscreen+SW survive full reloads / tab switches / popup close | one page context — ends on full reload (SPA unaffected) | sessionStorage/IDB persist→resume (stitched) |
| Design pixel screenshots | `chrome.tabs.captureVisibleTab` pick-time PNG | M3 metadata-only (selector, rect, note) | html2canvas (+50KB, imperfect) or getDisplayMedia |
| Cross-origin iframe internals | content script per frame (`all_frames`) | own document + same-origin iframes only | impossible cross-origin (no script access) |

### ✅ Not actually lost (equivalent, or plumbing that disappears)

- The captured data itself — rrweb DOM, console, network, storage, vitals — is
  **identical** (`host/*` has zero `chrome.*`; that's what `@bugzar/capture-core` proves).
- Upload, replay, masking — identical (M2).
- `chrome.storage` / runtime messaging / `scripting` / `offscreen` / the 4-tier
  bridge — **unnecessary** in a single page context; not lost, just gone.

### rrweb is a DOM reconstruction, not video

The SDK keeps rrweb (which the extension also uses) and drops the pixel video the
extension layered on top. rrweb records the initial DOM snapshot + every mutation
and *rebuilds* the page in an iframe on replay — it looks and plays like video
(timeline, play/pause, 1×/2×/4×/8×) but cannot show what isn't in the readable
DOM: `<canvas>`/WebGL, `<video>` playback, cross-origin iframes (blank), some
native UI. For typical UI/layout/flow/state bugs rrweb is equal-or-better
(smaller, DOM/styles inspectable); only pixel-dependent content needs video.

## Enhanced network capture (research-backed) — M5

> **Scope decision (after review gate):** M5 is implemented as **Tier-1 Resource
> Timing only** (`PerformanceObserver('resource')` waterfall: timing, sizes,
> `deliveryType` cache, `nextHopProtocol`). The **Service Worker, NEL, and
> server-cooperation tiers are dropped** — the review verified a SW cannot
> passively read bodies (only `respondWith`-proxy, which breaks streaming/opaque),
> NEL is batched out-of-band with no request id, and the SW's marginal yield over
> Resource Timing does not justify its invasiveness. Those capabilities remain in
> the "requires an extension/CDP" residual wall below; the research is retained for
> the record.

Today both the extension *and* the SDK capture network via the same in-page
`fetch`/`XHR` monkeypatch (`host/network-patch.ts`) — neither is DevTools-level.
Deep research (30 sources, 25 adversarially-verified claims) found an in-page SDK
**can** approach Chrome DevTools Network fidelity for **first-party app↔own-API
traffic** using two levers — a **Service Worker** and **first-party server
cooperation**. The hard wall shrinks to *origins you don't control*.

### Per-item recovery

| Target (was "impossible") | Method | Assumes | Residual |
|---|---|---|---|
| Set-Cookie + real wire headers | server exposes wanted headers via `Access-Control-Expose-Headers`; echoes Set-Cookie to a request-id-keyed header/body or logs server-side & correlates | first-party server | third-party Set-Cookie stays forbidden |
| cross-origin (no-cors) body·headers | that origin sends CORS (`Access-Control-Allow-Origin`) → SW/JS can read | that origin cooperates | uncontrolled origin = opaque (status 0, no headers, null body); SW can't pierce it either |
| cross-origin size·detailed timing | server adds `Timing-Allow-Origin` → Resource Timing exposes size/timing/`nextHopProtocol` | that origin cooperates | no TAO → zeroed (foreign-fetch was removed/never shipped) |
| browser-initiated requests (img/css/font, navigations, sendBeacon) | **Service Worker `fetch` event intercepts all in-scope requests** (not just JS fetch); same-origin+CORS yields headers/status/body | SW registered | bodyless GETs = metadata only |
| accurate cache state | **`PerformanceResourceTiming.deliveryType`** (`'cache'` / `''` / `'navigational-prefetch'`) | — (Chromium/Safari) | Firefox lacks `deliveryType` |
| remote IP·protocol·phase | **NEL (Network Error Logging) + Reporting API** → first-party endpoint | server sends `NEL` header | metadata only (no bodies/headers); Chromium-only |

### Research corrections to earlier assumptions

- **`transferSize===0` is NOT a reliable cache signal** (refuted 0-3). Use `deliveryType`.
- A Service Worker reads **the full set of CORS-exposed response headers** (server
  controls via `Access-Control-Expose-Headers`), not a small fixed subset.
- A Service Worker intercepts **all in-scope requests** — navigations,
  browser-initiated subresources, sendBeacon — not just JS `fetch`/`XHR`.

### Recommended architecture (first-party, DevTools-near) — ⚠️ SUPERSEDED

> **Not implemented.** The Service Worker / NEL / server-cooperation architecture
> below was the research's ideal, but the review gate cut M5 to **Tier-1 Resource
> Timing only** (see the scope decision at the top of this section). The block is
> retained for the record / a possible future opt-in milestone — **do not build
> from it.**

```
[SDK]
 1) Service Worker → fetch event intercepts every in-scope request
    · generate req-id → inject into request header (X-QA-Id)
    · record status/headers/body for same-origin + CORS responses
 2) PerformanceObserver('resource', { buffered: true })
    · full waterfall incl. pre-mount (boot) + deliveryType (cache)
      + nextHopProtocol + sizes
 3) NEL/Reporting → first-party endpoint (server IP · protocol · phase)
[server — first-party cooperation]
 4) middleware: Access-Control-Expose-Headers (all wanted headers)
    + Timing-Allow-Origin + Server-Timing + echo X-QA-Id
    + (optional) log Set-Cookie / wire headers keyed by req-id → QA backend
 5) NEL response-header opt-in
→ correlate SW records + Resource Timing + server header logs by req-id
```

### Definitively out of reach without an extension/CDP

For origins you **don't control** (payment widgets, social login, ads, third-party
CDNs): opaque (no-cors) bodies/headers, their Set-Cookie, no-TAO size/timing, their
exact cache/IP. This is the same-origin boundary — a Service Worker can't pierce it.
Only `chrome.debugger` (CDP, what DevTools uses) crosses it, and **even a Chrome
extension must opt into CDP to see these**: `chrome.webRequest` gives headers /
Set-Cookie / IP but **never response bodies**; only `chrome.debugger` gives bodies.
`chrome.debugger` shows a persistent *"[extension] started debugging this browser"*
banner, conflicts with open DevTools, and is Chromium-only → impractical for a
silent always-on QA tool. **Note:** the *current* extension uses neither `debugger`
nor `webRequest` (just the fetch/XHR patch), so it has the **same third-party blind
spots** — moving to the SDK loses nothing on this axis.

Sources: MDN FetchEvent/respondWith · WHATWG Fetch (opaque) · W3C Resource Timing
(deliveryType / TAO) · MDN Set-Cookie · Chrome blog (foreign-fetch removed) · W3C NEL.

## App-state capture (TanStack Query / Redux / Zustand) — M6

Because the SDK runs *inside* the app, it can capture in-app state the extension
cannot easily reach — an **advantage** over the extension. The host injects its
store/client; the SDK never imports the state library (version-safe):

```tsx
<Bugzar
  captureState={() => dehydrate(queryClient)}   // or store.getState(), client.cache.extract()
  // timeline: pass queryClient → SDK subscribes to getQueryCache().subscribe()
/>
```

- **Snapshot** at record start + stop (throttled mid-session) → serialized into `bundle.state`.
- **Timeline** (TanStack): `queryClient.getQueryCache().subscribe(...)` records cache
  events (refetch / error / invalidate) in time order alongside console/network.
- **Yields** per-query `queryKey · data · status · fetchStatus · error · dataUpdatedAt
  (staleness) · observer count` — exactly what server-state the UI rendered from at bug time.
- **Privacy:** snapshots may carry sensitive response data → redact (reuse masking) + size-cap.
- Generic `captureState` also covers Redux (`store.getState()`), Zustand, Apollo
  (`client.cache.extract()`).

## Non-goals

- Native/mobile hosts (capture is DOM-based).
- Non-React frameworks (React-only per decision; a vanilla `init()` mount is a
  possible future addition, not M1).

## Publish note

The workspace package is `@bugzar/sdk`; the **published npm name is a deploy-time
decision** (requires the `@bugzar` npm org, or pick an unscoped name) and is set in
`packages/sdk/package.json` `name` before `npm publish`. M1 builds the package;
it does not publish.
