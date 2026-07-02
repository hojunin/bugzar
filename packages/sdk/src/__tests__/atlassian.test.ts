import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AtlassianSession,
  base64UrlEncode,
  buildAuthorizeUrl,
  clearSession,
  fetchSites,
  getValidAccessToken,
  loadSession,
  publishIssue,
  saveSession,
} from '../oauth/atlassian';

const target = { base: 'https://w.dev', headers: {} };
const session = (over: Partial<AtlassianSession['tokens']> = {}): AtlassianSession => ({
  tokens: {
    accessToken: 'a-tok',
    refreshToken: 'r-tok',
    expiresAt: Date.now() + 3_600_000,
    scope: 's',
    ...over,
  },
  site: { id: 'cloud-1', url: 'https://acme.atlassian.net', name: 'acme' },
  profile: { accountId: 'acc', displayName: '홍길동', email: null, avatarUrl: null },
});

beforeEach(() => {
  // happy-dom's localStorage is a no-op in this runner; use an in-memory stub.
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
});
afterEach(() => vi.restoreAllMocks());

describe('PKCE + authorize URL', () => {
  it('base64UrlEncode is URL-safe and unpadded', () => {
    expect(base64UrlEncode(new Uint8Array([1, 2, 3]))).toBe('AQID');
    expect(base64UrlEncode(new Uint8Array([255, 255, 255]))).toBe('____');
  });

  it('builds an authorize URL with PKCE + required scopes', () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: 'cid',
        redirectUri: 'https://w.dev/oauth/callback',
        challenge: 'chal',
        state: 'st',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://auth.atlassian.com/authorize');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe('https://w.dev/oauth/callback');
    expect(url.searchParams.get('scope')).toContain('write:issue:jira');
    expect(url.searchParams.get('scope')).toContain('offline_access');
  });
});

describe('session storage', () => {
  it('round-trips and clears', () => {
    expect(loadSession()).toBeNull();
    const s = session();
    saveSession(s);
    expect(loadSession()?.site.id).toBe('cloud-1');
    clearSession();
    expect(loadSession()).toBeNull();
  });
});

describe('getValidAccessToken', () => {
  it('returns the cached token when still valid (no network)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    saveSession(session());
    expect(await getValidAccessToken(target)).toBe('a-tok');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes via the Worker when near expiry and persists', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ ok: true, tokens: { access_token: 'new-tok', expires_in: 3600 } }),
            { status: 200 },
          ),
      ),
    );
    saveSession(session({ expiresAt: Date.now() + 1000 })); // within the 60s skew
    expect(await getValidAccessToken(target)).toBe('new-tok');
    expect(loadSession()?.tokens.accessToken).toBe('new-tok');
  });

  it('returns null when there is no session', async () => {
    expect(await getValidAccessToken(target)).toBeNull();
  });
});

describe('worker-proxied Jira calls', () => {
  it('publishIssue forwards the user token and returns the issue', async () => {
    let header: string | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string | URL, init?: RequestInit) => {
        header = new Headers(init?.headers).get('X-Atlassian-Authorization');
        return new Response(
          JSON.stringify({
            issueKey: 'BUGZAR-9',
            issueUrl: 'https://acme.atlassian.net/browse/BUGZAR-9',
          }),
          { status: 200 },
        );
      }),
    );
    const r = await publishIssue(target, 'u-tok', {
      cloudId: 'cloud-1',
      siteUrl: 'https://acme.atlassian.net',
      projectKey: 'BUGZAR',
      title: 'x',
    });
    expect(header).toBe('Bearer u-tok');
    expect(r.issueKey).toBe('BUGZAR-9');
  });

  it('fetchSites maps the proxy response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ sites: [{ id: 'c1', url: 'https://x.atlassian.net', name: 'x' }] }),
            {
              status: 200,
            },
          ),
      ),
    );
    const sites = await fetchSites(target, 'u-tok');
    expect(sites[0]?.id).toBe('c1');
  });
});

// #2: the long-lived refresh token must never be persisted to localStorage
// (any same-origin script could exfiltrate it). It lives in memory for the tab;
// localStorage holds refreshToken:null and loadSession re-attaches from memory.
describe('refresh token is never persisted (#2)', () => {
  beforeEach(() => clearSession()); // reset the module-scope in-memory holder

  it('saveSession redacts the refresh token out of localStorage', () => {
    saveSession(session({ refreshToken: 'SUPER-SECRET-REFRESH' }));
    const raw = localStorage.getItem('bugzar:atlassian') as string;
    expect(raw).not.toContain('SUPER-SECRET-REFRESH'); // absent from storage entirely
    expect(JSON.parse(raw).tokens.refreshToken).toBeNull();
  });

  it('loadSession re-attaches the in-memory refresh token in the same tab', () => {
    saveSession(session({ refreshToken: 'r-mem' }));
    expect(loadSession()?.tokens.refreshToken).toBe('r-mem'); // from memory, not storage
    expect(loadSession()?.tokens.accessToken).toBe('a-tok');
  });

  it('clearSession drops both the in-memory token and the storage key', () => {
    saveSession(session({ refreshToken: 'r-mem' }));
    clearSession();
    expect(localStorage.getItem('bugzar:atlassian')).toBeNull();
    expect(loadSession()).toBeNull();
  });
});
