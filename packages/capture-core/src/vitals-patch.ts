/**
 * PR-23 — Core Web Vitals capture.
 *
 * Subscribes to `PerformanceObserver` for LCP / CLS / INP / TTFB during a
 * recording. The metrics are accumulated in-memory and flushed once via
 * `flushVitals()` on stop — the rrweb / console / network batches are noisy
 * enough on their own, no point streaming vitals at 1Hz.
 *
 * Browsers without `PerformanceObserver` (or specific entry types) just
 * leave the corresponding field undefined — the ADF builder treats every
 * vital as optional.
 */

import type { WebVitals } from '@bugzar/shared';

interface LayoutShiftEntry extends PerformanceEntry {
  value: number;
  hadRecentInput: boolean;
}

interface PerformanceEventTimingEntry extends PerformanceEntry {
  interactionId?: number;
  processingStart: number;
  processingEnd: number;
}

type Observer = { disconnect(): void };

let observers: Observer[] = [];
let vitals: WebVitals = {};
let installed = false;

const tryObserve = (
  type: string,
  cb: (entries: PerformanceEntry[]) => void,
  buffered = true,
): Observer | null => {
  try {
    if (typeof PerformanceObserver === 'undefined') return null;
    const obs = new PerformanceObserver((list) => cb(list.getEntries()));
    obs.observe({ type, buffered });
    return obs;
  } catch {
    return null;
  }
};

export const installVitalsPatch = (): void => {
  if (installed) return;
  installed = true;
  vitals = {};

  // LCP — the latest entry wins. Once `hidden` fires the entry stops updating.
  const lcp = tryObserve('largest-contentful-paint', (entries) => {
    const last = entries[entries.length - 1];
    if (last) vitals.lcp = Math.round(last.startTime);
  });
  if (lcp) observers.push(lcp);

  // CLS — sum every layout-shift that did NOT have recent input.
  const cls = tryObserve('layout-shift', (entries) => {
    for (const e of entries as LayoutShiftEntry[]) {
      if (e.hadRecentInput) continue;
      vitals.cls = (vitals.cls ?? 0) + e.value;
    }
  });
  if (cls) observers.push(cls);

  // INP — keep the worst interaction-to-next-paint we've seen.
  const inp = tryObserve('event', (entries) => {
    for (const e of entries as PerformanceEventTimingEntry[]) {
      // event.interactionId > 0 means it counts toward INP per the spec.
      if (!e.interactionId || e.interactionId <= 0) continue;
      const dur = e.duration;
      if (!vitals.inp || dur > vitals.inp) vitals.inp = Math.round(dur);
    }
  });
  if (inp) observers.push(inp);

  // TTFB — derived from the navigation entry. Buffered so we get the value
  // even though the navigation finished before the observer attached.
  const nav = tryObserve('navigation', (entries) => {
    const first = entries[0] as PerformanceNavigationTiming | undefined;
    if (first) vitals.ttfb = Math.round(first.responseStart);
  });
  if (nav) observers.push(nav);
};

/**
 * Disconnect every observer and return the accumulated vitals. Safe to call
 * even when `installVitalsPatch` never installed (returns an empty object).
 */
export const flushVitals = (): WebVitals => {
  for (const obs of observers) {
    try {
      obs.disconnect();
    } catch {
      // ignore — observers don't always clean up on stop
    }
  }
  observers = [];
  installed = false;
  return { ...vitals };
};

/** Test-only — resets the module's accumulator without disconnecting. */
export const _resetForTests = (): void => {
  vitals = {};
  observers = [];
  installed = false;
};
