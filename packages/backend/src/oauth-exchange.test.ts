/**
 * PR-24 — server-side Atlassian OAuth exchange.
 *
 * We stub global `fetch` so the upstream `auth.atlassian.com/oauth/token`
 * call is captured and we can assert on the payload + status forwarding.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from './worker';

const baseEnv = (overrides: Partial<Env> = {}): Env =>
  ({
    ARTIFACTS: {} as unknown,
    ...overrides,
  }) as unknown as Env;

const buildReq = (body: unknown): Request =>
  new Request('https://example.com/oauth/exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const installFetchStub = (
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) => {
  vi.stubGlobal('fetch', vi.fn(handler));
};

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /oauth/exchange', () => {
  it('returns 501 when ATLASSIAN_CLIENT_ID/SECRET are unset', async () => {
    const res = await worker.fetch(
      buildReq({
        grant_type: 'authorization_code',
        code: 'x',
        code_verifier: 'v',
        redirect_uri: 'r',
      }),
      baseEnv(),
    );
    expect(res.status).toBe(501);
  });

  it('returns 400 for an unsupported grant_type', async () => {
    const res = await worker.fetch(
      buildReq({ grant_type: 'password' }),
      baseEnv({ ATLASSIAN_CLIENT_ID: 'id', ATLASSIAN_CLIENT_SECRET: 's' }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when authorization_code body is incomplete', async () => {
    const res = await worker.fetch(
      buildReq({ grant_type: 'authorization_code', code: 'x' }),
      baseEnv({ ATLASSIAN_CLIENT_ID: 'id', ATLASSIAN_CLIENT_SECRET: 's' }),
    );
    expect(res.status).toBe(400);
  });

  it('forwards the upstream token response on success', async () => {
    const upstream = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://auth.atlassian.com/oauth/token');
      const sent = JSON.parse(init?.body as string);
      expect(sent.client_id).toBe('myid');
      expect(sent.client_secret).toBe('mysecret');
      expect(sent.code).toBe('abc');
      return new Response(
        JSON.stringify({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', upstream);

    const res = await worker.fetch(
      buildReq({
        grant_type: 'authorization_code',
        code: 'abc',
        code_verifier: 'cv',
        redirect_uri: 'https://x',
      }),
      baseEnv({ ATLASSIAN_CLIENT_ID: 'myid', ATLASSIAN_CLIENT_SECRET: 'mysecret' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; tokens: { access_token: string } };
    expect(body.ok).toBe(true);
    expect(body.tokens.access_token).toBe('AT');
  });

  it('forwards a refresh_token grant correctly', async () => {
    let sentBody: Record<string, string> = {};
    installFetchStub(async (_input, init) => {
      sentBody = JSON.parse(init?.body as string) as Record<string, string>;
      return new Response(JSON.stringify({ access_token: 'AT2' }), { status: 200 });
    });

    const res = await worker.fetch(
      buildReq({ grant_type: 'refresh_token', refresh_token: 'oldRT' }),
      baseEnv({ ATLASSIAN_CLIENT_ID: 'id', ATLASSIAN_CLIENT_SECRET: 's' }),
    );
    expect(res.status).toBe(200);
    expect(sentBody.grant_type).toBe('refresh_token');
    expect(sentBody.refresh_token).toBe('oldRT');
    expect(sentBody.client_secret).toBe('s');
  });

  it('preserves the upstream status code on failure', async () => {
    installFetchStub(async () => new Response('{"error":"invalid_grant"}', { status: 401 }));
    const res = await worker.fetch(
      buildReq({
        grant_type: 'authorization_code',
        code: 'bad',
        code_verifier: 'cv',
        redirect_uri: 'https://x',
      }),
      baseEnv({ ATLASSIAN_CLIENT_ID: 'id', ATLASSIAN_CLIENT_SECRET: 's' }),
    );
    expect(res.status).toBe(401);
  });
});
