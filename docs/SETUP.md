# Backend & Atlassian setup

`@bugzar/sdk` 를 실제로 운영하려면 (1) `@bugzar/backend` Worker 를 배포하고, (2) Jira
발행을 쓸 거면 Atlassian 을 셋업한다. Worker 배포·R2·시크릿·CORS·검증의 **전체
흐름**은 [`self-hosting-sdk.md`](./self-hosting-sdk.md) 에 Tier 0–3 으로 정리돼 있다.
이 문서는 그중 손이 많이 가는 **Atlassian OAuth 앱 등록**(per-user 발행용 granular
scope)과 org admin 을 상세히 다룬다.

The code is written with graceful fallbacks, so it builds and tests pass even
before any of this is configured.

---

## 1. Atlassian OAuth 앱 (per-user 발행)

> 서비스 계정 방식(`jira.enabled` + `JIRA_API_TOKEN`)만 쓰면 이 섹션은 건너뛴다 —
> 셋업은 [`self-hosting-sdk.md` Tier 3](./self-hosting-sdk.md#step-by-step). per-user
> OAuth(`jira.clientId`, 리뷰어 본인 계정으로 발행)를 쓸 때만 아래가 필요하다.

### 1.1 Register the Atlassian OAuth app

1. Go to https://developer.atlassian.com/console/myapps/ → **Create** →
   "OAuth 2.0 integration".
2. **Permissions → Add 'Jira API' → Configure**, then enable the granular
   scopes below. If any are missing, Atlassian silently drops them and the
   dependent endpoint fails with `401 Unauthorized; scope does not match`.

   | Scope | Used by |
   |---|---|
   | `read:issue:jira` | POST /issue read-back |
   | `write:issue:jira` | POST /issue |
   | `write:comment:jira` | POST /issue |
   | `write:comment.property:jira` | POST /issue |
   | `write:attachment:jira` | POST /issue |
   | `read:project:jira` | GET /project/search |
   | `read:project.property:jira` | GET /project/search |
   | `read:project-category:jira` | GET /project/search |
   | `read:project-version:jira` | GET /project/search |
   | `read:project.component:jira` | GET /project/search |
   | `read:application-role:jira` | GET /project/search |
   | `read:group:jira` | GET /project/search |
   | `read:issue-type-hierarchy:jira` | GET /project/search |
   | `read:avatar:jira` | GET /project/search, /search/jql |
   | `read:user:jira` | GET /project/search |
   | `read:issue-type:jira` | GET /project/search |
   | `read:issue-details:jira` | GET /search/jql |
   | `read:issue-meta:jira` | GET /search/jql |
   | `read:field-configuration:jira` | GET /search/jql |
   | `read:audit-log:jira` | GET /search/jql |
   | `read:jql:jira` | GET /search/jql |
   | `read:issue-status:jira` | Epic dropdown status |
   | `read:email-address:jira` | draft prefill |

   `offline_access` is added automatically (for the refresh token). The
   scope ↔ endpoint mapping comes from Atlassian's published OpenAPI spec;
   verify any entry with:
   ```sh
   curl -sL https://dac-static.atlassian.com/cloud/jira/platform/swagger-v3.v3.json \
     | jq '.paths."/rest/api/3/project/search".get."x-atlassian-oauth2-scopes"'
   ```

   > `GET /rest/api/3/myself` is intentionally **not** called — its granular
   > mapping lives in a separate User Identity API app group. The issue
   > reporter is auto-filled by Atlassian from the token holder.

3. **Authorization → "OAuth 2.0 (3LO)" → Add**:
   - Callback URL: `https://bugzar-backend.<your-subdomain>.workers.dev/oauth/callback`
     (your deployed Worker URL).
4. **Settings → copy the Client ID and Client Secret.**

### 1.2 Put the secret on the Worker

Atlassian's 3LO apps are confidential clients: the token exchange requires the
`client_secret` alongside the PKCE `code_verifier` (pure PKCE returns
`401 access_denied`). The secret lives on the **Worker**, never in the browser:

```sh
wrangler secret put ATLASSIAN_CLIENT_ID
wrangler secret put ATLASSIAN_CLIENT_SECRET
```

The SDK only ever receives the **public** `clientId` as a prop; the token
exchange runs in the Worker (`/oauth/exchange`), so the secret never reaches the
browser bundle:

```tsx
<Bugzar
  endpoint="https://bugzar-backend.<your-subdomain>.workers.dev"
  jira={{ clientId: '<Client ID>', projectKey: 'ACME' }}
/>
```

If the Worker secrets are unset, OAuth returns a `501` / `... is not set`
response and the build/tests still pass.

### 1.3 Backend — Cloudflare Worker + R2 + Workers AI

R2 버킷 생성·배포·`PUBLIC_DEPLOY`/`ALLOWED_ORIGINS` 잠금·시크릿 전체는
[`self-hosting-sdk.md`](./self-hosting-sdk.md#step-by-step) 에 Tier 0–3 으로
정리돼 있다. 배포 후 나온 `https://bugzar-backend.<your-subdomain>.workers.dev` 를
SDK `endpoint` prop 으로 넘긴다. Workers AI(`[ai]` binding, Llama 3.1 8B)는 Free
plan 10k neurons/day — 한 번 배포로 활성화되고 `GET /__state` → `aiMode: "real"`
로 확인한다.

### 1.4 Atlassian org admin (one-time)

1. Allow installation of the OAuth app from 1.1 into your Atlassian org.
2. Enable the issue types Bugzar publishes to: **Bug** (bug mode),
   **Task** (design mode), **Epic** (team-managed projects must explicitly
   enable Epics, otherwise the Epic picker shows "no Epic"). Publishing to a
   disabled type surfaces a `Jira 400` toast but does not break the chain.

---

## 2. SDK 설정 (props)

The SDK reads no env itself — your app passes config as props on `<Bugzar />`:

- **`endpoint`** — your deployed Worker URL (the Jira backend). Object form
  `{ url, headers }` to send an auth header on every request.
- **`jira`** — `{ projectKey, clientId?, enabled?, defaultEpicKey? }`. Unset →
  publishing is skipped and only the local replay HTML is produced.
- **`mask`** (default ON), **`redactState`**, **`onBeforeUpload`** — privacy
  controls. The AI sanitizer always redacts Authorization/Cookie/JWT before
  sending to Workers AI; raw artifacts in R2 are preserved; cookies are never
  captured.

Full prop reference: [`packages/sdk/README.md`](../packages/sdk/README.md).

---

## 3. Verification

After setup, run the bug-mode round trip in your app: record → the review drawer
opens → **AI polish** → **Publish** → a real Jira issue (Tier 3) or an honest
`STUB-…` (Tier 1–2). Confirm the replay at
`https://bugzar-backend.<sub>.workers.dev/r/<reportId>`. Worker health/mode is at
`GET /__state`; see [`self-hosting-sdk.md`](./self-hosting-sdk.md#verify-the-deployment).
