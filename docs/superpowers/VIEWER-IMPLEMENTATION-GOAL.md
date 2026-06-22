# Implementation Goal — `@bugzar/viewer` (standalone replay + design-review viewer)

**For:** a goal-driven loop (`/goal`) to execute autonomously to completion.
**Branch:** `feat/embeddable-sdk` · **Date:** 2026-06-18
**Read first (source of truth — already written + gated):**
- The **contract tests** — locked + passed a 3-reviewer gate (R2: 0 unanimous blockers). DO NOT weaken them. They are the oracle.
- `docs/superpowers/specs/2026-06-18-replay-viewer-design.md` — spec.
- `docs/superpowers/plans/2026-06-18-viewer-plan.md` — milestone design + per-VM contracts + build order (VM1→VM13).

---

## State entering this goal

Spec + plan + ALL contract tests are written and committed; the gate passed. Every
viewer module is a typed **shell** (pure-logic fns throw `not implemented`; React
components return `null`); the SDK schema-stamp is unimplemented. Implementation is
the LAST step — fill the shells so the tests go green, per the gated plan.

**Today (the red oracle):**
- `@bugzar/viewer`: **55 red + 1 green** (56 tests) — turn all 56 green.
- `@bugzar/sdk`: **2 red** schema-stamp tests (`uploadBundle` + `uploadDesign`) + 33 green — turn the 2 green without regressing the 33.
- `@bugzar/shared`, `@bugzar/capture-core`, `@bugzar/backend`, `@bugzar/extension`: green — keep green (you only ADD `SCHEMA_VERSION` use; don't break them).

---

## ✅ Definition of Done (탈출조건) — every item must hold

Run, in order, and confirm — **the HARD oracle is 1–6:**

1. `pnpm --filter @bugzar/viewer typecheck` → clean.
2. `pnpm --filter @bugzar/sdk typecheck` → clean.
3. `pnpm -r test` → **0 failures** — every package green. *(Primary oracle. Today: 55 viewer + 2 sdk red.)*
4. `pnpm --filter @bugzar/viewer build` → success (Vite `dist/`).
5. **No regression in the SDK/extension pipeline:** `pnpm --filter @bugzar/sdk build` → success AND `grep -c "@tanstack/react-query" packages/sdk/dist/index.js` → `0` (iss-13); `pnpm --filter @bugzar/extension build` → success; `node scripts/verify-sri.mjs` → pass.
6. **e2e (VM13) — the final end-to-end gate, must pass:** add `@playwright/test` (dev) to the viewer, `npx playwright install chromium`, write two committed fixture reports under `packages/viewer/e2e/fixture/reports/<id>/…` (a **session**: meta+events(≥2 valid rrweb)+console(1 error)+network(1 ×500)+…; a **design**: meta(mode:design)+design(2 elements)), serve `dist` via `vite preview`, and `pnpm --filter @bugzar/viewer exec playwright test` → passes: session id → replay iframe mounts + Console shows the error + Network shows the 500 + a scrubber error marker; design id → annotation cards (selector + note) render.
7. **Lint (don't regress):** `pnpm check:fix` leaves **no NEW** Biome errors in files YOU change. (Pre-existing repo drift in backend/extension is OUT OF SCOPE.)
8. Final: update `packages/viewer/README.md` (what it is · `?endpoint=&id=` · `wrangler pages deploy dist` · CORS `*` / public-by-URL note · both modes) and commit.

**Stop condition:** when 1–6 pass, 7 has no new errors, and 8 is committed, `@bugzar/viewer` is feature-complete on this branch.

---

## The oracle — turn these green by IMPLEMENTING (never by editing the test)

**Pure logic** (`__tests__/`: schema-version, params, filters, timeline, tabs, markers, mode, assets) — implement `report/schema-version.ts`, `report/params.ts`, `report/mode.ts`, `panels/filters.ts`, `panels/timeline.ts`, `panels/tabs.ts`, `panels/markers.ts`. (`assets.test.ts` is already green — the `ASSET_NAMES` drift guard; keep it.)

**Data layer** (`load-report.test.ts`) — `report/load-report.ts`: parallel fetch of all `ASSET_NAMES` from `${endpoint}/reports/${id}/<name>.json`; per-slot 404/parse-fail → push to `failed` + default that slot; read `meta.schemaVersion` → `checkSchemaVersion`.

**Components** (`states`, `ui`, `panels`, `Player`, `Controls`, `DesignView`, `App` tests) — implement `ui/states.tsx`, `ui/MetaHeader.tsx`, `ui/Tabs.tsx`, the 5 `panels/*Panel.tsx`, `player/use-replayer.ts` + `player/Player.tsx` + `player/Controls.tsx`, `design/DesignView.tsx`, and `App.tsx` (the state machine + `reportMode` routing). Wire `main.tsx` to `<App/>`.

**SDK** (`packages/sdk/src/__tests__/schema-version.test.ts`) — `uploadBundle` and `uploadDesign` stamp `meta.schemaVersion = SCHEMA_VERSION` (import from `@bugzar/shared`); `uploadDesign` also sets `url` from `location.href`. Don't regress the other SDK tests or iss-13.

---

## Build order (implement LAST, milestone by milestone)

Follow the plan's **VM1 → VM13**. Per milestone: implement the shell(s) →
`pnpm --filter @bugzar/viewer typecheck` + `pnpm --filter @bugzar/viewer exec vitest run <files>`
(or the SDK filter for VM1) green → **atomic commit**. Order: VM1 schema (SDK
stamps + viewer check) → VM2 scaffold/data (params, load-report, App states,
MetaHeader, main.tsx) → VM3 player (use-replayer/Player/Controls, `<2`-events
guard) → VM4–8 panels → VM9 mode + DesignView (+ App routing) → VM10 sync → VM11
markers/jump → VM12 build + README → VM13 e2e.

---

## Constraints (hard)

- **Contract tests are LOCKED + gated.** Implement against them. Do NOT delete/skip/`.only`/weaken a test. If one genuinely contradicts reality, STOP and surface it (the gate already fixed the known ones — e.g. rrweb needs ≥2 events).
- **No new runtime deps** beyond `rrweb` (already added). `@playwright/test` is dev-only (e2e).
- **Do not touch the backend** (`packages/backend/src/worker.ts`). The viewer only reads the existing `/reports/:id/*.json` over CORS `*`.
- **Do not regress** the green tests (SDK review-drawer/design-publish/conformance, capture-core, extension, backend, shared) or the SDK core bundle's tanstack-freedom (iss-13).
- Match repo conventions: workspace deps, biome, vitest + happy-dom, the `bugzarv-` CSS prefix (the viewer owns its whole page — scope styles so nothing leaks, but it has no host to collide with), dark theme (`#18181b`/`#e4e4e7`).
- rrweb `Replayer` real API: `new Replayer(events, { root, skipInactive, mouseTail:false })`, `play(offset?)`, `pause(offset?)`, `getCurrentTime()`, `getMetaData()`, `on(...)`, `setConfig({speed})`, `destroy()`. Guard `events.length < 2` → empty state (it throws otherwise).

## Loop protocol

After each milestone: typecheck + `vitest run <files>` green → atomic commit.
After VM1–VM11: full `pnpm -r test` (no regression). After VM12: `vite build`.
After VM13: `playwright test` green. Never claim done without showing command output.
