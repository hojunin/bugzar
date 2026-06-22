# Jira Report-less Rework Implementation Plan (Plan B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repurpose `endpoint` to be the **Jira backend only**: the AI draft takes capture data **inline** (no R2 hosting) and the issue links to the **R2/S3 URL** that `onExport` returns; remove the Worker report-upload path and the props that depended on it (`onUploaded`, `onBeforeUpload`, `user`).

**Architecture:** The Jira branch of `stop()`/pick builds the offline HTML, calls `onExport` to get the share URL, then opens the drawer. The drawer posts capture **artifacts inline** to `/jira/draft` (which already falls back to a formatted stub on AI error) and publishes via a **report-less** `/jira/issue` route. The replay link rides in the draft's ADF (as today), now pointing at the `onExport` URL. `uploadBundle`/`uploadDesign` (Worker report hosting) are deleted.

**Tech Stack:** Cloudflare Worker (TypeScript), React SDK, vitest. Depends on **Plan A** (`onExport` already exists).

**Prerequisite:** Plan A merged (`onExport`, `ExportMeta`, prop pruning of `download`/`onSubmit`/`onStop`/`captureCookies`).

**Conventions:**
- SDK tests: `pnpm --filter @bugzar/sdk test -- <file>`; backend tests: `pnpm --filter @bugzar/backend test -- <file>`. Typecheck: `pnpm --filter @bugzar/<pkg> typecheck`.
- The AI-failure → stub fallback the user asked for **already exists** in `handleBugDraft`/`handleDesignDraft` (try/catch → `buildBugStubDraft`/`buildDesignStubDraft`). These tasks preserve it; a Workers-AI rate-limit throws and hits the same catch.

---

### Task 1: `/jira/draft` accepts capture artifacts inline (drop R2 read)

`generateBugDraft` already takes `artifacts: DraftInputArtifacts` ([jira-draft.ts:774](../../../packages/backend/src/jira-draft.ts)); only the handler reads R2. Move artifacts to the request body and use the client `url` as the replay link.

**Files:**
- Modify: `packages/backend/src/worker.ts` (`handleJiraDraft`, `handleBugDraft`, `handleDesignDraft`)
- Test: `packages/backend/src/__tests__/jira-draft-route.test.ts` (create or extend the existing draft route test)

- [x] **Step 1: Write the failing test**

Create/extend a draft-route test that posts inline artifacts (no `reportId`) and asserts a draft comes back with the client `url` in the ADF. Use the existing test harness for the Worker (see a sibling `*.test.ts` in `packages/backend/src/__tests__/` for the `env`/`fetch` mock pattern):

```ts
it('drafts from inline artifacts and links to the provided url', async () => {
  const res = await worker.fetch(
    new Request('https://w/jira/draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://app.test' },
      body: JSON.stringify({
        mode: 'bug',
        userInput: 'login button does nothing',
        url: 'https://cdn.example.com/r/abc.html',
        artifacts: {
          meta: { url: 'https://app.test', startedAt: 1000, durationMs: 500 },
          console: [{ level: 'error', args: ['boom'] }],
          network: [{ status: 500, url: 'https://app.test/api' }],
          events: [],
          storage: [],
        },
      }),
    }),
    envWithoutAi(), // forces the stub path — deterministic
  );
  expect(res.status).toBe(200);
  const data = await res.json();
  expect(data.mode).toBe('bug');
  expect(JSON.stringify(data.description)).toContain('https://cdn.example.com/r/abc.html');
});
```

(`envWithoutAi()` = an `env` with no `AI` binding and allowlisted origin, so the deterministic stub path runs.)

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bugzar/backend test -- jira-draft-route`
Expected: FAIL — handler still requires `reportId` (`400 missing reportId`).

- [x] **Step 3: Rework `handleJiraDraft` body parsing**

Replace the body type + reportId validation (worker.ts ~1537-1549):

```ts
const handleJiraDraft = async (req: Request, env: Env, reqUrl: URL): Promise<Response> => {
  if (!originAllowed(req, env)) return errorResponse(403, 'origin not allowed');
  let body: {
    userInput?: string;
    mode?: 'bug' | 'design';
    url?: string;
    artifacts?: DraftInputArtifacts;
    elements?: DesignElementInput[];
    meta?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return errorResponse(400, 'invalid json');
  }
  const userInput = (body.userInput ?? '').trim();
  if (!userInput) return errorResponse(400, 'missing userInput');
  const mode = body.mode ?? 'bug';
  const replayUrl = (body.url ?? '').trim();
  return mode === 'design'
    ? handleDesignDraft(env, { elements: body.elements ?? [], meta: body.meta ?? {}, userInput, replayUrl })
    : handleBugDraft(env, { artifacts: body.artifacts ?? {}, userInput, replayUrl });
};
```

- [x] **Step 4: Rework `handleBugDraft` to take artifacts + url inline**

Change its signature and drop the R2 fetch (worker.ts ~1377-1434):

```ts
const handleBugDraft = async (
  env: Env,
  input: { artifacts: DraftInputArtifacts; userInput: string; replayUrl: string },
): Promise<Response> => {
  const { artifacts, userInput, replayUrl } = input;

  if (!env.AI) {
    console.warn('[jira:draft:bug] AI binding missing — returning stub');
    const stub = buildBugStubDraft({ userInput, meta: artifacts.meta ?? {}, artifacts });
    return jsonResponse(200, { title: stub.title, description: jsonToBugAdf(stub, replayUrl), mode: 'bug', stub: true });
  }
  try {
    const draft = await generateBugDraft(env.AI, {
      artifacts,
      userInput,
      ...(env.AI_MODEL_BUG ? { model: env.AI_MODEL_BUG } : {}),
    });
    return jsonResponse(200, { title: draft.title, description: jsonToBugAdf(draft, replayUrl), mode: 'bug' });
  } catch (err) {
    console.warn('[jira:draft:bug] AI generation failed, falling back to stub:', (err as Error).message);
    const stub = buildBugStubDraft({ userInput, meta: artifacts.meta ?? {}, artifacts });
    return jsonResponse(200, { title: stub.title, description: jsonToBugAdf(stub, replayUrl), mode: 'bug', stub: true });
  }
};
```

Update `buildBugStubDraft` to drop the `reportId` field from its options and remove the
`envBullets.push(\`Report: ${reportId}\`)` line (worker.ts ~1364) — the replay link is in
the ADF via `jsonToBugAdf(stub, replayUrl)` already.

- [x] **Step 5: Rework `handleDesignDraft` the same way**

Change its signature to `{ elements: DesignElementInput[]; meta: unknown; userInput: string; replayUrl: string }`, drop the R2 `fetchJsonAsset` calls and `normalizeDesignElements(designRaw)` (the SDK now sends already-normalized `elements`), and use `replayUrl`. Drop `reportId` from `buildDesignStubDraft`'s options.

- [x] **Step 6: Guard the ADF link on empty url**

In `jsonToBugAdf` and `jsonToDesignAdf`, only emit the "Replay" link node when `replayUrl` is non-empty (no `onExport` → no link). Find where the link node is built and wrap it: `...(replayUrl ? [linkNode(replayUrl)] : [])`.

- [x] **Step 7: Run tests + typecheck**

Run: `pnpm --filter @bugzar/backend test -- jira-draft` then `pnpm --filter @bugzar/backend typecheck`
Expected: PASS.

- [x] **Step 8: Commit**

```bash
git add packages/backend/src/worker.ts packages/backend/src/__tests__/jira-draft-route.test.ts
git commit -m "feat(backend)!: /jira/draft takes capture artifacts inline + url (report-less)"
```

---

### Task 2: report-less publish route `POST /jira/issue`

`handlePublish` already ignores its `reportId` arg ([worker.ts:2038](../../../packages/backend/src/worker.ts)). Route it without an id and drop the advisory `reporter`.

**Files:**
- Modify: `packages/backend/src/worker.ts` (router + `handlePublish`)
- Test: `packages/backend/src/__tests__/jira-publish.test.ts` (extend)

- [x] **Step 1: Write the failing test**

```ts
it('publishes report-lessly via POST /jira/issue', async () => {
  const res = await worker.fetch(
    new Request('https://w/jira/issue', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://app.test' },
      body: JSON.stringify({ title: 'Bug: login', projectKey: 'QA' }),
    }),
    envStubJira(), // no JIRA creds → stubbed:true
  );
  expect(res.status).toBe(200);
  expect((await res.json()).stubbed).toBe(true);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bugzar/backend test -- jira-publish`
Expected: FAIL — no `/jira/issue` route (404).

- [x] **Step 3: Add the route + drop reporter**

In the request router, add `POST /jira/issue` → `handlePublish(req, env)`. Change
`handlePublish(req, env, _reportId)` → `handlePublish(req, env)`; remove the
`reporter` field from the body type and the `reporterName`/`reporterEmail`/`reporterLine`/
`qa-reporter:` lines (worker.ts ~2061-2068) — pass `null` for the reporter line:

```ts
  const adf = buildPublishAdf(body.descriptionAdf, body.description ?? '', null);
  const labels = ['bugzar'];
```

Keep `POST /reports/:id/publish` routing to a thin wrapper that calls `handlePublish(req, env)` for back-compat with the extension, OR remove it if the extension doesn't use it — verify with `grep -rn "reports/.*/publish" packages/extension`. (If unused, delete the old route.)

- [x] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @bugzar/backend test -- jira-publish` then `pnpm --filter @bugzar/backend typecheck`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/backend/src/worker.ts packages/backend/src/__tests__/jira-publish.test.ts
git commit -m "feat(backend)!: report-less POST /jira/issue; drop advisory reporter"
```

---

### Task 3: `ReviewDrawer` — inline artifacts + url, drop `reportId`/`user`

**Files:**
- Modify: `packages/sdk/src/ReviewDrawer.tsx`
- Test: `packages/sdk/src/__tests__/review-drawer.test.tsx`

- [x] **Step 1: Write the failing test**

Assert `aiPolish` POSTs to `/jira/draft` with inline `artifacts` + `url` (no `reportId`), and service-account publish POSTs to `/jira/issue`. Mock `fetch` and inspect the body. Model it on the existing `review-drawer.test.tsx` setup:

```tsx
it('drafts with inline artifacts + url and publishes to /jira/issue', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ title: 't', description: {}, issueKey: 'QA-1', issueUrl: 'u', stubbed: true }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }),
  );
  render(
    <ReviewDrawer
      mode="bug" endpoint="https://w" projectKey="QA"
      url="https://cdn/x.html" bundle={bundle as never}
      position="bottom-right" theme="light" onClose={() => {}}
    />,
  );
  fireEvent.click(screen.getByLabelText(/ai polish/i));
  await waitFor(() => {
    const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/jira/draft'));
    expect(call).toBeTruthy();
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.reportId).toBeUndefined();
    expect(body.url).toBe('https://cdn/x.html');
    expect(body.artifacts.meta).toBeTruthy();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bugzar/sdk test -- review-drawer`
Expected: FAIL — drawer still sends `reportId`, posts to `/reports/:id/publish`.

- [x] **Step 3: Update `ReviewDrawerProps`**

Remove `reportId: string` and `user?: …`; add `url?: string`. Drawer already has `bundle`
(bug) and `annotations` (design) to build the draft input.

- [x] **Step 4: Rework `aiPolish`**

```ts
  const aiPolish = useCallback(async () => {
    setAiError(false);
    setAiBusy(true);
    const userInput = [title, description].map((s) => s.trim()).filter(Boolean).join('\n\n');
    const draftBody =
      mode === 'design'
        ? {
            mode, userInput, url,
            elements: (annotations ?? []).map((a) => ({
              selector: a.selector, tagName: a.tagName, textContent: a.textContent,
              cssClasses: a.cssClasses, rect: a.rect,
              ...(a.componentName ? { componentName: a.componentName } : {}),
              ...(a.attributes ? { attributes: a.attributes } : {}),
              ...(a.figmaUrl ? { figmaUrl: a.figmaUrl } : {}),
              userNote: a.note,
            })),
            meta: { url: typeof location !== 'undefined' ? location.href : '', mode: 'design' },
          }
        : {
            mode, userInput, url,
            artifacts: bundle
              ? { meta: bundle.meta, events: bundle.events, console: bundle.console, network: bundle.network, storage: bundle.storage }
              : {},
          };
    try {
      const res = await fetch(`${base}/jira/draft`, {
        method: 'POST', headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(draftBody),
      });
      if (!res.ok) throw new Error(`draft ${res.status}`);
      const data = (await res.json()) as { title?: string; description?: unknown };
      const text = adfToText(data.description);
      if (data.title) setTitle(data.title);
      setDescription(text);
      aiAdfRef.current = data.description ?? null;
      aiTextRef.current = text;
    } catch {
      setAiError(true);
    } finally {
      setAiBusy(false);
    }
  }, [base, headers, mode, url, title, description, bundle, annotations]);
```

- [x] **Step 5: Rework the service-account `publish`**

In `publish`, replace the `body` + endpoint (worker.ts-side is `/jira/issue` now). Remove the `if (user) body.reporter = user` line:

```ts
      const body: Record<string, unknown> = { title: title.trim(), projectKey };
      if (epicKey) body.epicKey = epicKey;
      if (description.trim()) body.description = description;
      if (descAdf) body.descriptionAdf = descAdf;
      const res = await fetch(`${base}/jira/issue`, {
        method: 'POST', headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(body),
      });
```

Remove `reportId`, `user` from the `publish` dep array. The OAuth branch (`publishIssue`)
is unchanged — it already carries the link in `descriptionAdf` and needs no `reportId`.

- [x] **Step 6: Run tests + typecheck**

Run: `pnpm --filter @bugzar/sdk test -- review-drawer` then `pnpm --filter @bugzar/sdk typecheck`
Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add packages/sdk/src/ReviewDrawer.tsx packages/sdk/src/__tests__/review-drawer.test.tsx
git commit -m "feat(sdk)!: drawer posts inline artifacts + url, publishes report-lessly"
```

---

### Task 4: `Bugzar` Jira branch — `onExport` URL → drawer; remove Worker upload

**Files:**
- Modify: `packages/sdk/src/Bugzar.tsx`
- Test: `packages/sdk/src/__tests__/jira-oauth-drawer.test.tsx`

- [x] **Step 1: Write the failing test**

Assert that with `jira` + `endpoint` + `onExport`, stopping calls `onExport` (gets the url) and opens the drawer with that `url` — and `uploadBundle` is NOT called. Extend `jira-oauth-drawer.test.tsx` (it already exercises the drawer open); add the `@bugzar/sdk/export` mock and an `onExport` returning a URL, and assert the drawer renders (no network upload).

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bugzar/sdk test -- jira-oauth-drawer`
Expected: FAIL — current `stop()` calls `uploadBundle` and opens the drawer with `reportId`.

- [x] **Step 3: Change `DrawerState` to carry `url`, not `reportId`**

```ts
type DrawerState =
  | { mode: 'bug'; url?: string; bundle: ReportBundle }
  | { mode: 'design'; url?: string; annotations: DesignAnnotation[] };
```

- [x] **Step 4: Rewrite the Jira branch of `stop()`**

Replace the `if ((jira?.clientId || jira?.enabled) && endpoint) { uploadBundle(...).then(drawer) }`
block and the leftover `if (endpoint) runUpload(bundle)` (Plan A intermediate) with:

```ts
    const jiraOn = (jira?.clientId || jira?.enabled) && endpoint;
    if (onExport || jiraOn) {
      setUploading(true);
      buildReplayBlob(bundle)
        .then((blob) => onExport?.(blob, { ...bundle.meta, mode: 'session' }))
        .then((url) => {
          if (jiraOn) setDrawer({ mode: 'bug', bundle, ...(url ? { url } : {}) });
        })
        .catch((err) => onError?.(err instanceof Error ? err : new Error(String(err))))
        .finally(() => setUploading(false));
      return;
    }
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[bugzar] no onExport / jira configured — capture discarded');
    }
```

Delete `runUpload` (and its `useCallback`) and `runDesignUpload`. Update the `stop` dep
array: drop `runUpload`; ensure `onExport`, `jira`, `endpoint`, `onError` are present.

- [x] **Step 5: Rewrite the Jira branch of `startPick()` `onComplete`**

```ts
        onAnnotate?.(annotations);
        const jiraOn = (jira?.clientId || jira?.enabled) && endpoint;
        if (onExport || jiraOn) {
          const now = Date.now();
          setUploading(true);
          buildDesignBlob(annotations, snapshot)
            .then((blob) =>
              onExport?.(blob, {
                url: typeof location !== 'undefined' ? location.href : '',
                userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
                viewport: { width: typeof window !== 'undefined' ? window.innerWidth : 0, height: typeof window !== 'undefined' ? window.innerHeight : 0 },
                startedAt: now, endedAt: now, durationMs: 0, mode: 'design',
              }),
            )
            .then((url) => {
              if (jiraOn) setDrawer({ mode: 'design', annotations, ...(url ? { url } : {}) });
            })
            .catch((err) => onError?.(err instanceof Error ? err : new Error(String(err))))
            .finally(() => setUploading(false));
        }
```

Remove the old `window.open('', '_blank')` tab + `runDesignUpload` path.

- [x] **Step 6: Update the drawer render**

In the render (`if (drawer && endpoint)`), pass `url` instead of `reportId`, drop `user`:

```tsx
      <ReviewDrawer
        mode={drawer.mode}
        endpoint={endpoint}
        {...(drawer.url ? { url: drawer.url } : {})}
        projectKey={jira?.projectKey ?? ''}
        {...(jira?.clientId ? { clientId: jira.clientId } : {})}
        {...(jira?.defaultEpicKey ? { defaultEpicKey: jira.defaultEpicKey } : {})}
        {...(drawer.mode === 'bug' ? { bundle: drawer.bundle } : { annotations: drawer.annotations })}
        position={position}
        theme={theme}
        {...(onPublished ? { onPublished } : {})}
        onClose={() => setDrawer(null)}
      />
```

- [x] **Step 7: Run tests + typecheck**

Run: `pnpm --filter @bugzar/sdk test -- jira-oauth-drawer` then `pnpm --filter @bugzar/sdk typecheck`
Expected: PASS. **Remove `runExportCallback`** (Plan A) — the new combined block inlines build→`onExport`(→drawer) for BOTH the non-Jira and Jira paths, so `runExportCallback` is now dead. Delete it and its `useCallback`.

- [x] **Step 8: Commit**

```bash
git add packages/sdk/src/Bugzar.tsx packages/sdk/src/__tests__/jira-oauth-drawer.test.tsx
git commit -m "feat(sdk)!: Jira branch uses onExport URL; remove Worker report upload"
```

---

### Task 5: Remove `onUploaded` / `onBeforeUpload` / `user`; trim `upload.ts`

**Files:**
- Modify: `packages/sdk/src/Bugzar.tsx`, `packages/sdk/src/upload.ts`, `packages/sdk/src/public-types.ts`

- [x] **Step 1: Delete the props**

In `Bugzar.tsx` remove the `onUploaded`, `onBeforeUpload`, `user` prop decls + destructures + any remaining references (all should be gone after Task 4 deleted `runUpload`/`runDesignUpload`). Remove the now-unused `UploadResult` import.

- [x] **Step 2: Trim `upload.ts`**

Delete `uploadBundle` and `uploadDesign` (and the now-unused `CreateReportResponse`, `UploadOptions`, `UploadResult`, asset-PUT helpers, `buildReplayHtml` import). **Keep** `Endpoint` + `resolveEndpoint` (the drawer + Jira POSTs use them). Update `index.ts` exports: drop `uploadBundle`, `uploadDesign`, `UploadResult`; keep `Endpoint`.

- [x] **Step 3: Run tests + typecheck + build**

Run: `pnpm --filter @bugzar/sdk test` then `pnpm --filter @bugzar/sdk typecheck` then `pnpm --filter @bugzar/sdk build`
Expected: PASS; build clean. Delete `packages/sdk/src/__tests__/upload.test.ts` (covers the removed functions) or trim it to the `resolveEndpoint` cases.

- [x] **Step 4: Commit**

```bash
git add packages/sdk/src/Bugzar.tsx packages/sdk/src/upload.ts packages/sdk/src/public-types.ts packages/sdk/src/index.ts packages/sdk/src/__tests__/upload.test.ts
git commit -m "refactor(sdk)!: drop onUploaded/onBeforeUpload/user + Worker report upload"
```

---

### Task 6: Trim `useBugzar` (drop `endpoint`/`onUploaded`/`onBeforeUpload`)

**Files:**
- Modify: `packages/sdk/src/use-bugzar.ts`
- Test: `packages/sdk/src/__tests__/use-bugzar.test.tsx`

- [x] **Step 1: Delete the options**

Remove `endpoint`, `onUploaded`, `onBeforeUpload` from `UseBugzarOptions` and the
destructure; delete the `uploadBundle(...)` block in `stop()` (the hook is headless — no
drawer — so it has no Jira path; its only sink is `onExport`, added in Plan A). Remove the
`uploadBundle` / `UploadResult` / `Endpoint` imports.

- [x] **Step 2: Run tests + typecheck**

Run: `pnpm --filter @bugzar/sdk test -- use-bugzar` then `pnpm --filter @bugzar/sdk typecheck`
Expected: PASS (delete any test asserting hook upload-on-`endpoint`).

- [x] **Step 3: Commit**

```bash
git add packages/sdk/src/use-bugzar.ts packages/sdk/src/__tests__/use-bugzar.test.tsx
git commit -m "refactor(sdk)!: useBugzar drops endpoint/onUploaded/onBeforeUpload"
```

---

### Task 7: README + example — `endpoint` is Jira-only

**Files:**
- Modify: `packages/sdk/README.md`, `packages/sdk/example/src/App.tsx`

- [x] **Step 1: README**

Rewrite the `endpoint` section: it is the **Jira backend only** (auth + AI draft + issue creation); web sharing is `onExport` → R2/S3. Update the Jira section to show `onExport` + `jira` + `endpoint` together, and note the ticket links to the `onExport` URL. Remove `onUploaded`/`onBeforeUpload`/`user` rows and any "View replay via Worker" prose.

- [x] **Step 2: example**

Update `example/src/App.tsx` so the Jira example sets `onExport` (returns a URL) alongside `jira` + `endpoint`; drop `onUploaded`/`onBeforeUpload`/`user`.

- [x] **Step 3: Build + verify**

Run: `pnpm --filter @bugzar/sdk build` then `pnpm --filter @bugzar/sdk typecheck`
Expected: clean.

- [x] **Step 4: Commit**

```bash
git add packages/sdk/README.md packages/sdk/example/src/App.tsx
git commit -m "docs(sdk): endpoint is Jira-only; sharing via onExport → R2/S3"
```

---

## Self-review notes

- **Spec coverage:** endpoint = Jira-only ✓ (Tasks 1-2, 4); `/jira/draft` inline + fallback ✓ (Task 1, fallback pre-existing); report-less publish ✓ (Task 2); ticket links to `onExport` URL ✓ (Task 1 ADF + Task 4 plumbing); remove `onUploaded`/`onBeforeUpload`/`user` ✓ (Task 5); trim `upload.ts`/hook ✓ (Tasks 5-6); README/example ✓ (Task 7).
- **Type consistency:** `ExportMeta` reused from Plan A; `DraftInputArtifacts = { meta, events, console, network, storage }` ([jira-draft.ts:167](../../../packages/backend/src/jira-draft.ts)) is what the drawer sends (Task 3) and the handler receives (Task 1); `DesignElementInput` is the design draft shape.
- **Verify-on-execution (named, not vague):** (a) `jsonToBugAdf`/`jsonToDesignAdf` link-node guard on empty `replayUrl` (Task 1 Step 6) — confirm the exact node-build site. (b) Whether `packages/extension` still calls `POST /reports/:id/publish` (Task 2 Step 3) — `grep` decides keep-wrapper vs delete.
- **Backend test harness:** match the `env`/`worker.fetch` mock pattern already used by sibling tests in `packages/backend/src/__tests__/` (don't invent a new harness).
