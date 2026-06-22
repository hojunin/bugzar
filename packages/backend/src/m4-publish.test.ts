/**
 * M4 — SDK Jira publish + epic search (server-side service account, F4-AUTH).
 *
 *  - The stub path returns an EXPLICIT `stubbed:true` flag (not a fake-real key),
 *    so the SDK never shows a fabricated issue as published.
 *  - Origin + projectKey allowlists close the CORS-`*` open-ticket-creation hole.
 *  - Epic search forces the project server-side and escapes `q` → no JQL break-out.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from './worker';

const env = (over: Partial<Env> = {}): Env => ({ ...over }) as Env;

const post = (path: string, body: unknown, e: Env, headers: Record<string, string> = {}) =>
  worker.fetch(
    new Request(`https://w.example${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    e,
  );

const get = (path: string, e: Env, headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`https://w.example${path}`, { headers }), e);

afterEach(() => vi.restoreAllMocks());

describe('POST /reports/:id/publish', () => {
  it('stubs with an explicit stubbed:true flag when Jira is unconfigured', async () => {
    const res = await post('/reports/abc/publish', { title: 'Bug', projectKey: 'BUGZAR' }, env());
    expect(res.status).toBe(200);
    const b = (await res.json()) as { stubbed: boolean; issueKey: string };
    expect(b.stubbed).toBe(true);
    expect(b.issueKey).toMatch(/^STUB-/);
  });

  it('400 without a title', async () => {
    const res = await post('/reports/abc/publish', { projectKey: 'BUGZAR' }, env());
    expect(res.status).toBe(400);
  });

  it('400 when projectKey is not allowlisted', async () => {
    const res = await post(
      '/reports/abc/publish',
      { title: 'x', projectKey: 'SECRET' },
      env({ ALLOWED_PROJECT_KEYS: 'BUGZAR,OPS' }),
    );
    expect(res.status).toBe(400);
  });

  it('403 when Origin is not allowlisted', async () => {
    const res = await post(
      '/reports/abc/publish',
      { title: 'x', projectKey: 'BUGZAR' },
      env({ ALLOWED_ORIGINS: 'https://app.example' }),
      { Origin: 'https://evil.example' },
    );
    expect(res.status).toBe(403);
  });

  it('creates an issue with the configured creds + absolute URL', async () => {
    let sent: {
      fields: { labels: string[]; project: { key: string }; description: unknown };
    } | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        sent = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({ key: 'BUGZAR-42' }), { status: 200 });
      }),
    );
    const res = await post(
      '/reports/abc/publish',
      {
        title: 'Login broken',
        description: 'cannot submit',
        projectKey: 'BUGZAR',
      },
      env({
        JIRA_API_BASE: 'https://x.atlassian.net',
        JIRA_EMAIL: 'a@b.c',
        JIRA_API_TOKEN: 't',
        ALLOWED_PROJECT_KEYS: 'BUGZAR',
      }),
    );
    expect(res.status).toBe(200);
    const b = (await res.json()) as { stubbed: boolean; issueKey: string; issueUrl: string };
    expect(b.stubbed).toBe(false);
    expect(b.issueKey).toBe('BUGZAR-42');
    expect(b.issueUrl).toBe('https://x.atlassian.net/browse/BUGZAR-42');
    // Cast un-narrows `sent` (TS only sees the `= null` init; the callback
    // assignment is invisible to linear flow).
    const captured = sent as {
      fields: { labels: string[]; project: { key: string }; description: unknown };
    } | null;
    expect(captured?.fields.labels).toContain('bugzar');
    expect(captured?.fields.project.key).toBe('BUGZAR');
  });
});

describe('GET /jira/epics', () => {
  it('returns empty without a query', async () => {
    const res = await get('/jira/epics', env({ JIRA_PROJECT_KEY: 'BUGZAR' }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { epics: unknown[] }).epics).toEqual([]);
  });

  it('stubs when unconfigured', async () => {
    const res = await get('/jira/epics?q=login&projectKey=BUGZAR', env());
    expect(((await res.json()) as { stubbed?: boolean }).stubbed).toBe(true);
  });

  it('forces project server-side and escapes q (JQL injection cannot widen scope)', async () => {
    let sentUrl = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        sentUrl = String(url);
        return new Response(JSON.stringify({ issues: [] }), { status: 200 });
      }),
    );
    const res = await get(
      `/jira/epics?${new URLSearchParams({ q: 'x" OR project=SECRET', projectKey: 'BUGZAR' })}`,
      env({
        JIRA_API_BASE: 'https://x.atlassian.net',
        JIRA_EMAIL: 'a@b.c',
        JIRA_API_TOKEN: 't',
        ALLOWED_PROJECT_KEYS: 'BUGZAR',
      }),
    );
    expect(res.status).toBe(200);
    const jql = new URL(sentUrl).searchParams.get('jql') ?? '';
    expect(jql).toContain('project = "BUGZAR"');
    expect(jql).toContain('summary ~ "x\\" OR project=SECRET*"');
    expect(jql).not.toMatch(/project = "SECRET"/);
  });

  it('searches by key only (upper-cased) for an issue-key-shaped query', async () => {
    let sentUrl = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        sentUrl = String(url);
        return new Response(
          JSON.stringify({ issues: [{ key: 'BUGZAR-123', fields: { summary: 'Checkout' } }] }),
          { status: 200 },
        );
      }),
    );
    const res = await get(
      '/jira/epics?q=bugzar-123',
      env({ JIRA_API_BASE: 'https://x.atlassian.net', JIRA_EMAIL: 'a@b.c', JIRA_API_TOKEN: 't' }),
    );
    expect(res.status).toBe(200);
    const jql = new URL(sentUrl).searchParams.get('jql') ?? '';
    expect(jql).toContain('key = "BUGZAR-123"'); // exact key match, upper-cased
    expect(jql).not.toContain('summary ~'); // hyphen-fragile text clause dropped
  });
});
