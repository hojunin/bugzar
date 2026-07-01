// Atlassian 3LO OAuth (PKCE) for the in-page SDK — web popup flow.
//
// Differs from the extension's version only in transport: a normal web page has
// no `chrome.identity`, so we open a popup to Atlassian's authorize URL, which
// redirects to the Worker's /oauth/callback page; that page postMessages the code
// back here. The code→token (and refresh) exchange goes through the Worker's
// /oauth/exchange so the client_secret stays server-side. Tokens live in
// localStorage. The browser only ever holds the public client_id + the user's
// own access/refresh tokens.

const SCOPES = [
  // POST /issue
  'read:issue:jira',
  'write:issue:jira',
  'write:comment:jira',
  'write:comment.property:jira',
  'write:attachment:jira',
  // project + epic reads
  'read:project:jira',
  'read:project.property:jira',
  'read:project-category:jira',
  'read:project-version:jira',
  'read:project.component:jira',
  'read:application-role:jira',
  'read:group:jira',
  'read:issue-type-hierarchy:jira',
  'read:avatar:jira',
  'read:user:jira',
  'read:issue-type:jira',
  'read:issue-details:jira',
  'read:issue-meta:jira',
  'read:field-configuration:jira',
  'read:audit-log:jira',
  'read:jql:jira',
  'read:issue-status:jira',
  'read:email-address:jira',
  // refresh token
  'offline_access',
].join(' ');

export interface Tokens {
  accessToken: string;
  refreshToken: string | null;
  /** Absolute epoch ms when the access token expires. */
  expiresAt: number;
  scope: string;
}

export interface Site {
  /** Atlassian cloudId — used in api.atlassian.com/ex/jira/<cloudId>/… */
  id: string;
  /** Site base URL, e.g. https://acme.atlassian.net — for browse links. */
  url: string;
  name: string;
}

export interface AtlassianProfile {
  accountId: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
}

export interface AtlassianSession {
  tokens: Tokens;
  site: Site;
  profile: AtlassianProfile;
}

export interface WorkerTarget {
  /** Worker base URL (no trailing slash). */
  base: string;
  /** Host-supplied auth headers that ride every Worker request. */
  headers: Record<string, string>;
}

export type OAuthResult = { ok: true; tokens: Tokens } | { ok: false; error: string };

// ─── PKCE helpers (exported for tests) ──────────────────────────────────────

export const base64UrlEncode = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] ?? 0);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const generateCodeVerifier = (): string =>
  base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));

export const sha256Base64Url = async (input: string): Promise<string> => {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return base64UrlEncode(new Uint8Array(hash));
};

export const buildAuthorizeUrl = (params: {
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
}): string => {
  const q = new URLSearchParams({
    audience: 'api.atlassian.com',
    client_id: params.clientId,
    scope: SCOPES,
    redirect_uri: params.redirectUri,
    response_type: 'code',
    prompt: 'consent',
    state: params.state,
    code_challenge: params.challenge,
    code_challenge_method: 'S256',
  });
  return `https://auth.atlassian.com/authorize?${q.toString()}`;
};

// ─── localStorage ───────────────────────────────────────────────────────────

const STORAGE_KEY = 'bugzar:atlassian';

export const saveSession = (session: AtlassianSession): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // private mode / storage disabled — connection just won't persist
  }
};

export const loadSession = (): AtlassianSession | null => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as AtlassianSession;
    if (v?.tokens?.accessToken && v?.site?.id) return v;
    return null;
  } catch {
    return null;
  }
};

export const clearSession = (): void => {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
};

// ─── Worker-proxied token exchange + Jira calls ─────────────────────────────

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

const toTokens = (data: TokenResponse, prevRefresh?: string | null): Tokens => ({
  accessToken: data.access_token,
  refreshToken: data.refresh_token ?? prevRefresh ?? null,
  expiresAt: Date.now() + data.expires_in * 1000,
  scope: data.scope ?? SCOPES,
});

const exchange = async (
  target: WorkerTarget,
  body: Record<string, string>,
): Promise<TokenResponse> => {
  const res = await fetch(`${target.base}/oauth/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...target.headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`oauth exchange ${res.status}`);
  const wrapped = (await res.json()) as { ok?: boolean; tokens?: TokenResponse; error?: string };
  if (!wrapped.ok || !wrapped.tokens)
    throw new Error(`oauth exchange failed: ${wrapped.error ?? '?'}`);
  return wrapped.tokens;
};

const refresh = async (target: WorkerTarget, refreshToken: string): Promise<Tokens> => {
  const data = await exchange(target, { grant_type: 'refresh_token', refresh_token: refreshToken });
  return toTokens(data, refreshToken);
};

/** A still-valid access token, refreshing within 60s of expiry. Null = needs OAuth. */
export const getValidAccessToken = async (target: WorkerTarget): Promise<string | null> => {
  const session = loadSession();
  if (!session) return null;
  if (Date.now() < session.tokens.expiresAt - 60_000) return session.tokens.accessToken;
  if (!session.tokens.refreshToken) return null;
  try {
    const tokens = await refresh(target, session.tokens.refreshToken);
    saveSession({ ...session, tokens });
    return tokens.accessToken;
  } catch {
    return null;
  }
};

const atlHeaders = (target: WorkerTarget, token: string): Record<string, string> => ({
  ...target.headers,
  'X-Atlassian-Authorization': `Bearer ${token}`,
});

export const fetchSites = async (target: WorkerTarget, token: string): Promise<Site[]> => {
  const res = await fetch(`${target.base}/jira/oauth/resources`, {
    headers: atlHeaders(target, token),
  });
  if (!res.ok) throw new Error(`resources ${res.status}`);
  const { sites } = (await res.json()) as { sites: Site[] };
  return sites ?? [];
};

export const fetchMyself = async (
  target: WorkerTarget,
  token: string,
  cloudId: string,
): Promise<AtlassianProfile> => {
  const res = await fetch(
    `${target.base}/jira/oauth/myself?cloudId=${encodeURIComponent(cloudId)}`,
    { headers: atlHeaders(target, token) },
  );
  if (!res.ok) throw new Error(`myself ${res.status}`);
  return (await res.json()) as AtlassianProfile;
};

export const searchEpics = async (
  target: WorkerTarget,
  token: string,
  cloudId: string,
  q: string,
): Promise<Array<{ key: string; summary: string }>> => {
  // No projectKey — search Epics across all accessible projects.
  const qs = new URLSearchParams({ cloudId, q });
  const res = await fetch(`${target.base}/jira/oauth/epics?${qs}`, {
    headers: atlHeaders(target, token),
  });
  if (!res.ok) throw new Error(`epics ${res.status}`);
  const { epics } = (await res.json()) as { epics: Array<{ key: string; summary: string }> };
  return epics ?? [];
};

export interface PublishInput {
  cloudId: string;
  siteUrl: string;
  projectKey: string;
  title: string;
  description?: string;
  descriptionAdf?: unknown;
  epicKey?: string;
  issueType?: string;
}

export const publishIssue = async (
  target: WorkerTarget,
  token: string,
  input: PublishInput,
): Promise<{ issueKey: string; issueUrl: string }> => {
  const res = await fetch(`${target.base}/jira/oauth/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...atlHeaders(target, token) },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`publish ${res.status}${t ? `: ${t.slice(0, 160)}` : ''}`);
  }
  return (await res.json()) as { issueKey: string; issueUrl: string };
};

// ─── Popup OAuth flow ───────────────────────────────────────────────────────

const awaitCallback = (
  state: string,
  popup: Window | null,
  workerOrigin: string,
): Promise<{ code?: string; error?: string }> =>
  new Promise((resolve) => {
    let done = false;
    const finish = (r: { code?: string; error?: string }): void => {
      if (done) return;
      done = true;
      window.removeEventListener('message', onMsg);
      clearInterval(poll);
      clearTimeout(timer);
      resolve(r);
    };
    const onMsg = (e: MessageEvent): void => {
      if (e.origin !== workerOrigin) return;
      const d = e.data as { source?: string; code?: string; state?: string; error?: string } | null;
      if (!d || d.source !== 'bugzar-oauth' || d.state !== state) return;
      finish({ ...(d.code ? { code: d.code } : {}), ...(d.error ? { error: d.error } : {}) });
    };
    window.addEventListener('message', onMsg);
    const poll = setInterval(() => {
      if (popup?.closed) finish({ error: 'popup-closed' });
    }, 500);
    const timer = setTimeout(() => finish({ error: 'timeout' }), 180_000);
  });

/** Run the interactive popup OAuth; returns tokens or a typed error. */
export const startOAuth = async (target: WorkerTarget, clientId: string): Promise<OAuthResult> => {
  if (!clientId) return { ok: false, error: 'missing clientId' };
  const redirectUri = `${target.base}/oauth/callback`;
  try {
    const verifier = generateCodeVerifier();
    const challenge = await sha256Base64Url(verifier);
    const state = generateCodeVerifier();
    const authUrl = buildAuthorizeUrl({ clientId, redirectUri, challenge, state });
    const popup = window.open(
      authUrl,
      'bugzar-atlassian-oauth',
      'width=520,height=720,menubar=no,toolbar=no',
    );
    if (!popup) return { ok: false, error: 'popup-blocked' };
    const workerOrigin = new URL(target.base).origin;
    const cb = await awaitCallback(state, popup, workerOrigin);
    try {
      popup.close();
    } catch {
      // already closed
    }
    if (cb.error) return { ok: false, error: cb.error };
    if (!cb.code) return { ok: false, error: 'no-code' };
    const data = await exchange(target, {
      grant_type: 'authorization_code',
      code: cb.code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    });
    return { ok: true, tokens: toTokens(data) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

/** Full connect: OAuth → pick the first accessible site → load profile → persist. */
export const connectAtlassian = async (
  target: WorkerTarget,
  clientId: string,
): Promise<{ ok: true; session: AtlassianSession } | { ok: false; error: string }> => {
  const auth = await startOAuth(target, clientId);
  if (!auth.ok) return auth;
  try {
    const sites = await fetchSites(target, auth.tokens.accessToken);
    const site = sites[0];
    if (!site) return { ok: false, error: 'no-accessible-site' };
    const profile = await fetchMyself(target, auth.tokens.accessToken, site.id);
    const session: AtlassianSession = { tokens: auth.tokens, site, profile };
    saveSession(session);
    return { ok: true, session };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};
