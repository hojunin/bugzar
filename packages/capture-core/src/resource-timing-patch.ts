/**
 * M5 — Resource Timing capture.
 *
 * Subscribes to `PerformanceObserver('resource', { buffered: true })` (so
 * resources that loaded before install are still captured) and maps each
 * `PerformanceResourceTiming` to a serializable `ResourceTimingEntry`,
 * accumulating in memory and flushing once on stop. Standalone + store-only:
 * no Service Worker, no request-id correlation, no AI/viewer render — just the
 * waterfall metadata uploaded via the `resources` asset slot. Cross-origin
 * resources without `Timing-Allow-Origin` already arrive with sizes/protocol
 * zeroed/blank, so fields are copied verbatim.
 */

import type { ResourceTimingEntry } from '@bugzar/shared';

// responseStatus / deliveryType are Chromium-ish and may be absent from the lib type.
type ResourceTimingLike = PerformanceResourceTiming & {
  responseStatus?: number;
  deliveryType?: string;
};

let observer: { disconnect(): void } | null = null;
let entries: ResourceTimingEntry[] = [];

const mapEntry = (e: ResourceTimingLike): ResourceTimingEntry => ({
  name: e.name,
  initiatorType: e.initiatorType,
  startTime: Math.round(e.startTime),
  duration: Math.round(e.duration),
  transferSize: e.transferSize,
  encodedBodySize: e.encodedBodySize,
  decodedBodySize: e.decodedBodySize,
  nextHopProtocol: e.nextHopProtocol,
  ...(typeof e.responseStatus === 'number' ? { responseStatus: e.responseStatus } : {}),
  ...(typeof e.deliveryType === 'string' ? { deliveryType: e.deliveryType } : {}),
  ...(Array.isArray(e.serverTiming)
    ? {
        serverTiming: e.serverTiming.map((s) => ({
          name: s.name,
          duration: s.duration,
          description: s.description,
        })),
      }
    : {}),
});

export const installResourceTimingPatch = (): void => {
  if (typeof PerformanceObserver === 'undefined') return;
  try {
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.entryType === 'resource') entries.push(mapEntry(e as ResourceTimingLike));
      }
    });
    obs.observe({ type: 'resource', buffered: true });
    observer = obs;
  } catch {
    observer = null;
  }
};

export const flushResourceTiming = (): ResourceTimingEntry[] => {
  if (observer) {
    try {
      observer.disconnect();
    } catch {
      // ignore — observers don't always clean up on stop
    }
    observer = null;
  }
  const out = entries;
  entries = [];
  return out;
};

/** Test-only — disconnect + clear the accumulator. */
export const _resetForTests = (): void => {
  if (observer) {
    try {
      observer.disconnect();
    } catch {
      // ignore
    }
    observer = null;
  }
  entries = [];
};
