# Self-hosting the Bugzar backend (for `@bugzar/sdk`)

This guide is for a team/company that wants to drop `@bugzar/sdk` into their own
frontend and have uploads, replays, AI drafts, and Jira publishing run on **their
own infrastructure**. You deploy one Cloudflare Worker; the SDK points at it.

## Architecture

```
┌─────────────────────────────┐         ┌──────────────────────────────────────┐
│  Your web app (browser)      │  HTTPS  │  Your Cloudflare Worker (@bugzar/backend) │
│  ─────────────────────────   │ ──────▶ │  ──────────────────────────────────   │
│  <Bugzar endpoint=… />   │         │   R2 (ARTIFACTS) — rrweb data + replay │
│  rrweb · console · network   │         │   Workers AI (AI) — /jira/draft        │
│  PUBLIC config only          │         │   Jira service account — publish       │
└─────────────────────────────┘         └──────────────────────────────────────┘
        public, anyone can read                 secrets live HERE, never in the browser
```

**The security boundary:** the browser holds only public config (the Worker URL,
maybe a public-safe header). The privileged secrets — the Jira API token,
Atlassian creds — live as **Worker secrets** and never reach the page. Publishing
is done by the Worker's service account, so the browser never holds a Jira token.

`@bugzar/backend` is **not published to npm** (`private: true`). You deploy it from
this repository (or your fork).

## Pick your tier — start minimal, add later

| Tier | You configure | You get | Missing pieces degrade to |
|------|---------------|---------|---------------------------|
| **0 — no backend** | nothing | `onSubmit` callback / JSON download | — (no deploy at all) |
| **1 — upload + replay** | R2 bucket | shareable rrweb replay at `/r/:id` | AI draft → deterministic stub · publish → `STUB-…` |
| **2 — + AI drafts** | R2 + Workers AI binding | real AI "polish" drafts in the drawer | publish → `STUB-…` |
| **3 — + real Jira** | R2 + AI + Jira secrets | files real Jira issues | — (full feature set) |

Every tier is honest: a missing Jira config returns a `stubbed: true` placeholder
the drawer surfaces as **"not a real issue"** — it never fabricates a filed bug.

## Step-by-step

You need a **Cloudflare account** (R2 + Workers, both have free tiers) and, for
Tier 3, a **Jira Cloud** site + an API token from a service account.

```bash
# 0. Get the backend source (this repo or your fork) and install
pnpm install

# 1. Log in to YOUR Cloudflare account
pnpm --filter @bugzar/backend exec wrangler login

# 2. Create the R2 bucket the Worker writes to  (Tier 1+)
pnpm --filter @bugzar/backend r2:create        # → wrangler r2 bucket create bugzar-artifacts

# 3. (Tier 3) Provision Jira service-account creds — all four, or none (→ stub)
pnpm --filter @bugzar/backend exec wrangler secret put JIRA_API_BASE      # https://your-org.atlassian.net
pnpm --filter @bugzar/backend exec wrangler secret put JIRA_EMAIL         # service-account email
pnpm --filter @bugzar/backend exec wrangler secret put JIRA_API_TOKEN     # id.atlassian.com/manage-profile/security/api-tokens
pnpm --filter @bugzar/backend exec wrangler secret put JIRA_PROJECT_KEY   # e.g. ACME

# 4. Lock down a PUBLIC Worker (STRONGLY recommended in prod)
pnpm --filter @bugzar/backend exec wrangler secret put ALLOWED_ORIGINS    # https://app.yourco.com,https://staging.yourco.com
pnpm --filter @bugzar/backend exec wrangler secret put ALLOWED_PROJECT_KEYS  # ACME,WEB   (optional)
pnpm --filter @bugzar/backend exec wrangler secret put UPLOAD_SECRET      # any long random string — binds writes to their report
#   …and set PUBLIC_DEPLOY=1 (var) in wrangler.toml so an unset ALLOWED_ORIGINS
#   fails closed and the `/` enumeration index is hidden. PUBLIC_INDEX=1 re-exposes it.

# 5. Deploy — wrangler prints your Worker URL
pnpm --filter @bugzar/backend deploy           # → https://bugzar-backend.<your-subdomain>.workers.dev
```

Workers AI (Tier 2) needs **no extra step** — the `[ai]` binding is already in
`packages/backend/wrangler.toml`. It's on the Cloudflare Free plan up to 10k
neurons/day.

## Configuration reference

Bindings live in `packages/backend/wrangler.toml`; secrets are set with
`wrangler secret put`.

| Name | Kind | Required | Purpose | If unset |
|------|------|----------|---------|----------|
| `ARTIFACTS` | R2 binding | **Yes** (Tier 1+) | stores rrweb assets + replay HTML | upload fails |
| `AI` | Workers AI binding | No | real `/jira/draft` AI drafts | deterministic stub draft (still 200) |
| `ALLOWED_ORIGINS` | secret | Recommended | comma-sep browser Origins allowed to write/publish/search epics/draft/oauth | open in dev; **denied** when `PUBLIC_DEPLOY` is set |
| `PUBLIC_DEPLOY` | var | **Yes for public** | set to `1` on any internet-exposed Worker so an unset `ALLOWED_ORIGINS` fails closed (no anonymous writes) and the `/` index is hidden | unset = local-dev defaults (open) |
| `UPLOAD_SECRET` | secret | Recommended | HMAC secret binding each asset write to the report that issued the token (`POST /reports` → `uploadToken`; PUT echoes it as `X-Upload-Token`). Stops cross-report overwrite/IDOR-write | unset = token checks skipped (dev) |
| `PUBLIC_INDEX` | var | No | set to `1` to expose the `GET /` report index on a public deploy | hidden on public deploy; report URLs stay reachable by their unguessable id |
| `ALLOWED_PROJECT_KEYS` | secret | No | comma-sep Jira projects an SDK caller may target | any shape-valid key allowed |
| `JIRA_API_BASE` / `JIRA_EMAIL` / `JIRA_API_TOKEN` / `JIRA_PROJECT_KEY` | secrets | No (all-or-nothing) | real Jira publishing | publish returns honest `STUB-…` |
| `PUBLIC_HOST` | var | No | host advertised for artifact URLs | Worker proxies `/artifacts/:key` itself |
| `ADMIN_SECRET` | secret | No | enables `DELETE /reports/:id` (+ delete CLI) | delete endpoint returns 501 |
| `AI_MODEL_BUG` / `AI_MODEL_DESIGN` | secrets/vars | No | override the Workers AI model | default Llama 3.1 8B |
| `ATLASSIAN_CLIENT_ID` / `ATLASSIAN_CLIENT_SECRET` | secrets | No (per-user OAuth) | `jira.clientId` 3LO publish — token exchange at `/oauth/exchange` + `/oauth/callback` | endpoint returns 501 |

## Wire up the SDK (your frontend app)

```bash
npm install @bugzar/sdk        # React 18+ peer dependency
```

The SDK reads **no environment variables itself** — your app reads its own env
and passes them as props:

```tsx
// Next.js example — NEXT_PUBLIC_* is exposed to the browser (that's fine: it's just a URL)
import { Bugzar } from '@bugzar/sdk';

export function QAWidget() {
  return (
    <Bugzar
      endpoint={process.env.NEXT_PUBLIC_BUGZAR_ENDPOINT}        // your deployed Worker URL
      jira={{ enabled: true, projectKey: 'ACME' }}           // Tier 3 — opens the review drawer
      user={{ name: currentUser.name, email: currentUser.email }}
      onPublished={({ issueKey, issueUrl, stubbed }) => {
        if (!stubbed) window.open(issueUrl);                 // a real issue was filed
      }}
    />
  );
}
```

```bash
# .env (your app)         Vite: VITE_BUGZAR_ENDPOINT          CRA: REACT_APP_BUGZAR_ENDPOINT
NEXT_PUBLIC_BUGZAR_ENDPOINT=https://bugzar-backend.<your-subdomain>.workers.dev
```

If your Worker sits behind an auth gateway, pass a **public-safe** header (a
scoped/short-lived token — never the Jira token):

```tsx
endpoint={{ url: process.env.NEXT_PUBLIC_BUGZAR_ENDPOINT, headers: { Authorization: `Bearer ${publicToken}` } }}
```

> ⚠️ Anything you pass to the SDK runs in the **browser** and is visible to end
> users (bundle + network tab). Only ever put public-safe values there. Real
> secrets belong in the Worker.

## Cross-origin (CORS)

Your app (`https://app.yourco.com`) and your Worker
(`https://bugzar-backend.<sub>.workers.dev`) are different origins. This works out
of the box:

- The Worker answers preflight with `Access-Control-Allow-Origin: *`,
  methods `GET, POST, PUT, DELETE, OPTIONS`, headers `Content-Type, Authorization`.
  No cookies are used, so wildcard CORS is safe.
- **Separately**, the publish + epic-search routes enforce `ALLOWED_ORIGINS` at
  the application layer (HTTP 403 if your app's Origin isn't listed). Set it in
  production so only your own apps can file issues through your Worker.

## Verify the deployment

```bash
# health + which mode Jira/AI are in
curl https://bugzar-backend.<sub>.workers.dev/__state

# report allocation works (returns reportId + assetUrls)
curl -X POST https://bugzar-backend.<sub>.workers.dev/reports
```

Then, in your app: record → the drawer opens → AI polish → Publish. Open the
replay at `https://bugzar-backend.<sub>.workers.dev/r/<reportId>` and confirm the
Jira issue (Tier 3) or the honest `STUB-…` (Tier 1–2).

## Local development

```bash
pnpm --filter @bugzar/backend dev          # http://127.0.0.1:8787 with a local R2 simulator
```

Point the SDK at it: `endpoint="http://127.0.0.1:8787"` (leave `ALLOWED_ORIGINS`
unset for local dev so `http://localhost:*` passes). Stream prod logs with
`pnpm --filter @bugzar/backend tail`.

## Operational notes & limits

- **Retention:** a daily cron (02:00 UTC) removes orphaned uploads (no
  `replay.html`, > 24h) and reports older than 6 months.
- **Free tiers:** R2, Workers AI (10k neurons/day), and Analytics Engine
  (telemetry; degrades to `console.log` when the binding is absent).
- **Single-tenant by design:** one Worker per company keeps each tenant's R2 data
  and Jira creds isolated. Serving **many** companies from **one** shared Worker
  (multi-tenant SaaS) needs an added per-tenant auth + R2-prefix isolation layer
  that is **not built** — run a Worker per tenant instead.
