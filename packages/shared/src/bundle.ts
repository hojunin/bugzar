// Canonical capture-bundle types — the SINGLE source of truth for the shape a
// recording produces. `@bugzar/capture-core` (the producer) and the SDK both
// derive from these so a new field (resources, state, …) lands in ONE place.
//
// Events are the opaque `RrwebEvent` (not rrweb's `eventWithTime`) so the
// published SDK `.d.ts` can mirror these without pulling in `@rrweb/types`.
// The SDK's `public-types.ts` is a deliberate self-contained mirror of these
// shapes, guarded against drift by a typecheck-only conformance assertion.

import type { ConsoleEntry, NetworkEntryPayload, StorageSnapshotPayload } from './messages';

/**
 * Capture-schema version — the single contract anchor shared by the producer
 * (the SDK stamps it into the uploaded `meta.json` as `schemaVersion`) and the
 * consumer (`@bugzar/viewer` checks it before rendering). Bump on a breaking change
 * to any captured asset shape so an old viewer refuses a newer report instead of
 * mis-rendering it.
 */
export const SCHEMA_VERSION = 1;

/**
 * An rrweb event. Opaque on purpose — a bundle is serialized and replayed with
 * `rrweb-player`; see the `rrweb` package for the full event union.
 */
export type RrwebEvent = {
  type: number;
  timestamp: number;
  data: unknown;
};

export interface WebVitals {
  /** Largest Contentful Paint (ms). */
  lcp?: number;
  /** Cumulative Layout Shift. */
  cls?: number;
  /** Interaction to Next Paint (ms). */
  inp?: number;
  /** Time to First Byte (ms). */
  ttfb?: number;
}

export interface SessionMeta {
  url: string;
  userAgent: string;
  viewport: { width: number; height: number };
  startedAt: number;
  endedAt: number;
  durationMs: number;
}

/**
 * Device / browser / environment snapshot taken once at recording start —
 * everything a triager wants to answer "what was the user on?" without guessing
 * from the UA string alone. Captured store-only (additive; never replayed).
 * Non-standard fields (UA-CH, Network Information, deviceMemory) are optional
 * because they're Chromium-only or behind permissions.
 */
export interface SystemInfo {
  /** Epoch ms when this snapshot was taken. */
  collectedAt: number;
  browser: {
    userAgent: string;
    /** navigator.userAgentData brands (Chromium UA Client Hints). */
    brands?: Array<{ brand: string; version: string }>;
    /** UA-CH platform ('macOS', 'Windows', …), Chromium only. */
    platform?: string;
    /** UA-CH mobile flag. */
    mobile?: boolean;
    vendor?: string;
    language: string;
    languages: string[];
    cookieEnabled: boolean;
    /** navigator.doNotTrack ('1' | '0' | null). */
    doNotTrack: string | null;
    /** Logical CPU cores (navigator.hardwareConcurrency). */
    hardwareConcurrency?: number;
    /** Approx RAM in GiB (navigator.deviceMemory), Chromium only. */
    deviceMemory?: number;
    maxTouchPoints?: number;
    online: boolean;
  };
  screen: {
    width: number;
    height: number;
    availWidth: number;
    availHeight: number;
    colorDepth: number;
    pixelDepth: number;
    devicePixelRatio: number;
    /** screen.orientation.type ('landscape-primary', …). */
    orientation?: string;
  };
  viewport: { width: number; height: number };
  /** navigator.connection (Network Information API), Chromium only. */
  connection?: {
    effectiveType?: string;
    /** Mbps. */
    downlink?: number;
    /** Round-trip estimate (ms). */
    rtt?: number;
    saveData?: boolean;
    type?: string;
  };
  locale: {
    /** IANA zone, e.g. 'Asia/Seoul'. */
    timeZone: string;
    /** Minutes behind UTC (Date.prototype.getTimezoneOffset). */
    timezoneOffsetMin: number;
    /** Resolved Intl locale, e.g. 'ko-KR'. */
    locale: string;
  };
  page: {
    url: string;
    referrer: string;
    title: string;
    prefersColorScheme: 'dark' | 'light' | 'no-preference';
    prefersReducedMotion: boolean;
  };
}

/**
 * One `PerformanceResourceTiming` entry (M5), captured store-only. Fields are
 * copied verbatim from the browser — a cross-origin resource without
 * `Timing-Allow-Origin` already arrives with sizes zeroed and protocol blank,
 * so no special-casing is needed here.
 */
export interface ResourceTimingEntry {
  /** Resource URL (`PerformanceEntry.name`). */
  name: string;
  /** 'fetch' | 'xmlhttprequest' | 'img' | 'script' | 'css' | 'link' | 'navigation' | … */
  initiatorType: string;
  /** ms from `timeOrigin`. */
  startTime: number;
  duration: number;
  /** 0 when the server omits `Timing-Allow-Origin` (cross-origin). */
  transferSize: number;
  encodedBodySize: number;
  decodedBodySize: number;
  /** '' when cross-origin without TAO. */
  nextHopProtocol: string;
  /** Chromium only — HTTP status; absent elsewhere. */
  responseStatus?: number;
  /** Cache signal: 'cache' | 'navigational-prefetch' | ''. Absent in Firefox. */
  deliveryType?: string;
  /** Server-Timing entries, when exposed. */
  serverTiming?: Array<{ name: string; duration: number; description: string }>;
}

/**
 * One host app-state snapshot (M6), correlated to the rrweb timeline. `data` is
 * already serialized (structured-clone-safe) and redacted — see `serializeState`.
 */
export interface StateSnapshot {
  /** ms from recording start (correlates with rrweb/console/network/resources). */
  tFromStart: number;
  /** The serialized + redacted host state at this instant. */
  data: unknown;
}

/** Everything captured in one recording session. */
export interface ReportBundle {
  events: RrwebEvent[];
  console: ConsoleEntry[];
  network: NetworkEntryPayload[];
  storage: StorageSnapshotPayload[];
  vitals: WebVitals;
  /** Resource Timing waterfall (M5; additive, store-only). */
  resources: ResourceTimingEntry[];
  /** Host app-state timeline (M6; additive, store-only). */
  state: StateSnapshot[];
  /** Device/browser/environment snapshot (additive, store-only). */
  system: SystemInfo;
  meta: SessionMeta;
}
