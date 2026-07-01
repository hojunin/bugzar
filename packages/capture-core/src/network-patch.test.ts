import { NETWORK_BODY_MAX_BYTES } from '@bugzar/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetNetworkBudget,
  capBody,
  installNetworkPatch,
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
