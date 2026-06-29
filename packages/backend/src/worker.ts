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

import { NETWORK_ASSET_CAP_BYTES } from '@bugzar/shared';
import { indexAllowed, originAllowed } from './config';
import { handleEpics, handleJiraDraft, handleJiraIssue, handlePublish } from './jira';
import {
  handleJiraOAuthEpics,
  handleJiraOAuthMyself,
  handleJiraOAuthPublish,
  handleJiraOAuthResources,
  handleOAuthCallback,
  handleOAuthExchange,
} from './jira-oauth';
import { handleListReports } from './reports-index';
import { runRetentionCleanup } from './retention';
import { RRWEB_PLAYER_CSS, RRWEB_PLAYER_JS } from './rrweb-player-asset.generated';
import {
  applyAssetSecurityHeaders,
  applyPilotHtmlSecurityHeaders,
  applyReplaySecurityHeaders,
  buildOrigin,
  CORS_HEADERS,
  type Env,
  errorResponse,
  escapeHtmlAttr,
  jsonResponse,
  timingSafeEqual,
} from './runtime';
import { handleAiQuality, handleTelemetryEvent, handleTelemetrySummary } from './telemetry';

// Re-exported for backward compatibility: tests and ./retention import these
// from './worker'.
export type { Env } from './runtime';

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
  network: NETWORK_ASSET_CAP_BYTES, // #20: large response bodies — only this asset needs >10MB
  video: 100 * 1024 * 1024,
  screenshot: 5 * 1024 * 1024,
};
export const assetCap = (asset?: AssetName): number =>
  (asset && MAX_ASSET_BYTES[asset]) || MAX_ASSET_BYTES.default;

/** Fast reject when the client *declares* an over-cap Content-Length. */
const overSizeLimit = (req: Request, asset?: AssetName): boolean => {
  const declared = Number(req.headers.get('content-length') ?? '0');
  return Number.isFinite(declared) && declared > assetCap(asset);
};

/** Sentinel so only the cap abort (not other R2 errors) maps to 413. */
const ASSET_TOO_LARGE = 'asset too large';

/**
 * Enforce the cap on the ACTUAL bytes, not just the declared Content-Length —
 * a chunked or header-omitted PUT otherwise streams straight past the ceiling
 * (`overSizeLimit` only sees the header). Counts bytes as R2 pulls the body and
 * aborts the stream once it exceeds `cap`, so the size guard can't be bypassed
 * by simply omitting/understating Content-Length.
 */
const capBodyStream = (
  body: ReadableStream<Uint8Array>,
  cap: number,
): ReadableStream<Uint8Array> => {
  let total = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > cap) controller.error(new Error(ASSET_TOO_LARGE));
        else controller.enqueue(chunk);
      },
    }),
  );
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
  // Cap the ACTUAL bytes, then buffer to a length-known ArrayBuffer: prod R2
  // rejects a bare TransformStream (no known length), and capBodyStream still
  // aborts mid-stream if the body runs past the cap.
  let payload: ArrayBuffer;
  try {
    payload = await new Response(capBodyStream(req.body, assetCap(asset))).arrayBuffer();
  } catch (e) {
    if (e instanceof Error && e.message === ASSET_TOO_LARGE)
      return errorResponse(413, 'asset too large');
    throw e;
  }
  await env.ARTIFACTS.put(key, payload, {
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
  let payload: ArrayBuffer;
  try {
    payload = await new Response(capBodyStream(req.body, assetCap('screenshot'))).arrayBuffer();
  } catch (e) {
    if (e instanceof Error && e.message === ASSET_TOO_LARGE)
      return errorResponse(413, 'asset too large');
    throw e;
  }
  await env.ARTIFACTS.put(key, payload, {
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
 * PILOT — single-object replay upload for the catalog `onExport` trial. Stores
 * under the `pilot/` prefix (outside the `reports/` asset set) and returns a
 * GET-able URL that becomes the Jira ticket's replay link. Trial surface, not
 * part of the documented SDK contract.
 */
const handlePilotPut = async (
  req: Request,
  env: Env,
  reqUrl: URL,
  key: string,
): Promise<Response> => {
  if (!req.body) return errorResponse(400, 'empty body');
  if (!originAllowed(req, env)) return errorResponse(403, 'origin not allowed');
  // R2 needs a known-length body (see handlePutAsset) — cap, then buffer.
  let payload: ArrayBuffer;
  try {
    payload = await new Response(capBodyStream(req.body, 50 * 1024 * 1024)).arrayBuffer();
  } catch (e) {
    if (e instanceof Error && e.message === ASSET_TOO_LARGE)
      return errorResponse(413, 'replay too large');
    throw e;
  }
  await env.ARTIFACTS.put(`pilot/${key}`, payload, {
    httpMetadata: {
      contentType: 'text/html; charset=utf-8',
      cacheControl: 'public, max-age=31536000, immutable',
    },
    customMetadata: { pilot: '1', uploadedAt: String(Date.now()) },
  });
  return jsonResponse(200, { url: `${buildOrigin(env, reqUrl)}/pilot/r2/${key}`, key });
};

const handlePilotGet = async (env: Env, key: string): Promise<Response> => {
  const obj = await env.ARTIFACTS.get(`pilot/${key}`);
  if (!obj) return new Response('not found', { status: 404, headers: CORS_HEADERS });
  const headers = new Headers(CORS_HEADERS);
  obj.writeHttpMetadata(headers); // preserve cache-control from the stored object
  if (obj.httpEtag) headers.set('etag', obj.httpEtag);
  // Render inline, but sandboxed into an opaque origin (see helper) so the
  // attacker-influenced HTML can't act on the Worker's own origin.
  applyPilotHtmlSecurityHeaders(headers);
  return new Response(obj.body, { headers });
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

    // PILOT — /pilot/r2/:key single-object replay upload (catalog onExport trial)
    const pilotMatch = /^\/pilot\/r2\/([\w.-]{1,128})$/.exec(url.pathname);
    if (pilotMatch) {
      const key = pilotMatch[1];
      if (key) {
        if (req.method === 'PUT') return handlePilotPut(req, env, url, key);
        if (req.method === 'GET') return handlePilotGet(env, key);
      }
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
