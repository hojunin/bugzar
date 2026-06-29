/**
 * Bugzar backend — Jira integration (service-account / API-token path).
 *
 * Two surfaces:
 *   - /jira/draft  — Workers AI synthesis of a BugDraft from captured artifacts
 *                    (handleBugDraft / handleDesignDraft, dispatched by
 *                    handleJiraDraft), with a deterministic stub fallback.
 *   - /jira/issue, /jira/publish, /jira/epics — post to Atlassian Cloud using
 *     the configured service account (stub when unconfigured), F4-AUTH gated.
 *
 * Extracted from worker.ts. The per-user OAuth flow lives in jira-oauth.ts.
 */

import { jsonToBugAdf, jsonToDesignAdf, type SelectedElementLite } from './adf';
import { jiraConfigured, originAllowed, projectAllowed } from './config';
import {
  buildBugStub,
  buildDesignStub,
  type DesignElementInput,
  type DraftInputArtifacts,
  generateBugDraft,
  generateDesignDraft,
} from './jira-draft';
import { type Env, errorResponse, jsonResponse } from './runtime';

// ────────────────────────────────────────────────────────────────────────
// Jira draft (Workers AI)
// ────────────────────────────────────────────────────────────────────────

// Stub fallback (AI binding missing / generation fails) is the deterministic
// draft built in jira-draft.ts (`buildBugStub` / `buildDesignStub`) — it
// synthesizes real repro steps from the curated timeline, not a placeholder.

const handleBugDraft = async (
  env: Env,
  input: { artifacts: DraftInputArtifacts; userInput: string; replayUrl: string },
): Promise<Response> => {
  const { artifacts, userInput, replayUrl } = input;

  // AI binding entirely absent (dev / unconfigured deployment) — stub.
  if (!env.AI) {
    console.warn('[jira:draft:bug] AI binding missing — returning stub');
    const stub = buildBugStub(artifacts, userInput);
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
    const stub = buildBugStub(artifacts, userInput);
    return jsonResponse(200, {
      title: stub.title,
      description: jsonToBugAdf(stub, replayUrl),
      mode: 'bug',
      stub: true,
    });
  }
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
    const stub = buildDesignStub(elements, userInput, meta);
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
    const stub = buildDesignStub(elements, userInput, meta);
    return jsonResponse(200, {
      title: stub.title,
      description: jsonToDesignAdf(stub, replayUrl, elementsLite),
      mode: 'design',
      stub: true,
    });
  }
};

export const handleJiraDraft = async (req: Request, env: Env): Promise<Response> => {
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

export const handleJiraIssue = async (req: Request, env: Env): Promise<Response> => {
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
// M4 — SDK Jira publish (server-side, service account; F4-AUTH gated)
// ────────────────────────────────────────────────────────────────────────

/** Build the publish ADF: use a provided ADF doc (e.g. from /jira/draft) or wrap text, with an optional reporter line on top. */
export const buildPublishAdf = (
  provided: unknown,
  text: string,
  reporterLine: string | null,
): unknown => {
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
export const handlePublish = async (req: Request, env: Env): Promise<Response> => {
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
export const handleEpics = async (req: Request, env: Env): Promise<Response> => {
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
