/**
 * Regression test for the trailing-buffer bug in rrweb-recorder. Earlier
 * versions dropped every event between the last interval tick and stop —
 * which on a sub-second recording meant the entire FullSnapshot was lost
 * and the viewer showed a blank DOM. Fixed: stopRecording now flushes the
 * buffer through the onBatch it was started with.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock rrweb's `record` so we can drive `emit` manually without touching
// the DOM. We capture the emit callback the recorder was started with, then
// inject events through it and assert flush behavior.
let injectedEmit: ((e: unknown) => void) | null = null;
let lastRecordOpts: Record<string, unknown> | null = null;
let stopSpy: ReturnType<typeof vi.fn>;

vi.mock('rrweb', () => ({
  record: (opts: { emit: (e: unknown) => void }) => {
    injectedEmit = opts.emit;
    lastRecordOpts = opts as Record<string, unknown>;
    return stopSpy;
  },
}));

import { captureSnapshot, startRecording, stopRecording } from '../rrweb-recorder';

beforeEach(() => {
  vi.useFakeTimers();
  stopSpy = vi.fn();
  injectedEmit = null;
  lastRecordOpts = null;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('rrweb-recorder', () => {
  it('flushes pending events through onBatch on stop (regression: trailing buffer was dropped)', () => {
    const onBatch = vi.fn();
    startRecording({ onBatch, batchIntervalMs: 1000 });

    // Two events arrive *before* the first interval tick — historically lost.
    // biome-ignore lint/style/noNonNullAssertion: injectedEmit set by mock
    injectedEmit!({ type: 4, data: { href: 'a' }, timestamp: 1 } as never);
    // biome-ignore lint/style/noNonNullAssertion: injectedEmit set by mock
    injectedEmit!({ type: 2, data: {} as never, timestamp: 2 } as never);

    // Caller stops without waiting for an interval tick.
    stopRecording();

    expect(onBatch).toHaveBeenCalledOnce();
    const flushed = onBatch.mock.calls[0]?.[0] as unknown[];
    expect(flushed.length).toBe(2);
    expect(stopSpy).toHaveBeenCalledOnce();
  });

  it('does not flush twice if events were already flushed on the interval', () => {
    const onBatch = vi.fn();
    startRecording({ onBatch, batchIntervalMs: 1000 });

    // biome-ignore lint/style/noNonNullAssertion: injectedEmit set by mock
    injectedEmit!({ type: 4, data: {} as never, timestamp: 1 } as never);
    vi.advanceTimersByTime(1000); // interval flush — buffer cleared
    expect(onBatch).toHaveBeenCalledTimes(1);

    stopRecording();
    // No new events between last tick and stop → no extra flush call.
    expect(onBatch).toHaveBeenCalledTimes(1);
  });

  it('is idempotent on repeated startRecording / stopRecording', () => {
    const onBatch = vi.fn();
    startRecording({ onBatch, batchIntervalMs: 1000 });
    startRecording({ onBatch, batchIntervalMs: 1000 }); // second call is a no-op
    stopRecording();
    stopRecording(); // second stop is a no-op too
    expect(stopSpy).toHaveBeenCalledOnce();
  });
});

describe('captureSnapshot input masking', () => {
  // The design-pick snapshot must mask credentials just like startRecording —
  // otherwise password fields on the page are captured in cleartext into the
  // design report (which is uploaded to R2 / linked from Jira).
  it('masks password inputs by default (parity with the recording path)', () => {
    captureSnapshot();
    expect(lastRecordOpts?.maskAllInputs).toBe(false);
    expect(lastRecordOpts?.maskInputOptions).toEqual({ password: true });
  });

  it('masks every input when maskAllInputs is set', () => {
    captureSnapshot('.bugzar-root', false, true);
    expect(lastRecordOpts?.maskAllInputs).toBe(true);
    // maskAllInputs on ⇒ rrweb masks all types, so no per-type options.
    expect(lastRecordOpts?.maskInputOptions).toBeUndefined();
  });
});
