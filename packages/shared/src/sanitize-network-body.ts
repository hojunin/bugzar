/**
 * Redact PII (passwords, tokens, secrets, API keys) from captured HTTP
 * request/response bodies BEFORE they hit IDB / R2.
 *
 * Threat model: the host-script network patch records form submissions
 * verbatim (login form POSTs, OAuth code exchanges, etc.). Those bodies are
 * stored in IDB during the recording, uploaded to R2 on publish, and the
 * `/r/<id>` replay URL is linked from Jira — anyone with Jira read access
 * to the project then has unauthenticated access to the cleartext PII.
 *
 * Defense in depth: this runs at capture time so PII never reaches IDB or
 * R2 in the first place. The backend AI prompt path still runs
 * `sanitizeForAI` for headers/JWTs, but that doesn't protect the R2
 * payload — which is what this function fixes.
 *
 * Strategy:
 *   1. JSON body  → recurse, mask values whose KEY matches a sensitive name.
 *   2. URL-encoded → parse, mask matching keys, re-encode preserving order.
 *   3. Anything else (plain text, GraphQL, etc.) → returned untouched.
 *      We can't safely redact arbitrary text without false positives — and
 *      forms are the dominant PII vector in our captures.
 *
 * Content-Type is used as a hint when available; we sniff body shape
 * otherwise so this still works for the XHR path where the patch doesn't
 * always know the Content-Type at capture time.
 */

export const REDACTED = '[REDACTED]';

/**
 * Substrings that mark a field name as carrying credentials. Matched
 * case-insensitively against the lowercased key. Substring match is
 * deliberate so `userPassword`, `access_token`, `clientSecret`,
 * `x-api-key` all hit; the list itself is conservative to keep false
 * positives down (e.g. `description`, `bookmark` don't match anything).
 */
const SENSITIVE_KEY_PATTERNS = [
  'password',
  'passwd',
  'secret',
  'token',
  'authorization',
  'authorisation',
  'credential',
  'apikey',
  'api_key',
  'api-key',
  'access_key',
  'accesskey',
  'private_key',
  'privatekey',
  'session_id',
  'sessionid',
  'cookie',
  'pwd',
  // PII (#3). Deliberately COMPOUND substrings so they only hit PII fields:
  // no bare `name` (would hit filename/username/event_name), no bare `address`
  // (ip_address/mac_address), no bare `tel` (telemetry/hotel).
  // Known accepted over-redaction: `mobile` also hits device-telemetry keys
  // (mobileVersion/isMobile) — that only costs debug info, never leaks data.
  // Narrow it like `tel` if real reports lose too much signal.
  'email',
  'e-mail',
  'phone',
  'mobile',
  'telephone',
  'firstname',
  'first_name',
  'lastname',
  'last_name',
  'fullname',
  'full_name',
  'surname',
  'ssn',
  'social_security',
  'passport',
  'tax_id',
  'creditcard',
  'credit_card',
  'cardnumber',
  'card_number',
  'cvv',
  'cvc',
  'iban',
  'street_address',
  'postal_code',
  'postcode',
  'zipcode',
  'zip_code',
] as const;

export const isSensitiveKey = (name: string): boolean => {
  const lower = name.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((pat) => lower.includes(pat));
};

// HTTP header names carrying credentials that `isSensitiveKey` doesn't already
// catch — deny-by-default vs the old 5-name exact-match list (#6). `content-type`
// / `content-length` / `accept` match none of these and survive intact.
const SENSITIVE_HEADER_EXTRA = ['auth', 'session', 'csrf', 'xsrf', 'bearer'];

/** True if an HTTP header NAME carries credentials and its value must be redacted. */
export const isSensitiveHeader = (name: string): boolean => {
  if (isSensitiveKey(name)) return true;
  const lower = name.toLowerCase();
  return SENSITIVE_HEADER_EXTRA.some((p) => lower.includes(p));
};

// URL query/fragment param names whose VALUE is a credential (#5). Intentionally
// CREDENTIAL-focused, NOT the full isSensitiveKey — URLs commonly carry benign
// contextual PII (e.g. `postal_code`) that should NOT be redacted, and #5 targets
// secrets. Short names ('code', 'sig', 'state', 'key') are EXACT-match so they
// don't over-hit `postal_code` / `sortKey` etc.
const URL_CRED_SUBSTR = [
  'token',
  'secret',
  'password',
  'passwd',
  'apikey',
  'api_key',
  'api-key',
  'access_key',
  'credential',
  'authorization',
  'session_id',
];
const URL_CRED_EXACT = new Set([
  'code',
  'sig',
  'signature',
  'state',
  'key',
  'auth',
  'sid',
  'session',
  'pwd',
]);
const isSensitiveParamName = (name: string): boolean => {
  const lower = name.toLowerCase();
  return URL_CRED_EXACT.has(lower) || URL_CRED_SUBSTR.some((p) => lower.includes(p));
};

const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

const redactQueryString = (qs: string): string =>
  qs
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq < 0) return pair;
      const name = pair.slice(0, eq);
      return isSensitiveParamName(safeDecode(name)) ? `${name}=${REDACTED}` : pair;
    })
    .join('&');

/**
 * Redact credential VALUES in a URL's query string and (key=value) fragment,
 * preserving scheme/host/path so the entry stays debuggable (#5). String-based so
 * relative URLs keep their relativity; malformed input is returned unchanged.
 */
export const sanitizeUrl = (url: string): string => {
  if (!url || (!url.includes('?') && !url.includes('#'))) return url;
  const hashIdx = url.indexOf('#');
  const base = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
  const frag = hashIdx >= 0 ? url.slice(hashIdx + 1) : null;
  const qIdx = base.indexOf('?');
  let out = qIdx >= 0 ? `${base.slice(0, qIdx)}?${redactQueryString(base.slice(qIdx + 1))}` : base;
  if (frag != null) out += frag.includes('=') ? `#${redactQueryString(frag)}` : `#${frag}`;
  return out;
};

/**
 * The bare SHAPE of a JWT: three base64url segments (each ≥ 8 chars so version
 * strings like "1.2.3" never match). Anchored — the WHOLE value is the token.
 * Shape alone is not enough to mask on (see `looksLikeJwt`): dotted build/commit/
 * hash IDs share this shape, so masking by shape silently corrupts captured data.
 */
export const JWT_RE = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;

/**
 * True only for a REAL JWT: the JWT_RE shape AND a first segment that base64url-
 * decodes to a JSON object carrying an `alg` field (the JWT header invariant).
 * The shape alone false-positives on dotted build/commit/content-hash IDs; the
 * header decode rejects those while still masking every spec-compliant token.
 */
export const looksLikeJwt = (s: string): boolean => {
  if (!JWT_RE.test(s)) return false;
  const header = s.slice(0, s.indexOf('.'));
  try {
    const b64 = header.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const decoded = JSON.parse(atob(padded)) as unknown;
    return typeof decoded === 'object' && decoded !== null && 'alg' in decoded;
  } catch {
    return false;
  }
};

// Free-text scanners — catch token-shaped secrets inside arbitrary bodies /
// console args where there's no key boundary to match on. Deliberately
// high-precision (Bearer headers, embedded JWTs, sensitively-named XML
// elements) so ordinary prose is never mangled.
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
// Leading boundary is a capture group, NOT a lookbehind — a lookbehind literal
// is a parse-time SyntaxError on Safari < 16.4 / old WebKit, and since these are
// module-scope literals eagerly evaluated through @bugzar/sdk's static import chain
// it would abort the whole SDK at import. The trailing lookahead is fine (ES2015).
const JWT_INLINE_RE =
  /(^|[^\w-])([A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})(?![\w-])/g;
const XML_SENSITIVE_RE =
  /(<([a-zA-Z0-9:_-]*(?:password|passwd|pwd|secret|token|credential|apikey)[a-zA-Z0-9:_-]*)>)([^<]*)(<\/\2>)/gi;

// PII value scanners (#3) — high-precision shapes so ordinary prose survives.
// Leading boundaries are CAPTURE GROUPS, never lookbehind (a lookbehind literal
// is a parse-time SyntaxError on Safari < 16.4 and would abort the SDK at import).
const EMAIL_RE = /(^|[^\w.+-])([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/g;
// E.164 (+ country code) OR a delimited local grouping — NOT any bare digit run
// (which would eat IDs, prices, timestamps).
const PHONE_RE = /(^|[^\d+])(\+[1-9]\d{6,14}|\d{3}[-.\s]\d{3,4}[-.\s]\d{4})(?!\d)/g;
// Candidate card: 13-19 digits with optional single space/dash separators. Masked
// ONLY if Luhn-valid (rejects order/tracking IDs), checked in the replacer.
const CARD_RE = /(^|[^\d])(\d(?:[ -]?\d){12,18})(?!\d)/g;

/** Luhn checksum — validates a card candidate so non-card digit runs survive. */
const luhnValid = (digits: string): boolean => {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
};

/**
 * Mask email / phone (E.164 or delimited) / Luhn-valid card numbers in free text,
 * preserving the leading boundary char. Idempotent — `[REDACTED]` has no `@`,
 * no delimited phone, and no 13-19 digit run, so re-running never re-matches.
 */
export const redactPiiText = (s: string): string =>
  s
    .replace(EMAIL_RE, (_m, pre: string) => `${pre}${REDACTED}`)
    .replace(PHONE_RE, (_m, pre: string) => `${pre}${REDACTED}`)
    .replace(CARD_RE, (_m, pre: string, cand: string) => {
      const digits = cand.replace(/[ -]/g, '');
      return digits.length >= 13 && digits.length <= 19 && luhnValid(digits)
        ? `${pre}${REDACTED}`
        : `${pre}${cand}`;
    });

/**
 * Best-effort redaction for free-form text (non-JSON/non-form bodies, console
 * args): mask Bearer tokens, embedded JWTs, sensitively-named XML elements, then
 * email/phone/card PII (#3). Ordinary prose passes through untouched.
 */
export const redactFreeText = (s: string): string =>
  redactPiiText(
    s
      .replace(BEARER_RE, `Bearer ${REDACTED}`)
      // Only redact an inline match that decodes as a real JWT — preserves the
      // leading boundary char and leaves benign dotted IDs (build/commit hashes).
      .replace(JWT_INLINE_RE, (_m, pre: string, tok: string) =>
        looksLikeJwt(tok) ? `${pre}${REDACTED}` : `${pre}${tok}`,
      )
      .replace(XML_SENSITIVE_RE, `$1${REDACTED}$4`),
  );

/**
 * Recursively walk a parsed JSON value, returning a new structure where
 * any value under a sensitive key is replaced with `[REDACTED]`. Non-key
 * values (array items, primitive leaves) are returned unchanged.
 *
 * Implementation notes:
 *   - We don't mutate the input — callers may still hand it to the page's
 *     own code path elsewhere.
 *   - Arrays are walked element-wise; arrays whose KEY is sensitive
 *     (e.g. `tokens: [...]`) are blanket-redacted.
 *   - Sensitive keys with object/array values still get `[REDACTED]` —
 *     a nested object stored under `credentials: {...}` is whole-replaced.
 */
export const maskJsonValue = (value: unknown): unknown => {
  // A real JWT leaf is masked regardless of its key — closes the "sensitive
  // value under a benign key" gap (e.g. `{ input: "<jwt>" }`) without corrupting
  // benign JWT-shaped IDs (build/commit hashes), which `looksLikeJwt` rejects.
  // Non-JWT string leaves are PII-scrubbed (email/phone/card under benign keys).
  if (typeof value === 'string') return looksLikeJwt(value) ? REDACTED : redactPiiText(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(maskJsonValue);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSensitiveKey(k) ? REDACTED : maskJsonValue(v);
  }
  return out;
};

/**
 * Mask URL-encoded form bodies: `password=secret123&user=alice` →
 * `password=[REDACTED]&user=alice`. Order is preserved so the diff
 * against the original is minimal in a viewer.
 */
const maskUrlEncoded = (raw: string): string => {
  const params = new URLSearchParams(raw);
  const masked = new URLSearchParams();
  for (const [k, v] of params.entries()) {
    masked.append(k, isSensitiveKey(k) ? REDACTED : v);
  }
  return masked.toString();
};

/** Cheap shape sniff — `{` or `[` after optional whitespace ⇒ JSON-ish. */
const looksLikeJson = (s: string): boolean => /^\s*[{[]/.test(s);

/** Cheap sniff for `key=value(&key=value)*` (no JSON, no XML, no leading <). */
const looksLikeUrlEncoded = (s: string): boolean => {
  if (looksLikeJson(s)) return false;
  if (s.trimStart().startsWith('<')) return false;
  // At least one key=value pair, optionally separated by `&`. Both keys and
  // values use the standard URL-encoded charset (incl. percent-encoding).
  return /^[A-Za-z0-9._%~+-]+=([^&]*)(&[A-Za-z0-9._%~+-]+=([^&]*))*$/.test(s.trim());
};

/**
 * Sanitize a captured request/response body. Returns a new string with
 * sensitive values replaced; the original is left untouched. `null` and
 * the host-patch's placeholder strings (`<Blob 1234B>`, `<ArrayBuffer ...>`)
 * are returned as-is.
 *
 * `contentType` is an optional hint — if absent (or `null`) we fall back
 * to sniffing the body shape. Common contentTypes:
 *   - `application/json` → JSON path
 *   - `application/x-www-form-urlencoded` → URL-encoded path
 *   - `multipart/form-data` → already stringified to `{key:value,...}` JSON
 *     by the host patch's `stringifyBody`, so JSON path catches it.
 */
export const sanitizeNetworkBody = (
  body: string | null,
  contentType: string | null = null,
): string | null => {
  if (body == null) return null;
  if (body.length === 0) return body;
  // Host patch placeholders for non-textual bodies — nothing to mask.
  if (/^<(Blob|ArrayBuffer|File)\s.*>$/.test(body)) return body;

  const ct = (contentType ?? '').toLowerCase();
  const isJsonCt = ct.includes('json');
  const isFormCt = ct.includes('x-www-form-urlencoded');

  // JSON path — either declared or sniffed.
  if (isJsonCt || (!isFormCt && looksLikeJson(body))) {
    try {
      const parsed = JSON.parse(body) as unknown;
      const masked = maskJsonValue(parsed);
      return JSON.stringify(masked);
    } catch {
      // Malformed JSON — fall through to other strategies rather than
      // throw. Captured bodies are best-effort, not authoritative.
    }
  }

  // URL-encoded path — declared or sniffed.
  if (isFormCt || looksLikeUrlEncoded(body)) {
    try {
      return maskUrlEncoded(body);
    } catch {
      return body;
    }
  }

  // Plain text / unknown (incl. XML/SOAP, which start with `<` and so skip the
  // JSON + URL-encoded paths) — best-effort scrub for token-shaped secrets
  // (Bearer/JWT) and sensitively-named XML elements. Arbitrary prose can't be
  // redacted without false positives, so only these high-precision shapes are
  // masked; everything else passes through.
  return redactFreeText(body);
};

/**
 * Sanitize one storage entry (a localStorage/sessionStorage value). Redacts when
 *   - the KEY is sensitive (e.g. `sb-<ref>-auth-token`, `accessToken`),
 *   - the value is itself a token (a bare JWT), or
 *   - the value is JSON holding sensitive sub-keys / token leaves
 *     (e.g. Supabase/Auth0 `{ access_token, refresh_token, ... }`).
 * Otherwise free-text-scrubbed. The storage counterpart to `sanitizeNetworkBody`,
 * closing the same secret-leak for the storage snapshot.
 */
export const sanitizeStorageValue = (key: string, value: string): string => {
  if (isSensitiveKey(key)) return REDACTED;
  if (looksLikeJwt(value)) return REDACTED;
  if (looksLikeJson(value)) {
    try {
      return JSON.stringify(maskJsonValue(JSON.parse(value) as unknown));
    } catch {
      // not valid JSON after all — fall through to the free-text scrub
    }
  }
  return redactFreeText(value);
};

/** Exposed for tests. */
export const _internal = {
  isSensitiveKey,
  isSensitiveHeader,
  maskJsonValue,
  maskUrlEncoded,
  looksLikeJwt,
  redactPiiText,
  luhnValid,
  sanitizeUrl,
  freeTextRegexes: [BEARER_RE, JWT_INLINE_RE, XML_SENSITIVE_RE, EMAIL_RE, PHONE_RE, CARD_RE],
};
