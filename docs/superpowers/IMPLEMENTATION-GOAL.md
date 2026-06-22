# Implementation Goal — finish the embeddable SDK UI

**For:** a goal-driven loop (`/goal`) to execute autonomously to completion.
**Branch:** `feat/embeddable-sdk` · **Date:** 2026-06-18
**Read these (source of truth):**
- The **contract tests** — locked + gated; DO NOT weaken them. They are the oracle.
- `docs/superpowers/plans/2026-06-17-sdk-m4-m6-plan.md` — full spec + impl order + every gate decision.
- `docs/superpowers/reviews/2026-06-18-sdk-uiux-review.md` — the UX intent behind ③ (summary, terminal states) and ⑤ (motion).

---

## State entering this goal

All **capture + DX** modules are implemented and green: `serialize-state` (M6 + redaction/truncation markers), `state-sampler` (M6), `tanstack` (M6), `resource-timing-patch` (M5), endpoint-auth headers (④), `useBugzar` (④). `@bugzar/backend`, `@bugzar/shared`, `@bugzar/capture-core` are **fully green**.

The **only remaining work is the SDK UI**: the M4 review drawer, F4.3 design publish, ③ widget terminal states, ⑤ motion polish. **15 `@bugzar/sdk` unit tests are red — they are the completion oracle.**

---

## ✅ Definition of Done (종결조건) — every item must hold

Run, in order, and confirm — **the HARD oracle is 1–5:**

1. `pnpm --filter @bugzar/backend typecheck` → clean.
2. `pnpm --filter @bugzar/sdk typecheck` → clean.
3. `pnpm -r test` → **0 failures** — every package green. *(Primary oracle; today 15 `@bugzar/sdk` tests are red.)*
4. `pnpm --filter @bugzar/sdk build` → success (ESM + CJS + DTS + the `tanstack` subpath). The core `packages/sdk/dist/index.js` still has **0** `@tanstack` references: `grep -c "@tanstack/react-query" packages/sdk/dist/index.js` → `0` (iss-13).
5. `pnpm --filter @bugzar/extension build` → success (no extension regression) · `node scripts/verify-sri.mjs` → pass.
6. **Lint (don't regress):** run `pnpm check:fix` and ensure **no NEW** Biome errors in files YOU change. ⚠️ The repo has **pre-existing** Biome drift unrelated to this work (backend/extension + ~9 issues in `sanitize-network-body.test.ts`/`storage-snapshot.test.ts`/`picker.ts`/`recorder.ts`'s unused `WebVitals` import/`Bugzar.tsx:242` aria-label). That is a SEPARATE wrap-up chore — do **not** expand this goal to fix backend/extension. (Fixing the `Bugzar.tsx` aria-label is fair game since the drawer touches that file.)
7. **Visual / motion / e2e (not unit-pinned, confirm by running the demo):** in `packages/sdk/example`, record → the review drawer opens → publish (stub) → the sent / post-publish state shows; the drawer slides in and widget state changes cross-fade; `prefers-reduced-motion: reduce` disables non-essential motion.

**Stop condition:** when 1–5 pass, 6 has no new errors, and 7 is visually confirmed, the SDK is feature-complete on this branch. Then: final whole-branch self-review, update `packages/sdk/README.md` (props table incl. `jira`/`user`/`onPublished`/`captureState`/`redactState`/`useBugzar`/`endpoint` object form, with a "requires a configured Worker + Jira service account" callout), and commit.

---

## The 15-test oracle — turn these green by IMPLEMENTING (never by editing the test)

**`packages/sdk/src/__tests__/review-drawer.test.tsx` (10):**
1. uploads the bundle then opens the drawer on stop (jira flow) — `onSubmit` suppressed.
2. leads the drawer with a read-only **capture summary** — `data-testid="bugzar-capture-summary"` showing "2 console errors", "1 failed", LCP.
3. Publish disabled until a Title is entered.
4. epic combobox — debounced server search, request includes `projectKey=BUGZAR`, pick reflects in the field.
5. AI polish — `POST /jira/draft` with `reportId` + non-empty `userInput`; the ADF `description` is flattened to plain text in the textarea.
6. forwards the AI draft body to publish as `descriptionAdf` when the textarea is unedited (no AI-body loss).
7. AI-fail fallback — `/jira/draft` 500 → a message mentioning AI, manual publish still works.
8. publish payload (title + projectKey + reporter + `epicKey` from `defaultEpicKey`) → post-publish view → `onPublished({issueKey,issueUrl,stubbed:false})`.
9. stubbed not-real affordance — STUB key shown, "not a real / placeholder / not configured" text, **no `<a>` link**.
10. Cancel closes without publishing; **D3** — `onUploaded` fired exactly once on the upload-on-stop, Cancel does not re-upload.

**`packages/sdk/src/__tests__/design-publish.test.tsx` (3):**
1. pick → upload annotations as the `design` asset, **mapping each annotation `note`→`userNote`** (the field the backend reads), + open the drawer; `onAnnotate` still fires.
2. AI polish uses `POST /jira/draft` with `mode:'design'`.
3. publish a design issue → post-publish + `onPublished`.

**`packages/sdk/src/__tests__/terminal-states.test.tsx` (2):**
1. non-jira upload success → explicit "sent" state + replay link.
2. non-jira upload failure → "failed" + Retry that re-uploads the **held** bundle (`attempts === 2`).

---

## Build order (구현 6 → 8)

**6. M4 review drawer** — in `Bugzar.tsx`, invert `stop()` on `jira.enabled`:
   - **jira flow** (`jira.enabled` && `endpoint`): upload-on-stop (`uploadBundle` → `onUploaded` fires, a `reportId` exists), then open a new `ReviewDrawer` and SUPPRESS `onSubmit`/download/FAB-return until Publish or Cancel.
   - **non-jira flow**: stays eager (`onStop`/`onSubmit`/download — keep `Bugzar.test.tsx` green) AND gains the ③ terminal states: hold the returned `UploadResult`/error, show **"sent ✓"** (+ replay link) or **"failed — Retry"** (Retry re-runs `uploadBundle` on the held bundle), each `aria-live`-announced.
   - **ReviewDrawer**: capture-summary strip (`N events · M console errors · K failed requests · LCP`, errors via `console.level==='error'`, failed via `network.status>=400`); Title(required) / Description(ADF-flattened `<textarea>`) / Epic (debounced server combobox, sends `projectKey`, pre-fills `defaultEpicKey`); **AI polish** (`POST /jira/draft` {reportId,userInput,mode:'bug'}, flatten the ADF `description` to text — needs an `adfToText` helper — stash the original ADF); AI-fail fallback; **Publish** (`POST /reports/:id/publish` {title,description?,descriptionAdf?,projectKey,epicKey,reporter}); **post-publish** (real key → `<a href={issueUrl}>`; `stubbed` → monospace key + "Not a real Jira issue — Worker unconfigured", NO link); **Cancel**. Anchor to `position`; focus-trap, focus → Title, Escape = Cancel. English copy.

**7. F4.3 design publish** — add `uploadDesign(endpoint, annotations)` (POST `/reports` → PUT `design.json` mapping each annotation `note`→`userNote` + PUT meta `mode:'design'`); the picker's `onComplete` (when `jira.enabled` && `endpoint`) calls it then opens the drawer in `mode:'design'` (AI polish posts `mode:'design'`; publish via the mode-agnostic `/reports/:id/publish`). `onAnnotate` still fires (no data loss). Body shows imageless element cards.

**8. ⑤ motion polish** (`styles.ts`) — drawer slide/fade-in, FAB & widget-state cross-fades, the `sent ✓` checkmark, the `failed` shake. Pure CSS transitions/keyframes; **extend the existing `@media (prefers-reduced-motion: reduce)` block (styles.ts:86) to cover every new animation.** No animation lib.

---

## Constraints (hard)

- **The contract tests are LOCKED + gated.** Implement against them. Do NOT delete/skip/`.only`/weaken a test to go green. If a test genuinely contradicts reality, STOP and surface it — do not silently change it.
- **No new runtime deps.** Motion is pure CSS. `@tanstack/react-query` stays an OPTIONAL peer; the core bundle must stay tanstack-free (iss-13).
- **Do not regress the green tests** — especially `Bugzar.test.tsx` (eager non-jira `stop`→`onSubmit`→FAB-return), the no-drawer-when-jira-disabled guards, the conformance + build tests.
- **Do not touch the backend** (`packages/backend/src/worker.ts` is done + gated). The drawer calls the existing `/reports`, `/reports/:id/publish`, `/jira/epics`, `/jira/draft`.
- Match existing style — the `bugzar-` CSS prefix/scoping (`styles.ts`), the portal + `position` + `theme` patterns (`Bugzar.tsx`), the canonical types (`public-types.ts` mirror of `@bugzar/shared`, drift-guarded).

## Loop protocol

After each step: `pnpm --filter @bugzar/sdk typecheck` + `pnpm --filter @bugzar/sdk exec vitest run <file>`; commit when that file is green (atomic commits). After all 15 are green: run the hard DoD (1–5) and fix any fallout, then the lint pass (6) + visual pass (7). Never claim done without showing the command output.
