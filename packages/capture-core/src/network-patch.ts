import {
  isSensitiveHeader,
  NETWORK_BODY_MAX_BYTES,
  NETWORK_TOTAL_BUDGET_BYTES,
  type NetworkEntryPayload,
  sanitizeNetworkBody,
  sanitizeUrl,
} from '@bugzar/shared';

/**
 * Monkey-patches window.fetch and XMLHttpRequest in the page's MAIN-world
 * context to capture network traffic. Wrapped methods preserve the original
 * call semantics so the page's behavior is unchanged.
 *
 * Limitations:
 *  - Only requests issued by JS are captured. Browser-issued requests
 *    (<img>, fonts, navigator.sendBeacon, prefetch links) are NOT seen.
 *  - Response bodies are captured by cloning the response — adds memory
 *    overhead for large responses.
 *  - Request bodies that are streams/FormData are stringified best-effort.
 *
 * PII: header whitelist + response key redaction is M3+ work — kept minimal
 * here. For M1+ we strip a basic set of credential headers.
 */

const REDACTED = '[REDACTED]';

// Exported for tests (a `new Request().headers` is cross-realm in happy-dom —
// tests pass a plain map or a same-realm `new Headers()` directly instead).
export const sanitizeHeaders = (h: Headers | Record<string, string>): Record<string, string> => {
  const out: Record<string, string> = {};
  const apply = (k: string, v: string): void => {
    // Deny-by-default substring matcher (#6) — catches custom auth/session/csrf
    // headers the old 5-name exact-match list missed. content-type isn't
    // sensitive, so it survives for the body content-type lookup below.
    out[k] = isSensitiveHeader(k) ? REDACTED : v;
  };
  if (h instanceof Headers) {
    h.forEach((v, k) => {
      apply(k, v);
    });
  } else {
    for (const [k, v] of Object.entries(h)) apply(k, String(v));
  }
  return out;
};

const stringifyBody = async (body: unknown): Promise<string | null> => {
  if (body == null) return null;
  if (typeof body === 'string') return body;
  if (body instanceof FormData) {
    const obj: Record<string, string> = {};
    body.forEach((v, k) => {
      obj[k] = typeof v === 'string' ? v : `<File ${v.name}>`;
    });
    return JSON.stringify(obj);
  }
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof Blob) return `<Blob ${body.size}B>`;
  if (body instanceof ArrayBuffer) return `<ArrayBuffer ${body.byteLength}B>`;
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
};

const TRUNCATED_MARK = '…[truncated]';
const BUDGET_MARK = '…[budget exceeded]';
const encoder = new TextEncoder();

// Cumulative captured body bytes for the current session. Reset on install (#20).
let capturedBodyBytes = 0;

/** Reset the session network budget — test hook + called on install. */
export const __resetNetworkBudget = (): void => {
  capturedBodyBytes = 0;
};

/**
 * Cap a single network body (request OR response) before it's persisted (#20):
 *  1. per-body truncation to NETWORK_BODY_MAX_BYTES UTF-8 bytes (codepoint-safe),
 *  2. per-session total budget — once spent, drop the body to a marker (the entry
 *     + metadata are still kept), bounding tab memory and keeping the network
 *     asset under the backend cap,
 *  3. the existing credential redaction (sanitizeNetworkBody) on the kept body.
 * Counting bytes (not chars) keeps the client cap dimensionally consistent with
 * the backend asset cap so non-ASCII bodies don't 413 the whole session.
 */
export const capBody = (text: string | null, contentType: string | null): string | null => {
  if (text == null) return null;
  if (capturedBodyBytes >= NETWORK_TOTAL_BUDGET_BYTES) return BUDGET_MARK;
  const bytes = encoder.encode(text);
  let body = text;
  let truncated = false;
  let kept = bytes.length;
  if (bytes.length > NETWORK_BODY_MAX_BYTES) {
    // Slice on a byte boundary; a split trailing codepoint decodes to U+FFFD,
    // which we trim so the kept body stays valid.
    body = new TextDecoder('utf-8', { fatal: false })
      .decode(bytes.subarray(0, NETWORK_BODY_MAX_BYTES))
      .replace(/�+$/, '');
    truncated = true;
    kept = NETWORK_BODY_MAX_BYTES; // conservative budget charge for the clipped body
  }
  if (capturedBodyBytes + kept > NETWORK_TOTAL_BUDGET_BYTES) {
    capturedBodyBytes = NETWORK_TOTAL_BUDGET_BYTES; // mark the session budget spent
    return BUDGET_MARK;
  }
  capturedBodyBytes += kept;
  return sanitizeNetworkBody(truncated ? `${body}${TRUNCATED_MARK}` : body, contentType);
};

type Options = {
  sessionStart: number;
  onEntry: (entry: NetworkEntryPayload) => void;
};

let originalFetch: typeof window.fetch | null = null;
let originalXHROpen: typeof XMLHttpRequest.prototype.open | null = null;
let originalXHRSend: typeof XMLHttpRequest.prototype.send | null = null;
let originalXHRSetRequestHeader: typeof XMLHttpRequest.prototype.setRequestHeader | null = null;

// Bugzar's own installed wrappers. uninstall only unwinds a layer when the live
// global still === our wrapper; if a later library (Sentry/Datadog/APM/mock)
// stacked its wrapper on top, restoring our pre-install snapshot would silently
// drop that layer. Track ours so we can leave someone else's stack intact (#48).
let bugzarFetch: typeof window.fetch | null = null;
let bugzarXHROpen: typeof XMLHttpRequest.prototype.open | null = null;
let bugzarXHRSend: typeof XMLHttpRequest.prototype.send | null = null;
let bugzarXHRSetRequestHeader: typeof XMLHttpRequest.prototype.setRequestHeader | null = null;

export const installNetworkPatch = ({ sessionStart, onEntry }: Options): void => {
  if (originalFetch) return; // idempotent
  __resetNetworkBudget(); // fresh session → fresh body budget

  // ── fetch ──
  originalFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const startedMs = Date.now();
    const tFromStart = startedMs - sessionStart;
    const req = new Request(input, init);
    const method = req.method || 'GET';
    // #5: strip credential query/fragment params so they never reach the report.
    const url = sanitizeUrl(req.url);
    const requestHeaders = sanitizeHeaders(req.headers);
    let requestBody: string | null = null;
    try {
      // Clone to leave original intact for the page's fetch path.
      const cloned = req.clone();
      const text = await cloned.text();
      // Cap + redact form PII (passwords/tokens/api keys) BEFORE the body leaves
      // the page — keeps cleartext out of IDB and R2. See capBody / sanitize-network-body.
      requestBody = capBody(text || null, req.headers.get('content-type'));
    } catch {
      requestBody = null;
    }

    try {
      // biome-ignore lint/style/noNonNullAssertion: originalFetch was set just above
      const res = await originalFetch!(input, init);
      const durationMs = Date.now() - startedMs;
      const cloned = res.clone();
      let responseBody: string | null = null;
      try {
        const text = await cloned.text();
        // Servers sometimes echo credentials back (login response with
        // session_id, OAuth code → token responses). capBody truncates + redacts.
        responseBody = capBody(text, res.headers.get('content-type'));
      } catch {
        responseBody = null;
      }
      onEntry({
        tFromStart,
        method,
        url,
        status: res.status,
        durationMs,
        requestHeaders,
        requestBody,
        responseHeaders: sanitizeHeaders(res.headers),
        responseBody,
        error: null,
        initiator: 'fetch',
      });
      return res;
    } catch (err) {
      // R2c — an opaque fetch rejection ("Failed to fetch" TypeError, status 0,
      // no body) is *likely* CORS, but also fires on offline/DNS/adblock — flag
      // it as a heuristic, never asserted.
      const corsLikely = err instanceof TypeError;
      onEntry({
        tFromStart,
        method,
        url,
        status: null,
        durationMs: Date.now() - startedMs,
        requestHeaders,
        requestBody,
        responseHeaders: {},
        responseBody: null,
        error: err instanceof Error ? err.message : String(err),
        initiator: 'fetch',
        ...(corsLikely ? { corsLikely: true } : {}),
      });
      throw err;
    }
  }) as typeof window.fetch;
  bugzarFetch = window.fetch;

  // ── XMLHttpRequest ──
  originalXHROpen = XMLHttpRequest.prototype.open;
  originalXHRSend = XMLHttpRequest.prototype.send;
  originalXHRSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  type BugzarXHR = XMLHttpRequest & {
    __bugzar?: {
      method: string;
      url: string;
      startedMs: number;
      requestHeaders: Record<string, string>;
      requestBody: string | null;
    };
  };

  XMLHttpRequest.prototype.open = function patchedOpen(
    this: BugzarXHR,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    this.__bugzar = {
      method: method.toUpperCase(),
      // #5: sanitize at store time so the raw URL (query secrets) is never retained.
      url: sanitizeUrl(typeof url === 'string' ? url : url.toString()),
      startedMs: 0,
      requestHeaders: {},
      requestBody: null,
    };
    // biome-ignore lint/suspicious/noExplicitAny: variadic XHR open signature
    return (originalXHROpen as any).apply(this, [method, url, ...rest]);
    // biome-ignore lint/suspicious/noExplicitAny: variadic XHR open signature
  } as any;

  XMLHttpRequest.prototype.setRequestHeader = function patchedSetHeader(
    this: BugzarXHR,
    name: string,
    value: string,
  ) {
    if (this.__bugzar) {
      this.__bugzar.requestHeaders[name] = isSensitiveHeader(name) ? REDACTED : value;
    }
    // biome-ignore lint/style/noNonNullAssertion: original captured above
    return originalXHRSetRequestHeader!.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function patchedSend(
    this: BugzarXHR,
    body?: Document | XMLHttpRequestBodyInit | null,
  ) {
    if (this.__bugzar) {
      this.__bugzar.startedMs = Date.now();
      void stringifyBody(body).then((s) => {
        if (this.__bugzar) {
          // Pull Content-Type from already-captured request headers (content-type
          // isn't sensitive per isSensitiveHeader, so it survives intact).
          // Lookup is case-insensitive since setRequestHeader preserves
          // the caller's casing.
          const rh = this.__bugzar.requestHeaders;
          const ct =
            rh['content-type'] ??
            rh['Content-Type'] ??
            rh['CONTENT-TYPE'] ??
            Object.entries(rh).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ??
            null;
          this.__bugzar.requestBody = capBody(s, ct);
        }
      });

      const finalize = (err: string | null): void => {
        const ctx = this.__bugzar;
        if (!ctx) return;
        const tFromStart = ctx.startedMs - sessionStart;
        const durationMs = Date.now() - ctx.startedMs;
        let responseBody: string | null = null;
        try {
          if (this.responseType === '' || this.responseType === 'text') {
            // Same threat as fetch response — login/OAuth flows echo credentials
            // back. capBody truncates + redacts.
            responseBody = capBody(this.responseText, this.getResponseHeader('content-type'));
          } else if (this.response != null) {
            responseBody = `<${this.responseType}>`;
          }
        } catch {
          responseBody = null;
        }
        const responseHeadersStr = this.getAllResponseHeaders();
        const responseHeaders: Record<string, string> = {};
        for (const line of responseHeadersStr.split('\r\n')) {
          const idx = line.indexOf(':');
          if (idx > 0) {
            const k = line.slice(0, idx).trim();
            const v = line.slice(idx + 1).trim();
            responseHeaders[k] = isSensitiveHeader(k) ? REDACTED : v;
          }
        }
        onEntry({
          tFromStart,
          method: ctx.method,
          url: ctx.url,
          status: err ? null : this.status,
          durationMs,
          requestHeaders: ctx.requestHeaders,
          requestBody: ctx.requestBody,
          responseHeaders,
          responseBody,
          error: err,
          initiator: 'xhr',
        });
      };

      this.addEventListener('loadend', () => finalize(null));
      this.addEventListener('error', () => finalize('XHR error event'));
      this.addEventListener('abort', () => finalize('XHR aborted'));
      this.addEventListener('timeout', () => finalize('XHR timeout'));
    }
    // biome-ignore lint/style/noNonNullAssertion: original captured above
    return originalXHRSend!.call(this, body ?? null);
  };

  bugzarXHROpen = XMLHttpRequest.prototype.open;
  bugzarXHRSend = XMLHttpRequest.prototype.send;
  bugzarXHRSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
};

export const uninstallNetworkPatch = (): void => {
  // Only unwind a layer if Bugzar's wrapper is still the active one. If a later
  // library stacked its own wrapper on top of ours, restoring our pre-install
  // snapshot would silently remove that wrapper — so we leave the stack intact
  // and just release our references (#48).
  if (originalFetch && window.fetch === bugzarFetch) window.fetch = originalFetch;
  if (originalXHROpen && XMLHttpRequest.prototype.open === bugzarXHROpen) {
    XMLHttpRequest.prototype.open = originalXHROpen;
  }
  if (originalXHRSend && XMLHttpRequest.prototype.send === bugzarXHRSend) {
    XMLHttpRequest.prototype.send = originalXHRSend;
  }
  if (
    originalXHRSetRequestHeader &&
    XMLHttpRequest.prototype.setRequestHeader === bugzarXHRSetRequestHeader
  ) {
    XMLHttpRequest.prototype.setRequestHeader = originalXHRSetRequestHeader;
  }
  originalFetch = null;
  originalXHROpen = null;
  originalXHRSend = null;
  originalXHRSetRequestHeader = null;
  bugzarFetch = null;
  bugzarXHROpen = null;
  bugzarXHRSend = null;
  bugzarXHRSetRequestHeader = null;
};
