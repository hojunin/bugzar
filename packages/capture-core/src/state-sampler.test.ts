// @vitest-environment happy-dom
/**
 * M6 — app-state sampler cadence contract.
 *
 * The sampler must sample captureState() immediately on install, then on the
 * throttle interval, then once more on flush (which stops the timer), tagging
 * each snapshot with tFromStart and passing the value through serializeState. A
 * throwing captureState is swallowed. The module is a SHELL (install/flush are
 * no-ops), so the cadence assertions are RED until the implement-last pass; the
 * "install never throws" guard is green.
 */

import type { StateSnapshot } from '@bugzar/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetForTests, flushStateSampler, installStateSampler } from './state-sampler';

let snaps: StateSnapshot[];

beforeEach(() => {
  vi.useFakeTimers();
  _resetForTests();
  snaps = [];
});
afterEach(() => {
  flushStateSampler();
  vi.useRealTimers();
});

const install = (captureState: () => unknown, throttleMs = 1000): void => {
  installStateSampler({
    sessionStart: Date.now(),
    captureState,
    throttleMs,
    onSnapshot: (s) => snaps.push(s),
  });
};

describe('state-sampler (M6)', () => {
  it('samples once immediately on install', () => {
    install(() => ({ n: 1 }));
    expect(snaps).toHaveLength(1);
    expect(snaps[0].data).toEqual({ n: 1 });
    expect(snaps[0].tFromStart).toBeLessThan(50);
  });

  it('samples again on each throttle interval', () => {
    install(() => ({}), 1000);
    vi.advanceTimersByTime(3500);
    // install + 3 ticks
    expect(snaps.length).toBeGreaterThanOrEqual(4);
  });

  it('tags snapshots with tFromStart relative to sessionStart', () => {
    install(() => ({}), 1000);
    vi.advanceTimersByTime(2000);
    expect(snaps[snaps.length - 1].tFromStart).toBeGreaterThanOrEqual(2000);
  });

  it('flush takes a final sample and stops the timer', () => {
    install(() => ({}), 1000);
    const before = snaps.length;
    flushStateSampler();
    expect(snaps.length).toBe(before + 1);
    vi.advanceTimersByTime(5000);
    expect(snaps.length).toBe(before + 1); // timer stopped — no further samples
  });

  it('runs each value through serializeState (so primitives pass through)', () => {
    install(() => 'plain');
    expect(snaps[0].data).toBe('plain');
  });

  it('swallows a throwing captureState (best-effort — never breaks recording)', () => {
    expect(() =>
      installStateSampler({
        sessionStart: Date.now(),
        captureState: () => {
          throw new Error('boom');
        },
        onSnapshot: (s) => snaps.push(s),
      }),
    ).not.toThrow();
  });
});
