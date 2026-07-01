import { describe, expect, it } from 'vitest';
import { newSessionId, tFromStart } from './time';

describe('newSessionId', () => {
  it('returns a UUID v7 (version digit 7 at index 14)', () => {
    const id = newSessionId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('two sequential calls produce different IDs', () => {
    expect(newSessionId()).not.toBe(newSessionId());
  });

  it('IDs from later calls sort lexicographically after earlier ones (time-ordered)', () => {
    const a = newSessionId();
    // Spin briefly to ensure timestamp advances
    const target = Date.now() + 2;
    while (Date.now() < target) {
      /* spin */
    }
    const b = newSessionId();
    expect(a < b).toBe(true);
  });
});

describe('tFromStart', () => {
  it('returns ms offset for timestamp after start', () => {
    expect(tFromStart(1_000_500, 1_000_000)).toBe(500);
  });

  it('returns 0 when timestamp equals start', () => {
    expect(tFromStart(1_000_000, 1_000_000)).toBe(0);
  });

  it('throws when timestamp precedes start (rejects clock skew)', () => {
    expect(() => tFromStart(900, 1_000)).toThrow(/before session start/);
  });
});
