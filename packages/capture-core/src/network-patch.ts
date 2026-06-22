import { type NetworkEntryPayload, sanitizeNetworkBody } from '@bugzar/shared';

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

const REDACT_HEADER = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
]);

const REDACTED = '[REDACTED]';

const sanitizeHeaders = (h: Headers | Record<string, string>): Record<string, string> => {
  const out: Record<string, string> = {};
  const apply = (k: string, v: string): void => {
    out[k] = REDACT_HEADER.has(k.toLowerCase()) ? REDACTED : v;
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

type Options = {
  sessionStart: number;
  onEntry: (entry: NetworkEntryPayload) => void;
};

let originalFetch: typeof window.fetch | null = null;
let originalXHROpen: typeof XMLHttpRequest.prototype.open | null = null;
let originalXHRSend: typeof XMLHttpRequest.prototype.send | null = null;
let originalXHRSetRequestHeader: typeof XMLHttpRequest.prototype.setRequestHeader | null = null;

export const installNetworkPatch = ({ sessionStart, onEntry }: Options): void => {
  if (originalFetch) return; // idempotent

  // ── fetch ──
  originalFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const startedMs = Date.now();
    const tFromStart = startedMs - sessionStart;
    const req = new Request(input, init);
    const method = req.method || 'GET';
    const url = req.url;
    const requestHeaders = sanitizeHeaders(req.headers);
    let requestBody: string | null = null;
    try {
      // Clone to leave original intact for the page's fetch path.
      const cloned = req.clone();
      const text = await cloned.text();
      // Redact form PII (passwords/tokens/api keys) BEFORE the body leaves
      // the page — keeps cleartext out of IDB and R2. See sanitize-network-body.
      requestBody = sanitizeNetworkBody(text || null, req.headers.get('content-type'));
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
        const truncated = text.length > 100_000 ? `${text.slice(0, 100_000)}…[truncated]` : text;
        // Servers sometimes echo credentials back (login response with
        // session_id, OAuth code → token responses). Mask before persist.
        responseBody = sanitizeNetworkBody(truncated, res.headers.get('content-type'));
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
      });
      throw err;
    }
  }) as typeof window.fetch;

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
      url: typeof url === 'string' ? url : url.toString(),
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
      this.__bugzar.requestHeaders[name] = REDACT_HEADER.has(name.toLowerCase()) ? REDACTED : value;
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
          // Pull Content-Type from already-captured request headers (the
          // header is not on our REDACT_HEADER list, so it survives intact).
          // Lookup is case-insensitive since setRequestHeader preserves
          // the caller's casing.
          const rh = this.__bugzar.requestHeaders;
          const ct =
            rh['content-type'] ??
            rh['Content-Type'] ??
            rh['CONTENT-TYPE'] ??
            Object.entries(rh).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ??
            null;
          this.__bugzar.requestBody = sanitizeNetworkBody(s, ct);
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
            const text = this.responseText;
            const truncated =
              text.length > 100_000 ? `${text.slice(0, 100_000)}…[truncated]` : text;
            // Same threat as fetch response — login/OAuth flows echo
            // credentials back.
            responseBody = sanitizeNetworkBody(truncated, this.getResponseHeader('content-type'));
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
            responseHeaders[k] = REDACT_HEADER.has(k.toLowerCase()) ? REDACTED : v;
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
};

export const uninstallNetworkPatch = (): void => {
  if (originalFetch) {
    window.fetch = originalFetch;
    originalFetch = null;
  }
  if (originalXHROpen) {
    XMLHttpRequest.prototype.open = originalXHROpen;
    originalXHROpen = null;
  }
  if (originalXHRSend) {
    XMLHttpRequest.prototype.send = originalXHRSend;
    originalXHRSend = null;
  }
  if (originalXHRSetRequestHeader) {
    XMLHttpRequest.prototype.setRequestHeader = originalXHRSetRequestHeader;
    originalXHRSetRequestHeader = null;
  }
};
