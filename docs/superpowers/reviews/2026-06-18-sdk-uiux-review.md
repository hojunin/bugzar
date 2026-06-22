# Bugzar SDK — UI/UX Review (handoff report)

- **Date:** 2026-06-18
- **Branch:** `feat/embeddable-sdk`
- **Produced by:** a 3-person Senior UI/UX Product Designer panel review (parallel, independent lenses), synthesized into one report.
  - **Designer A — Interaction & Flow** (end-user widget UX, recording lifecycle, micro-interactions, a11y)
  - **Designer B — Developer Experience** (the SDK API surface, props, defaults, integration ergonomics as UX)
  - **Designer C — Information Architecture & Data-viz** (review drawer + replay viewer, how captured data is presented, trust/privacy signals)
- **Audience:** the engineer/AI implementing M4–M6. This document is self-contained — read it cold, then implement against the "Definition of done" and "Trust contracts" sections.
- **Source of truth (read these):** `packages/sdk/src/Bugzar.tsx`, `packages/sdk/src/public-types.ts`, `packages/sdk/src/styles.ts`, `packages/sdk/src/picker/picker.ts`, `packages/sdk/src/replay-html.ts`, `packages/sdk/README.md`, `packages/sdk/example/src/App.tsx`, `docs/superpowers/specs/2026-06-17-embeddable-sdk-design.md`, `docs/superpowers/plans/2026-06-17-sdk-m4-m6-plan.md`.

---

## 0. Context snapshot

Bugzar is moving from a Chrome MV3 extension to an **embeddable React SDK** — a host app renders `<Bugzar />` from `@bugzar/sdk` and gets an in-page capture widget (rrweb DOM + console + network + storage + vitals), optional Worker upload, and a shareable replay at `/r/<id>`.

**Status the review is grounded in:**
- **M1–M3 shipped:** floating FAB ("QA" + "Pick"), recording pill (timer + Stop), uploading state, `endpoint` upload, design element picker, replay viewer (rrweb-player only).
- **M4–M6 spec'd + contract-tested, NOT wired into the component** ("implement-last" gate):
  - **M4** = server-side Jira publish + **review drawer** + AI-drafted repro steps.
  - **M5** = Resource Timing network waterfall → `bundle.resources` (**store-only**, no UI).
  - **M6** = app-state capture (TanStack/Redux/Zustand) → `bundle.state` (**store-only**, no UI; may carry sensitive data → redaction required).

**Consensus verdict (all three lenses agreed):** the **capture engine (M1–M3) and the rrweb replay are strong; everything missing is concentrated in the middle of the journey — the "review → publish" surface (M4 drawer) and the *visualization* of the data M5/M6 capture.** Today three of those props (`jira`, `user`, `onPublished`) are advertised in the type but silently do nothing, `Stop` is a one-click irreversible commit, the widget never confirms success or failure, and M5/M6 data is captured but has no human-facing surface at all.

---

## 1. Priority-0 blockers (release-gating, cross-lens consensus)

> These are the four issues at least two designers independently rated BLOCKER. Nothing ships to a real host until these are addressed.

### P0.1 — The review-drawer safety gate is declared but unwired; `Stop` is a one-click irreversible commit
*(Designer A #1+#2, Designer B #1 — the panel's strongest consensus.)*

- `jira`, `user`, `onPublished` are in `BugzarProps` with full JSDoc ([Bugzar.tsx:62](packages/sdk/src/Bugzar.tsx:62)–72) and exported, but **never destructured** ([Bugzar.tsx:127](packages/sdk/src/Bugzar.tsx:127)–142) and **never referenced in `stop()`** ([Bugzar.tsx:182](packages/sdk/src/Bugzar.tsx:182)–207). A developer passing `jira={{enabled:true,…}}` gets autocomplete, a green type-check, and a **silent no-op** — the worst failure mode for an SDK.
- Independently, `stop()` ends recording AND fires `onSubmit`/upload/download in one synchronous action with **no confirm, no review, no undo**. A premature or reflexive stop ships a half-captured report with zero recourse.
- These are the same fix: **the review drawer IS the "stop ≠ commit" gate.** Wire it per the M4 contract (`review-drawer.test.tsx`): on stop in the jira flow (`jira.enabled && endpoint`), upload-on-stop → open drawer → suppress `onSubmit`/download/FAB-return; Publish or Cancel resolves it. The non-jira flow stays eager (existing `Bugzar.test.tsx` contract).
- **Interim (until the drawer lands):** add a dev-only mount warning so the type stops lying — `if (jira?.enabled && !PROD) console.warn('[Bugzar] jira is declared but not active in this build — no issue will be filed.')`. Same for `onPublished`/`user` and the stubbed `@bugzar/sdk/tanstack` helper.

### P0.2 — The widget has no terminal success/failure state
*(Designer A #3.)*

On upload success the FAB silently reverts to idle "QA"; on failure it **also** reverts to idle and the error only reaches `onError` ([Bugzar.tsx:194](packages/sdk/src/Bugzar.tsx:194)–200, 241–245). A silent failure is indistinguishable from success — the tester never learns whether the bug was sent. → Add explicit terminal states: **"Report sent ✓"** (with the replay link when `onUploaded` returns one) and **"Upload failed — Retry"** (Retry re-invokes `uploadBundle` on the held bundle), each announced via `aria-live`.

### P0.3 — M5/M6 data is captured but has no human-facing surface
*(Designer C #1+#2 — and a governance decision, see §6.)*

`replay-html.ts` mounts **only** `rrweb-player`; the locked **RENDER/AI policy** (plan L31) pins `resources`/`state`/`vitals` as "capture+store ONLY … NOT rendered in `/r/:id`." Net effect: a human opening a replay sees a silent DOM playback and must download raw JSON to discover there were failed requests or a stale query at crash time. Worse, every stream already carries `tFromStart`/`startTime` ([public-types.ts:21](packages/sdk/src/public-types.ts:21), 90, 107) for timeline alignment, but **nothing binds them to the player clock** — so even if rendered they'd be static logs, not a replay. → Decouple *render policy* from *AI-cost policy* (see §6 decision), add a synchronized **panel rail** (console / network-waterfall / state-timeline) with a **shared playhead**: click a row → `player.goto(tFromStart)`; player time → highlight/auto-scroll the nearest row.

### P0.4 — The honesty/trust cases exist as types but have no visual contract
*(Designer C #4+#5+#6.)*

Three correctness-critical signals are modeled in data but undefined in UI, so honesty currently depends on an implementer remembering:
- **`PublishResult.stubbed === true`** ([public-types.ts:138](packages/sdk/src/public-types.ts:138)–147) = a fake `STUB-`/`BUGZAR-<ts>` placeholder, **not a real issue**. Must render as plain monospace text + "Not a real Jira issue — Worker unconfigured" + copy button, **never an `<a href>`**. (Plan L91 records this already caused one near-miss.)
- **Cross-origin-without-TAO** zeroes `transferSize`/`nextHopProtocol` ([public-types.ts:92](packages/sdk/src/public-types.ts:92), 96). A naive waterfall renders these as "0 bytes / instant" lies. Must show "— (cross-origin, no timing)" + opaque/hatched bar.
- **M6 redaction + size-cap** — silent redaction looks like real data; silent truncation looks like missing data. The serializer must emit **in-band markers** (`⟨redacted⟩` sentinel, per-snapshot `truncated:true`) so the viewer can render a muted pill and a "⚠ snapshot truncated — N keys dropped" banner.

Make each a **snapshot-tested visual contract**, not implementer discretion.

---

## 2. Findings by lens (condensed, ranked)

### A — Interaction & Flow
- **[BLOCKER]** Stop = one-click irreversible submit → gate behind drawer (jira) or add a 1.5s "Stopped — Undo" window (non-jira). ([Bugzar.tsx:182](packages/sdk/src/Bugzar.tsx:182)–207) — *see P0.1.*
- **[BLOCKER]** Review-drawer gate declared but unwired. ([:62](packages/sdk/src/Bugzar.tsx:62)–72 vs :127–142) — *see P0.1.*
- **[HIGH]** No terminal success/failure state. — *see P0.2.*
- **[HIGH]** Two always-on FABs with bare "QA"/"Pick" labels, default bottom-right at max z-index ([styles.ts:11](packages/sdk/src/styles.ts:11), 37) — collide with Intercom/Zendesk/Crisp host chat. → collapse to one primary FAB that expands to "Report a bug" / "Design feedback"; add `title` tooltips; document corner-collision dodge.
- **[HIGH]** No pause / discard / in-flight cancel — the only exit while recording is Stop-and-commit ([:235](packages/sdk/src/Bugzar.tsx:235)–240). → add "✕ Discard" (confirm → stop with bundle thrown away, no callbacks); consider Pause/Resume.
- **[MEDIUM]** Picker panel hardcoded `right/bottom:20px` ([styles.ts:116](packages/sdk/src/styles.ts:116)–117) ignores the `position` prop the toolbar honors. → drive the panel corner from `position`.
- **[MEDIUM]** Mode switch is a hard unmount (`if (picking) return null`, [:228](packages/sdk/src/Bugzar.tsx:228)) — the FAB vanishes, reading as "the widget disappeared." → keep a persistent anchor across modes.
- **[MEDIUM]** Idle FAB shows a solid red dot ([:249](packages/sdk/src/Bugzar.tsx:249), [styles.ts:63](packages/sdk/src/styles.ts:63)–67) = same accent as the live recording dot → "live" signal at rest. → neutral idle glyph; red reserved for active.
- **[MEDIUM]** A11y: state changes are visual-only; no `role="status"`/`aria-live` for start/upload/sent; picker is mouse-only ([picker.ts:184](packages/sdk/src/picker/picker.ts:184)–202). → add an `aria-live="polite"` lifecycle region; document picker mouse-only.
- **[LOW]** Disabled "Done" in picker has no hint that Cancel is the clean empty-exit ([picker.ts:177](packages/sdk/src/picker/picker.ts:177)).

### B — Developer Experience (API-as-UX)
- **[BLOCKER]** Declared-but-unwired props = silent no-op. — *see P0.1.*
- **[HIGH]** README/type drift — props table ([README.md:43](packages/sdk/README.md:43)–56) omits `jira`/`user`/`onPublished`/`captureState`/`redactState`; Roadmap says "Jira is the next milestone" (README.md:138–139) while the type already ships it. → one authoritative table with a "Status: not yet active (M4)" column; delete the contradicting prose.
- **[HIGH]** Callback overlap — `onStop(bundle)` ([:192](packages/sdk/src/Bugzar.tsx:192)) vs `onSubmit(bundle, meta)` ([:202](packages/sdk/src/Bugzar.tsx:202)–203) both fire on stop; `meta` is just `bundle.meta`; only `onSubmit` suppresses download (a hidden side effect). → collapse to pure-lifecycle `onStart`/`onStop` + one terminal `onCapture(bundle)`; drop the redundant `meta`.
- **[HIGH]** Output-routing precedence in `stop()` is unpredictable — `endpoint`+`onSubmit` → uploads AND calls onSubmit AND no download; `download:true`+`endpoint` → silently no download ([:194](packages/sdk/src/Bugzar.tsx:194)–205). → one explicit decision; dev-warn on contradicted props; document as a 3-row table.
- **[HIGH]** No headless/controlled mode — only the FAB drives recording; `createRecorder()` is private. → export `useBugzar()` → `{recording, elapsed, start, stop}` and/or `headless?: boolean`. The #1 real-world integration shape (host's own "Report a bug" button) and the clearest agentation-parity gap.
- **[MEDIUM]** `endpoint` has no auth/custom headers ([upload.ts:30](packages/sdk/src/upload.ts:30), 45); report API is unauthenticated CORS-`*` (plan L16, L102). → `endpoint?: string | { url; headers? }`.
- **[MEDIUM]** `position` has no offset/style escape hatch for FAB collisions. → `offset?: {x?,y?}` + root `className`/`style`.
- **[MEDIUM]** Zero-config default downloads a JSON file ([:204](packages/sdk/src/Bugzar.tsx:204)–205) — fine for demo, surprising in prod. → keep, but `console.info` once when download fires with no sink. (The example already sets `download={false}`, [App.tsx:122](packages/sdk/example/src/App.tsx:122).)
- **[MEDIUM]** `@bugzar/sdk/tanstack` helper returns `() => ({})` (tanstack.ts) and `stateTimeline`/throttle from the plan (L65–66) aren't on the public props → wiring `captureState` today yields empty `bundle.state` with no signal. → warn from the stub; don't doc as working until wired.
- **[LOW]** `onAnnotate` download-suppression is a second invisible "sink suppresses download" convention. → state the principle once.

### C — Information Architecture & Data-viz
- **[BLOCKER]** M5/M6 captured but un-visualizable by policy. — *see P0.3.*
- **[BLOCKER]** No playhead-correlation model. — *see P0.3.*
- **[HIGH]** Review drawer has no summary IA — it's spec'd as a *publish form* (plan L50), not a *data summary*. → add a read-only "What we captured" block at the top: stat strip (`N events · M console errors · K failed requests · LCP 2.4s`) → AI repro steps → then the editable title/desc.
- **[HIGH]** `stubbed` honesty has no visual contract. — *see P0.4.*
- **[HIGH]** M6 state can leak sensitive data with no redaction/truncation *signal* in the output. — *see P0.4.*
- **[MEDIUM]** No-TAO cross-origin rows render as zero-lies. — *see P0.4.*
- **[MEDIUM]** Design annotations are metadata-only (imageless cards, plan F4.3/L51) — no visual anchor for "what element." → overlay the annotation `rect` as a numbered box on the rrweb replay at its `tFromStart` (the picker already draws this, [picker.ts:61](packages/sdk/src/picker/picker.ts:61)–79); lead the card with `componentName`+`textContent`+`selector`.
- **[MEDIUM]** Three disjoint streams → DevTools-noise risk. → offer a merged "Timeline" tab + an "Errors only" filter (`console.level==='error'`, `status>=400`/`error`, state `error`).
- **[LOW]** Vitals are raw numbers with no threshold semantics. → color against Web Vitals thresholds (LCP 2.5/4s, CLS 0.1/0.25, INP 200/500ms).
- **[LOW]** Report-list rows don't surface error counts. → small count badge per row.

---

## 3. Target UI/UX when M6 is complete

### 3a. Widget state machine (make it explicit and total)
Today only `idle / recording / uploading` exist. Define and render every state, each with distinct chrome + an `aria-live` announcement:

```
idle ─► recording ─┬─► discard ───────────────► idle        (no callbacks)
                   └─► stopping ─► uploading ─┬─► [jira] reviewing ─► published | stubbed
                                              └─► sent ✓ (link)  |  failed ─► retry
```
- `published` / `stubbed` / `sent` / `failed` / `reviewing` / `discarded` are all missing today and must each be a real state.
- Between Stop and drawer-open (upload is async, currently invisible) show an interstitial **"Preparing review…"**.

### 3b. Review drawer (M4) — summary-first, progressive disclosure
```
┌─ QA Report ─────────────────────────────────┐
│ Captured summary  (read-only, surfaced 1st)  │
│   142 events · 3 console errors · 2 failed   │  ← errors in accent; vitals colored vs thresholds
│   requests · LCP 2.4s ✓ · CLS 0.08 ✓         │
│                                              │
│ AI-drafted repro steps        [Re-draft]     │  ← from /jira/draft; flattened ADF, original stashed
│   1. Open /checkout  2. Click Pay  3. …      │
│   [▸ View full replay → /r/<id>]             │
│ ──────────────────────────────────────────  │
│ Title*  [____________________]               │  ← editable form BELOW the summary
│ Description [ADF-flattened textarea]          │
│ Epic    [combobox · debounced server search] │
│                          [Cancel] [Publish]  │
└──────────────────────────────────────────────┘
stubbed:true  → STUB-1718…  (monospace, NOT a link)  [Copy]  ⚠ Not a real Jira issue — Worker unconfigured
stubbed:false → BUGZAR-123  (link → issueUrl)
```
Drawer contract: opens only after `POST /reports` resolves; **anchor to `position`** (not a hardcoded corner); focus-trap, focus → Title, Escape = Cancel; Cancel restores the FAB and must decide what happens to the already-uploaded R2 report (orphan / "download instead").

### 3c. Replay viewer `/r/<id>` — player + synchronized panel rail
```
┌──────────────────────────────┬───────────────────────────┐
│                              │ [Console][Network][State]  │ ← + [Timeline][Errors] views
│      rrweb-player            │ • 0.8s  ✕ TypeError …      │
│   (DOM reconstruction)       │ ▸ 1.2s  GET /api 500 ───▮  │ ← waterfall bar; no-TAO rows hatched
│   + annotation rect overlay  │ ▮▮ size + deliveryType cell│
│     (numbered box, M3)       │ State: key·status·staleness │
│ ◄──────●───────────► 1.2s    │ ⟨redacted⟩ pills; ⚠ trunc   │
└──────────────────────────────┴───────────────────────────┘
 one rrweb-player clock drives both: click row → player.goto(tFromStart); player time → highlight nearest row
```

---

## 4. Proposed consolidated API (Designer B)

```tsx
interface BugzarProps {
  // lifecycle — pure pings, no data
  onStart?: () => void;
  onStop?: () => void;

  // one terminal sink; providing it suppresses the JSON download
  onCapture?: (bundle: ReportBundle) => void;        // replaces onSubmit; meta is bundle.meta
  onAnnotate?: (annotations: DesignAnnotation[]) => void;

  // upload — now auth-capable
  endpoint?: string | { url: string; headers?: Record<string,string> | (() => Promise<Record<string,string>>) };
  onUploaded?: (result: UploadResult) => void;
  onError?: (error: Error) => void;

  // capture tuning
  mask?: boolean;                                    // default true
  captureState?: () => unknown;                      // host store/cache (version-safe)
  redactState?: (state: unknown) => unknown;

  // presentation + headless
  position?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  offset?: { x?: number; y?: number };
  theme?: 'light' | 'dark' | 'auto';
  design?: boolean;
  headless?: boolean;                                // render nothing; drive via useBugzar()
  download?: boolean;                                // default true; warns if contradicted by endpoint/onCapture
}

function useBugzar(opts?: BugzarProps):
  { recording: boolean; elapsed: number; start(): void; stop(): void };

// M4 publish props ship ONLY once wired (or behind a flag) so autocomplete never offers a no-op:
interface BugzarJiraProps {
  jira?: JiraConfig;
  user?: { name: string; email: string };
  onPublished?: (result: PublishResult) => void;     // PublishResult.stubbed already honest
}
```

---

## 5. Trust / honesty contracts (snapshot-test each)
1. **Stubbed publish** (`PublishResult.stubbed === true`): plain monospace key, "Not a real Jira issue" caption, copy button, **no `<a href>`**.
2. **Cross-origin no-TAO** (`transferSize===0 && encodedBodySize===0` on a cross-origin row): "— (cross-origin, no timing)" + hatched/opaque bar — never a solid zero.
3. **M6 redaction**: serializer emits `⟨redacted⟩` sentinel → viewer renders a muted pill, not the literal string.
4. **M6 size-cap**: serializer sets per-snapshot `truncated: true` → viewer shows "⚠ snapshot truncated — N keys dropped".
5. **Deploy-discipline caveat**: `jira`/`endpoint` JSDoc must state "requires a Worker with `ALLOWED_ORIGINS` set" — F4-AUTH is fail-open otherwise (plan L102).

---

## 6. Open decisions (need a human/owner call before implementing)

- **D1 — RENDER policy vs product value (the biggest one).** The plan locks `vitals`/`resources`/`state` as **store-only, not rendered in `/r/:id`** (plan L31, iss-1/iss-14) to avoid unbudgeted viewer+CSP work. Designer C rates this a BLOCKER for product value: the data is invisible to humans. **Recommendation:** keep them out of the *AI draft* (the cost concern is real) but **revisit the *render* ban** — add the panel rail (§3c) as a scoped milestone (M7?) reading the already-uploaded `console.json`/`resources.json`/`state.json`. This is a governance change, not a silent override — flag it to the owner.
- **D2 — Single FAB vs two.** Collapsing "QA"+"Pick" into one expanding entry point (Designer A) changes the M3 picker entry. Confirm before refactor.
- **D3 — Cancel-after-upload semantics.** The drawer's Cancel happens *after* the bundle was uploaded to R2 on stop. Define: orphan the report, offer "download instead," or schedule cleanup. (Plan deferred `upload-failure-dead-state` to the M4 gate, L104 — close it here.)
- **D4 — Ship M4 publish props now or gate them.** Until `stop()` branches on `jira.enabled`, either remove `jira`/`user`/`onPublished` from the published type or keep them with a mandatory dev-only warning (P0.1). Pick one before the next release tag.

---

## 7. Definition of done (acceptance criteria)

- [ ] **P0.1** `jira.enabled && endpoint` → stop uploads → review drawer opens → `onSubmit`/download suppressed; Cancel restores FAB; non-jira flow unchanged (existing `Bugzar.test.tsx` green). No declared prop is a silent no-op (wired or dev-warns).
- [ ] **P0.2** Widget shows distinct `sent ✓` (with link) and `failed — Retry` terminal states; Retry re-uploads the held bundle; both `aria-live`-announced.
- [ ] **P0.3** (pending D1) Replay viewer renders console + network-waterfall + state-timeline panels bound to one rrweb-player clock (click-to-seek + nearest-row highlight).
- [ ] **P0.4** All five trust contracts in §5 are snapshot-tested.
- [ ] Single FAB entry point (pending D2); idle dot is neutral, red reserved for active recording.
- [ ] Recording has a Discard path (no callbacks fire).
- [ ] Picker panel anchors to `position`.
- [ ] Callbacks consolidated (`onCapture` + pure lifecycle); output-routing documented as a table; contradicted props dev-warn.
- [ ] `useBugzar()` headless hook exported; `endpoint` accepts auth headers.
- [ ] README props table is authoritative with a "not-yet-active" status column; no roadmap/type contradiction.

---

## 8. Sequencing recommendation

1. **Honesty now (hours):** dev-warn the unwired `jira`/`onPublished`/`user` + the empty tanstack helper; fix README/type drift (P0.1 interim, B-HIGH). Zero behavior risk, stops the type from lying immediately.
2. **M4 drawer (the keystone):** wiring it closes P0.1, the stop-irreversibility blocker, and P0.4's `stubbed` contract in one pass — and gives the summary IA (§3b) a home.
3. **Widget polish:** terminal states (P0.2), single FAB, discard, idle-dot, a11y, picker position.
4. **DX consolidation:** `onCapture`, output-routing table, `useBugzar()`, `endpoint` headers, `offset`.
5. **D1 decision → viewer panel rail (P0.3) + M5/M6 trust viz (P0.4 #2–4).** Largest scope; gated on the render-policy call.
