/**
 * M6 — app-state serialization + redaction contract.
 *
 * `serializeState` must turn arbitrary host state (TanStack cache, a Redux
 * store, …) into a JSON-serializable, redacted snapshot: structured-clone-safe
 * value coercion, a circular guard, a size cap, sensitive-key + JWT masking,
 * then the host `redact` override. The module is a SHELL (returns its input),
 * so these are RED until the implement-last pass.
 */

import { describe, expect, it } from 'vitest';
import { serializeState } from './serialize-state';

const str = (v: unknown): string => JSON.stringify(v);

describe('serializeState (M6)', () => {
  it('coerces Date to an ISO string', () => {
    const out = serializeState({ at: new Date('2020-01-02T03:04:05.000Z') }) as { at: unknown };
    expect(out.at).toBe('2020-01-02T03:04:05.000Z');
  });

  it('coerces Map to an entries array and Set to a values array', () => {
    const out = serializeState({ m: new Map([['k', 1]]), s: new Set([1, 2]) }) as {
      m: unknown;
      s: unknown;
    };
    expect(out.m).toEqual([['k', 1]]);
    expect(out.s).toEqual([1, 2]);
  });

  it('coerces Error to a JSON-serializable { name, message }', () => {
    // A raw Error serializes to '{}' (name/message are non-enumerable), so the
    // module must convert it to a plain object — assert it survives a JSON round-trip.
    const out = serializeState({ err: new TypeError('boom') }) as { err: unknown };
    const roundTrip = JSON.parse(JSON.stringify(out.err)) as { name?: string; message?: string };
    expect(roundTrip.name).toBe('TypeError');
    expect(roundTrip.message).toBe('boom');
  });

  it('passes primitives through unchanged (stable across shell + impl)', () => {
    expect(serializeState(42)).toBe(42);
    expect(serializeState('plain')).toBe('plain');
    expect(serializeState(null)).toBe(null);
    expect(serializeState(true)).toBe(true);
  });

  it('drops functions and Promises (keeping the rest)', () => {
    const out = serializeState({ fn: () => 1, p: Promise.resolve(1), keep: 5 }) as Record<
      string,
      unknown
    >;
    expect(out.keep).toBe(5);
    expect(typeof out.fn).not.toBe('function');
    expect(out.p).not.toBeInstanceOf(Promise);
  });

  it('guards circular references with a marker (no infinite loop / throw)', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    const out = serializeState(a) as Record<string, unknown>;
    expect(out.name).toBe('a');
    expect(out.self).toBe('[Circular]');
  });

  it('redacts sensitive keys with an in-band marker (not silent deletion)', () => {
    const out = serializeState({ password: 'secret123', user: 'alice' });
    expect(str(out)).not.toContain('secret123');
    expect(str(out)).toContain('alice');
    // The masked value is MARKED (e.g. [REDACTED]) so a viewer shows "redacted",
    // never mistaking it for absent data.
    expect(str(out)).toMatch(/redact/i);
  });

  it('redacts JWT-looking strings even under a non-sensitive key', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const out = serializeState({ note: jwt });
    expect(str(out)).not.toContain(jwt);
  });

  it('applies the host redact override AFTER the built-in masking', () => {
    const out = serializeState(
      { email: 'a@b.com' },
      { redact: (s) => ({ ...(s as Record<string, unknown>), extra: 'x' }) },
    ) as Record<string, unknown>;
    expect(out.extra).toBe('x');
  });

  it('caps oversized state with a truncation marker (not silent)', () => {
    const big = { blob: 'x'.repeat(500_000) };
    const out = serializeState(big, { maxBytes: 1000 });
    expect(str(out).length).toBeLessThan(5000);
    // Honest truncation — a viewer can tell "truncated" from "missing".
    expect(str(out)).toMatch(/truncat/i);
  });
});
