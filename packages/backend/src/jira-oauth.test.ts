/**
 * SDK per-user Atlassian OAuth proxy routes. The Worker forwards the user's
 * access token (from X-Atlassian-Authorization) to api.atlassian.com so the
 * browser never hits CORS, and files the issue AS THE USER (not the service
 * account). Origin + projectKey allowlists still gate publish.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from './worker';

const env = (over: Partial<Env> = {}): Env => ({ ...over }) as Env;
const TOK = { 'X-Atlassian-Authorization': 'Bearer utok' };

const get = (path: string, e: Env, headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`https://w.example${path}`, { headers }), e);
const post = (path: string, body: unknown, e: Env, headers: Record<string, string> = {}) =>
  worker.fetch(
    new Request(`https://w.example${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    e,
  );

afterEach(() => vi.restoreAllMocks());

describe('GET /oauth/callback', () => {
  it('serves a page that postMessages the code back to the opener', async () => {
    const res = await get('/oauth/callback?code=abc&state=xyz', env());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('bugzar-oauth');
    expect(html).toContain('postMessage');
  });
});

describe('GET /jira/oauth/resources', () => {
  it('401 without a token', async () => {
    expect((await get('/jira/oauth/resources', env())).status).toBe(401);
  });

  it('forwards the user token and maps sites', async () => {
    let auth: string | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string | URL, init?: RequestInit) => {
        auth = new Headers(init?.headers).get('authorization');
        return new Response(
          JSON.stringify([{ id: 'cloud-1', url: 'https://acme.atlassian.net', name: 'acme' }]),
          { status: 200 },
        );
      }),
    );
    const res = await get('/jira/oauth/resources', env(), TOK);
    expect(res.status).toBe(200);
    expect(auth).toBe('Bearer utok');
    const b = (await res.json()) as { sites: Array<{ id: string; url: string }> };
    expect(b.sites[0]).toMatchObject({ id: 'cloud-1', url: 'https://acme.atlassian.net' });
  });
});

describe('GET /jira/oauth/epics', () => {
  it('forces project server-side and strips injected quotes', async () => {
    let sentUrl = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string | URL) => {
        sentUrl = String(u);
        return new Response(
          JSON.stringify({ issues: [{ key: 'BUGZAR-1', fields: { summary: 'Epic' } }] }),
          {
            status: 200,
          },
        );
      }),
    );
    const res = await get(
      `/jira/oauth/epics?${new URLSearchParams({ cloudId: 'cloud-1', projectKey: 'BUGZAR', q: 'x" OR project=SECRET' })}`,
      env(),
      TOK,
    );
    expect(res.status).toBe(200);
    const jql = new URL(sentUrl).searchParams.get('jql') ?? '';
    expect(jql).toContain('project = "BUGZAR"');
    // injected quote stripped → project=SECRET stays trapped inside the summary term (no breakout).
    // Trailing `*` is the as-you-type prefix wildcard.
    expect(jql).toContain('summary ~ "x OR project=SECRET*"');
    expect(jql).not.toMatch(/"\s+OR\s+project/i);
    expect(((await res.json()) as { epics: unknown[] }).epics).toHaveLength(1);
  });

  it('searches by key only (upper-cased) for an issue-key-shaped query', async () => {
    let sentUrl = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string | URL) => {
        sentUrl = String(u);
        return new Response(
          JSON.stringify({ issues: [{ key: 'BUGZAR-123', fields: { summary: 'Checkout' } }] }),
          { status: 200 },
        );
      }),
    );
    const res = await get(
      `/jira/oauth/epics?${new URLSearchParams({ cloudId: 'cloud-1', q: 'bugzar-123' })}`,
      env(),
      TOK,
    );
    expect(res.status).toBe(200);
    const jql = new URL(sentUrl).searchParams.get('jql') ?? '';
    expect(jql).toContain('key = "BUGZAR-123"'); // exact key match, upper-cased
    expect(jql).not.toContain('summary ~'); // hyphen-fragile text clause dropped
  });
});

describe('POST /jira/oauth/publish', () => {
  it('401 without a token', async () => {
    const res = await post(
      '/jira/oauth/publish',
      { cloudId: 'cloud-1', title: 'x', projectKey: 'BUGZAR' },
      env(),
    );
    expect(res.status).toBe(401);
  });

  it('403 when Origin is not allowlisted', async () => {
    const res = await post(
      '/jira/oauth/publish',
      { cloudId: 'cloud-1', title: 'x', projectKey: 'BUGZAR' },
      env({ ALLOWED_ORIGINS: 'https://app.example' }),
      { ...TOK, Origin: 'https://evil.example' },
    );
    expect(res.status).toBe(403);
  });

  it('400 without a cloudId', async () => {
    const res = await post('/jira/oauth/publish', { title: 'x', projectKey: 'BUGZAR' }, env(), TOK);
    expect(res.status).toBe(400);
  });

  it('files the issue AS THE USER (their Bearer token) and returns key + browse url', async () => {
    let auth: string | null = null;
    let sent: { fields: { issuetype: { name: string }; project: { key: string } } } | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string | URL, init?: RequestInit) => {
        auth = new Headers(init?.headers).get('authorization');
        sent = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({ key: 'BUGZAR-77' }), { status: 200 });
      }),
    );
    const res = await post(
      '/jira/oauth/publish',
      {
        cloudId: 'cloud-1',
        siteUrl: 'https://acme.atlassian.net',
        title: 'Button color wrong',
        description: 'fix it',
        projectKey: 'BUGZAR',
        issueType: 'Task',
      },
      env({ ALLOWED_PROJECT_KEYS: 'BUGZAR' }),
      TOK,
    );
    expect(res.status).toBe(200);
    expect(auth).toBe('Bearer utok');
    const b = (await res.json()) as { issueKey: string; issueUrl: string };
    expect(b.issueKey).toBe('BUGZAR-77');
    expect(b.issueUrl).toBe('https://acme.atlassian.net/browse/BUGZAR-77');
    const captured = sent as {
      fields: { issuetype: { name: string }; project: { key: string } };
    } | null;
    expect(captured?.fields.issuetype.name).toBe('Task');
    expect(captured?.fields.project.key).toBe('BUGZAR');
  });
});
