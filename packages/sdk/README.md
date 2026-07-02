# @bugzar/sdk

Embeddable in-app **QA session recorder** for any React frontend. Drop in one
component and capture a replayable bug report — rrweb DOM, console, network, and
storage — with no browser extension.

```bash
npm install @bugzar/sdk
```

## Usage

```tsx
import { Bugzar } from '@bugzar/sdk';

function App() {
  return (
    <>
      <YourApp />
      <Bugzar
        onExport={async (blob, meta) => uploadToYourStorage(`qa/${meta.startedAt}.html`, blob)}
      />
    </>
  );
}
```

A floating **QA** button appears in the bottom-right corner. Click to start
recording, interact with your app, then click again to stop. A **self-contained
replay HTML** is built and handed to `onExport`, which uploads it to your own
storage (S3/R2/…) — that URL is the shareable replay.

## What it captures

- **DOM** — full rrweb recording, replayable with `rrweb-player`
- **Console** — every level (`log`/`info`/`warn`/`error`/`debug`) + grouping, with stack traces
- **Network** — `fetch` and `XMLHttpRequest` (method, URL, status, headers, bodies, timing)
- **Storage** — `localStorage` / `sessionStorage` snapshots (cookies are never captured)
- **Web Vitals** — LCP / CLS / INP / TTFB

## Privacy & redaction

Captured data is **token-scrubbed at capture time**, before it ever leaves the page:

- **Inputs** — `rrweb` always masks password fields; set `mask` to mask all text inputs.
- **Network** — request/response bodies have values under sensitive keys
  (`password`, `token`, `authorization`, `secret`, `api_key`, …) **and any
  JWT-shaped value** replaced with `[REDACTED]`; credential headers are masked.
- **Storage** — values under sensitive keys, bare JWTs, and token sub-keys inside
  JSON values (e.g. Supabase/Auth0 `{ access_token, refresh_token }`) are redacted.
  Cookies are **never** captured.
- **Console** — `Bearer` tokens and embedded JWTs in log args are scrubbed.
- **App-state** — `captureState` snapshots get the same key/JWT masking, then your `redactState`.

This is best-effort, **not a guarantee**: free-form bodies (custom RPC frames,
GraphQL with inline literals) can't be auto-redacted without false positives. For
app-state you control the output via **`redactState`**; elsewhere, mask
aggressively (**`mask`**) and avoid surfacing secrets the built-in key/JWT
redaction can't catch. When self-hosting, report URLs are public-by-URL — treat
them accordingly.

## Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `onExport` | `(blob: Blob, meta: ExportMeta) => Promise<string \| void>` | – | Receive the built self-contained replay HTML on stop / pick-finish. Upload it to your storage (S3/R2/…) and return the public URL. `meta.mode` is `'session'` or `'design'`. |
| `onStart` | `() => void` | – | Called when recording starts. |
| `mask` | `boolean` | `true` | Mask all text inputs (passwords are always masked regardless). |
| `position` | `'bottom-right' \| 'bottom-left' \| 'top-right' \| 'top-left'` | `'bottom-right'` | Toolbar corner. |
| `offset` | `number \| { x?: number; y?: number }` | `20` | Inset (px) from the anchored corner edges. A number sets both axes; `{ x, y }` sets them independently (a missing axis falls back to 20). Applies to the toolbar and the review drawer. |
| `theme` | `'light' \| 'dark' \| 'auto'` | `'auto'` | Color theme. |
| `autoHide` | `boolean` | `false` | Tuck the toolbar off the anchored edge; it slides in only while the cursor is over the corner `hoverZone`, while in use, or for 2s after. Mouse-only. |
| `hoverZone` | `{ width?: number; height?: number }` | `{ width: 300, height: 30 }` | Size (px) of the invisible corner region you hover to reveal the auto-hidden toolbar — shrink it when the default zone overlaps your own UI. A missing axis keeps its default. Only used when `autoHide` is on. |
| `endpoint` | `string \| { url: string; headers?: Record<string, string> }` | – | Bugzar backend base URL — the **Jira backend only** (auth + AI draft + server-side issue creation). Set together with `jira` to enable the review drawer. Use the object form to send auth headers on every request. |
| `onError` | `(error: Error) => void` | – | Called if `onExport` or a publish attempt fails. |
| `design` | `boolean` | `true` | Show the "Pick" button for design-feedback element annotation. |
| `onAnnotate` | `(annotations: DesignAnnotation[]) => void` | – | Called with the picked elements + notes on Done (a notification — `onExport` still produces the design HTML). |
| `jira` | `{ clientId?: string; enabled?: boolean; defaultEpicKey?: string }` | – | Enable the **review drawer** (requires `endpoint`). With `clientId` it's per-user OAuth (filed as the reviewer); with `enabled` it uses the backend's service account. The project is derived from the chosen Epic (`BUGZAR-123` → `BUGZAR`). The ticket links to the `onExport` URL. See [Jira publishing](#jira-publishing-optional). |
| `onPublished` | `(result: { issueKey: string; issueUrl: string; stubbed: boolean }) => void` | – | Called after a publish attempt. `stubbed === true` means the backend was unconfigured and **no real issue was created** — do not treat it as filed. |
| `captureState` | `() => unknown` | – | Capture host app-state into the bundle's `state` timeline at start/stop/throttle. Each snapshot is serialized + redacted. |
| `redactState` | `(state: unknown) => unknown` | – | Redact each state snapshot (runs after the built-in key/JWT masking). |

## The bundle

```ts
interface ReportBundle {
  events: RrwebEvent[];          // rrweb — replay with rrweb-player
  console: ConsoleEntry[];
  network: NetworkEntryPayload[];
  storage: StorageSnapshotPayload[];
  vitals: WebVitals;             // lcp / cls / inp / ttfb
  resources: ResourceTimingEntry[]; // Resource Timing waterfall (store-only)
  state: StateSnapshot[];        // host app-state timeline (via captureState)
  system: SystemInfo;            // device/browser/environment snapshot (store-only)
  meta: {
    url: string; userAgent: string;
    viewport: { width: number; height: number };
    startedAt: number; endedAt: number; durationMs: number;
  };
}
```

All types are exported from the package.

## Design feedback (element picker)

The toolbar's **Pick** button starts an in-page element picker — hover to
highlight, click to select, and add a note per element. On Done you get
structured annotations an AI agent can `grep` for:

```tsx
<Bugzar
  onAnnotate={(annotations) => {
    annotations.forEach((a) => console.log(a.selector, a.componentName, a.note));
    // e.g. "main > button.primary"  "<SubmitButton>"  "spacing looks off"
  }}
/>
```

```ts
interface DesignAnnotation {
  id: string;
  selector: string;        // unique CSS selector
  tagName: string;
  textContent: string;
  cssClasses: string;
  rect: { x: number; y: number; width: number; height: number };
  componentName?: string;  // React component name, when detectable
  note: string;
}
```

Set `design={false}` to hide the Pick button. `startDesignPick()` is also
exported for programmatic use.

## Web sharing — bring your own storage

`onExport` hands you the **self-contained replay HTML** (the full viewer + data
inlined). Upload it to any static host (S3, R2, GitHub Pages, …) and that URL is
the shareable replay — no Bugzar backend needed.

Just want a file to attach (no host)? Mount `<Bugzar />` with no `onExport` and
the HTML auto-downloads (plus a result chip). That fallback is the bundled
**`downloadReplay`** — import it directly only to reuse the same save inside a
custom `onExport`.

```tsx
<Bugzar
  onExport={async (blob, meta) => {
    const key = `qa/${meta.mode}-${meta.startedAt}.html`;
    await fetch(presignedPutUrl(key), { method: 'PUT', body: blob });
    return publicUrl(key); // returning the URL lets a Jira ticket link to it
  }}
/>
```

`onExport` fires on recording stop **and** design-pick finish (`meta.mode` is
`'session'` or `'design'`). The returned URL becomes the Jira ticket's replay link
when `jira` + `endpoint` are configured (below). The backend (`endpoint`) is the
**Jira backend only** — it never hosts reports, and its implementation lives
outside this repo.

## Jira publishing (optional)

Set `jira` **and** `endpoint` to turn stop into a **review drawer** that files a
Jira issue for you:

```tsx
<Bugzar
  endpoint="https://your-bugzar-backend.example.com"
  jira={{ enabled: true, defaultEpicKey: 'BUGZAR-1' }}
  onExport={async (blob, meta) => uploadToYourStorage(`qa/${meta.startedAt}.html`, blob)}
  onPublished={({ issueKey, issueUrl, stubbed }) => {
    if (!stubbed) window.open(issueUrl); // a real issue was filed
  }}
/>
```

On stop the bundle uploads, then the drawer opens with a read-only **capture
summary** (events · console errors · failed requests · LCP), an editable
Title / Description / Epic, and an **AI polish** button that drafts the issue
from the captured session. The **Epic** field resolves a full key
(`CBPFE-3991`), a bare issue number (`3991`), or a pasted Jira browse URL
(`…/browse/CBPFE-3991`). Publishing files the issue through the backend's Jira
service account — the browser never holds an Atlassian token.

> **Requires a configured backend + Jira service account.** If the backend is not
> configured, publish returns a `STUB-…` placeholder: the drawer surfaces it as
> explicitly **not a real issue** (no clickable link) and `onPublished` receives
> `stubbed: true`. Never treat a stubbed result as filed.

The **Annotate** button shares the same drawer in design-feedback mode — pick
elements, annotate, and file a design issue the same way.

### Per-user OAuth (file as the reviewer)

Pass `jira.clientId` (instead of / in addition to `enabled`) to switch the drawer
to **per-user Atlassian OAuth**: each reviewer connects their own account once and
the ticket is filed **as them** — no shared service account.

```tsx
<Bugzar
  endpoint="https://your-bugzar-backend.example.com"
  jira={{ clientId: 'YOUR_ATLASSIAN_OAUTH_CLIENT_ID', defaultEpicKey: 'BUGZAR-1' }}
/>
```

On stop/finish the report uploads, then the drawer shows **Connect Atlassian** for
a first-time reviewer (a login popup; the session is saved in `localStorage` for
next time). Once connected it shows the AI-drafted ticket + the connected account,
and **File Jira ticket** files it as that user. The secret never touches the
browser — only the public `clientId` is a prop; the token exchange runs on the
backend.

> **Token custody:** the long-lived **refresh token is never written to
> `localStorage`** — it lives in memory for the tab only, so a same-origin
> script/XSS can't steal a durable credential. The trade-off: after a full page
> reload (or in another tab), the drawer works until the access token expires
> (~1h), then asks the reviewer to reconnect with the same one-click popup.

**One-time setup** (Atlassian admin + backend owner):

1. In the Atlassian developer console, create an OAuth 2.0 (3LO) app with the Jira
   scopes and register the redirect URI at your backend's `/oauth/callback`.
2. Configure the OAuth client id + secret on your backend service (never in the
   client bundle).
3. Pass the same client id as `jira.clientId`.

> Reviewers must have permission to create issues in the target project (derived
> from the chosen Epic) on a Jira site their account can access.

## Headless engine (`useBugzar`)

Want your own "Report a bug" button instead of the floating toolbar? Drive the
same start/stop/upload engine from a hook:

```tsx
import { useBugzar } from '@bugzar/sdk';

function MyButton() {
  const { recording, elapsed, start, stop } = useBugzar({ endpoint });
  return (
    <button onClick={recording ? stop : start}>
      {recording ? `Stop (${elapsed}s)` : 'Report a bug'}
    </button>
  );
}
```

## How it works

`<Bugzar />` mounts a floating toolbar into `document.body` via a React
portal (SSR-safe) and instruments the page only while recording — it patches
`console`, `fetch`/`XHR`, and storage, runs rrweb, and restores everything on
stop. The capture engine (`@bugzar/capture-core`) has **zero `chrome.*`
dependencies**.

## Requirements

- `react` **and** `react-dom` ≥ 18 (peer dependencies)
- A browser (capture is DOM-based; SSR renders nothing until hydration)

Server-side Jira publishing (`jira`, M4), Resource Timing + app-state capture
(`captureState`, M5/M6) shipped on top of upload + replay URL (`endpoint`, M2)
and the design element picker (`onAnnotate`, M3).

## License

Apache-2.0
