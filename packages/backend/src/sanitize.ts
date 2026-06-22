/**
 * Redact PII from captured QA session data **before** sending it to the LLM.
 *
 * Captured artifacts are kept verbatim in R2 — replay needs accurate bytes —
 * so this module is the *only* layer between R2 and `ai.run(...)` and must
 * be tight. Two complementary strategies:
 *
 *   1. **Header allowlist.** Anything not on a small list of well-known
 *      transport / content / cache / CORS headers becomes [REDACTED]. A
 *      blocklist (Authorization / Cookie / ...) is fragile because a new
 *      vendor-specific auth header would slip through; an allowlist fails
 *      closed.
 *
 *   2. **JWT regex sweep.** Even with header redaction, tokens leak into
 *      bodies, query strings, console args, etc. A textbook 3-segment JWT
 *      starting with `eyJ` is high-confidence to redact wholesale.
 *
 * Additionally, well-known sensitive keys (`cookie`, `cookies`, `set-cookie`,
 * `authorization`) get redacted whenever they appear as object properties —
 * this catches storage snapshots (which carry `document.cookie` verbatim).
 *
 * Output length is constant ([REDACTED]) — token length itself is a side
 * channel we'd rather not leak.
 */

export const REDACTED = '[REDACTED]';

/**
 * Headers we consider safe to pass to the LLM. Everything else gets stripped.
 *
 * Lower-cased for case-insensitive comparison. Keep this list conservative —
 * if a header carries identifiers, trace tokens, or credentials, leave it
 * off and rely on the allowlist failing closed.
 */
const SAFE_HEADERS = new Set<string>([
  // Content negotiation / framing
  'accept',
  'accept-charset',
  'accept-encoding',
  'accept-language',
  'accept-ranges',
  'content-encoding',
  'content-language',
  'content-length',
  'content-range',
  'content-type',
  'range',
  'transfer-encoding',
  // Caching / freshness
  'age',
  'cache-control',
  'date',
  'etag',
  'expires',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-unmodified-since',
  'last-modified',
  'pragma',
  'vary',
  // Connection / framing
  'connection',
  'host',
  'keep-alive',
  'te',
  'upgrade',
  'via',
  // Navigation context (these CAN carry identifiers in query strings but
  // are necessary for the model to understand the request; JWT sweep will
  // catch tokens embedded in them).
  'origin',
  'referer',
  'user-agent',
  // Response routing
  'location',
  'server',
  // CORS — never sensitive
  'access-control-allow-credentials',
  'access-control-allow-headers',
  'access-control-allow-methods',
  'access-control-allow-origin',
  'access-control-expose-headers',
  'access-control-max-age',
  'access-control-request-headers',
  'access-control-request-method',
  // Security policy headers — public by design
  'content-security-policy',
  'content-security-policy-report-only',
  'referrer-policy',
  'strict-transport-security',
  'x-content-type-options',
  'x-frame-options',
  'x-xss-protection',
  // CDN / tracing (best-effort — these are typically opaque ids, not creds)
  'alt-svc',
  'cf-cache-status',
  'cf-ray',
  'x-amz-cf-id',
  'x-amz-cf-pop',
]);

/**
 * Property keys that are *always* redacted regardless of nesting. Captures
 * `document.cookie` in storage snapshots and any stray auth-token blob.
 */
const ALWAYS_REDACT_KEYS = new Set<string>(['authorization', 'cookie', 'cookies', 'set-cookie']);

/**
 * Field names whose value is a Headers-shaped record. We apply the allowlist
 * to those values verbatim instead of recursing key-by-key.
 */
const HEADER_BAG_KEYS = new Set<string>(['requestheaders', 'responseheaders', 'headers']);

/** JWT in canonical `header.payload.signature` form, base64url segments. */
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]+){2}/g;

/**
 * Replace any embedded JWT in a string with [REDACTED]. Non-string input is
 * returned unchanged.
 */
export const redactJwt = (text: string): string => text.replace(JWT_PATTERN, REDACTED);

/**
 * Apply the header allowlist. Keys outside the allowlist have their value
 * replaced with [REDACTED]; allowed values still get a JWT sweep so a bearer
 * token leaking into e.g. `referer` doesn't survive.
 */
export const sanitizeHeaders = (
  headers: Record<string, unknown> | null | undefined,
): Record<string, string> => {
  if (!headers || typeof headers !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const value = typeof v === 'string' ? v : String(v ?? '');
    out[k] = SAFE_HEADERS.has(k.toLowerCase()) ? redactJwt(value) : REDACTED;
  }
  return out;
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Recursively walk `value` and apply the redaction rules. Returns a new
 * structure — the input is not mutated, so the caller can safely keep the
 * original for non-AI uses (e.g. echoing back to the viewer).
 */
export const sanitizeForAI = (value: unknown): unknown => {
  if (typeof value === 'string') return redactJwt(value);
  if (Array.isArray(value)) return value.map((v) => sanitizeForAI(v));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const keyLc = k.toLowerCase();
      if (ALWAYS_REDACT_KEYS.has(keyLc)) {
        out[k] = REDACTED;
        continue;
      }
      if (HEADER_BAG_KEYS.has(keyLc) && isPlainObject(v)) {
        out[k] = sanitizeHeaders(v);
        continue;
      }
      out[k] = sanitizeForAI(v);
    }
    return out;
  }
  return value;
};
