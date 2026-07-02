import { NETWORK_BODY_MAX_BYTES } from '@bugzar/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetNetworkBudget,
  capBody,
  installNetworkPatch,
  sanitizeHeaders,
  uninstallNetworkPatch,
} from './network-patch';

// `capBody` (#20): per-body BYTE truncation + per-session total budget, then the
// existing sanitize. RED until the helper + shared limits land.

const byteLen = (s: string): number => new TextEncoder().encode(s).length;

beforeEach(() => {
  __resetNetworkBudget();
});

describe('capBody — per-body byte cap + session total budget', () => {
  it('passes a small clean body through unchanged', () => {
    expect(capBody('{"ok":true}', 'application/json')).toBe('{"ok":true}');
  });

  it('returns null for a null body', () => {
    expect(capBody(null, null)).toBeNull();
  });

  it('still redacts sensitive fields via sanitizeNetworkBody on the kept body', () => {
    const out = capBody('{"password":"hunter2"}', 'application/json') ?? '';
    expect(out).not.toContain('hunter2'); // sanitize still runs after the cap
  });

  it('truncates an ASCII body over 1MB and appends the marker', () => {
    const big = 'a'.repeat(NETWORK_BODY_MAX_BYTES + 50_000);
    const out = capBody(big, 'text/plain') ?? '';
    expect(out.endsWith('…[truncated]')).toBe(true);
    expect(byteLen(out)).toBeLessThanOrEqual(NETWORK_BODY_MAX_BYTES + 32); // cap + marker
  });

  it('caps by BYTES not chars — a CJK body under 1M chars but over 1MB bytes is truncated', () => {
    // '가' = 3 UTF-8 bytes, 1 UTF-16 code unit.
    const cjk = '가'.repeat(Math.floor(NETWORK_BODY_MAX_BYTES / 3) + 50_000);
    expect(cjk.length).toBeLessThan(NETWORK_BODY_MAX_BYTES); // char-length is UNDER the cap…
    expect(byteLen(cjk)).toBeGreaterThan(NETWORK_BODY_MAX_BYTES); // …but byte-length is OVER
    const out = capBody(cjk, 'text/plain') ?? '';
    expect(out.endsWith('…[truncated]')).toBe(true); // a char-based cap would NOT truncate this
  });

  it('drops bodies with a budget marker once the session total is exhausted', () => {
    const oneMb = 'a'.repeat(NETWORK_BODY_MAX_BYTES);
    let last = '';
    for (let i = 0; i < 25; i++) last = capBody(oneMb, 'text/plain') ?? '';
    expect(last).toBe('…[budget exceeded]');
    // Any further body — even tiny — is dropped while the budget stays spent.
    expect(capBody('{"x":1}', 'application/json')).toBe('…[budget exceeded]');
  });

  it('resets the budget per session (__resetNetworkBudget)', () => {
    const oneMb = 'a'.repeat(NETWORK_BODY_MAX_BYTES);
    for (let i = 0; i < 25; i++) capBody(oneMb, 'text/plain');
    expect(capBody('{"x":1}', 'application/json')).toBe('…[budget exceeded]');
    __resetNetworkBudget();
    expect(capBody('{"x":1}', 'application/json')).toBe('{"x":1}'); // fresh session
  });

  it('counts request bodies toward the same budget (request bodies were uncapped before)', () => {
    const oneMb = 'a'.repeat(NETWORK_BODY_MAX_BYTES);
    // Mix of request + response bodies all draw down the one session budget.
    let last = '';
    for (let i = 0; i < 25; i++) last = capBody(oneMb, 'text/plain') ?? '';
    expect(last).toBe('…[budget exceeded]');
  });
});

// #48 — uninstall must not clobber a host wrapper (Sentry/Datadog/APM/mock)
// stacked on top of Bugzar's patch. It only unwinds when Bugzar is still the
// active (top) layer.
describe('uninstallNetworkPatch — stack-safe restore (#48)', () => {
  const noop = { sessionStart: 0, onEntry: () => {} };

  it('unwinds Bugzar when it is still the top layer', () => {
    const before = window.fetch;
    installNetworkPatch(noop);
    const bugzar = window.fetch;
    expect(bugzar).not.toBe(before); // wrapper installed
    uninstallNetworkPatch();
    expect(window.fetch).not.toBe(bugzar); // our wrapper removed
  });

  it('leaves a later fetch wrapper intact instead of restoring the pre-install snapshot', () => {
    const original = window.fetch;
    installNetworkPatch(noop);
    const bugzar = window.fetch;
    // A later library stacks its own wrapper on top of Bugzar's.
    const later = ((input: RequestInfo | URL, init?: RequestInit) =>
      bugzar(input, init)) as typeof window.fetch;
    window.fetch = later;

    uninstallNetworkPatch();

    expect(window.fetch).toBe(later); // NOT clobbered back to the pre-install fetch
    window.fetch = original; // normalize for other tests
  });

  it('leaves a later XHR.open wrapper intact', () => {
    const original = XMLHttpRequest.prototype.open;
    installNetworkPatch(noop);
    const bugzarOpen = XMLHttpRequest.prototype.open;
    const later = function patchedByOther(this: XMLHttpRequest, ...args: unknown[]) {
      // biome-ignore lint/suspicious/noExplicitAny: variadic XHR open signature
      return (bugzarOpen as any).apply(this, args);
    } as typeof XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = later;

    uninstallNetworkPatch();

    expect(XMLHttpRequest.prototype.open).toBe(later);
    XMLHttpRequest.prototype.open = original; // normalize
  });
});

// #6: header redaction now uses the shared deny-by-default isSensitiveHeader.
// (A `new Request().headers` is cross-realm in happy-dom, so `instanceof
// Headers` is false there — but a same-realm `new Headers()` constructed in
// the test does exercise the Headers-instance branch.)
describe('sanitizeHeaders — deny-by-default custom auth headers (#6)', () => {
  it('redacts custom auth/csrf/session headers, keeps content-type', () => {
    const out = sanitizeHeaders({
      'x-access-token': 'a',
      'x-csrf-token': 'b',
      'x-session-id': 'c',
      authentication: 'd',
      'x-amz-security-token': 'e',
      'content-type': 'application/json',
      'content-length': '42',
    });
    expect(out['x-access-token']).toBe('[REDACTED]');
    expect(out['x-csrf-token']).toBe('[REDACTED]');
    expect(out['x-session-id']).toBe('[REDACTED]');
    expect(out.authentication).toBe('[REDACTED]');
    expect(out['x-amz-security-token']).toBe('[REDACTED]');
    expect(out['content-type']).toBe('application/json'); // survives (downstream needs it)
    expect(out['content-length']).toBe('42');
  });

  it('redacts through the Headers-instance branch too (same-realm Headers)', () => {
    const out = sanitizeHeaders(
      new Headers({
        'x-csrf-token': 'b',
        authorization: 'Bearer t',
        'content-type': 'application/json',
      }),
    );
    expect(out['x-csrf-token']).toBe('[REDACTED]');
    expect(out.authorization).toBe('[REDACTED]');
    expect(out['content-type']).toBe('application/json');
  });
});

// #5: the fetch wrapper feeds req.url through sanitizeUrl before recording, so
// query-string secrets never reach the captured entry (end-to-end).
describe('capture redaction — URL query secrets (#5)', () => {
  let origFetch: typeof window.fetch;
  beforeEach(() => {
    __resetNetworkBudget();
    origFetch = window.fetch;
  });
  afterEach(() => {
    uninstallNetworkPatch();
    window.fetch = origFetch;
  });

  it('redacts credential query params in the captured fetch entry, keeps benign + host/path', async () => {
    window.fetch = (async () =>
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof window.fetch;

    const entries: Array<{ url: string }> = [];
    installNetworkPatch({ sessionStart: 0, onEntry: (e) => entries.push(e as never) });

    await window.fetch('https://api.x/v1?token=SECRET&api_key=K&page=2');

    expect(entries[0]?.url).toBe('https://api.x/v1?token=[REDACTED]&api_key=[REDACTED]&page=2');
  });
});
