# ReviewDrawer + Bugzar — "Thinking in React" refactor

**Date:** 2026-06-22
**Scope:** `packages/sdk/src/ReviewDrawer.tsx` (615 lines) and `packages/sdk/src/Bugzar.tsx` (441 lines)
**Type:** Pure structural refactor — **zero behavior change**.
**Decisions (locked with user):** Balanced decomposition · Safety-net tests.

---

## 1. Goal & success criteria

Split two god-components into folders whose internal structure mirrors a *Thinking in
React* decomposition: a clear component tree, minimal state that lives at its lowest
common owner, and self-contained custom hooks for related state + effects.

Success =

1. `ReviewDrawer/` and `Bugzar/` folders exist; each renders the same UI and behaves
   identically to today.
2. **The existing 68 tests pass unchanged** (the regression net), plus the new
   safety-net tests pass.
3. `pnpm --filter @bugzar/sdk typecheck` is clean.
4. No public API change: `index.ts`, the example app, and every test still import from
   the exact same specifiers.

## 2. Hard constraints (the safety mechanism)

- **`Bugzar` is the only public surface.** `index.ts` re-exports `Bugzar` + `BugzarProps`.
  `ReviewDrawer` is internal — imported *only* by `Bugzar.tsx`.
- **All 6 component test files drive `ReviewDrawer` *through* `<Bugzar>`** and import
  `from '../Bugzar'`. None imports `ReviewDrawer` directly.
- **Therefore:** converting `Bugzar.tsx → Bugzar/index.tsx` and
  `ReviewDrawer.tsx → ReviewDrawer/index.tsx` keeps every existing import path
  (`'./Bugzar'`, `'../Bugzar'`, `'./ReviewDrawer'`) byte-for-byte valid. The refactor is
  invisible to the public surface and to the test suite. This is what makes it safe.
- Preserve the top-of-file `'use client';` directive in both new `index.tsx` files (RSC).
- Preserve the lazy bare specifier `import('@bugzar/sdk/export' as string)` exactly — the
  vitest alias and the bundler "keep viewer out of core" trick both depend on that string.

## 3. Current-state analysis (the seams)

### `ReviewDrawer.tsx` — one component doing 6 jobs

- **Pure helpers (module scope):** `adfToText`, `initials`, `highlightMatch`,
  `loadLastEpic`/`saveLastEpic` (+ `LAST_EPIC_KEY`), `JSON_HEADERS`.
- **State (15 slots):** `avatarBroke` · `title`, `description` · `prefillEpic` (memo),
  `epicQuery`, `epicKey`, `epicTouched`, `epicResults`, `epicOpen`, `epicLoading` ·
  `aiBusy`, `aiError`, `aiAdfRef`, `aiTextRef` · `phase`, `published`, `publishError` ·
  `titleRef`.
- **Effects (3):** focus Title on form show · Escape→`onClose` · debounced epic search.
- **Async callbacks (2):** `aiPolish` (POST `/jira/draft`, flatten ADF→text, stash ADF) ·
  `publish` (OAuth `publishIssue` **or** service-account POST `/jira/publish`).
- **Render = 3 distinct screens:** post-publish "done" · OAuth "connect" gate · the edit form
  (header + account popover + uploaded link + design cards + title/description + epic
  combobox + AI/Cancel/Publish actions).

### `Bugzar.tsx` — toolbar + 3 sub-machines + orchestration

- **Helpers:** `PenIcon`, `formatTime`, `loadExport`, `buildReplayBlob`, `buildDesignBlob`,
  type `DrawerState`.
- **State/refs:** `mounted`, `recording`, `uploading`, `picking`, `elapsed`, `drawer`,
  `hovering`, `grace` + refs `recorderRef`, `tickRef`, `pickRef`, `rootRef`, `graceTimer`,
  `prevInUse`.
- **Logic:** portal mount/cleanup · `start`/`stop` (recorder + tick) · `startPick` (snapshot
  + systeminfo + design pick) · `exportBlob` glue · autoHide geometric-hover effect · 2s
  grace-timer effect.
- **Render:** drawer portal (`<ReviewDrawer>`) **or** toolbar (REC pill / uploading / FAB+Pick).

## 4. Target structure

### `packages/sdk/src/ReviewDrawer/`

| File | Responsibility |
|---|---|
| `index.tsx` | **Container.** Wires the 3 hooks, computes `showForm`/`canPublish`, routes to one of the 3 screens. Owns `title`/`description` (shared by AI + publish + fields) and `titleRef`. |
| `ConnectGate.tsx` | OAuth "Connect Atlassian" screen (`oauth && !authenticated`). |
| `PublishedView.tsx` | Post-publish "done" screen — real issue link **or** the stub "not-real" note. |
| `DrawerForm.tsx` | Edit-form layout: composes Header + UploadedLink + DesignCards + fields + EpicCombobox + the AI/Cancel/Publish action row. |
| `DrawerHeader.tsx` | Drawer title + the account badge (avatar button + name/disconnect popover). Owns `avatarBroke` locally — state lives where it's used. |
| `UploadedLink.tsx` | "View replay/report" external link. Shared by ConnectGate + DrawerForm. |
| `DesignCards.tsx` | Design-mode imageless element-note cards (index badge + note). |
| `EpicCombobox.tsx` | Epic search `<input>` + results dropdown (loading / results / empty). Uses `highlightMatch`. |
| `useEpicSearch.ts` | **Hook.** Owns `epicQuery/key/touched/results/open/loading` + the prefill memo + the 250 ms debounced search effect (OAuth proxy vs service-account route). Returns `{query,key,results,open,loading,onChange,onFocus,select}`. |
| `useAiPolish.ts` | **Hook.** Owns `aiBusy/aiError` + the ADF/text refs. `polish()` returns the drafted `{title,description}` for the container to apply; `adfFor(description)` returns the rich ADF iff the description is unchanged since polish. |
| `usePublish.ts` | **Hook.** Owns `phase/published/publishError`; `publish(args)` runs the OAuth or service-account branch, persists last-epic on success, fires `onPublished`. |
| `last-epic.ts` | `loadLastEpic`/`saveLastEpic` + `LAST_EPIC_KEY` (localStorage prefill/persist). |
| `utils.ts` | Pure view helpers: `adfToText`, `highlightMatch`, `initials`. |

*(Optional, only if it reads cleaner during implementation: a tiny `Field.tsx` for the
two identical labeled Title/Description inputs. Default: inline them in `DrawerForm`.)*

### `packages/sdk/src/Bugzar/`

| File | Responsibility |
|---|---|
| `index.tsx` | **Container.** Portal mount + lifecycle, the export→drawer orchestration for both stop (bug) and pick-complete (design), `wantsHtml`/`inUse` derivations, renders `<ReviewDrawer>` or `<Toolbar>`. Owns `mounted`, `uploading`, `picking`, `drawer` + `pickRef`/`rootRef`. |
| `Toolbar.tsx` | Presentational toolbar. Given `{recording, uploading, elapsed, design, …handlers}` renders the REC pill / uploading indicator / idle FAB+Pick. Co-locates the tiny `RecordingPill`, `UploadingIndicator`, `IdleControls`, `PenIcon` (all single-use). |
| `useRecorder.ts` | **Hook.** Owns `recording`, `elapsed`, `recorderRef`, `tickRef`. `start()` and `stop()→ReportBundle \| null`. Note: stop **returns** the bundle (unlike the public `use-bugzar.ts`, which does export internally) so the container drives export/drawer. |
| `useAutoHide.ts` | **Hook.** Owns `hovering`, `grace`; the geometric `pointermove` effect + the 2 s grace timer. Takes `(autoHide, mounted, position, inUse, rootRef)`, returns `{revealed, collapsed}`. |
| `export-blobs.ts` | `loadExport`, `buildReplayBlob`, `buildDesignBlob`, and the design `ExportMeta` builder. |

## 5. Component tree (Thinking in React — step 1)

```
Bugzar (container)
├── Toolbar                      ← idle / recording / uploading
│   ├── RecordingPill
│   ├── UploadingIndicator
│   └── IdleControls (PenIcon)
└── ReviewDrawer (container)     ← portal, jira flow
    ├── PublishedView            (phase === 'done')
    ├── ConnectGate              (oauth && !authenticated)
    │   └── UploadedLink
    └── DrawerForm               (edit)
        ├── DrawerHeader → AccountBadge
        ├── UploadedLink
        ├── DesignCards          (design mode)
        ├── Field × 2            (Title, Description)
        ├── EpicCombobox
        └── (AI / Cancel / Publish actions)
```

## 6. State inventory & ownership (steps 3–5)

| State | Today | New owner | Rationale |
|---|---|---|---|
| `avatarBroke` | ReviewDrawer | **AccountBadge** (local) | Used only to swap avatar→initials. |
| `title`, `description`, `titleRef` | ReviewDrawer | **container** | Shared by fields + `useAiPolish` + `usePublish` → lowest common owner. |
| `epic*` (6) + prefill | ReviewDrawer | **useEpicSearch** | One cohesive search machine. |
| `aiBusy/aiError` + ADF/text refs | ReviewDrawer | **useAiPolish** | Encapsulates the "forward ADF iff unedited" rule. |
| `phase/published/publishError` | ReviewDrawer | **usePublish** | The publish state machine. |
| `recording`, `elapsed` | Bugzar | **useRecorder** | Recording machine. |
| `hovering`, `grace` | Bugzar | **useAutoHide** | Reveal machine. |
| `mounted`, `uploading`, `picking`, `drawer` | Bugzar | **container** | Cross-cut the orchestration; stay at the top. |

Data flows **props down, callbacks up** — subviews are presentational; the containers
own orchestration and pass values + handlers.

## 7. Behavior-preservation contract & test strategy

- **Net = the existing 68 tests, unchanged.** They exercise the public `<Bugzar>` surface,
  so they validate the refactor end-to-end without caring about internal structure.
- **Safety-net additions** (`src/__tests__/refactor-safety-net.test.tsx`) cover seams the
  refactor cuts that are *currently unasserted*, all driven through `<Bugzar>` so they are
  structure-agnostic and stay green before/after:
  1. **Escape closes the drawer** without filing (the keydown effect → `usePublish`/container).
  2. **last-epic load** — seeded `localStorage` prefills the Epic field (no `defaultEpicKey`).
  3. **last-epic save** — a successful publish writes `{key,summary}` to `localStorage`.
  4. **last-epic NOT saved on stub** — stubbed publish leaves storage untouched.
  5. **Publish-failure fallback** — a failing publish shows "Publish failed", form stays usable.
  6. **Epic dropdown — loading→results** — "Searching…" shows immediately, then the option.
  7. **Epic dropdown — empty** — "No epics found" when the search returns none.
  8. **Design cards** — 2 picks → 2 cards with index badges 1 & 2 + notes (DesignCards seam).
  9. **Title autofocus** — Title input is focused when the form opens.
- **Verification gate after every step:** `npx vitest run` green + `tsc --noEmit` clean.

## 8. Implementation sequence (each step independently green)

> Implementation happens **after** this plan is approved (per the project's "implement last"
> workflow). Order minimizes blast radius; the suite is run after every step.

1. **ReviewDrawer/ scaffold** — move file to `ReviewDrawer/index.tsx`, fix relative imports
   (`./x → ../x`). Run suite → green. (Pure move; proves the folder+index trick.)
2. **Extract pure modules** — `utils.ts`, `last-epic.ts`. Re-import in `index.tsx`. Suite green.
3. **Extract hooks** — `useEpicSearch`, `useAiPolish`, `usePublish`, one at a time, suite
   green after each.
4. **Extract subviews** — `UploadedLink`, `DesignCards`, `DrawerHeader`(+AccountBadge),
   `EpicCombobox`, `PublishedView`, `ConnectGate`, `DrawerForm`. One at a time, suite green.
5. **Bugzar/ scaffold** — move to `Bugzar/index.tsx`, fix imports (incl. `./ReviewDrawer →
   ../ReviewDrawer`, `./export → ../export`). Suite green.
6. **Extract** `export-blobs.ts`, then `useRecorder`, `useAutoHide`, then `Toolbar`. Suite
   green after each.
7. **Final gate** — full suite + typecheck + a visual diff of the example app if quick.

## 9. Risks, non-goals, notes

- **`use-bugzar.ts` duplication (non-goal).** The public `useBugzar` hook already contains a
  *subset* of Bugzar's recording logic, but its `stop()` does the export internally and never
  returns the bundle — incompatible with Bugzar's drawer/pick orchestration. Unifying them
  would change a published hook's contract. **Out of scope**; left untouched. Flagged for a
  separate decision.
- **Focus-assertion flakiness.** The autofocus test (#9) asserts `document.activeElement`; if
  happy-dom proves flaky it will be wrapped in `waitFor` or dropped — it is the lowest-value
  net item.
- **No styling/markup/className changes.** CSS classes (`bugzar-*`) and DOM structure stay
  identical — `styles.ts` is untouched and the design tests assert on classes/text.
- **No commit without explicit ask** (repo is on `main`).
