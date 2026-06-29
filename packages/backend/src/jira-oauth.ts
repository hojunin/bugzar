/**
 * Bugzar backend — per-user Atlassian OAuth (browser popup flow).
 *
 *   POST /oauth/exchange       — proxy the token exchange so client_secret
 *                                never ships in the extension bundle.
 *   GET  /oauth/callback       — popup landing page that posts the code back.
 *   GET  /jira/oauth/resources — accessible Atlassian sites for the user.
 *   GET  /jira/oauth/myself    — the authenticated user.
 *   GET  /jira/oauth/epics     — epics in a project (as the user).
 *   POST /jira/oauth/publish   — create an issue AS THE USER (user's token).
 *
 * Extracted from worker.ts. The service-account Jira path lives in jira.ts.
 */

import { originAllowed, projectAllowed } from './config';
import { buildPublishAdf } from './jira';
import { CORS_HEADERS, type Env, errorResponse, jsonResponse } from './runtime';

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
export const handleOAuthExchange = async (req: Request, env: Env): Promise<Response> => {
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
export const handleOAuthCallback = (): Response => {
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
export const handleJiraOAuthResources = async (req: Request): Promise<Response> => {
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
export const handleJiraOAuthMyself = async (req: Request, url: URL): Promise<Response> => {
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
export const handleJiraOAuthEpics = async (req: Request, url: URL): Promise<Response> => {
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
export const handleJiraOAuthPublish = async (req: Request, env: Env): Promise<Response> => {
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
