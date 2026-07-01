/**
 * M6 — host app-state sampler.
 *
 * Mirrors the vitals/resource-timing patch shape: the recorder installs it on
 * start (when a `captureState` is provided) and flushes it on stop. Samples
 * `captureState()` immediately, then on a throttle interval, then once more on
 * flush — each sample run through `serializeState` (redaction + structured-clone
 * coercion) and emitted as a `StateSnapshot { tFromStart, data }` via `onSnapshot`.
 * A throwing `captureState` is swallowed (best-effort; recording must never break
 * because the host's state getter failed).
 */

import type { StateSnapshot } from '@bugzar/shared';
import { serializeState } from '@bugzar/shared';

export interface StateSamplerOptions {
  /** Recording start (ms epoch) — snapshots carry `tFromStart = Date.now() - sessionStart`. */
  sessionStart: number;
  /** Host state getter (e.g. a dehydrated TanStack cache). Sampled on a cadence. */
  captureState: () => unknown;
  /** Host redaction applied (after the built-in masking) inside `serializeState`. */
  redactState?: (state: unknown) => unknown;
  /** Sampling interval while recording (ms). Default 2000. */
  throttleMs?: number;
  /** Receives each serialized + redacted snapshot. */
  onSnapshot: (snapshot: StateSnapshot) => void;
}

let timer: ReturnType<typeof setInterval> | null = null;
let current: StateSamplerOptions | null = null;

const sample = (): void => {
  const o = current;
  if (!o) return;
  try {
    const data = serializeState(o.captureState(), o.redactState ? { redact: o.redactState } : {});
    o.onSnapshot({ tFromStart: Date.now() - o.sessionStart, data });
  } catch {
    // best-effort — a throwing captureState must never break recording.
  }
};

export const installStateSampler = (opts: StateSamplerOptions): void => {
  if (timer) clearInterval(timer);
  current = opts;
  sample(); // immediate
  timer = setInterval(sample, opts.throttleMs ?? 2000);
};

export const flushStateSampler = (): void => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  sample(); // final
  current = null;
};

/** Test-only — drops any live timer/state without sampling. */
export const _resetForTests = (): void => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  current = null;
};
