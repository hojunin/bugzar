# @bugzar/backend

Cloudflare Worker that backs the Bugzar extension. Same wire format as
the in-process mock backend used by E2E tests — drop-in replacement once
deployed.

## Deploy in one command

```bash
git clone https://github.com/hojunin/bugzar && cd bugzar
pnpm run deploy:backend
```

That installs deps, logs into Cloudflare (browser, first time only), creates the
R2 bucket, builds the viewer, and deploys the Worker — then prints the URL to use
as the SDK `endpoint` (`<Bugzar endpoint="…" />`). Workers AI + Analytics
Engine need no extra setup. Jira is optional (the script prints those steps at the
end; see also [Jira publishing](../sdk/README.md#jira-publishing-optional)). The
manual breakdown is below.

## What it does

| Endpoint | Purpose |
|---|---|
| `POST /upload` | multipart upload of the exported replay HTML → stored in R2 |
| `GET /artifacts/:key` | serves a stored artifact (proxied through the Worker) |
| `POST /jira/issue` | creates a Jira issue (stub mode if creds are missing) |
| `GET /__state` | health check + which mode (stub/real) Jira is in |

## One-time setup

```bash
# 1. Install wrangler (workspace-local)
pnpm install

# 2. Log in to your Cloudflare account
pnpm --filter @bugzar/backend exec wrangler login

# 3. Create the R2 bucket the Worker will write to
pnpm --filter @bugzar/backend r2:create
#   → wraps `wrangler r2 bucket create bugzar-artifacts`

# 4. (Optional) Provision Jira creds. Skip to run in stub mode.
pnpm --filter @bugzar/backend exec wrangler secret put JIRA_API_BASE     # e.g. https://your-org.atlassian.net
pnpm --filter @bugzar/backend exec wrangler secret put JIRA_EMAIL        # your Atlassian email
pnpm --filter @bugzar/backend exec wrangler secret put JIRA_API_TOKEN    # https://id.atlassian.com/manage-profile/security/api-tokens
pnpm --filter @bugzar/backend exec wrangler secret put JIRA_PROJECT_KEY  # e.g. BUGZAR
```

## Develop locally

```bash
pnpm --filter @bugzar/backend dev
# wrangler dev runs the Worker on http://127.0.0.1:8787 by default with a
# local R2 simulator (data is per-process; gone when you Ctrl-C).
```

Point the extension at the local dev Worker by opening its Options page and
setting:

```
uploadUrl:     http://127.0.0.1:8787/upload
jiraCreateUrl: http://127.0.0.1:8787/jira/issue
```

## Deploy

```bash
pnpm --filter @bugzar/backend deploy
# After deploy, wrangler prints the public URL, e.g.
#   https://bugzar-backend.<your-subdomain>.workers.dev
```

Update the extension's Options page with the deployed Worker URL +
`/upload` and `/jira/issue` paths.

Extension settings to use (substitute your own subdomain):
```
uploadUrl:     https://bugzar-backend.<your-subdomain>.workers.dev/upload
jiraCreateUrl: https://bugzar-backend.<your-subdomain>.workers.dev/jira/issue
```

## Tail logs in prod

```bash
pnpm --filter @bugzar/backend tail
```

## Notes

- **CORS** is `*` for now. Tighten to `chrome-extension://<id>` once we pin
  a production extension ID.
- **PUBLIC_HOST** (var in wrangler.toml) is empty by default — the Worker
  proxies artifacts itself at `/artifacts/:key`. Set it to a CDN-fronted
  custom domain later if you want shorter URLs / cheaper egress.
- **Video upload is not yet split out** — replay HTML still inlines video
  chunks as base64. Splitting `replay.html` and `video.webm` into separate
  R2 objects is the next planned change.
- **Migration to S3**: the wire format is provider-agnostic. Swap
  `env.ARTIFACTS.put(...)` for an AWS SDK call (or presigned PUT) and the
  extension doesn't need to change.
