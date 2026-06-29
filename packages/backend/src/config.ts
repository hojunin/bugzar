/**
 * Bugzar backend — request authorization / deploy-mode config helpers.
 *
 * F4-AUTH / Phase B gating: which browser Origins may call the SDK routes,
 * whether the deploy is "public" (fail-closed), whether the GET / index is
 * exposed, and which Jira projects a caller may target. Extracted from
 * worker.ts so the Jira / telemetry / OAuth handler modules can share them.
 */

import { type Env, timingSafeEqual } from './runtime';

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
export const originAllowed = (req: Request, env: Env): boolean => {
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
export const indexAllowed = (req: Request, env: Env): boolean => {
  if (env.PUBLIC_INDEX === '1') return true;
  if (!isPublicDeploy(env)) return true;
  if (env.ADMIN_SECRET) {
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
    return !!token && timingSafeEqual(token, env.ADMIN_SECRET);
  }
  return false;
};

/** F4-AUTH: a caller may only target an allowlisted project (or, if unset, any shape-valid key). */
export const projectAllowed = (projectKey: string, env: Env): boolean => {
  const allow = splitAllowlist(env.ALLOWED_PROJECT_KEYS);
  if (allow.length > 0) return allow.includes(projectKey);
  return /^[A-Z][A-Z0-9_]{1,20}$/.test(projectKey);
};

export const jiraConfigured = (env: Env): boolean =>
  !!(env.JIRA_API_BASE && env.JIRA_EMAIL && env.JIRA_API_TOKEN);
