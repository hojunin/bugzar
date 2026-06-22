# onExport + R2/S3 Sharing (SDK) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `onExport(blob, meta) => Promise<string | void>` callback that hands the consumer the built self-contained replay HTML so they upload it to their own storage (R2/S3), and remove the now-meaningless `download`, `onSubmit`, `onStop`, `captureCookies` props.

**Architecture:** `onExport` is the non-`endpoint` output sink. On stop / design-pick finish the SDK lazy-builds the offline HTML (via the existing `@bugzar/sdk/export` dynamic import, so the ~478 KB viewer stays out of the core bundle) and calls `onExport`. The existing `endpoint` (Worker upload) + Jira-drawer path is left untouched here — repurposing `endpoint` to Jira-only is **Plan B** (`2026-06-22-jira-reportless-rework.md`, written next).

**Tech Stack:** React, TypeScript, tsup, vitest + @testing-library/react. Commands run from repo root via pnpm filters.

**Scope note:** This is Plan A of two. It ships working "capture → onExport → R2/S3" on its own. Plan B does the Jira report-less rework + removes the upload-tied props (`onUploaded`, `onBeforeUpload`, `user`) and trims `upload.ts`/the hook's `endpoint` usage.

**Conventions:**
- Test command: `pnpm --filter @bugzar/sdk test -- <file>` (vitest run). Typecheck: `pnpm --filter @bugzar/sdk typecheck`. Build: `pnpm --filter @bugzar/sdk build`.
- Component tests mock `@bugzar/capture-core` (recorder stub) — copy the `vi.mock('@bugzar/capture-core', …)` block from `src/__tests__/Bugzar.test.tsx`.
- The offline HTML builder is reached via `import('@bugzar/sdk/export')`; tests mock that module.

---

### Task 1: `ExportMeta` type + `onExport` on session stop

`SessionMeta` has no `mode` field, so the callback meta is a distinct type.

**Files:**
- Modify: `packages/sdk/src/public-types.ts` (add `ExportMeta`)
- Modify: `packages/sdk/src/Bugzar.tsx` (prop, `runExportCallback`, `wantsHtml`, `stop()`)
- Test: `packages/sdk/src/__tests__/onexport.test.tsx` (create)

- [x] **Step 1: Write the failing test**

Create `packages/sdk/src/__tests__/onexport.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const bundle = {
  events: [{ type: 2 }],
  console: [],
  network: [],
  storage: [],
  resources: [],
  state: [],
  vitals: {},
  system: null,
  meta: {
    url: 'https://example.com',
    userAgent: 'test',
    viewport: { width: 800, height: 600 },
    startedAt: 1000,
    endedAt: 2000,
    durationMs: 1000,
  },
};

vi.mock('@bugzar/capture-core', () => {
  let active = false;
  return {
    createRecorder: () => ({
      start: () => {
        active = true;
      },
      stop: () => {
        active = false;
        return bundle;
      },
      isActive: () => active,
    }),
    captureSnapshot: () => [{ type: 2 }],
  };
});

// The offline HTML builder is lazy-imported; stub it so no real viewer loads.
const htmlBlob = new Blob(['<!doctype html>'], { type: 'text/html' });
vi.mock('@bugzar/sdk/export', () => ({
  exportReportHtml: vi.fn(async () => htmlBlob),
  exportDesignHtml: vi.fn(async () => htmlBlob),
}));

import { Bugzar } from '../Bugzar';

afterEach(cleanup);

describe('onExport — session', () => {
  it('builds the HTML and calls onExport with mode "session" on stop', async () => {
    const onExport = vi.fn(async () => 'https://cdn.example.com/r/1.html');
    render(<Bugzar onExport={onExport} />);

    fireEvent.click(screen.getByLabelText(/start recording/i));
    fireEvent.click(screen.getByLabelText(/stop recording/i));

    await waitFor(() => expect(onExport).toHaveBeenCalledTimes(1));
    const [blob, meta] = onExport.mock.calls[0];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('text/html');
    expect(meta.mode).toBe('session');
    expect(meta.url).toBe('https://example.com');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bugzar/sdk test -- onexport`
Expected: FAIL — `onExport` is not a prop yet, so the spy is never called (`expected 1, got 0`).

- [x] **Step 3: Add the `ExportMeta` type**

In `packages/sdk/src/public-types.ts`, after the `SessionMeta` interface (ends line 66):

```ts
/** Meta handed to `onExport` — session meta plus which capture produced it. */
export type ExportMeta = SessionMeta & { mode: 'session' | 'design' };
```

- [x] **Step 4: Add the prop + builder wiring in `Bugzar.tsx`**

Add `ExportMeta` to the type import (line 9-16 block):

```ts
import type {
  DesignAnnotation,
  ExportMeta,
  JiraConfig,
  PublishResult,
  ReportBundle,
  RrwebEvent,
  SessionMeta,
} from './public-types';
```

Add the prop to `BugzarProps` (insert after the `download` prop, ~line 84):

```ts
  /**
   * Receive the built self-contained replay HTML so you can upload it to your own
   * storage (S3/R2/…). Return the public URL the report is now reachable at. Fires
   * on recording stop AND design-pick finish (`meta.mode` distinguishes). Active on
   * the no-`endpoint` path.
   */
  onExport?: (blob: Blob, meta: ExportMeta) => Promise<string | void>;
```

Destructure it (in the `Bugzar({ … })` param list, after `download = true,`):

```ts
  onExport,
```

Extend `wantsHtml` (line 257) so capture inlines assets when `onExport` is set:

```ts
  const wantsHtml = (!endpoint && !!onExport) || (!endpoint && !onSubmit && !!download);
```

Add `runExportCallback` next to `runExport` (after `runExport`, ~line 351):

```ts
  // onExport sink: build the offline HTML, hand it to the consumer to upload.
  const runExportCallback = useCallback(
    (produce: () => Promise<Blob>, meta: ExportMeta) => {
      setUploading(true);
      produce()
        .then((blob) => onExport?.(blob, meta))
        .catch((err) => onError?.(err instanceof Error ? err : new Error(String(err))))
        .finally(() => setUploading(false));
    },
    [onExport, onError],
  );
```

In `stop()`, add the `onExport` branch ahead of the `download` chip (replace the
`if (onSubmit) { … } else if (!endpoint && download) { … }` tail, ~line 383-391):

```ts
    if (endpoint) {
      runUpload(bundle);
    }
    if (!endpoint && onExport) {
      runExportCallback(() => buildReplayBlob(bundle), { ...bundle.meta, mode: 'session' });
    } else if (onSubmit) {
      onSubmit(bundle, bundle.meta);
    } else if (!endpoint && download) {
      runExport(() => buildReplayBlob(bundle), `qa-replay-${bundle.meta.startedAt}.html`, t.replayReady);
    }
```

Add `onExport` and `runExportCallback` to the `stop` `useCallback` dep array (line 392-404).

- [x] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @bugzar/sdk test -- onexport`
Expected: PASS.

- [x] **Step 6: Typecheck + commit**

Run: `pnpm --filter @bugzar/sdk typecheck`
Expected: no errors.

```bash
git add packages/sdk/src/public-types.ts packages/sdk/src/Bugzar.tsx packages/sdk/src/__tests__/onexport.test.tsx
git commit -m "feat(sdk): onExport callback — hand built HTML to the consumer on stop"
```

---

### Task 2: `onExport` on design-pick finish (mode "design")

**Files:**
- Modify: `packages/sdk/src/Bugzar.tsx` (`startPick()` `onComplete`)
- Test: `packages/sdk/src/__tests__/onexport.test.tsx` (extend)

- [x] **Step 1: Write the failing test**

Append to `onexport.test.tsx`. Mock the picker so `onComplete` fires synchronously with one annotation:

```tsx
vi.mock('../picker/picker', () => ({
  startDesignPick: ({ onComplete }: { onComplete: (a: unknown[]) => void }) => {
    queueMicrotask(() =>
      onComplete([
        { id: 'a1', selector: '.x', tagName: 'DIV', textContent: '', cssClasses: [], rect: {}, note: 'n' },
      ]),
    );
    return { stop: () => {}, isActive: () => false };
  },
}));

describe('onExport — design', () => {
  it('calls onExport with mode "design" when a pick finishes', async () => {
    const onExport = vi.fn(async () => undefined);
    render(<Bugzar onExport={onExport} design />);

    fireEvent.click(screen.getByLabelText(/pick/i));

    await waitFor(() => expect(onExport).toHaveBeenCalledTimes(1));
    expect(onExport.mock.calls[0][1].mode).toBe('design');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bugzar/sdk test -- onexport`
Expected: FAIL — design pick has no `onExport` branch (`expected 1, got 0`).

- [x] **Step 3: Wire `onExport` into `startPick()` `onComplete`**

In `startPick()` `onComplete` (after the `else if (endpoint) { … runDesignUpload … }` block, before `else if (!onAnnotate && download)`, ~line 444):

```ts
        } else if (!endpoint && onExport) {
          const now = Date.now();
          runExportCallback(() => buildDesignBlob(annotations, snapshot), {
            url: typeof location !== 'undefined' ? location.href : '',
            userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
            viewport: {
              width: typeof window !== 'undefined' ? window.innerWidth : 0,
              height: typeof window !== 'undefined' ? window.innerHeight : 0,
            },
            startedAt: now,
            endedAt: now,
            durationMs: 0,
            mode: 'design',
          });
```

Add `onExport` and `runExportCallback` to the `startPick` `useCallback` dep array (line 458-469).

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @bugzar/sdk test -- onexport`
Expected: PASS (both onExport tests).

- [x] **Step 5: Commit**

```bash
git add packages/sdk/src/Bugzar.tsx packages/sdk/src/__tests__/onexport.test.tsx
git commit -m "feat(sdk): onExport fires on design-pick finish (mode: design)"
```

---

### Task 3: `onExport` rejection routes to `onError`

**Files:**
- Test: `packages/sdk/src/__tests__/onexport.test.tsx` (extend)
- (Implementation already present in `runExportCallback` — this pins it.)

- [x] **Step 1: Write the failing test**

Append:

```tsx
describe('onExport — errors', () => {
  it('calls onError when onExport rejects', async () => {
    const onError = vi.fn();
    const onExport = vi.fn(async () => {
      throw new Error('upload failed');
    });
    render(<Bugzar onExport={onExport} onError={onError} />);

    fireEvent.click(screen.getByLabelText(/start recording/i));
    fireEvent.click(screen.getByLabelText(/stop recording/i));

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
  });
});
```

- [x] **Step 2: Run test to verify it passes**

Run: `pnpm --filter @bugzar/sdk test -- onexport`
Expected: PASS — `runExportCallback` already `.catch`es into `onError`. (If it fails, the `.then(onExport).catch(onError)` chain in Task 1 Step 4 is wrong — fix it there.)

- [x] **Step 3: Commit**

```bash
git add packages/sdk/src/__tests__/onexport.test.tsx
git commit -m "test(sdk): onExport rejection surfaces via onError"
```

---

### Task 4: Remove the `download` share-chip path

`onExport` replaces the built-in offline chip. Remove `download` and everything only it used. `buildReplayBlob` / `buildDesignBlob` stay (onExport uses them).

**Files:**
- Modify: `packages/sdk/src/Bugzar.tsx`
- Modify: `packages/sdk/src/__tests__/terminal-states.test.tsx` (drop the `exported`-chip cases)

- [x] **Step 1: Delete the chip implementation**

In `Bugzar.tsx` remove:
- The `download?: boolean` prop (~line 76-84 doc + decl) and `download = true,` from the destructure.
- The `'exported'` arm of the `TerminalState` union (lines 34-36).
- `triggerDownload` (152-161), `openBlob` (177-186), `shareOrDownload` (188-200).
- `runExport` (the chip runner, 341-351).
- The `else if (!endpoint && download)` branch in `stop()` and the `else if (!onAnnotate && download)` branch in `startPick()`.
- The `terminal.status === 'exported'` render arm (515-543) — collapse so the render starts at `terminal.status === 'sent'`.

Simplify `wantsHtml` (now only `onExport` drives offline HTML on the SDK path):

```ts
  const wantsHtml = !endpoint && !!onExport;
```

Remove `download` and `runExport` from any `useCallback` dep arrays; remove now-unused i18n reads (`t.replayReady`, `t.designReady`, `t.open`, `t.share`) if the lint flags them.

- [x] **Step 2: Update terminal-states test**

In `terminal-states.test.tsx`, delete the test(s) asserting the `exported`/Open/Share chip. Keep the `sent`/`failed` cases (those belong to the `endpoint` path, still present).

- [x] **Step 3: Run tests + typecheck**

Run: `pnpm --filter @bugzar/sdk test` then `pnpm --filter @bugzar/sdk typecheck`
Expected: PASS; no unused-symbol errors.

- [x] **Step 4: Commit**

```bash
git add packages/sdk/src/Bugzar.tsx packages/sdk/src/__tests__/terminal-states.test.tsx
git commit -m "refactor(sdk)!: remove download share-chip — output is onExport"
```

---

### Task 5: Remove `onSubmit` and `onStop`

`onExport` supersedes `onSubmit` (raw bundle → built HTML); `onStop` is a redundant duplicate.

**Files:**
- Modify: `packages/sdk/src/Bugzar.tsx`
- Modify: `packages/sdk/src/__tests__/Bugzar.test.tsx` (drop `onSubmit`/`onStop` assertions)

- [x] **Step 1: Delete the props + usages**

In `Bugzar.tsx`:
- Remove `onStop?` (line 63-64) and `onSubmit?` (65-69) prop decls; remove `onStop,` and `onSubmit,` from the destructure.
- Remove the `onStop?.(bundle);` call in `stop()` (line 363).
- Remove the `else if (onSubmit) { onSubmit(bundle, bundle.meta); }` branch left in `stop()` — the tail is now just:

```ts
    if (endpoint) {
      runUpload(bundle);
    } else if (onExport) {
      runExportCallback(() => buildReplayBlob(bundle), { ...bundle.meta, mode: 'session' });
    } else if (process.env.NODE_ENV !== 'production') {
      console.warn('[bugzar] no onExport / endpoint configured — capture discarded');
    }
```

- Remove `onStop` / `onSubmit` from `stop()` dep array.

- [x] **Step 2: Update Bugzar.test.tsx**

Replace any `onSubmit`/`onStop` spies with an `onExport` spy (the test already mocks `@bugzar/capture-core`; add the `@bugzar/sdk/export` mock from Task 1 if absent). Assert `onExport` is called on stop instead of `onSubmit`.

- [x] **Step 3: Run tests + typecheck**

Run: `pnpm --filter @bugzar/sdk test` then `pnpm --filter @bugzar/sdk typecheck`
Expected: PASS.

- [x] **Step 4: Commit**

```bash
git add packages/sdk/src/Bugzar.tsx packages/sdk/src/__tests__/Bugzar.test.tsx
git commit -m "refactor(sdk)!: remove onSubmit/onStop (onExport supersedes)"
```

---

### Task 6: Remove `captureCookies`

Security opt-in, default-off; hard-lock cookies off. The `capture-core` `captureCookies` option stays (the extension uses it); the SDK just stops passing it.

**Files:**
- Modify: `packages/sdk/src/Bugzar.tsx`
- Modify: `packages/sdk/src/__tests__/*` (any test passing `captureCookies`)

- [x] **Step 1: Delete the prop + arg**

In `Bugzar.tsx`:
- Remove the `captureCookies?: boolean` prop (137-143) and `captureCookies = false,` from the destructure.
- Drop `captureCookies,` from the `createRecorder({ … })` call (line 263) and from the `start` dep array (277). Result:

```ts
    const rec = createRecorder({
      maskAllInputs: mask,
      inlineAssets: wantsHtml,
      ...(captureState ? { captureState } : {}),
      ...(redactState ? { redactState } : {}),
    });
```

- [x] **Step 2: Run tests + typecheck**

Run: `pnpm --filter @bugzar/sdk test` then `pnpm --filter @bugzar/sdk typecheck`
Expected: PASS (if a test set `captureCookies`, delete that line first).

- [x] **Step 3: Commit**

```bash
git add packages/sdk/src/Bugzar.tsx
git commit -m "refactor(sdk)!: remove captureCookies prop (default-off, hard-locked)"
```

---

### Task 7: Mirror in `useBugzar` (add `onExport`, drop `onStop`/`onSubmit`/`captureCookies`/`download`)

The headless hook gets `onExport` for parity and loses the same independent props. (Its `endpoint`/`onUploaded`/`onBeforeUpload` stay until Plan B.)

**Files:**
- Modify: `packages/sdk/src/use-bugzar.ts`
- Test: `packages/sdk/src/__tests__/use-bugzar.test.tsx`

- [x] **Step 1: Write the failing test**

Add to `use-bugzar.test.tsx` (mirror its existing mock setup; add the `@bugzar/sdk/export` mock from Task 1):

```tsx
it('calls onExport with the built HTML + session meta on stop', async () => {
  const onExport = vi.fn(async () => 'https://cdn/x.html');
  const { result } = renderHook(() => useBugzar({ onExport }));
  act(() => result.current.start());
  act(() => result.current.stop());
  await waitFor(() => expect(onExport).toHaveBeenCalledTimes(1));
  expect(onExport.mock.calls[0][1].mode).toBe('session');
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bugzar/sdk test -- use-bugzar`
Expected: FAIL — no `onExport` option.

- [x] **Step 3: Implement**

In `use-bugzar.ts`:
- Import: add `ExportMeta` to the `public-types` import; add the lazy builder:

```ts
const buildReplayBlob = async (bundle: ReportBundle): Promise<Blob> =>
  (await (import('@bugzar/sdk/export' as string) as Promise<typeof import('./export')>)).exportReportHtml(bundle);
```

- `UseBugzarOptions`: remove `onStop`, `onSubmit`, `captureCookies`, `download`; add:

```ts
  onExport?: (blob: Blob, meta: ExportMeta) => Promise<string | void>;
```

- Destructure: drop `onStop`, `onSubmit`, `captureCookies`; add `onExport`. Remove `captureCookies` from the `createRecorder` call + `start` deps.
- In `stop()`: remove `onStop?.(bundle)` and `onSubmit?.(…)`; after the `endpoint` upload block add:

```ts
    if (!endpoint && onExport) {
      buildReplayBlob(bundle)
        .then((blob) => onExport(blob, { ...bundle.meta, mode: 'session' }))
        .catch((err) => onError?.(err instanceof Error ? err : new Error(String(err))));
    }
```

- Update the `stop` dep array (`onStop`/`onSubmit` out, `onExport` in).

- [x] **Step 4: Run test + typecheck**

Run: `pnpm --filter @bugzar/sdk test -- use-bugzar` then `pnpm --filter @bugzar/sdk typecheck`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/sdk/src/use-bugzar.ts packages/sdk/src/__tests__/use-bugzar.test.tsx
git commit -m "refactor(sdk)!: useBugzar mirrors onExport + prop removals"
```

---

### Task 8: README + example

**Files:**
- Modify: `packages/sdk/README.md`
- Modify: `packages/sdk/example/src/App.tsx`

- [x] **Step 1: README**

- Add an `onExport` row to the props table and a short "Bring your own storage" section:

```tsx
<Bugzar
  onExport={async (blob, meta) => {
    const key = `qa/${meta.mode}-${meta.startedAt}.html`;
    await fetch(presignedPutUrl(key), { method: 'PUT', body: blob });
  }}
/>
```

- Remove the `download`, `onSubmit`, `onStop`, `captureCookies` rows and the JSON-download / share-chip prose.

- [x] **Step 2: example**

In `example/src/App.tsx`, remove any `onSubmit`/`onStop`/`download`/`captureCookies` usage; add an `onExport` handler (a stub that `console.log`s the blob size + returns a placeholder URL is fine for the example).

- [x] **Step 3: Build + verify the package compiles**

Run: `pnpm --filter @bugzar/sdk build` then `pnpm --filter @bugzar/sdk typecheck`
Expected: build emits ESM+CJS+dts; no type errors. Confirm `@bugzar/sdk/export` and `@bugzar/sdk/tanstack` subpaths still build.

- [x] **Step 4: Commit**

```bash
git add packages/sdk/README.md packages/sdk/example/src/App.tsx
git commit -m "docs(sdk): document onExport + drop removed-prop docs/example"
```

---

## Self-review notes

- **Spec coverage (Plan A subset):** `onExport` signature + URL return ✓ (Task 1); session + design ✓ (1, 2); error → onError ✓ (3); `inlineAssets = !!onExport` ✓ (4); remove `download`/`onSubmit`/`onStop`/`captureCookies` ✓ (4-6); hook mirror ✓ (7); README/example ✓ (8). **Deferred to Plan B:** `endpoint` → Jira-only, `onExport` URL → Jira link, remove `onUploaded`/`onBeforeUpload`/`user`, trim `upload.ts` (`uploadBundle`/`uploadDesign`), backend `/jira/draft` inline + fallback + report-less publish.
- **Type consistency:** `ExportMeta` (Task 1) is the meta type used in every `onExport` call (Tasks 1, 2, 7) and the README. `buildReplayBlob`/`buildDesignBlob` are the existing lazy wrappers ([Bugzar.tsx:171](../../../packages/sdk/src/Bugzar.tsx)); Task 7 re-declares an equivalent in the hook.
- **Intermediate state:** after Plan A, `endpoint` still does Worker upload (+ Jira drawer) exactly as today — nothing breaks; Plan B repurposes it.
