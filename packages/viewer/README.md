# `@bugzar/viewer`

A **replay + design-review viewer** for Bugzar reports — a Vite/React SPA
that's **bundled into and served by the `bugzar-backend` Worker** (Cloudflare Static
Assets, mounted at `/v/`). The SDK/extension upload a full QA bundle to the Worker
— rrweb DOM events **plus** console, network, storage, resources, and app-state,
each a JSON asset in R2 — and this app reads those assets and renders a
DevTools-style view: rrweb replay on the left, searchable data panels (with
expandable request/response detail) on the right, synced to the timeline.

One Worker, one deploy, one origin: the viewer reads a report from the **same
origin** that serves it, so there's no CORS and no separate hosting.

## Opening a report

The Worker's share URL redirects into the viewer:

```
https://<worker>/r/<reportId>     →  302  →  https://<worker>/v/?id=<reportId>
```

- `id` — the report id (required).
- `endpoint` — **optional** override; defaults to the viewer's own origin (the
  Worker). Pass `?endpoint=<other-worker>` only to view a different Worker's report.

On load it fetches, in parallel, from `<endpoint>/reports/<id>/`: `meta.json`,
`events.json`, `console.json`, `network.json`, `storage.json`, `resources.json`,
`state.json`, `design.json`. Each asset is independently optional — a `404`/parse
failure degrades that panel to empty rather than failing the whole view.

### Two report modes

- **Session** — a recorded rrweb session. Player + data sidebar. The scrubber
  carries error ticks (console errors + failed requests) with prev/next-error jump;
  clicking a row seeks the player; network/console rows expand to full detail.
  `events.json` is the one "primary" asset — if it's missing (or `< 2` events,
  which rrweb can't replay) the replay pane shows an empty state, panels still render.
- **Design** — Pick/click annotations (no rrweb). A card per annotated element
  (selector · tag · component · note). Detected from `meta.mode === 'design'`.

### Schema version

The capture schema is versioned by `SCHEMA_VERSION` in `@bugzar/shared`. The SDK
stamps it into `meta.json`; the viewer shows a **version-mismatch** state instead
of mis-rendering an older/newer report.

## Develop

```sh
pnpm --filter @bugzar/viewer dev        # vite dev server (port 5373); ?id=&endpoint= in the URL
pnpm --filter @bugzar/viewer typecheck
pnpm --filter @bugzar/viewer test       # vitest (happy-dom)
pnpm --filter @bugzar/viewer build      # → dist/ (base '/'); set VITE_BASE=/v/ for the Worker bundle
pnpm --filter @bugzar/viewer exec playwright test   # e2e against the built viewer + fixtures
```

## Deploy

The viewer is a static SPA — build it and serve the assets from your backend
(or any static host) under the base path reports are fetched from:

```sh
VITE_BASE=/v/ pnpm --filter @bugzar/viewer build
```

Serve the built `dist/` under `/v/` with the usual static security headers
(CSP, X-Frame-Options, etc., scoped to `/v/*`).

### SDK "View replay"

No viewer config — just set `endpoint`. The backend's `reportUrl` (`<endpoint>/r/<id>`)
redirects to the viewer it serves:

```tsx
<Bugzar endpoint="https://your-bugzar-backend.example.com" />
```

> **Access:** reports are **public-by-URL** today — anyone with the `/r/<id>` link
> can view a report. Access control is out of scope for v1.
