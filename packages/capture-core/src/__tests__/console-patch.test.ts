// @vitest-environment happy-dom
/**
 * console-patch captures the 5 standard levels (log/info/warn/error/debug)
 * AND the 3 grouping markers (group/groupCollapsed/groupEnd) so the viewer
 * can reconstruct nested folds. The patch loop is uniform — these tests
 * pin the contract that every patched method actually emits an entry.
 */

import type { ConsoleEntry } from '@bugzar/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installConsolePatch, uninstallConsolePatch } from '../console-patch';

let entries: ConsoleEntry[];
const originalConsole: Record<string, unknown> = {};

beforeEach(() => {
  entries = [];
  // Snapshot every level we patch so afterEach can fully restore even if
  // a test throws mid-flow.
  for (const k of [
    'log',
    'info',
    'warn',
    'error',
    'debug',
    'group',
    'groupCollapsed',
    'groupEnd',
  ] as const) {
    originalConsole[k] = (console as unknown as Record<string, unknown>)[k];
  }
  installConsolePatch({
    sessionStart: Date.now(),
    onEntry: (e) => entries.push(e),
  });
});

afterEach(() => {
  uninstallConsolePatch();
  for (const [k, v] of Object.entries(originalConsole)) {
    (console as unknown as Record<string, unknown>)[k] = v;
  }
  vi.restoreAllMocks();
});

describe('console-patch — standard log levels', () => {
  it('captures log/info/warn/error/debug', () => {
    console.log('a');
    console.info('b');
    console.warn('c');
    console.error('d');
    console.debug('e');
    expect(entries.map((x) => x.level)).toEqual(['log', 'info', 'warn', 'error', 'debug']);
  });
});

describe('console-patch — secret redaction', () => {
  // S-8: apps routinely log auth responses/tokens. Captured console args go to
  // the public-by-URL replay, so token-shaped values must be scrubbed.
  const JWT =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

  it('redacts token-shaped console args', () => {
    console.log('auth', `Bearer ${JWT}`);
    const entry = entries.find((e) => e.args[0] === 'auth');
    expect(entry).toBeTruthy();
    const joined = entry!.args.join(' ');
    expect(joined).not.toContain(JWT);
    expect(joined).toContain('[REDACTED]');
  });
});

describe('console-patch — R2b/R2c location signals', () => {
  const fireError = (over: Record<string, unknown>) => {
    const ev = new Event('error') as unknown as Record<string, unknown>;
    Object.assign(ev, over);
    window.dispatchEvent(ev as unknown as Event);
  };

  it('captures source(file:line:col), kind=error, and the error.cause chain', () => {
    fireError({
      message: 'boom',
      filename: 'https://app.example/assets/main.js',
      lineno: 42,
      colno: 7,
      error: Object.assign(new Error('boom'), { cause: new Error('root cause here') }),
    });
    const e = entries.find((x) => x.args[0] === 'boom');
    expect(e?.kind).toBe('error');
    expect(e?.source).toEqual({ file: 'https://app.example/assets/main.js', line: 42, col: 7 });
    expect(e?.cause).toContain('root cause here');
  });

  it('redacts a token-shaped value inside error.cause', () => {
    const JWT =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    fireError({
      message: 'auth fail',
      error: Object.assign(new Error('auth fail'), { cause: new Error(`token ${JWT}`) }),
    });
    const e = entries.find((x) => x.args[0] === 'auth fail');
    expect(e?.cause).toBeTruthy();
    expect(e?.cause).not.toContain(JWT);
    expect(e?.cause).toContain('[REDACTED]');
  });

  it('marks unhandledrejection with kind', () => {
    const ev = new Event('unhandledrejection') as unknown as Record<string, unknown>;
    ev.reason = new Error('rejected');
    window.dispatchEvent(ev as unknown as Event);
    const e = entries.find((x) => x.args[0] === 'rejected');
    expect(e?.kind).toBe('unhandledrejection');
  });

  it('captures a CSP violation as kind=csp', () => {
    const ev = new Event('securitypolicyviolation') as unknown as Record<string, unknown>;
    ev.violatedDirective = 'script-src';
    ev.blockedURI = 'https://evil.example/x.js';
    window.dispatchEvent(ev as unknown as Event);
    const e = entries.find((x) => x.kind === 'csp');
    expect(e).toBeTruthy();
    expect(e?.args.join(' ')).toContain('script-src');
  });
});

describe('console-patch — grouping markers', () => {
  // happy-dom's console.group implementation also invokes console.log
  // internally, so calls produce a `group` entry AND a downstream `log`
  // entry. We assert the `group` entry exists; the real browser doesn't
  // re-enter like that. The downstream noise is acceptable in tests.

  it('captures console.group with its label', () => {
    console.group('[API@x] f154ga GET /api/products');
    expect(
      entries.some((e) => e.level === 'group' && e.args[0] === '[API@x] f154ga GET /api/products'),
    ).toBe(true);
  });

  it('captures console.groupCollapsed distinct from group', () => {
    console.groupCollapsed('start collapsed');
    expect(
      entries.some((e) => e.level === 'groupCollapsed' && e.args[0] === 'start collapsed'),
    ).toBe(true);
  });

  it('captures console.groupEnd', () => {
    console.groupEnd();
    expect(entries.some((e) => e.level === 'groupEnd')).toBe(true);
  });

  it('captures the 3 marker types so the viewer can stack-pair', () => {
    console.group('outer');
    console.log('child');
    console.groupEnd();
    const levels = entries.map((x) => x.level);
    // Marker order must hold (children may be intermixed by host impl).
    const groupIdx = levels.indexOf('group');
    const logIdx = levels.indexOf('log');
    const groupEndIdx = levels.indexOf('groupEnd');
    expect(groupIdx).toBeGreaterThanOrEqual(0);
    expect(logIdx).toBeGreaterThan(groupIdx);
    expect(groupEndIdx).toBeGreaterThan(logIdx);
  });
});

// #4: object console args must get the SAME key-based masking as network bodies.
// Previously they were only free-text-scrubbed (Bearer/JWT), leaking e.g.
// console.log({ password }). Reuses @bugzar/shared sanitizeNetworkBody.
describe('object arg key-based redaction (#4)', () => {
  it('redacts sensitive keys in a logged object, keeps benign fields', () => {
    console.log({ password: 'hunter2', apiKey: 'sk_live_xyz', note: 'ok' });
    const joined = entries.at(-1)!.args.join(' ');
    expect(joined).not.toContain('hunter2');
    expect(joined).not.toContain('sk_live_xyz');
    expect(joined).toContain('[REDACTED]');
    expect(joined).toContain('ok'); // benign preserved
  });

  it('still redacts a Bearer token inside a string arg (existing behavior kept)', () => {
    console.warn('auth failed', 'Authorization: Bearer sk_live_abc');
    const joined = entries.at(-1)!.args.join(' ');
    expect(joined).not.toContain('sk_live_abc');
    expect(joined).toContain('Bearer [REDACTED]');
  });

  it('does not throw on a circular object — an entry is still produced', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => console.log(circular)).not.toThrow();
    expect(entries.length).toBeGreaterThan(0);
  });

  // Review follow-up: a JSON STRING arg must not sidestep the key masking —
  // console.log(JSON.stringify({ password })) is the same leak in string form.
  it('key-masks a JSON string arg too', () => {
    console.log(JSON.stringify({ password: 'hunter2', note: 'ok' }));
    const joined = entries.at(-1)!.args.join(' ');
    expect(joined).not.toContain('hunter2');
    expect(joined).toContain('[REDACTED]');
    expect(joined).toContain('ok');
  });

  it('leaves plain prose string args untouched', () => {
    console.log('user clicked the save button 3 times');
    expect(entries.at(-1)!.args[0]).toBe('user clicked the save button 3 times');
  });
});
