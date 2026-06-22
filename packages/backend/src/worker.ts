/**
 * Bugzar backend — Cloudflare Worker.
 *
 * Two URL families:
 *
 *   /reports/*    — REST surface the extension uses to upload artifacts.
 *                   Every QA session gets a short `reportId` here, and each
 *                   captured resource (events, console, network, storage,
 *                   meta, video, replay.html) lands under that prefix.
 *
 *   /r/:reportId  — Human-facing share URL. Returns the replay.html for
 *                   the given report (which itself fetches the sibling
 *                   meta/events/console/network/storage/video objects via
 *                   the /reports/:id/:asset URLs).
 *
 * Plus the Jira surface:
 *
 *   /jira/draft   — Workers AI synthesis. Reads R2 artifacts for the given
 *                   reportId, sanitizes them, asks Llama 3.1 8B for a
 *                   structured `BugDraft`, returns { title, description }
 *                   (description as ADF JSON).
 *   /jira/issue   — Posts to Atlassian Cloud (stub if no creds).
 *
 * Legacy /upload + /artifacts/:key endpoints are kept as a backward
 * compatibility shim so existing E2E test fixtures still pass. New
 * extension builds use the /reports/ flow.
 */

import { jsonToBugAdf, jsonToDesignAdf, type SelectedElementLite } from './adf';
import type { DesignElementInput, DraftInputArtifacts } from './jira-draft';
import { generateBugDraft, generateDesignDraft, sniffAttachments } from './jira-draft';
import { RRWEB_PLAYER_CSS, RRWEB_PLAYER_JS } from './rrweb-player-asset.generated';

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

import { runRetentionCleanup } from './retention';

/**
 * Minimal type alias for the `wae` (Workers Analytics Engine) binding. The
 * official type ships from `@cloudflare/workers-types` but we narrow it here
 * so the worker compiles cleanly even when the binding stanza is omitted
 * from wrangler.toml for local dev.
 */
interface AnalyticsEngineDataset {
  writeDataPoint(dataPoint: AnalyticsEngineDataPoint): void;
}

interface AnalyticsEngineDataPoint {
  /** Up to 20 string tags. Cardinality-friendly. */
  indexes?: string[];
  /** Up to 20 blob columns — coarse strings (event name, mode, errorType…). */
  blobs?: string[];
  /** Up to 20 numeric metrics — counts, durations. */
  doubles?: number[];
}

const CORS_HEADERS: Record<string, string> = {
  // The extension's origin is chrome-extension://<id> which varies; * keeps
  // dev simple. Tighten once we know the production extension ID.
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, X-Atlassian-Authorization, X-Upload-Token',
  'Access-Control-Max-Age': '86400',
};

const jsonResponse = (
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS, ...extra },
  });

const errorResponse = (status: number, message: string): Response =>
  jsonResponse(status, { error: message });

/**
 * Generate a short, URL-safe report id.
 *
 * 10 chars from a 32-char alphabet → 32^10 ≈ 1.1 × 10^15 possible ids,
 * which is more than enough for collision avoidance at any sane volume.
 * Alphabet excludes the visually ambiguous chars (0/O, 1/l/I).
 */
const REPORT_ID_ALPHABET = 'abcdefghijkmnopqrstuvwxyz23456789';
const generateReportId = (): string => {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let id = '';
  for (const b of bytes) id += REPORT_ID_ALPHABET[b % REPORT_ID_ALPHABET.length];
  return id;
};

const b64url = (bytes: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

/** HMAC-SHA256(reportId) → URL-safe token. Binds an upload token to its report. */
const signUploadToken = async (secret: string, reportId: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(reportId));
  return b64url(sig);
};

/** Constant-time string compare (avoids byte-by-byte timing leaks). */
const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/**
 * Authorize an asset write. With `UPLOAD_SECRET` unset → always allowed (dev).
 * With it set → the `Authorization: Bearer <token>` must HMAC-match `reportId`,
 * so a caller can only write reports it allocated via `POST /reports`.
 */
const uploadAuthorized = async (req: Request, env: Env, reportId: string): Promise<boolean> => {
  if (!env.UPLOAD_SECRET) return true;
  // A dedicated header so it never collides with a consumer's gateway `Authorization`.
  const token = (req.headers.get('X-Upload-Token') ?? '').trim();
  if (!token) return false;
  const expected = await signUploadToken(env.UPLOAD_SECRET, reportId);
  return timingSafeEqual(token, expected);
};

/** Reject oversized writes (S-3 / I-3). Per-asset byte ceiling. */
const MAX_ASSET_BYTES: Partial<Record<AssetName, number>> & { default: number } = {
  default: 10 * 1024 * 1024, // JSON assets
  video: 100 * 1024 * 1024,
  screenshot: 5 * 1024 * 1024,
};
const assetCap = (asset?: AssetName): number =>
  (asset && MAX_ASSET_BYTES[asset]) || MAX_ASSET_BYTES.default;

/** Fast reject when the client *declares* an over-cap Content-Length. */
const overSizeLimit = (req: Request, asset?: AssetName): boolean => {
  const declared = Number(req.headers.get('content-length') ?? '0');
  return Number.isFinite(declared) && declared > assetCap(asset);
};


/**
 * Allowed asset names. Anything else returns 400 from PUT/GET — prevents
 * arbitrary key suffixes from being shoved into the bucket.
 */
const ASSETS = [
  'meta',
  'events',
  'console',
  'network',
  'storage',
  'video',
  'replay',
  // Design mode (Phase 2 Task 18): annotated viewport PNG + per-element JSON.
  'screenshot',
  'design',
  // SDK extra streams (M5/M6): Resource Timing waterfall, app-state snapshots,
  // Core Web Vitals. JSON; capture-and-store only (not rendered in /r/:id).
  'resources',
  'state',
  'vitals',
  // Device/browser/environment snapshot for the viewer's System Info tab.
  'system',
] as const;
type AssetName = (typeof ASSETS)[number];
const isAsset = (s: string): s is AssetName => (ASSETS as readonly string[]).includes(s);

const assetExtension = (asset: AssetName, mime?: string): string => {
  if (asset === 'replay') return '.html';
  if (asset === 'video') {
    if (mime?.includes('mp4')) return '.mp4';
    if (mime?.includes('mov') || mime?.includes('quicktime')) return '.mov';
    return '.webm';
  }
  if (asset === 'screenshot') {
    if (mime?.includes('jpeg') || mime?.includes('jpg')) return '.jpg';
    if (mime?.includes('webp')) return '.webp';
    return '.png';
  }
  return '.json';
};

const assetContentType = (asset: AssetName, override?: string): string => {
  if (override) return override;
  if (asset === 'replay') return 'text/html; charset=utf-8';
  if (asset === 'video') return 'video/webm';
  if (asset === 'screenshot') return 'image/png';
  return 'application/json; charset=utf-8';
};

const buildOrigin = (env: Env, reqUrl: URL): string =>
  env.PUBLIC_HOST?.replace(/\/+$/, '') || reqUrl.origin;

const buildAssetUrl = (env: Env, reqUrl: URL, reportId: string, asset: AssetName): string => {
  const origin = buildOrigin(env, reqUrl);
  const ext = assetExtension(asset);
  return `${origin}/reports/${reportId}/${asset}${ext}`;
};

const buildReportUrl = (env: Env, reqUrl: URL, reportId: string): string =>
  `${buildOrigin(env, reqUrl)}/r/${reportId}`;

const r2KeyFor = (reportId: string, asset: AssetName, mime?: string): string =>
  `reports/${reportId}/${asset}${assetExtension(asset, mime)}`;

/**
 * Strip an optional file extension from a path segment so /reports/:id/events.json
 * and /reports/:id/events both route to the `events` asset. Keeps the URL
 * structure flexible for clients that prefer canonical filenames.
 */
const stripAssetExt = (seg: string): string => {
  const i = seg.lastIndexOf('.');
  return i === -1 ? seg : seg.slice(0, i);
};

// ────────────────────────────────────────────────────────────────────────
// Handlers — /reports
// ────────────────────────────────────────────────────────────────────────

/**
 * POST /reports
 * Allocates a new report id. The client then PUTs each asset under that id.
 * Returns the report's share URL and per-asset URLs the client should bake
 * into replay.html (since they're known up front).
 */
const handleCreateReport = async (req: Request, env: Env, reqUrl: URL): Promise<Response> => {
  if (!originAllowed(req, env)) return errorResponse(403, 'origin not allowed');
  const reportId = generateReportId();
  const assetUrls = Object.fromEntries(
    ASSETS.map((a) => [a, buildAssetUrl(env, reqUrl, reportId, a)]),
  ) as Record<AssetName, string>;
  // Issue a report-scoped upload token so only this caller can write the report.
  const uploadToken = env.UPLOAD_SECRET
    ? await signUploadToken(env.UPLOAD_SECRET, reportId)
    : undefined;
  return jsonResponse(200, {
    reportId,
    reportUrl: buildReportUrl(env, reqUrl, reportId),
    assetUrls,
    ...(uploadToken ? { uploadToken } : {}),
  });
};

/**
 * PUT /reports/:id/:asset
 * Body is the raw asset (JSON, webm, html). Content-Type is recorded as the
 * R2 object's contentType so subsequent GETs round-trip the right header.
 */
const handlePutAsset = async (
  req: Request,
  env: Env,
  reportId: string,
  asset: AssetName,
): Promise<Response> => {
  if (!req.body) return errorResponse(400, 'empty body');
  if (!originAllowed(req, env)) return errorResponse(403, 'origin not allowed');
  if (!(await uploadAuthorized(req, env, reportId)))
    return errorResponse(401, 'invalid upload token');
  if (overSizeLimit(req, asset)) return errorResponse(413, 'asset too large');
  const contentType = req.headers.get('content-type') ?? assetContentType(asset);
  const mime = contentType.split(';')[0]?.trim();
  const key = r2KeyFor(reportId, asset, mime);
  // Stream the raw request body straight to R2. Piping it through a
  // TransformStream (the old capBodyStream) drops the known length, and prod R2
  // then rejects the put — the size guard stays on `overSizeLimit` above.
  await env.ARTIFACTS.put(key, req.body, {
    httpMetadata: {
      contentType,
      // Per-report ids are unique → assets are immutable, cache hard.
      cacheControl: 'public, max-age=31536000, immutable',
    },
    customMetadata: { reportId, asset, uploadedAt: String(Date.now()) },
  });
  return jsonResponse(200, { ok: true, key });
};

/**
 * PUT /reports/:id/elements/:elementId — 디자인 picker 가 element 마다 잡은
 * pick-time chrome viewport PNG 한 장. body 는 raw PNG bytes (content-type
 * 무관, 모두 image/png 로 강제 저장).
 */
const handlePutElementScreenshot = async (
  req: Request,
  env: Env,
  reportId: string,
  elementId: string,
): Promise<Response> => {
  if (!req.body) return errorResponse(400, 'empty body');
  if (!originAllowed(req, env)) return errorResponse(403, 'origin not allowed');
  if (!(await uploadAuthorized(req, env, reportId)))
    return errorResponse(401, 'invalid upload token');
  if (overSizeLimit(req, 'screenshot')) return errorResponse(413, 'asset too large');
  const key = `reports/${reportId}/elements/${elementId}.png`;
  await env.ARTIFACTS.put(key, req.body, {
    httpMetadata: {
      contentType: 'image/png',
      cacheControl: 'public, max-age=31536000, immutable',
    },
    customMetadata: {
      reportId,
      asset: 'element-screenshot',
      elementId,
      uploadedAt: String(Date.now()),
    },
  });
  return jsonResponse(200, { ok: true, key });
};

/**
 * GET /reports/:id/elements/:elementId — viewer 가 <img src=...> 로 직접 fetch.
 */
const handleGetElementScreenshot = async (
  env: Env,
  reportId: string,
  elementId: string,
): Promise<Response> => {
  if (await isReportDeleted(env, reportId)) {
    return new Response('410 Gone', { status: 410, headers: CORS_HEADERS });
  }
  const key = `reports/${reportId}/elements/${elementId}.png`;
  const obj = await env.ARTIFACTS.get(key);
  if (!obj) return new Response('not found', { status: 404, headers: CORS_HEADERS });
  const headers = new Headers(CORS_HEADERS);
  obj.writeHttpMetadata(headers);
  if (!headers.has('content-type')) headers.set('content-type', 'image/png');
  headers.set('etag', obj.httpEtag);
  applyAssetSecurityHeaders(headers);
  return new Response(obj.body, { headers });
};

/**
 * GET /reports/:id/:asset  — direct R2 fetch for an asset (used by the
 * viewer JS to hydrate at runtime).
 */
const handleGetAsset = async (env: Env, reportId: string, asset: AssetName): Promise<Response> => {
  // PR-16: short-circuit deleted reports so referenced assets (the design
  // viewer's screenshot, the network/console JSON) also return Gone instead
  // of 404 — keeps the failure mode consistent with /r/:id.
  if (await isReportDeleted(env, reportId)) {
    return new Response('410 Gone', { status: 410, headers: CORS_HEADERS });
  }
  // We don't know the exact mime extension here without a HEAD, so try the
  // declared default for the asset. R2 handles the lookup either way.
  const key = r2KeyFor(reportId, asset);
  const obj = await env.ARTIFACTS.get(key);
  if (!obj) return new Response('not found', { status: 404, headers: CORS_HEADERS });

  const headers = new Headers(CORS_HEADERS);
  obj.writeHttpMetadata(headers);
  if (!headers.has('content-type')) headers.set('content-type', assetContentType(asset));
  headers.set('etag', obj.httpEtag);
  applyAssetSecurityHeaders(headers);
  return new Response(obj.body, { headers });
};

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
const applyReplaySecurityHeaders = (headers: Headers): void => {
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
const applyAssetSecurityHeaders = (headers: Headers): void => {
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  const ct = (headers.get('content-type') ?? '').toLowerCase();
  if (ct.includes('html') || ct.includes('xml') || ct.includes('svg')) {
    headers.set('content-type', 'text/plain; charset=utf-8');
    headers.set('Content-Disposition', 'attachment');
  }
};

// PR-16: tombstone for soft-deleted reports. Lives at `reports/<id>/.deleted`
// — a single zero-byte object whose presence flips `/r/:id` and asset GETs
// to 410 Gone. We keep the marker (rather than re-uploading a 410 HTML) so
// the GET path stays a single R2 HEAD + GET regardless of state.
const DELETED_MARKER_SUFFIX = '/.deleted';
const deletedMarkerKey = (reportId: string): string =>
  `reports/${reportId}${DELETED_MARKER_SUFFIX}`;

const isReportDeleted = async (env: Env, reportId: string): Promise<boolean> => {
  try {
    const marker = await env.ARTIFACTS.head(deletedMarkerKey(reportId));
    return marker !== null;
  } catch {
    return false;
  }
};

const goneResponse = (reportId: string): Response => {
  const html = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <title>삭제된 리포트 — Bugzar</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body style="font-family:system-ui,-apple-system,'Apple SD Gothic Neo',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#09090b;color:#fafafa;">
  <div style="text-align:center;max-width:420px;padding:24px;">
    <div style="font-size:48px;margin-bottom:16px;" aria-hidden="true">🗑️</div>
    <h1 style="font-size:20px;margin:0 0 8px;font-weight:600;">이 리포트는 삭제되었습니다</h1>
    <p style="color:#a1a1aa;font-size:14px;margin:0 0 4px;">Jira 티켓 본문의 정보는 그대로 유지됩니다.</p>
    <p style="color:#71717a;font-size:11px;font-family:ui-monospace,Menlo,monospace;margin-top:16px;">리포트 ID: ${escapeHtmlAttr(reportId)}</p>
  </div>
</body>
</html>`;
  const headers = new Headers({
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'public, max-age=86400',
    ...CORS_HEADERS,
  });
  applyReplaySecurityHeaders(headers);
  return new Response(html, { status: 410, headers });
};

/**
 * GET /r/:reportId  — the human share URL. Redirects to the bundled `@bugzar/viewer`
 * (served same-origin under `/v/`), which reads the report's assets from this
 * Worker. The per-report `replay.html` (still uploaded for back-compat) is no
 * longer served here.
 */
const handleGetReport = async (env: Env, reportId: string): Promise<Response> => {
  if (await isReportDeleted(env, reportId)) return goneResponse(reportId);
  // Same-origin viewer: a relative redirect keeps the user on this Worker's host
  // (the viewer defaults `endpoint` to its own origin, so `?id=` is enough).
  const headers = new Headers(CORS_HEADERS);
  headers.set('location', `/v/?id=${encodeURIComponent(reportId)}`);
  headers.set('cache-control', 'no-store');
  return new Response(null, { status: 302, headers });
};

/**
 * DELETE /reports/:id — admin-only soft delete.
 *
 * Authenticates via `Authorization: Bearer <ADMIN_SECRET>`. We list every
 * key under `reports/<id>/`, delete them concurrently with
 * `Promise.allSettled` (so a partial R2 failure doesn't abort the rest), and
 * then PUT the `.deleted` tombstone so subsequent `/r/:id` requests return
 * 410. Jira ticket bodies are unaffected — the public URL just transitions
 * from "report" to "410 Gone" page.
 */
const handleDeleteReport = async (req: Request, env: Env, reportId: string): Promise<Response> => {
  if (!env.ADMIN_SECRET) {
    return errorResponse(501, 'delete API not configured (ADMIN_SECRET missing)');
  }
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token || !timingSafeEqual(token, env.ADMIN_SECRET)) {
    return errorResponse(401, 'unauthorized');
  }

  const listed = await env.ARTIFACTS.list({ prefix: `reports/${reportId}/` });
  // The tombstone itself counts as a "key under the prefix" once it exists,
  // so we filter it out before deciding if anything is left to delete.
  const keys = listed.objects.map((o) => o.key).filter((k) => !k.endsWith(DELETED_MARKER_SUFFIX));

  if (keys.length === 0) {
    return errorResponse(404, `report not found: ${reportId}`);
  }

  await Promise.allSettled(keys.map((key) => env.ARTIFACTS.delete(key)));

  await env.ARTIFACTS.put(deletedMarkerKey(reportId), '', {
    httpMetadata: { contentType: 'text/plain' },
    customMetadata: { deletedAt: String(Date.now()), reportId },
  });

  if (env.BUGZAR_ANALYTICS) {
    try {
      env.BUGZAR_ANALYTICS.writeDataPoint({
        indexes: ['report_deleted'],
        blobs: [reportId.slice(0, 8)],
        doubles: [keys.length],
      });
    } catch (err) {
      console.warn('[delete] telemetry write failed', (err as Error).message);
    }
  }

  return jsonResponse(200, { ok: true, reportId, deletedKeys: keys.length });
};

/**
 * GET /  — index page listing every report in the bucket.
 *
 * Strategy: list R2 with `prefix: 'reports/'`, filter to keys ending in
 * `/meta.json`, fetch each meta's body to read url/startedAt/durationMs,
 * infer mode from whether `design.json` exists alongside, then render an
 * HTML table sorted by recency.
 *
 * Costs: ~1 list + N gets per render. For small QA teams (< few hundred
 * reports) this is fine. If usage grows we'll:
 *   - cache the index in a Worker KV (refresh on each `handleCreateReport`)
 *   - store url/mode in meta.json's R2 customMetadata so list() alone is enough
 *
 * Cache-Control is short (60s) so a fresh report shows up within a minute
 * but repeated dashboard refreshes don't hammer R2.
 */
interface ReportIndexEntry {
  id: string;
  url: string;
  startedAt: number;
  durationMs: number | null;
  mode: 'video' | 'design' | 'session';
  /**
   * 리포트를 발행한 Atlassian 사용자 — 추출은 extension 의 submit-chain 이
   * meta.json 에 박는다. 구식 리포트엔 누락되어 있을 수 있어 옵셔널.
   * avatar 는 Atlassian CDN 의 HTTPS URL — replay CSP `img-src https:` 통과.
   */
  author?: {
    displayName: string;
    avatar?: string;
  };
}

const REPORT_LIST_LIMIT = 500;

const handleListReports = async (env: Env, reqUrl: URL): Promise<Response> => {
  const origin = buildOrigin(env, reqUrl);

  // Step 1: list every object under reports/. We get up to 1000 keys per
  // page; loop until the cursor runs out or we hit our soft limit. For the
  // expected scale this rarely needs more than one page.
  const allObjects: { key: string; uploaded: Date }[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.ARTIFACTS.list({
      prefix: 'reports/',
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const o of page.objects) {
      allObjects.push({ key: o.key, uploaded: o.uploaded });
    }
    cursor = page.truncated ? page.cursor : undefined;
    // Hard cap so a runaway listing can't burn the whole CPU budget.
    if (allObjects.length >= REPORT_LIST_LIMIT * 10) break;
  } while (cursor);

  // Step 2: bucket keys by reportId, note which assets exist + the most
  // recent upload time per report.
  const byReport = new Map<
    string,
    { hasDesign: boolean; hasVideo: boolean; metaKey?: string; latestUpload: number }
  >();
  for (const obj of allObjects) {
    const m = /^reports\/([a-z0-9-]+)\/([^/]+)$/i.exec(obj.key);
    if (!m) continue;
    const id = m[1];
    const file = m[2];
    if (!id || !file) continue;
    const entry = byReport.get(id) ?? { hasDesign: false, hasVideo: false, latestUpload: 0 };
    if (file === 'design.json') entry.hasDesign = true;
    if (file.startsWith('video.')) entry.hasVideo = true;
    if (file === 'meta.json') entry.metaKey = obj.key;
    const upTime = obj.uploaded.getTime();
    if (upTime > entry.latestUpload) entry.latestUpload = upTime;
    byReport.set(id, entry);
  }

  // Step 3: fetch each report's meta.json body in parallel. Reports
  // without a meta.json (e.g. partial uploads) are dropped — listing them
  // would just confuse the reviewer.
  const candidates = [...byReport.entries()]
    .filter(([, v]) => v.metaKey)
    .sort((a, b) => b[1].latestUpload - a[1].latestUpload)
    .slice(0, REPORT_LIST_LIMIT);

  const entries: ReportIndexEntry[] = (
    await Promise.all(
      candidates.map(async ([id, info]): Promise<ReportIndexEntry | null> => {
        if (!info.metaKey) return null;
        try {
          const obj = await env.ARTIFACTS.get(info.metaKey);
          if (!obj) return null;
          const text = await obj.text();
          const meta = JSON.parse(text) as {
            url?: unknown;
            startedAt?: unknown;
            durationMs?: unknown;
            author?: unknown;
          };
          // author 는 extension submit-chain 이 박는 `{ accountId, displayName, avatar? }`.
          // worker UI 는 displayName + avatar 만 사용한다. 타입 가드를 좁게
          // 가져가서 meta.json 이 손상돼도 row 가 깨지지 않도록 한다.
          let author: ReportIndexEntry['author'];
          if (
            meta.author &&
            typeof meta.author === 'object' &&
            'displayName' in meta.author &&
            typeof (meta.author as { displayName: unknown }).displayName === 'string'
          ) {
            const a = meta.author as { displayName: string; avatar?: unknown };
            author = {
              displayName: a.displayName,
              ...(typeof a.avatar === 'string' && a.avatar ? { avatar: a.avatar } : {}),
            };
          }
          return {
            id,
            url: typeof meta.url === 'string' ? meta.url : '',
            startedAt: typeof meta.startedAt === 'number' ? meta.startedAt : info.latestUpload,
            durationMs: typeof meta.durationMs === 'number' ? meta.durationMs : null,
            mode: info.hasDesign ? 'design' : info.hasVideo ? 'video' : 'session',
            ...(author ? { author } : {}),
          };
        } catch (err) {
          console.warn('[reports:list] meta parse failed', id, err);
          return null;
        }
      }),
    )
  ).filter((e): e is ReportIndexEntry => e !== null);

  entries.sort((a, b) => b.startedAt - a.startedAt);

  const headers = new Headers(CORS_HEADERS);
  headers.set('content-type', 'text/html; charset=utf-8');
  // Short cache so repeat visits are fast but a new submit shows up within
  // a minute. The R2 list cost is what we're trading off.
  headers.set('cache-control', 'public, max-age=60');
  applyReplaySecurityHeaders(headers);
  return new Response(renderReportsIndexHtml(entries, origin), { headers });
};

const escapeHtmlAttr = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const formatDuration = (ms: number | null): string => {
  if (ms === null) return '—';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
};

const formatTimestamp = (ms: number): string => {
  try {
    return new Date(ms).toLocaleString('ko-KR', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return new Date(ms).toISOString();
  }
};

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const pathOf = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return '';
  }
};

const renderAuthorCell = (author: ReportIndexEntry['author']): string => {
  if (!author) return '<div class="cell author empty">—</div>';
  // 아바타 src 는 Atlassian 의 https CDN — 응답 헤더 CSP 가 img-src https
  // 만 허용. 그래도 defense-in-depth 로 http(s) 가 아닌 스킴은 코드 레벨에서
  // 거부하고 이니셜 fallback 으로 떨어진다.
  const safeAvatar = author.avatar && /^https?:\/\//i.test(author.avatar) ? author.avatar : null;
  const initial = author.displayName.trim().charAt(0).toUpperCase() || '?';
  const avatarHtml = safeAvatar
    ? `<img class="avatar" src="${escapeHtmlAttr(safeAvatar)}" alt="" loading="lazy" width="20" height="20" />`
    : `<span class="avatar avatar-fallback" aria-hidden="true">${escapeHtmlAttr(initial)}</span>`;
  return `<div class="cell author">
          ${avatarHtml}
          <span class="name">${escapeHtmlAttr(author.displayName)}</span>
        </div>`;
};

const renderReportsIndexHtml = (entries: ReportIndexEntry[], origin: string): string => {
  const rows = entries
    .map(
      (e) => `
      <a class="row" href="${escapeHtmlAttr(`${origin}/r/${e.id}`)}" data-host="${escapeHtmlAttr(hostOf(e.url))}" data-mode="${escapeHtmlAttr(e.mode)}" data-author="${escapeHtmlAttr(e.author?.displayName ?? '')}">
        <div class="cell mode">
          <span class="chip chip-${escapeHtmlAttr(e.mode)}">${e.mode === 'design' ? '디자인' : e.mode === 'session' ? '세션' : '영상'}</span>
        </div>
        <div class="cell url">
          <div class="host">${escapeHtmlAttr(hostOf(e.url) || '(host 없음)')}</div>
          <div class="path mono">${escapeHtmlAttr(pathOf(e.url))}</div>
        </div>
        ${renderAuthorCell(e.author)}
        <div class="cell when">${escapeHtmlAttr(formatTimestamp(e.startedAt))}</div>
        <div class="cell dur mono">${escapeHtmlAttr(formatDuration(e.durationMs))}</div>
        <div class="cell id mono">${escapeHtmlAttr(e.id.slice(0, 8))}</div>
      </a>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <title>Bugzar Reports</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <!-- Pretendard via jsDelivr (dynamic subset). System fallback covers
       offline / pre-load paint. -->
  <link
    rel="stylesheet"
    href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css"
  />
  <style>
    :root {
      --background: #ffffff;
      --surface: #fafafa;
      --surface-elevated: #ffffff;
      --border: #e5e7eb;
      --foreground: #0f172a;
      --muted-foreground: #64748b;
      --primary: #2563eb;
      --primary-soft: #dbeafe;
      --design: #8b5cf6;
      --design-soft: #ede9fe;
      --video: #10b981;
      --video-soft: #d1fae5;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --background: #09090b;
        --surface: #18181b;
        --surface-elevated: #27272a;
        --border: #3f3f46;
        --foreground: #fafafa;
        --muted-foreground: #a1a1aa;
        --primary: #60a5fa;
        --primary-soft: #1e3a8a;
        --design-soft: #4c1d95;
        --video-soft: #064e3b;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: 'Pretendard Variable', Pretendard, -apple-system, BlinkMacSystemFont,
        'Inter', system-ui, 'Segoe UI', 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif;
      background: var(--background);
      color: var(--foreground);
      font-size: 14px;
      line-height: 1.55;
    }
    .mono { font-family: inherit; }
    header.top {
      padding: 20px 24px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
    }
    header.top h1 { margin: 0; font-size: 18px; font-weight: 700; }
    header.top .count { font-size: 12px; color: var(--muted-foreground); }
    .controls {
      padding: 12px 24px;
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
      border-bottom: 1px solid var(--border);
      background: var(--surface);
    }
    .controls input[type="search"] {
      flex: 1;
      min-width: 220px;
      padding: 8px 12px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--background);
      color: var(--foreground);
      font: inherit;
    }
    .controls input[type="search"]:focus {
      outline: 2px solid var(--primary);
      outline-offset: 1px;
    }
    .filter-group { display: flex; gap: 4px; }
    .filter-btn {
      padding: 6px 12px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--background);
      color: var(--muted-foreground);
      font: inherit;
      cursor: pointer;
    }
    .filter-btn[aria-pressed="true"] {
      background: var(--primary-soft);
      color: var(--primary);
      border-color: var(--primary);
    }
    .list {
      padding: 16px 24px 32px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .row {
      display: grid;
      grid-template-columns: 80px minmax(0, 1fr) 180px 160px 70px 100px;
      gap: 16px;
      align-items: center;
      padding: 12px 16px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      text-decoration: none;
      color: var(--foreground);
      transition: background 150ms, border-color 150ms;
    }
    @media (max-width: 720px) {
      .row {
        grid-template-columns: 60px 1fr 80px;
        grid-template-areas: 'mode url dur' 'mode author id' 'mode when id';
      }
      .cell.mode { grid-area: mode; }
      .cell.url { grid-area: url; }
      .cell.author { grid-area: author; font-size: 11px; }
      .cell.when { grid-area: when; font-size: 10px; color: var(--muted-foreground); }
      .cell.dur { grid-area: dur; text-align: right; }
      .cell.id { grid-area: id; text-align: right; color: var(--muted-foreground); }
    }
    .cell.author {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      font-size: 12px;
      color: var(--foreground);
    }
    .cell.author.empty {
      color: var(--muted-foreground);
      font-size: 12px;
    }
    .cell.author .avatar {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      flex: 0 0 20px;
      object-fit: cover;
      background: var(--surface-elevated);
    }
    .cell.author .avatar-fallback {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      font-weight: 600;
      color: var(--muted-foreground);
      border: 1px solid var(--border);
    }
    .cell.author .name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .row:hover {
      background: var(--surface-elevated);
      border-color: var(--primary);
    }
    .row:focus-visible {
      outline: 2px solid var(--primary);
      outline-offset: 2px;
    }
    .chip {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 9999px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.04em;
    }
    .chip-video { background: var(--video-soft); color: var(--video); }
    .chip-design { background: var(--design-soft); color: var(--design); }
    .cell.url { min-width: 0; }
    .cell.url .host {
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .cell.url .path {
      font-size: 11px;
      color: var(--muted-foreground);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .cell.when, .cell.dur, .cell.id {
      font-size: 12px;
      color: var(--muted-foreground);
    }
    .empty {
      padding: 48px 24px;
      text-align: center;
      color: var(--muted-foreground);
    }
    .row.hidden { display: none; }
  </style>
</head>
<body>
  <header class="top">
    <div>
      <h1>Bugzar Reports</h1>
      <div class="count">${entries.length}건 (최신순, 최대 ${REPORT_LIST_LIMIT}건)</div>
    </div>
  </header>
  ${
    entries.length === 0
      ? '<div class="empty">아직 발행된 QA report 가 없습니다.<br/>확장을 통해 첫 리포트를 만들어보세요.</div>'
      : `
      <div class="controls">
        <input type="search" id="search" placeholder="호스트 / 경로 / 리포트 id 검색…" />
        <div class="filter-group" role="group" aria-label="모드 필터">
          <button type="button" class="filter-btn" data-filter="all" aria-pressed="true">전체</button>
          <button type="button" class="filter-btn" data-filter="video" aria-pressed="false">영상</button>
          <button type="button" class="filter-btn" data-filter="design" aria-pressed="false">디자인</button>
        </div>
      </div>
      <main class="list">${rows}</main>
      <script>
        (function() {
          var rows = Array.prototype.slice.call(document.querySelectorAll('.row'));
          var search = document.getElementById('search');
          var filters = document.querySelectorAll('.filter-btn');
          var currentMode = 'all';
          var currentQuery = '';
          function apply() {
            var q = currentQuery.trim().toLowerCase();
            for (var i = 0; i < rows.length; i++) {
              var r = rows[i];
              var modeOk = currentMode === 'all' || r.dataset.mode === currentMode;
              var queryOk = !q ||
                r.textContent.toLowerCase().indexOf(q) >= 0 ||
                (r.dataset.host || '').toLowerCase().indexOf(q) >= 0;
              r.classList.toggle('hidden', !(modeOk && queryOk));
            }
          }
          search.addEventListener('input', function(e) {
            currentQuery = e.target.value || '';
            apply();
          });
          filters.forEach(function(btn) {
            btn.addEventListener('click', function() {
              filters.forEach(function(b) { b.setAttribute('aria-pressed', 'false'); });
              btn.setAttribute('aria-pressed', 'true');
              currentMode = btn.dataset.filter || 'all';
              apply();
            });
          });
        })();
      </script>`
  }
</body>
</html>`;
};

// ────────────────────────────────────────────────────────────────────────
// Handlers — legacy /upload + /artifacts (backward compat for old extension
// builds and the existing E2E test fixture). These can be deleted once
// every client is on the /reports/ flow.
// ────────────────────────────────────────────────────────────────────────

const guessVideoExt = (mime: string): string => {
  if (mime.includes('webm')) return '.webm';
  if (mime.includes('mp4')) return '.mp4';
  if (mime.includes('mov') || mime.includes('quicktime')) return '.mov';
  return '.bin';
};

const buildLegacyUrl = (env: Env, reqUrl: URL, key: string): string =>
  `${buildOrigin(env, reqUrl)}/artifacts/${encodeURIComponent(key)}`;

const handleLegacyUpload = async (req: Request, env: Env, url: URL): Promise<Response> => {
  if (!originAllowed(req, env)) return errorResponse(403, 'origin not allowed');
  if (overSizeLimit(req)) return errorResponse(413, 'upload too large');
  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    return errorResponse(400, `invalid multipart body: ${(err as Error).message}`);
  }

  const sessionId = String(form.get('sessionId') ?? '').trim() || 'unknown';
  const filename = String(form.get('filename') ?? '').trim() || 'replay.html';
  const file = form.get('file') as unknown as File | string | null;
  if (!file || typeof file === 'string') {
    return errorResponse(400, "missing 'file' part");
  }

  // Optional video — same shape as the older /upload contract.
  const video = form.get('video') as unknown as File | string | null;
  const videoMimeType = String(form.get('videoMimeType') ?? '').trim() || 'video/webm';
  const videoPlaceholder = String(form.get('videoPlaceholder') ?? '').trim();

  const ts = Date.now();
  let videoUrl: string | null = null;
  let videoKey: string | null = null;
  if (video && typeof video !== 'string') {
    videoKey = `sessions/${sessionId}/${ts}-video${guessVideoExt(videoMimeType)}`;
    await env.ARTIFACTS.put(videoKey, video.stream(), {
      httpMetadata: {
        contentType: videoMimeType,
        cacheControl: 'public, max-age=31536000, immutable',
      },
      customMetadata: { sessionId, kind: 'video', uploadedAt: String(ts) },
    });
    videoUrl = buildLegacyUrl(env, url, videoKey);
  }

  const htmlKey = `sessions/${sessionId}/${ts}-${filename}`;
  let htmlPutBody: ReadableStream | string;
  if (videoUrl && videoPlaceholder) {
    const original = await file.text();
    htmlPutBody = original.split(videoPlaceholder).join(videoUrl);
  } else {
    htmlPutBody = file.stream();
  }

  await env.ARTIFACTS.put(htmlKey, htmlPutBody, {
    httpMetadata: {
      contentType: 'text/html; charset=utf-8',
      cacheControl: 'public, max-age=3600, immutable',
    },
    customMetadata: { sessionId, filename, uploadedAt: String(ts) },
  });

  return jsonResponse(200, {
    url: buildLegacyUrl(env, url, htmlKey),
    key: htmlKey,
    ...(videoUrl ? { videoUrl, videoKey } : {}),
  });
};

const handleLegacyArtifactsGet = async (url: URL, env: Env): Promise<Response> => {
  const raw = url.pathname.slice('/artifacts/'.length);
  if (!raw) return errorResponse(400, 'missing key');
  const key = decodeURIComponent(raw);
  const obj = await env.ARTIFACTS.get(key);
  if (!obj) return new Response('not found', { status: 404, headers: CORS_HEADERS });
  const headers = new Headers(CORS_HEADERS);
  obj.writeHttpMetadata(headers);
  if (!headers.has('content-type')) headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('etag', obj.httpEtag);
  // Legacy keys are fully caller-chosen → hardest case. Force inert + download.
  applyAssetSecurityHeaders(headers);
  return new Response(obj.body, { headers });
};

// ────────────────────────────────────────────────────────────────────────
// Jira draft (Workers AI)
// ────────────────────────────────────────────────────────────────────────

/**
 * Build a minimal but useful bug-draft skeleton from the captured artifacts
 * without involving the AI. Two callers:
 *   - `!env.AI`: AI binding missing in this deployment.
 *   - AI generation throws / times out / returns non-JSON: graceful
 *     fallback so the report still publishes to Jira. The caller flags
 *     `stub: true` so the chain records a warning instead of failing.
 *
 * Content rule: fill the FORM with defaults derived from the data we
 * already have (userInput, meta, sniffed attachments). The reviewer can
 * polish in Jira after publish. No fabrication.
 */
const buildBugStubDraft = (args: {
  userInput: string;
  meta: unknown;
  artifacts?: DraftInputArtifacts;
}): {
  title: string;
  overview: string;
  reproSteps: string[];
  envBullets: string[];
  attachments: { consoleError: string | null; failedRequest: string | null };
} => {
  const { userInput, meta, artifacts } = args;
  const title = userInput.trim().slice(0, 50) || 'Bugzar bug';
  const overview =
    userInput.trim() || '(사용자 한 줄 설명 없음 — Replay 영상에서 재현 절차를 확인하세요.)';
  const envBullets: string[] = [];
  const m = (meta && typeof meta === 'object' ? meta : {}) as Record<string, unknown>;
  if (typeof m.url === 'string') envBullets.push(`URL: ${m.url}`);
  if (m.viewport && typeof m.viewport === 'object') {
    envBullets.push(`Viewport: ${JSON.stringify(m.viewport)}`);
  }
  if (typeof m.userAgent === 'string') envBullets.push(`User-Agent: ${m.userAgent.slice(0, 140)}`);
  if (typeof m.startedAt === 'number') {
    envBullets.push(`발생 시각: ${new Date(m.startedAt).toISOString()}`);
  }
  if (typeof m.durationMs === 'number') envBullets.push(`지속 시간: ${m.durationMs}ms`);
  const sniff = artifacts
    ? sniffAttachments(artifacts)
    : { consoleError: null, failedRequest: null };
  return {
    title,
    overview,
    reproSteps: ['(AI 자동 생성 실패 — Replay 영상에서 직접 재현 절차를 확인 후 보완 필요)'],
    envBullets,
    attachments: sniff,
  };
};

const handleBugDraft = async (
  env: Env,
  input: { artifacts: DraftInputArtifacts; userInput: string; replayUrl: string },
): Promise<Response> => {
  const { artifacts, userInput, replayUrl } = input;
  const meta = (
    artifacts.meta && typeof artifacts.meta === 'object' ? artifacts.meta : {}
  ) as Record<string, unknown>;

  // AI binding entirely absent (dev / unconfigured deployment) — stub.
  if (!env.AI) {
    console.warn('[jira:draft:bug] AI binding missing — returning stub');
    const stub = buildBugStubDraft({ userInput, meta, artifacts });
    return jsonResponse(200, {
      title: stub.title,
      description: jsonToBugAdf(stub, replayUrl),
      mode: 'bug',
      stub: true,
    });
  }

  try {
    const draft = await generateBugDraft(env.AI, {
      artifacts,
      userInput,
      ...(env.AI_MODEL_BUG ? { model: env.AI_MODEL_BUG } : {}),
    });
    return jsonResponse(200, {
      title: draft.title,
      description: jsonToBugAdf(draft, replayUrl),
      mode: 'bug',
    });
  } catch (err) {
    // AI failure (non-JSON / timeout / 503 / rate-limit / schema violation) — fall
    // back to a stub built from the inline artifacts so the ticket still publishes.
    console.warn(
      '[jira:draft:bug] AI generation failed, falling back to stub:',
      (err as Error).message,
    );
    const stub = buildBugStubDraft({ userInput, meta, artifacts });
    return jsonResponse(200, {
      title: stub.title,
      description: jsonToBugAdf(stub, replayUrl),
      mode: 'bug',
      stub: true,
    });
  }
};

/**
 * Same pattern as buildBugStubDraft: fill the design-mode form with
 * defaults from user input + selected elements + meta. Used both when the
 * AI binding is absent and when AI generation throws.
 */
const buildDesignStubDraft = (args: {
  userInput: string;
  meta: Record<string, unknown>;
  elements: DesignElementInput[];
}): {
  title: string;
  overview: string;
  items: Array<{
    selector: string;
    location: string;
    issue: string;
    suggestion: string;
    severityHint: 'minor';
  }>;
  envBullets: string[];
} => {
  const { userInput, meta, elements } = args;
  return {
    title: `[디자인] ${userInput.slice(0, 50) || '(no title)'}`,
    overview:
      userInput.trim() || '(사용자 한 줄 설명 없음 — 각 요소의 메모와 Replay 영상을 참고하세요.)',
    items: elements.map((el) => ({
      selector: el.selector,
      location: el.componentName ?? el.selector,
      issue: el.userNote || '(메모 없음)',
      suggestion: '(AI 자동 생성 실패 — 직접 보완 필요)',
      severityHint: 'minor' as const,
    })),
    envBullets: [
      `URL: ${typeof meta.url === 'string' ? meta.url : '(unknown)'}`,
      `Viewport: ${meta.viewport ? JSON.stringify(meta.viewport) : '(unknown)'}`,
    ],
  };
};

const handleDesignDraft = async (
  env: Env,
  input: {
    elements: DesignElementInput[];
    meta: Record<string, unknown>;
    userInput: string;
    replayUrl: string;
  },
): Promise<Response> => {
  const { elements, meta, userInput, replayUrl } = input;
  const elementsLite: SelectedElementLite[] = elements.map((el) => ({
    id: el.id,
    selector: el.selector,
  }));

  if (!env.AI) {
    console.warn('[jira:draft:design] AI binding missing — returning stub');
    const stub = buildDesignStubDraft({ userInput, meta, elements });
    return jsonResponse(200, {
      title: stub.title,
      description: jsonToDesignAdf(stub, replayUrl, elementsLite),
      mode: 'design',
      stub: true,
    });
  }

  try {
    const draft = await generateDesignDraft(env.AI, {
      elements,
      userInput,
      meta,
      ...(env.AI_MODEL_DESIGN ? { model: env.AI_MODEL_DESIGN } : {}),
    });
    return jsonResponse(200, {
      title: draft.title,
      description: jsonToDesignAdf(draft, replayUrl, elementsLite),
      mode: 'design',
    });
  } catch (err) {
    // Mirror the bug-mode behavior: AI failure falls back to a stub built
    // from the user's per-element notes + meta, so the report still publishes.
    console.warn(
      '[jira:draft:design] AI generation failed, falling back to stub:',
      (err as Error).message,
    );
    const stub = buildDesignStubDraft({ userInput, meta, elements });
    return jsonResponse(200, {
      title: stub.title,
      description: jsonToDesignAdf(stub, replayUrl, elementsLite),
      mode: 'design',
      stub: true,
    });
  }
};

const handleJiraDraft = async (req: Request, env: Env): Promise<Response> => {
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
  // userInput is OPTIONAL — when the reviewer hasn't typed a seed, the AI drafts
  // the report purely from the captured artifacts (auto-draft). The generators and
  // the stub fallback both tolerate an empty userInput.
  const userInput = (body.userInput ?? '').trim();
  const mode = body.mode ?? 'bug';
  if (mode !== 'bug' && mode !== 'design') {
    return errorResponse(400, `unsupported mode: ${mode}`);
  }
  // The replay link is the consumer's R2/S3 URL (from `onExport`); empty → no link.
  const replayUrl = (body.url ?? '').trim();

  if (mode === 'design') {
    return handleDesignDraft(env, {
      elements: body.elements ?? [],
      meta: (body.meta && typeof body.meta === 'object' ? body.meta : {}) as Record<
        string,
        unknown
      >,
      userInput,
      replayUrl,
    });
  }
  return handleBugDraft(env, { artifacts: body.artifacts ?? {}, userInput, replayUrl });
};

// ────────────────────────────────────────────────────────────────────────
// Jira issue creation
//
// @deprecated Since Phase 2 Task 14, the extension calls Atlassian Cloud
// directly from the popup using user-bound OAuth (no service account /
// shared token). This handler is kept only so older extension builds —
// and the M0 mock backend fixture used by some E2E tests — keep working.
// New extension code should not POST here.
// ────────────────────────────────────────────────────────────────────────

const handleJiraIssue = async (req: Request, env: Env): Promise<Response> => {
  console.warn(
    '[jira:issue] DEPRECATED endpoint hit — popup-side issue creation took over (Phase 2 Task 14)',
  );
  let body: { title?: string; description?: string; sessionId?: string; replayUrl?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return errorResponse(400, 'invalid json');
  }

  if (!env.JIRA_API_TOKEN || !env.JIRA_API_BASE || !env.JIRA_EMAIL || !env.JIRA_PROJECT_KEY) {
    const key = `BUGZAR-${String(Date.now()).slice(-5)}`;
    const ticketUrl = `https://example.invalid/browse/${key}`;
    console.log('[jira:stub] would create:', key, body.title);
    return jsonResponse(200, { key, url: ticketUrl });
  }

  const adfDescription = {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: body.description ?? '' }],
      },
    ],
  };
  const payload = {
    fields: {
      project: { key: env.JIRA_PROJECT_KEY },
      summary: body.title ?? '(no title)',
      description: adfDescription,
      issuetype: { name: 'Bug' },
    },
  };

  const auth = btoa(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`);
  const res = await fetch(`${env.JIRA_API_BASE.replace(/\/+$/, '')}/rest/api/3/issue`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${auth}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error('[jira] create failed', res.status, errText);
    return errorResponse(502, `jira ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = (await res.json()) as { key?: string };
  if (!data.key) return errorResponse(502, 'jira returned no key');
  return jsonResponse(200, {
    key: data.key,
    url: `${env.JIRA_API_BASE.replace(/\/+$/, '')}/browse/${data.key}`,
  });
};

// ────────────────────────────────────────────────────────────────────────
// Telemetry (Phase 2 Task 27 / R27)
//
// POST /telemetry/event accepts `{name, props, sessionIdHash?, accountIdHash?,
// extVersion, ts}` from the extension. Body validation rejects anything that
// could leak PII (selectors, raw ids, free text). When the Analytics Engine
// binding is unset, we just log the event — useful for local dev + as a
// graceful fallback if the AE dataset is misconfigured in prod.
// ────────────────────────────────────────────────────────────────────────

const TELEMETRY_EVENT_NAMES = [
  'mode_picked',
  'submit_started',
  'submit_succeeded',
  'submit_failed',
  'ai_schema_violation',
  'oauth_succeeded',
  'picker_started',
  'picker_completed',
  // PR-13 신규
  'ai_fallback', // props.reason: 'timeout' | 'schema_violation' | 'parse_error' | 'api_error'
  'recording_started', // props.mode: 'bug' | 'design'
  'recording_completed', // props.durationMs: number
] as const;
type TelemetryEventName = (typeof TELEMETRY_EVENT_NAMES)[number];
const isTelemetryEventName = (s: string): s is TelemetryEventName =>
  (TELEMETRY_EVENT_NAMES as readonly string[]).includes(s);

/** Hash field length sanity check — see `hashId` in lib/telemetry-core. */
const isShortHexHash = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8,64}$/i.test(v);

interface ValidatedTelemetryEvent {
  name: TelemetryEventName;
  props: Record<string, string | number | boolean | null>;
  sessionIdHash: string | null;
  accountIdHash: string | null;
  extVersion: string;
  ts: number;
}

/**
 * Coerce the incoming JSON body into a validated event. We refuse anything
 * we don't recognize so a typo or a malicious client can't poison the AE
 * dataset with high-cardinality / PII-shaped data.
 */
const validateTelemetryEvent = (raw: unknown): ValidatedTelemetryEvent | { error: string } => {
  if (!raw || typeof raw !== 'object') return { error: 'body must be an object' };
  const o = raw as Record<string, unknown>;

  if (typeof o.name !== 'string' || !isTelemetryEventName(o.name)) {
    return { error: `unknown event name: ${String(o.name)}` };
  }

  const propsIn =
    o.props && typeof o.props === 'object' ? (o.props as Record<string, unknown>) : {};
  const props: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(propsIn)) {
    if (k.length > 32) continue;
    if (v === null || typeof v === 'boolean') {
      props[k] = v;
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      props[k] = v;
    } else if (typeof v === 'string') {
      // Strings get hard-trimmed so a client can't smuggle a long URL or
      // free-text note into "props" — coarse vocabulary only.
      if (v.length > 64) continue;
      props[k] = v;
    }
  }

  const sessionIdHash =
    o.sessionIdHash === null || o.sessionIdHash === undefined
      ? null
      : isShortHexHash(o.sessionIdHash)
        ? (o.sessionIdHash as string)
        : null;
  const accountIdHash =
    o.accountIdHash === null || o.accountIdHash === undefined
      ? null
      : isShortHexHash(o.accountIdHash)
        ? (o.accountIdHash as string)
        : null;
  const extVersion = typeof o.extVersion === 'string' ? o.extVersion.slice(0, 32) : '0.0.0';
  const ts = typeof o.ts === 'number' && Number.isFinite(o.ts) ? o.ts : Date.now();

  return { name: o.name, props, sessionIdHash, accountIdHash, extVersion, ts };
};

/**
 * Project the validated event into the Analytics Engine column model
 * (indexes / blobs / doubles). Kept tiny and explicit — every blob/index
 * slot is documented so the AE schema doesn't drift silently.
 */
const eventToDataPoint = (ev: ValidatedTelemetryEvent): AnalyticsEngineDataPoint => {
  const mode = typeof ev.props.mode === 'string' ? ev.props.mode : '';
  const step = typeof ev.props.step === 'string' ? ev.props.step : '';
  // `ai_fallback`은 `reason`을 blob3 slot에 재사용한다. 기존 `errorType` 슬롯과
  // 동일 컬럼을 쓰므로 AE 스키마가 늘어나지 않는다.
  const errorType =
    typeof ev.props.errorType === 'string'
      ? ev.props.errorType
      : typeof ev.props.reason === 'string'
        ? ev.props.reason
        : '';
  const elementCount = typeof ev.props.elementCount === 'number' ? ev.props.elementCount : 0;
  const durationMs = typeof ev.props.durationMs === 'number' ? ev.props.durationMs : 0;

  return {
    // index = primary group key. Event name has low cardinality (8 values).
    indexes: [ev.name],
    // blobs = high-readability tags. Order is stable — never reshuffle.
    //   blob1 = mode, blob2 = step, blob3 = errorType, blob4 = extVersion,
    //   blob5 = sessionIdHash, blob6 = accountIdHash.
    blobs: [mode, step, errorType, ev.extVersion, ev.sessionIdHash ?? '', ev.accountIdHash ?? ''],
    // doubles = numeric metrics.
    //   double1 = elementCount, double2 = durationMs.
    doubles: [elementCount, durationMs],
  };
};

const handleTelemetryEvent = async (req: Request, env: Env): Promise<Response> => {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return errorResponse(400, 'invalid json');
  }
  const ev = validateTelemetryEvent(parsed);
  if ('error' in ev) return errorResponse(400, ev.error);

  if (env.BUGZAR_ANALYTICS) {
    try {
      env.BUGZAR_ANALYTICS.writeDataPoint(eventToDataPoint(ev));
    } catch (err) {
      console.warn('[telemetry] writeDataPoint failed', (err as Error).message);
    }
  } else {
    // No binding → log it. Useful for `wrangler dev` and as a safety net so
    // misconfigured prod still leaves a breadcrumb.
    console.log('[telemetry]', ev.name, JSON.stringify(ev.props));
  }

  return jsonResponse(202, { ok: true });
};

/**
 * PR-24 — Atlassian OAuth token exchange proxied through the Worker so the
 * client_secret never ships inside the extension bundle. Handles both the
 * initial authorization-code grant and the refresh-token grant.
 *
 * Wire shape (request body):
 *   { grant_type: 'authorization_code', code, code_verifier, redirect_uri }
 *   { grant_type: 'refresh_token', refresh_token }
 *
 * Response: forwards the upstream JSON verbatim under `tokens` on success
 * or the upstream error code under `error` on failure. We deliberately
 * don't transform Atlassian's error names — debugging stays grep-friendly.
 */
interface OAuthExchangeRequest {
  grant_type?: unknown;
  code?: unknown;
  code_verifier?: unknown;
  redirect_uri?: unknown;
  refresh_token?: unknown;
}
const handleOAuthExchange = async (req: Request, env: Env): Promise<Response> => {
  if (!originAllowed(req, env)) return errorResponse(403, 'origin not allowed');
  if (!env.ATLASSIAN_CLIENT_ID || !env.ATLASSIAN_CLIENT_SECRET) {
    return errorResponse(501, 'oauth exchange not configured');
  }
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return errorResponse(400, 'invalid json');
  }
  if (!parsed || typeof parsed !== 'object') return errorResponse(400, 'body must be an object');
  const body = parsed as OAuthExchangeRequest;
  const grant = typeof body.grant_type === 'string' ? body.grant_type : '';

  const upstreamBody: Record<string, string> = {
    client_id: env.ATLASSIAN_CLIENT_ID,
    client_secret: env.ATLASSIAN_CLIENT_SECRET,
  };

  if (grant === 'authorization_code') {
    if (
      typeof body.code !== 'string' ||
      typeof body.code_verifier !== 'string' ||
      typeof body.redirect_uri !== 'string'
    ) {
      return errorResponse(400, 'missing code / code_verifier / redirect_uri');
    }
    upstreamBody.grant_type = 'authorization_code';
    upstreamBody.code = body.code;
    upstreamBody.code_verifier = body.code_verifier;
    upstreamBody.redirect_uri = body.redirect_uri;
  } else if (grant === 'refresh_token') {
    if (typeof body.refresh_token !== 'string') {
      return errorResponse(400, 'missing refresh_token');
    }
    upstreamBody.grant_type = 'refresh_token';
    upstreamBody.refresh_token = body.refresh_token;
  } else {
    return errorResponse(400, `unsupported grant_type: ${grant}`);
  }

  const upstream = await fetch('https://auth.atlassian.com/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(upstreamBody),
  });

  const upstreamText = await upstream.text();
  if (!upstream.ok) {
    // Forward the upstream status so the extension surfaces it correctly.
    return new Response(
      JSON.stringify({ ok: false, status: upstream.status, body: upstreamText.slice(0, 500) }),
      {
        status: upstream.status,
        headers: { 'content-type': 'application/json', ...CORS_HEADERS },
      },
    );
  }

  let tokens: unknown;
  try {
    tokens = JSON.parse(upstreamText);
  } catch {
    return errorResponse(502, 'upstream returned non-json');
  }
  return jsonResponse(200, { ok: true, tokens });
};

/**
 * PR-19 — LLM-as-a-judge quality check. The popup (or a CI test rig) POSTs
 * the reproSteps array from the rendered draft; we score it on a fixed
 * heuristic (count >= 3 AND avg length >= 10) and emit a coarse pass/fail
 * to telemetry. Heavier judging (semantic correctness via a second LLM
 * call) can layer on without changing the wire shape.
 */
interface AiQualityRequest {
  reproSteps?: unknown;
  mode?: unknown;
}
const handleAiQuality = async (req: Request, env: Env): Promise<Response> => {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return errorResponse(400, 'invalid json');
  }
  if (!parsed || typeof parsed !== 'object') return errorResponse(400, 'body must be an object');
  const body = parsed as AiQualityRequest;
  const reproSteps = Array.isArray(body.reproSteps)
    ? body.reproSteps.filter((s): s is string => typeof s === 'string')
    : [];
  const count = reproSteps.length;
  const totalLen = reproSteps.reduce((s, r) => s + r.length, 0);
  const avgLen = count > 0 ? Math.round(totalLen / count) : 0;
  const qualityPass = count >= 3 && avgLen >= 10;
  const mode = body.mode === 'design' ? 'design' : 'bug';

  if (env.BUGZAR_ANALYTICS) {
    try {
      env.BUGZAR_ANALYTICS.writeDataPoint({
        indexes: ['ai_quality_check'],
        blobs: [mode, qualityPass ? 'pass' : 'fail'],
        doubles: [count, avgLen],
      });
    } catch (err) {
      console.warn('[ai-quality] telemetry write failed', (err as Error).message);
    }
  } else {
    console.log('[ai-quality]', { mode, qualityPass, count, avgLen });
  }

  return jsonResponse(200, { ok: true, qualityPass, count, avgLen });
};

/**
 * Lightweight discovery endpoint — returns the registered telemetry event
 * names and the current binding mode. Useful for ops debugging and as a
 * sanity check from CI: when `telemetryMode === 'analytics-engine'` the
 * dashboard should be receiving writes.
 *
 * NOTE: We can't query Analytics Engine from inside a Worker — DDSQL runs
 * out-of-band via the Cloudflare dashboard. Aggregated stats therefore live
 * in `docs/telemetry-queries.md`, not here.
 */
const handleTelemetrySummary = (env: Env): Response => {
  return jsonResponse(200, {
    telemetryMode: env.BUGZAR_ANALYTICS ? 'analytics-engine' : 'console',
    events: TELEMETRY_EVENT_NAMES,
    queryEndpoint: 'https://dash.cloudflare.com/?to=/:account/workers/analytics-engine',
  });
};

/**
 * GET /assets/rrweb-player.{js,css} — rrweb-player served same-origin so the
 * SDK's slim replay viewer can load it under the /r/:id CSP (`script-src 'self'`,
 * which blocks CDNs). Content is versioned by the deployed Worker → immutable.
 */
const handleGetPlayerAsset = (file: 'js' | 'css'): Response => {
  const isJs = file === 'js';
  return new Response(isJs ? RRWEB_PLAYER_JS : RRWEB_PLAYER_CSS, {
    headers: {
      'content-type': isJs ? 'application/javascript; charset=utf-8' : 'text/css; charset=utf-8',
      'cache-control': 'public, max-age=31536000, immutable',
      ...CORS_HEADERS,
    },
  });
};

// ────────────────────────────────────────────────────────────────────────
// M4 — SDK Jira publish (server-side, service account; F4-AUTH gated)
// ────────────────────────────────────────────────────────────────────────

const splitAllowlist = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * F4-AUTH / Phase B: gate the SDK routes by browser Origin. Unset allowlist =
 * open in local dev, but DENY when `PUBLIC_DEPLOY` is set (so a public Worker
 * isn't accidentally left wide open).
 */
const originAllowed = (req: Request, env: Env): boolean => {
  const allow = splitAllowlist(env.ALLOWED_ORIGINS);
  if (allow.length === 0) return !env.PUBLIC_DEPLOY;
  const origin = req.headers.get('Origin');
  return !!origin && allow.includes(origin);
};

/**
 * Treat the deploy as public (fail closed) when PUBLIC_DEPLOY is set OR any
 * other hardening signal is present: an operator who set ALLOWED_ORIGINS or
 * UPLOAD_SECRET clearly intends a locked deploy, so the enumeration index
 * shouldn't silently stay exposed just because PUBLIC_DEPLOY was forgotten.
 * (Write origin-gating is intentionally NOT folded in here — the token-only
 * model, UPLOAD_SECRET with no allowlist, must keep writes reachable.)
 */
const isPublicDeploy = (env: Env): boolean =>
  !!env.PUBLIC_DEPLOY || !!env.UPLOAD_SECRET || splitAllowlist(env.ALLOWED_ORIGINS).length > 0;

/**
 * S-6: the `GET /` index enumerates every report (host, captured URL, reporter).
 * Open in local dev, but on a public deploy it's hidden unless `PUBLIC_INDEX=1`
 * or an admin bearer is presented — report URLs stay reachable only by their
 * unguessable id (capability model).
 */
const indexAllowed = (req: Request, env: Env): boolean => {
  if (env.PUBLIC_INDEX === '1') return true;
  if (!isPublicDeploy(env)) return true;
  if (env.ADMIN_SECRET) {
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
    return !!token && timingSafeEqual(token, env.ADMIN_SECRET);
  }
  return false;
};

/** F4-AUTH: a caller may only target an allowlisted project (or, if unset, any shape-valid key). */
const projectAllowed = (projectKey: string, env: Env): boolean => {
  const allow = splitAllowlist(env.ALLOWED_PROJECT_KEYS);
  if (allow.length > 0) return allow.includes(projectKey);
  return /^[A-Z][A-Z0-9_]{1,20}$/.test(projectKey);
};

const jiraConfigured = (env: Env): boolean =>
  !!(env.JIRA_API_BASE && env.JIRA_EMAIL && env.JIRA_API_TOKEN);

/** Build the publish ADF: use a provided ADF doc (e.g. from /jira/draft) or wrap text, with an optional reporter line on top. */
const buildPublishAdf = (provided: unknown, text: string, reporterLine: string | null): unknown => {
  const top = reporterLine
    ? [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: reporterLine, marks: [{ type: 'em' }] }],
        },
      ]
    : [];
  if (provided && typeof provided === 'object' && (provided as { type?: unknown }).type === 'doc') {
    const doc = provided as { content?: unknown };
    return {
      type: 'doc',
      version: 1,
      content: [...top, ...(Array.isArray(doc.content) ? doc.content : [])],
    };
  }
  return {
    type: 'doc',
    version: 1,
    content: [
      ...top,
      { type: 'paragraph', content: [{ type: 'text', text: text || '(no description)' }] },
    ],
  };
};

/**
 * POST /reports/:id/publish — create a Jira issue server-side (service account).
 * The browser never holds an Atlassian token. The host-supplied reporter is
 * ADVISORY metadata (body line + `qa-reporter:<email>` label), not the Jira
 * `reporter` field (which needs an accountId).
 */
const handlePublish = async (req: Request, env: Env): Promise<Response> => {
  if (!originAllowed(req, env)) return errorResponse(403, 'origin not allowed');
  let body: {
    title?: string;
    description?: string;
    descriptionAdf?: unknown;
    projectKey?: string;
    epicKey?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return errorResponse(400, 'invalid json');
  }

  const title = (body.title ?? '').trim();
  if (!title) return errorResponse(400, 'title required');
  const projectKey = (body.projectKey ?? '').trim();
  if (!projectKey || !projectAllowed(projectKey, env)) {
    return errorResponse(400, 'projectKey missing or not allowed');
  }

  const adf = buildPublishAdf(body.descriptionAdf, body.description ?? '', null);
  const labels = ['bugzar'];

  if (!jiraConfigured(env)) {
    const key = `STUB-${String(Date.now()).slice(-5)}`;
    return jsonResponse(200, {
      stubbed: true,
      issueKey: key,
      issueUrl: `https://example.invalid/browse/${key}`,
    });
  }

  const base = env.JIRA_API_BASE!.replace(/\/+$/, '');
  const payload = {
    fields: {
      project: { key: projectKey },
      summary: title,
      description: adf,
      issuetype: { name: 'Bug' },
      labels,
      ...(body.epicKey ? { parent: { key: body.epicKey } } : {}),
    },
  };
  const auth = btoa(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`);
  const res = await fetch(`${base}/rest/api/3/issue`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${auth}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const t = await res.text();
    return errorResponse(502, `jira ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = (await res.json()) as { key?: string };
  if (!data.key) return errorResponse(502, 'jira returned no key');
  return jsonResponse(200, {
    stubbed: false,
    issueKey: data.key,
    issueUrl: `${base}/browse/${data.key}`,
  });
};

/**
 * GET /jira/epics?q=&projectKey= — server-side Epic search. Project scope is
 * FORCED server-side (allowlisted, never from `q`); `q` only parameterizes the
 * quoted `summary ~` term (quotes escaped) → no JQL break-out / SSRF widening.
 */
const handleEpics = async (req: Request, env: Env): Promise<Response> => {
  if (!originAllowed(req, env)) return errorResponse(403, 'origin not allowed');
  const url = new URL(req.url);
  // projectKey OPTIONAL — omitted ⇒ global Epic search (project derived from the
  // chosen epic on publish).
  const projectKey = (url.searchParams.get('projectKey') ?? env.JIRA_PROJECT_KEY ?? '').trim();
  if (projectKey && !projectAllowed(projectKey, env)) {
    return errorResponse(400, 'projectKey not allowed');
  }
  const q = (url.searchParams.get('q') ?? '').trim();
  if (q.length === 0) return jsonResponse(200, { epics: [] }); // require a query
  if (q.length > 80) return errorResponse(400, 'query too long');

  if (!jiraConfigured(env)) return jsonResponse(200, { stubbed: true, epics: [] });

  // q is wrapped in a quoted summary~ term; escape quotes/backslashes so it
  // can't close the string and inject clauses. project is never taken from q.
  const safeQ = q.replace(/["\\]/g, '\\$&');
  // An issue-key-shaped query (e.g. "BUGZAR-123") matches by key so testers can paste
  // a ticket id; otherwise it's a prefix title match. Key queries search key ONLY —
  // `summary ~ "BUGZAR-123*"` would treat the hyphen as a text NOT operator and can
  // break the whole clause.
  const isKey = /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(q);
  const match = isKey ? `key = "${q.toUpperCase()}"` : `summary ~ "${safeQ}*"`;
  const jql = `${projectKey ? `project = "${projectKey}" AND ` : ''}issuetype = Epic AND ${match} ORDER BY updated DESC`;
  const base = env.JIRA_API_BASE!.replace(/\/+$/, '');
  const auth = btoa(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`);
  const res = await fetch(
    `${base}/rest/api/3/search/jql?${new URLSearchParams({ jql, maxResults: '20', fields: 'summary' })}`,
    { headers: { authorization: `Basic ${auth}`, accept: 'application/json' } },
  );
  if (!res.ok) return errorResponse(502, `jira ${res.status}`);
  const data = (await res.json()) as { issues?: { key: string; fields?: { summary?: string } }[] };
  return jsonResponse(200, {
    stubbed: false,
    epics: (data.issues ?? []).map((i) => ({ key: i.key, summary: i.fields?.summary ?? '' })),
  });
};

// ────────────────────────────────────────────────────────────────────────
// SDK per-user Atlassian OAuth (browser popup flow)
//
// The SDK runs in a normal web page (no chrome.identity), so it opens an
// Atlassian login popup that redirects to /oauth/callback, which posts the code
// back to the opener. The token exchange reuses /oauth/exchange (secret stays in
// the Worker). Because api.atlassian.com is CORS-blocked from a page, the SDK
// calls Atlassian THROUGH these proxy routes, forwarding the user's access token
// in an `X-Atlassian-Authorization` header (kept separate from host endpoint auth).
// ────────────────────────────────────────────────────────────────────────

/** OAuth popup landing page — postMessages the code/state back to the opener. */
const handleOAuthCallback = (): Response => {
  const html = `<!doctype html><meta charset="utf-8"><title>Bugzar — Atlassian</title>
<body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#18181b;color:#a1a1aa;display:grid;place-items:center;height:100vh;margin:0">
<p>Connecting…</p>
<script>
(function(){
  try {
    var p = new URLSearchParams(location.search);
    if (window.opener) {
      window.opener.postMessage({
        source: 'bugzar-oauth',
        code: p.get('code'),
        state: p.get('state'),
        error: p.get('error'),
      }, '*');
    }
  } catch (e) {}
  setTimeout(function(){ try { window.close(); } catch (e) {} }, 150);
})();
</script>`;
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', ...CORS_HEADERS },
  });
};

/** Read the user's Atlassian access token from the dedicated proxy header. */
const getAtlassianToken = (req: Request): string | null => {
  const h = (req.headers.get('X-Atlassian-Authorization') ?? '').trim();
  const m = /^Bearer\s+(.+)$/i.exec(h);
  const token = m?.[1]?.trim() ?? (h || '');
  return token || null;
};

/** GET /jira/oauth/resources — the user's accessible Atlassian sites (cloudId + url). */
const handleJiraOAuthResources = async (req: Request): Promise<Response> => {
  const token = getAtlassianToken(req);
  if (!token) return errorResponse(401, 'missing atlassian token');
  const res = await fetch('https://api.atlassian.com/oauth/token/accessible-resources', {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) {
    return errorResponse(
      res.status === 401 ? 401 : 502,
      `atlassian ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return errorResponse(502, 'atlassian returned non-json');
  }
  const sites = (Array.isArray(raw) ? raw : [])
    .map((r) => r as { id?: unknown; url?: unknown; name?: unknown })
    .filter((r) => typeof r.id === 'string' && typeof r.url === 'string')
    .map((r) => ({ id: r.id as string, url: r.url as string, name: (r.name as string) ?? '' }));
  return jsonResponse(200, { sites });
};

/** GET /jira/oauth/myself?cloudId= — the connected account (name + avatar). */
const handleJiraOAuthMyself = async (req: Request, url: URL): Promise<Response> => {
  const token = getAtlassianToken(req);
  if (!token) return errorResponse(401, 'missing atlassian token');
  const cloudId = (url.searchParams.get('cloudId') ?? '').trim();
  if (!/^[\w-]{6,64}$/.test(cloudId)) return errorResponse(400, 'cloudId required');
  const res = await fetch(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/myself`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) {
    return errorResponse(
      res.status === 401 ? 401 : 502,
      `atlassian ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  let d: {
    accountId?: string;
    displayName?: string;
    emailAddress?: string;
    avatarUrls?: Record<string, string>;
  };
  try {
    d = JSON.parse(text);
  } catch {
    return errorResponse(502, 'atlassian returned non-json');
  }
  return jsonResponse(200, {
    accountId: d.accountId ?? '',
    displayName: d.displayName ?? '',
    email: d.emailAddress ?? null,
    avatarUrl: d.avatarUrls?.['48x48'] ?? null,
  });
};

/** GET /jira/oauth/epics?cloudId=&projectKey=&q= — epic search as the user. */
const handleJiraOAuthEpics = async (req: Request, url: URL): Promise<Response> => {
  const token = getAtlassianToken(req);
  if (!token) return errorResponse(401, 'missing atlassian token');
  const cloudId = (url.searchParams.get('cloudId') ?? '').trim();
  if (!/^[\w-]{6,64}$/.test(cloudId)) return errorResponse(400, 'cloudId required');
  // projectKey OPTIONAL — when omitted, search Epics across ALL accessible
  // projects (the project is derived from the chosen epic key on publish).
  const projectKey = (url.searchParams.get('projectKey') ?? '').trim();
  if (projectKey && !/^[A-Z][A-Z0-9_]{1,20}$/.test(projectKey)) {
    return errorResponse(400, 'bad projectKey');
  }
  const q = (url.searchParams.get('q') ?? '').replace(/["\\]/g, '').slice(0, 80);
  // A query shaped like an issue key (e.g. "BUGZAR-123") matches by key, so a tester
  // can paste a ticket id; otherwise it's an as-you-type title match. Key queries
  // search key ONLY — `summary ~ "BUGZAR-123*"` would treat the hyphen as a text NOT
  // operator and can break the clause. (`key` takes only alphanumerics + one
  // hyphen, so it can't inject JQL.)
  const isKey = /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(q);
  const match = isKey
    ? `key = "${q.toUpperCase()}"`
    : // Prefix wildcard so partial titles match (Jira `~` is word-based;
      // `summary ~ "check"` won't match "checkout", `summary ~ "check*"` will).
      `summary ~ "${q}*"`;
  const jql =
    `${projectKey ? `project = "${projectKey}" AND ` : ''}issuetype = Epic` +
    (q ? ` AND ${match}` : '') +
    ' ORDER BY updated DESC';
  const api = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/search/jql?${new URLSearchParams(
    { jql, maxResults: '10', fields: 'summary' },
  )}`;
  const res = await fetch(api, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) {
    return errorResponse(
      res.status === 401 ? 401 : 502,
      `atlassian ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  let d: { issues?: Array<{ key?: string; fields?: { summary?: string } }> };
  try {
    d = JSON.parse(text);
  } catch {
    return errorResponse(502, 'atlassian returned non-json');
  }
  return jsonResponse(200, {
    epics: (d.issues ?? []).map((i) => ({ key: i.key ?? '', summary: i.fields?.summary ?? '' })),
  });
};

/** POST /jira/oauth/publish — create a Jira issue AS THE USER (their token). */
const handleJiraOAuthPublish = async (req: Request, env: Env): Promise<Response> => {
  if (!originAllowed(req, env)) return errorResponse(403, 'origin not allowed');
  const token = getAtlassianToken(req);
  if (!token) return errorResponse(401, 'missing atlassian token');
  let body: {
    cloudId?: string;
    siteUrl?: string;
    projectKey?: string;
    title?: string;
    description?: string;
    descriptionAdf?: unknown;
    epicKey?: string;
    issueType?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return errorResponse(400, 'invalid json');
  }
  const cloudId = (body.cloudId ?? '').trim();
  if (!/^[\w-]{6,64}$/.test(cloudId)) return errorResponse(400, 'cloudId required');
  const title = (body.title ?? '').trim();
  if (!title) return errorResponse(400, 'title required');
  const projectKey = (body.projectKey ?? '').trim();
  if (!projectKey || !projectAllowed(projectKey, env)) {
    return errorResponse(400, 'projectKey missing or not allowed');
  }
  const issueType = /^[\w\s-]{1,40}$/.test(body.issueType ?? '')
    ? (body.issueType as string)
    : 'Task';
  const adf = buildPublishAdf(body.descriptionAdf, body.description ?? '', null);
  const payload = {
    fields: {
      project: { key: projectKey },
      summary: title,
      description: adf,
      issuetype: { name: issueType },
      labels: ['bugzar'],
      ...(body.epicKey ? { parent: { key: body.epicKey } } : {}),
    },
  };
  const res = await fetch(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    return errorResponse(
      res.status === 401 ? 401 : 502,
      `jira ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  let d: { key?: string };
  try {
    d = JSON.parse(text);
  } catch {
    return errorResponse(502, 'atlassian returned non-json');
  }
  if (!d.key) return errorResponse(502, 'jira returned no key');
  const siteUrl = (body.siteUrl ?? '').replace(/\/+$/, '');
  const issueUrl = siteUrl ? `${siteUrl}/browse/${d.key}` : '';
  return jsonResponse(200, { issueKey: d.key, issueUrl });
};

// ────────────────────────────────────────────────────────────────────────
// Router
// ────────────────────────────────────────────────────────────────────────

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // ─── /assets/* — rrweb-player for the SDK's slim replay viewer ──────
    if (req.method === 'GET' && url.pathname === '/assets/rrweb-player.js') {
      return handleGetPlayerAsset('js');
    }
    if (req.method === 'GET' && url.pathname === '/assets/rrweb-player.css') {
      return handleGetPlayerAsset('css');
    }

    // ─── / — index page listing every published report ─────────────────
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/reports')) {
      if (!indexAllowed(req, env)) return errorResponse(404, 'not found');
      return handleListReports(env, url);
    }

    // ─── /reports — new flow ───────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/reports') {
      return handleCreateReport(req, env, url);
    }

    // PR-16: DELETE /reports/:id — admin-only soft delete. Match strictly
    // (no trailing asset segment) so this never collides with the asset
    // PUT/GET routes below.
    const reportDeleteMatch = /^\/reports\/([a-z0-9]{1,40})$/i.exec(url.pathname);
    if (reportDeleteMatch && req.method === 'DELETE') {
      const reportId = reportDeleteMatch[1];
      if (reportId) return handleDeleteReport(req, env, reportId);
    }

    // /reports/:id/elements/:elementId[.png]
    // 디자인 QA picker 가 picked element 마다 chrome viewport 한 장 따로 잡고
    // 그걸 별도 PNG 로 R2 에 올린다 (옛 단일 screenshot.png 폐기). elementId 는
    // crypto.randomUUID 라 URL-safe + path traversal 안전.
    const elementsMatch =
      /^\/reports\/([a-z0-9]{1,40})\/elements\/([a-z0-9-]{1,80})(?:\.png)?$/i.exec(url.pathname);
    if (elementsMatch) {
      const reportId = elementsMatch[1];
      const elementId = elementsMatch[2];
      if (!reportId || !elementId) return errorResponse(400, 'bad element path');
      if (req.method === 'PUT') return handlePutElementScreenshot(req, env, reportId, elementId);
      if (req.method === 'GET') return handleGetElementScreenshot(env, reportId, elementId);
    }

    // POST /jira/publish — report-less SDK Jira publish (service account). F4-AUTH gated.
    if (req.method === 'POST' && url.pathname === '/jira/publish') {
      return handlePublish(req, env);
    }
    // Legacy /reports/:id/publish alias (id ignored) — matched BEFORE the /:asset
    // catch-all so "publish" isn't captured as an asset name.
    const publishMatch = /^\/reports\/([a-z0-9]{1,40})\/publish$/i.exec(url.pathname);
    if (publishMatch && req.method === 'POST') {
      return handlePublish(req, env);
    }

    // /reports/:id/:asset[.ext]
    const reportsMatch = /^\/reports\/([a-z0-9]{1,40})\/([^/]+)$/i.exec(url.pathname);
    if (reportsMatch) {
      const reportId = reportsMatch[1];
      const assetSeg = reportsMatch[2];
      if (!reportId || !assetSeg) return errorResponse(400, 'bad report path');
      const asset = stripAssetExt(assetSeg);
      if (!isAsset(asset)) return errorResponse(400, `unknown asset: ${asset}`);
      if (req.method === 'PUT') return handlePutAsset(req, env, reportId, asset);
      if (req.method === 'GET') return handleGetAsset(env, reportId, asset);
    }

    // /r/:reportId — public share URL
    const shareMatch = /^\/r\/([a-z0-9]{1,40})$/i.exec(url.pathname);
    if (shareMatch && req.method === 'GET') {
      const reportId = shareMatch[1];
      if (reportId) return handleGetReport(env, reportId);
    }

    // ─── Legacy endpoints (backward compat) ────────────────────────────
    if (req.method === 'POST' && url.pathname === '/upload') {
      return handleLegacyUpload(req, env, url);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/artifacts/')) {
      return handleLegacyArtifactsGet(url, env);
    }

    // ─── Jira + health ─────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/jira/draft') {
      return handleJiraDraft(req, env);
    }
    if (req.method === 'GET' && url.pathname === '/jira/epics') {
      return handleEpics(req, env);
    }
    if (req.method === 'POST' && url.pathname === '/jira/issue') {
      return handleJiraIssue(req, env);
    }
    if (req.method === 'POST' && url.pathname === '/telemetry/event') {
      return handleTelemetryEvent(req, env);
    }
    if (req.method === 'GET' && url.pathname === '/telemetry/summary') {
      return handleTelemetrySummary(env);
    }
    if (req.method === 'POST' && url.pathname === '/telemetry/ai-quality') {
      return handleAiQuality(req, env);
    }
    if (req.method === 'POST' && url.pathname === '/oauth/exchange') {
      return handleOAuthExchange(req, env);
    }
    if (req.method === 'GET' && url.pathname === '/oauth/callback') {
      return handleOAuthCallback();
    }
    if (req.method === 'GET' && url.pathname === '/jira/oauth/resources') {
      return handleJiraOAuthResources(req);
    }
    if (req.method === 'GET' && url.pathname === '/jira/oauth/myself') {
      return handleJiraOAuthMyself(req, url);
    }
    if (req.method === 'GET' && url.pathname === '/jira/oauth/epics') {
      return handleJiraOAuthEpics(req, url);
    }
    if (req.method === 'POST' && url.pathname === '/jira/oauth/publish') {
      return handleJiraOAuthPublish(req, env);
    }
    if (req.method === 'GET' && url.pathname === '/__state') {
      return jsonResponse(200, {
        ok: true,
        worker: 'bugzar-backend',
        publicHost: env.PUBLIC_HOST || url.origin,
        jiraMode: env.JIRA_API_TOKEN ? 'real' : 'stub',
        aiMode: env.AI ? 'real' : 'stub',
        telemetryMode: env.BUGZAR_ANALYTICS ? 'analytics-engine' : 'console',
      });
    }

    return errorResponse(404, 'not found');
  },
  // PR-18 — daily retention cron. Schedule lives in wrangler.toml; this
  // handler is the entry point that Cloudflare invokes per the cron tab.
  scheduled(_event, env, ctx) {
    ctx.waitUntil(
      runRetentionCleanup(env).catch((err) => {
        console.error('[retention] scheduled run failed', err);
      }),
    );
  },
} satisfies ExportedHandler<Env>;
