# Bugzar SDK — v1 Architecture: `onExport` + R2/S3 sharing, Jira-only Worker

- **Date:** 2026-06-22
- **Status:** Design approved (architecture pivot) → implementation plan next.
- **Branch:** `harden/oss-release`
- **Touches:** `packages/sdk` (`Bugzar.tsx`, `use-bugzar.ts`, `ReviewDrawer.tsx`, `upload.ts`, `public-types.ts`, `README.md`, `example/`) **and** `packages/backend` (`/jira/draft` takes inline input + limit fallback; report-less publish). **No `capture-core` changes.**
- **Breaking:** Yes — major. Removes public props and repurposes `endpoint`. Bump `@bugzar/sdk`.

## Problem / Goal

The self-contained offline HTML that `@bugzar/sdk/export` builds already inlines the full
`@bugzar/viewer` + all session data and replays from any static host with **no backend**.
So the SDK's product reduces to: **capture → self-contained HTML → the consumer hosts it
on their own object storage (R2/S3) for web sharing.**

The managed Worker is therefore **no longer a viewer or report host**. Its only remaining
job is to be the **authenticated Atlassian client** for Jira — the browser must never hold
the Atlassian secret, so auth, the AI draft, and issue creation all run server-side.

This spec locks that v1 architecture:
1. **`onExport`** hands the consumer the built HTML and takes back the shareable URL.
2. **`endpoint`** = the Jira backend only (auth + AI draft + issue creation).
3. **Prune** every prop the old Worker-upload / viewer / JSON-download model required.

## Architecture (locked)

| Concern | v1 decision |
|---|---|
| Web share / view | Consumer uploads the self-contained HTML to **R2/S3**; that URL *is* the replay. No Worker viewer, no `/r/:id`, no `/v/` in the SDK flow. |
| `endpoint` (Worker) | **Jira backend only**: holds the Atlassian credential, runs the AI draft, **creates the issue** server-side. Does **not** host reports. |
| Output callback | `onExport(blob, meta) => Promise<string \| void>` — consumer PUTs `blob`, returns the public URL. |
| Jira replay link | The URL `onExport` returns. No `onExport` / no URL → issue filed **without** a replay link. |
| AI draft input | Sent **inline** in the `/jira/draft` request (slim: console errors / network failures / meta) — the Worker no longer reads R2. |
| AI draft fallback | On AI unavailable / rate-limit / error → deterministic **formatted-message draft** from the same inline data (extends the existing stub path). |
| `download` (chip / JSON) | **Removed.** Output is `onExport` → R2/S3. |

## Roles

### 1. Sharing — `onExport` → R2/S3

```ts
/**
 * Receive the built self-contained replay HTML and return its public URL.
 * Upload `blob` to your storage (R2/S3/…) and return the URL it is now reachable
 * at. Fires on recording stop AND design-pick finish (`meta.mode` distinguishes:
 * 'session' | 'design'). The returned URL becomes the Jira ticket's replay link
 * when `jira` + `endpoint` are configured.
 */
onExport?: (blob: Blob, meta: SessionMeta) => Promise<string | void>;
```

- SDK lazy-builds the HTML via `@bugzar/sdk/export`, reusing today's `import('@bugzar/sdk/export')`
  path so the ~478 KB viewer never enters the core bundle.
- No `onExport` **and** no Jira config → no output; a dev build logs a one-time
  `console.warn("[bugzar] no onExport / jira configured — capture discarded")`.

### 2. Jira — `endpoint` is the authenticated Atlassian client

When `jira` (`{ projectKey, clientId?, enabled?, defaultEpicKey? }`) **and** `endpoint`
are set, on stop / pick finish:

1. Build HTML → `url = await onExport(blob, meta)`.
2. Open the review drawer. SDK POSTs **slim draft input** (console / network / meta) to
   `endpoint` `/jira/draft`.
3. Worker drafts via Workers AI; **on limit/error → formatted-message fallback**
   (`buildBugStubDraft`, extended to fire on AI errors, not just a missing binding).
4. On publish the Worker creates the issue server-side (`/rest/api/3/issue`, credential in
   Worker env — [worker.ts:1605](../../../packages/backend/src/worker.ts)) linking to `url`;
   `onPublished(result)` fires.

`clientId` → per-user OAuth (filed as the reviewer); `enabled` → service account. The
browser never holds the Atlassian token in either mode.

## Removed props (breaking)

| Removed | Reason |
|---|---|
| `download` | No built-in chip / JSON download; output is `onExport` → R2/S3. |
| `onSubmit` | Overlaps `onExport`; consolidated (the raw-bundle sink is dropped). |
| `onStop` | Redundant lifecycle duplicate of the output callback. |
| `onUploaded` | Was the **Worker**-upload result; the consumer now owns the upload (sees it in `onExport`). |
| `onBeforeUpload` | Was the pre-**Worker**-upload scrub; the consumer scrubs inside `onExport`. |
| `user` | Advisory-only Jira reporter identity. |
| `captureCookies` | Security opt-in, default-off; hard-locked off (privacy-positive). |

**Cascades:**
- `ReviewDrawer` `user` prop removed.
- `useBugzar` mirrors the removals (`onStop`, `onSubmit`, `onUploaded`, `onBeforeUpload`, `captureCookies`).
- `upload.ts`: the Worker **report** upload (`uploadBundle` / `uploadDesign`: `POST /reports`, asset PUTs, `replay.html`) is removed. What remains is only the Jira POST helpers (`/jira/draft` + publish), carrying `endpoint`'s auth headers.
- **Kept:** `@bugzar/sdk/tanstack` + `captureState` / `redactState` (optional app-state feature).

## Kept props (v1 surface)

`onStart`, **`onExport`** (new), `onError`, `mask`, `position`, `theme`, `design`,
`onAnnotate`, `captureState`, `redactState`, `jira`, `endpoint` (= Jira backend),
`onPublished`.

## User flows

Two trigger points — **Stop** (recording) and **Pick done** (design).

### A. `onExport` only — the default web-share path
- **Stop** → build HTML → `onExport(blob, meta)` (`mode:'session'`); consumer PUTs to
  R2/S3, returns the URL.
- **Pick done** → design HTML → `onExport(blob, meta)` (`mode:'design'`). `onAnnotate`
  also fires if set.
- `onExport` throws/rejects → `onError`.

### B. `onExport` + `jira` + `endpoint` — web share + file a ticket
- As **A**, then: drawer → AI/fallback draft → **server creates the issue** linking to the
  returned URL → `onPublished`.

### C. No `onExport`
- No output (dev warning). If `jira` + `endpoint` are set, the ticket is still filed but
  **without a replay link**.

`onStart` / `onError` / `onPublished` / `onAnnotate` are notifications — they fire
independently of the path above.

## `inlineAssets` trigger

Offline HTML is faithful only if page assets were inlined **at capture time**. We inline
whenever HTML will be produced — i.e. whenever `onExport` is set:

```ts
const wantsHtml = !!onExport;   // was: !endpoint && !onSubmit && !!download
```

Used for both `createRecorder({ inlineAssets: wantsHtml })` and the design-pick
`captureSnapshot(…, wantsHtml, mask)`.

## Implementation sketch

**`packages/sdk`**
1. `BugzarProps`: add `onExport`; remove `download`, `onSubmit`, `onStop`, `onUploaded`,
   `onBeforeUpload`, `user`, `captureCookies`.
2. `stop()`: drop `runUpload` / the share-chip path / the `onStop` call. New body —
   `const url = onExport ? await buildAndExport(bundle) : undefined`; then
   `if ((jira?.clientId || jira?.enabled) && endpoint) openDrawer({ bundle, url })`; if
   neither `onExport` nor a Jira config is set, emit the one-time dev warning. (Jira can
   still file without `onExport` — the ticket just gets no replay link.)
3. `startPick()` `onComplete`: keep `onAnnotate?.(annotations)`; then the same
   build-export(-then-drawer) shape with `buildDesignBlob` and `mode:'design'`.
4. `wantsHtml = !!onExport`; simplify the `createRecorder` call to
   `{ maskAllInputs: mask, inlineAssets: wantsHtml, ...(captureState && {captureState}), ...(redactState && {redactState}) }` (drop `captureCookies`).
5. `runExportCallback(produce, meta)`: `produce()` → `await onExport(blob, meta)` → return
   the URL; on reject → `onError`.
6. `ReviewDrawer`: drop `user`; accept the R2/S3 `url` + slim draft input; the publish
   request carries `url` (not a `reportId`).
7. `upload.ts`: remove `uploadBundle` / `uploadDesign`; keep only the `/jira/draft` +
   publish POST helpers (auth headers from `endpoint`). `UploadResult` / `Endpoint` types
   trimmed accordingly.
8. `use-bugzar.ts`: mirror the prop removals.
9. README + `example/`: rewrite the `endpoint` section as **Jira-only**; document
   `onExport` with an R2/S3 example; remove `download` / JSON-download / `user` docs.

**`packages/backend`**
10. `/jira/draft`: accept the slim draft input (console / network / meta) in the request
    **body** instead of reading R2 by `reportId`. Keep `buildBugStubDraft` /
    `generateDesignDraft` and **extend the fallback to fire on AI rate-limit/error**, not
    only a missing `AI` binding.
11. Publish: a **report-less** path — take the finalized draft + the client-provided R2/S3
    `url`, create the issue, link to `url`. (Consolidate on `/jira/*`; the report-scoped
    `POST /reports/:id/publish` and report hosting are no longer used by the SDK.)

## Testing
- **`onExport` only, Stop** → called once with `Blob` (`text/html`), `meta.mode === 'session'`;
  returned URL surfaced; no chip.
- **Pick done** → `onExport` called with `meta.mode === 'design'`.
- **`onExport` rejects** → `onError` fires.
- **Jira + `onExport`** → ticket links to the returned URL; **no `onExport`** → ticket filed
  without a link.
- **AI draft fallback** → simulate AI error/limit → `/jira/draft` returns the
  formatted-message draft; issue still publishes.
- **Removed props** → package + `example/` typecheck/build clean; `@bugzar/sdk/tanstack` +
  `captureState` / `redactState` still build.
- **`inlineAssets`** → recorder created with `inlineAssets: true` when `onExport` is set,
  `false` otherwise.

## Out of scope
- No built-in S3/R2 client or presigned-URL helper — the consumer owns the upload.
- No Worker report hosting / `/r/:id` / `/v/` viewer in the SDK flow (extension still uses
  its own paths; unaffected).
- No `capture-core`, `ReportBundle.state`, or viewer changes; `@bugzar/sdk/tanstack` stays.
