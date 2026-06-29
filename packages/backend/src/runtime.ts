/**
 * Bugzar backend — shared runtime foundation.
 *
 * Environment bindings, the Analytics Engine type narrowing, and the HTTP /
 * URL helpers shared across the Worker's route-handler modules. Extracted
 * from worker.ts so domain handler modules can depend on these without
 * importing the router (which would create an import cycle).
 */

export interface Env {
  /** R2 bucket holding uploaded artifacts. Bound in wrangler.toml. */
  ARTIFACTS: R2Bucket;
  /**
   * Workers AI binding (`[ai]` in wrangler.toml). Used by /jira/draft to
   * synthesize a Jira description from captured artifacts. Optional so
   * tests / local stubs can omit it.
   */
  AI?: Ai;
  /**
   * When set, artifact URLs are advertised on this host instead of the
   * Worker's own origin. Use this to front R2 with a CDN / custom domain
   * later — the Worker still serves /reports/:id/:asset as a fallback.
   */
  PUBLIC_HOST?: string;
  /** Optional Jira config — see wrangler.toml. Unset = stub mode. */
  JIRA_API_BASE?: string;
  JIRA_EMAIL?: string;
  JIRA_API_TOKEN?: string;
  JIRA_PROJECT_KEY?: string;
  /**
   * F4-AUTH — comma-separated allowlists for the SDK publish/epics routes.
   * `ALLOWED_ORIGINS`: browser Origins permitted to POST /reports/:id/publish +
   * GET /jira/epics (closes the CORS-`*` open-ticket-creation hole). Unset =
   * open (dev only). `ALLOWED_PROJECT_KEYS`: Jira projects an SDK caller may
   * target; unset = shape-validate the key only.
   */
  ALLOWED_ORIGINS?: string;
  ALLOWED_PROJECT_KEYS?: string;
  /**
   * Workers Analytics Engine dataset (Task 27 / R27). Optional — when the
   * binding is unbound (local dev, tests, free plan without AE), telemetry
   * is logged to console instead of forwarded to AE.
   *
   * Binding name `BUGZAR_ANALYTICS` matches wrangler.toml; legacy code referred
   * to it as TELEMETRY before the rename — every callsite uses
   * `env.BUGZAR_ANALYTICS` now.
   */
  BUGZAR_ANALYTICS?: AnalyticsEngineDataset;
  /**
   * PR-16: Bearer token for the report admin API (`DELETE /reports/:id`).
   * Configured via `wrangler secret put ADMIN_SECRET`. When unset the
   * delete endpoint returns 501 — no accidental "open delete" in dev.
   */
  ADMIN_SECRET?: string;
  /**
   * PR-19: model identifiers for the two `/jira/draft` paths. When unset we
   * fall back to `@cf/meta/llama-4-scout-17b-16e-instruct`. Operators can swap
   * in a newer model by setting the secret — no redeploy required. (Avoid the
   * 70b variants here: they exceed AI_TIMEOUT_MS on the schema-constrained call.)
   */
  AI_MODEL_BUG?: string;
  AI_MODEL_DESIGN?: string;
  /**
   * PR-24: Atlassian OAuth credentials used by the server-side
   * `/oauth/exchange` endpoint. Configured via
   *   `wrangler secret put ATLASSIAN_CLIENT_ID`
   *   `wrangler secret put ATLASSIAN_CLIENT_SECRET`
   * When either is unset the endpoint returns 501 so the extension falls
   * back to its embedded credentials (legacy path).
   */
  ATLASSIAN_CLIENT_ID?: string;
  ATLASSIAN_CLIENT_SECRET?: string;
  /**
   * Phase B (S-3): HMAC secret binding write access to the report that issued
   * the token. `POST /reports` returns `uploadToken = HMAC(reportId)`; asset
   * PUTs must present it as `Authorization: Bearer <token>`. When UNSET, token
   * checks are skipped (local dev / gradual rollout) — set it before exposing
   * the Worker publicly. Rotate via `wrangler secret put UPLOAD_SECRET`.
   */
  UPLOAD_SECRET?: string;
  /**
   * Phase B: when set (e.g. `"1"`), the Worker is treated as publicly exposed —
   * an unset `ALLOWED_ORIGINS` then DENIES the SDK write/publish routes instead
   * of defaulting open. Leave unset for local dev.
   */
  PUBLIC_DEPLOY?: string;
  /**
   * Phase B (S-6): set to `"1"` to expose the `GET /` report index on a public
   * deploy. Default (with `PUBLIC_DEPLOY` set) hides it — reports remain
   * reachable only by their unguessable id.
   */
  PUBLIC_INDEX?: string;
}

/**
 * Minimal type alias for the `wae` (Workers Analytics Engine) binding. The
 * official type ships from `@cloudflare/workers-types` but we narrow it here
 * so the worker compiles cleanly even when the binding stanza is omitted
 * from wrangler.toml for local dev.
 */
export interface AnalyticsEngineDataset {
  writeDataPoint(dataPoint: AnalyticsEngineDataPoint): void;
}

export interface AnalyticsEngineDataPoint {
  /** Up to 20 string tags. Cardinality-friendly. */
  indexes?: string[];
  /** Up to 20 blob columns — coarse strings (event name, mode, errorType…). */
  blobs?: string[];
  /** Up to 20 numeric metrics — counts, durations. */
  doubles?: number[];
}

export const CORS_HEADERS: Record<string, string> = {
  // The extension's origin is chrome-extension://<id> which varies; * keeps
  // dev simple. Tighten once we know the production extension ID.
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, X-Atlassian-Authorization, X-Upload-Token',
  'Access-Control-Max-Age': '86400',
};

export const jsonResponse = (
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS, ...extra },
  });

export const errorResponse = (status: number, message: string): Response =>
  jsonResponse(status, { error: message });

export const buildOrigin = (env: Env, reqUrl: URL): string =>
  env.PUBLIC_HOST?.replace(/\/+$/, '') || reqUrl.origin;

/** Escape a value for safe interpolation into HTML text / attributes. */
export const escapeHtmlAttr = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * CSP for the public `/r/:id` share URL. The viewer HTML is generated by
 * `export-viewer.ts` / `design-viewer.ts` and inlines rrweb-player CSS/JS
 * plus user-provided data (URLs, console output, network bodies). Tight
 * defaults to mitigate XSS via that user content; explicit allows for what
 * the viewer actually needs.
 *
 *  - `script-src 'unsafe-inline'`: rrweb-player is inlined as a bundled
 *    `<script>` block. We accept inline-script here in exchange for not
 *    depending on a CDN that could be tampered with. No remote scripts.
 *  - `style-src 'unsafe-inline' jsdelivr`: viewer styles are inline; the
 *    Pretendard CSS comes from jsDelivr (locked by SRI on the `<link>` tag).
 *  - `font-src jsdelivr data:`: Pretendard webfont chunks + inline data URIs.
 *  - `img-src/media-src blob:`: rrweb-player rebuilds DOM snapshots into
 *    blob URLs; the video player streams the `/reports/:id/video` asset.
 *  - `connect-src 'self'`: asset hydration is same-origin.
 *  - `frame-ancestors 'none'` + `X-Frame-Options DENY`: never embeddable.
 */
// rrweb replay 는 캡처된 페이지의 원본 img/font/style 자산을 그대로 다시
// 로드한다. 옛 CSP 는 외부 https 도메인을 전부 차단해서 admin 페이지처럼
// CDN 이미지·외부 폰트를 쓰는 사이트의 replay 가 부서졌다 — "Node with id X
// not found" 가 누적되며 5초 안팎에 멈춰 보이는 증상의 주범.
//
// 본 viewer 는 내부 QA 도구이고 외부 사용자에게 노출되지 않으므로 자산
// 도메인 제한을 풀어준다. 활성 위협 모델은 여전히 동일:
//   - script-src 는 'self' + 'unsafe-inline' 만 — 외부 스크립트 fetch 차단
//   - frame-ancestors 'none' — 어떤 사이트에도 embed 불가
//   - form-action 'none' — 폼 전송 불가
//   - 외부 자산은 read-only 표시 → exfil 경로 없음
const REPLAY_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https:",
  'font-src https: data:',
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob:",
  // rrweb 캡처에 외부 sourcemap fetch / runtime XHR 흔적이 들어가도 viewer
  // 가 그걸 다시 fetch 하지는 않는다. 다만 일부 inline script (UNSAFE_
  // replayCanvas 로 sandbox 허용) 가 fetch 호출을 트리거할 수 있어서 https
  // 허용으로 풀어둔다.
  "connect-src 'self' https:",
  // rrweb-player 는 about:blank iframe 안에 DOM 을 빌드한다. frame-src 가
  // 명시 안 되면 default-src 가 적용되어 'self' 만 허용되는데, about:blank
  // 는 별개 origin 으로 평가되어 차단된다 — frame-src 로 명시.
  "frame-src 'self' blob: data: about:",
  "child-src 'self' blob: data:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

/**
 * Apply security headers to public HTML responses (`/` index + `/r/:id`).
 * Public URLs are linked from Jira tickets, so an XSS payload in user
 * content could otherwise hop sessions of every viewer.
 */
export const applyReplaySecurityHeaders = (headers: Headers): void => {
  headers.set('Content-Security-Policy', REPLAY_CSP);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
};

/**
 * Harden every R2-served artifact (S-2). Stored content is attacker-influenced
 * (captured DOM/console/network, or — for legacy keys — fully attacker-chosen),
 * and the upload path records the client's own Content-Type. So:
 *   - `nosniff` everywhere, and
 *   - any html/xml/svg-ish artifact is forced to inert `text/plain` + an
 *     `attachment` disposition so it can NEVER execute as active content on the
 *     Worker's own origin. The sandboxed `/v/` viewer is the only render path.
 */
export const applyAssetSecurityHeaders = (headers: Headers): void => {
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  const ct = (headers.get('content-type') ?? '').toLowerCase();
  if (ct.includes('html') || ct.includes('xml') || ct.includes('svg')) {
    headers.set('content-type', 'text/plain; charset=utf-8');
    headers.set('Content-Disposition', 'attachment');
  }
};

/**
 * The pilot report (PUT /pilot/r2/:key) is a self-contained replay/design HTML
 * uploaded by the SDK. Unlike per-report assets — which are force-downloaded so
 * stored HTML can never execute on this origin — we render the pilot report
 * INLINE so the tester just clicks the link and sees it, instead of downloading
 * a file and opening it from a folder.
 *
 * It runs under the same CSP the viewer uses at `/r/:id` (`applyReplaySecurityHeaders`):
 * no remote scripts, never embeddable, no form posts. A true opaque-origin sandbox
 * is NOT used because it breaks the rrweb replayer (which needs same-origin access
 * to its own replay iframe). The Worker sets no cookies, so executing this
 * self-contained HTML on-origin has no session to steal.
 */
export const applyPilotHtmlSecurityHeaders = (headers: Headers): void => {
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('Content-Disposition', 'inline');
  applyReplaySecurityHeaders(headers);
};

/** Constant-time string compare (avoids byte-by-byte timing leaks). */
export const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};
