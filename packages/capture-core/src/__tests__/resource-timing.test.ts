// @vitest-environment happy-dom
/**
 * M5 — Resource Timing capture contract.
 *
 * happy-dom ships no PerformanceObserver, so we stub one that captures its
 * callback; the test "emits" resource entries through it and asserts the module
 * maps each PerformanceResourceTiming to a serializable ResourceTimingEntry,
 * accumulates across callbacks, flushes once, and degrades gracefully.
 *
 * The module is a SHELL today (flush → []), so the behavioral assertions are RED
 * until the implement-last pass; the no-PerformanceObserver guard is green.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetForTests,
  flushResourceTiming,
  installResourceTimingPatch,
} from '../resource-timing-patch';

let poCallback: ((list: { getEntries: () => unknown[] }) => void) | null = null;
let observed: { type?: string; buffered?: boolean } | null = null;

class MockPerformanceObserver {
  constructor(cb: (list: { getEntries: () => unknown[] }) => void) {
    poCallback = cb;
  }
  observe(opts: { type?: string; buffered?: boolean }): void {
    observed = opts;
  }
  disconnect(): void {}
}

/** Push a batch of entries through the observer callback, as the browser would. */
const emit = (entries: unknown[]): void => {
  poCallback?.({ getEntries: () => entries });
};

const mockEntry = (over: Record<string, unknown> = {}): PerformanceResourceTiming =>
  ({
    name: 'https://app.example/api/products',
    entryType: 'resource',
    initiatorType: 'fetch',
    startTime: 100,
    duration: 50,
    transferSize: 1024,
    encodedBodySize: 900,
    decodedBodySize: 2048,
    nextHopProtocol: 'h2',
    responseStatus: 200,
    deliveryType: '',
    serverTiming: [],
    ...over,
  }) as unknown as PerformanceResourceTiming;

beforeEach(() => {
  _resetForTests();
  poCallback = null;
  observed = null;
  vi.stubGlobal('PerformanceObserver', MockPerformanceObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resource-timing-patch (M5)', () => {
  it('observes the resource entryType, buffered', () => {
    installResourceTimingPatch();
    expect(observed?.type).toBe('resource');
    expect(observed?.buffered).toBe(true);
  });

  it('maps an observed resource entry to a ResourceTimingEntry on flush', () => {
    installResourceTimingPatch();
    emit([mockEntry({ name: 'https://app.example/a.js', initiatorType: 'script' })]);
    const out = flushResourceTiming();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      name: 'https://app.example/a.js',
      initiatorType: 'script',
      startTime: 100,
      duration: 50,
      transferSize: 1024,
      encodedBodySize: 900,
      decodedBodySize: 2048,
      nextHopProtocol: 'h2',
    });
  });

  it('preserves cross-origin-no-TAO zeroed sizes/protocol verbatim', () => {
    installResourceTimingPatch();
    emit([
      mockEntry({ transferSize: 0, encodedBodySize: 0, decodedBodySize: 0, nextHopProtocol: '' }),
    ]);
    const out = flushResourceTiming();
    expect(out[0].transferSize).toBe(0);
    expect(out[0].nextHopProtocol).toBe('');
  });

  it('accumulates across multiple observer callbacks until flush', () => {
    installResourceTimingPatch();
    emit([mockEntry({ name: 'a' })]);
    emit([mockEntry({ name: 'b' }), mockEntry({ name: 'c' })]);
    expect(flushResourceTiming()).toHaveLength(3);
  });

  it('flush disconnects — a second flush returns empty', () => {
    installResourceTimingPatch();
    emit([mockEntry()]);
    expect(flushResourceTiming()).toHaveLength(1);
    expect(flushResourceTiming()).toHaveLength(0);
  });

  it('degrades gracefully when PerformanceObserver is unavailable', () => {
    vi.stubGlobal('PerformanceObserver', undefined);
    installResourceTimingPatch();
    expect(flushResourceTiming()).toEqual([]);
  });
});
