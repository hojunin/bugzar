// Public type surface for @bugzar/sdk.
//
// Self-contained ON PURPOSE: the published .d.ts must not reference the private
// @bugzar/* workspace packages (they are bundled into dist, not published). These
// mirror the canonical shapes in @bugzar/capture-core / @bugzar/shared and are kept
// structurally compatible, so the internal recorder's bundle assigns to them
// with no cast. If a capture payload shape changes upstream, update it here too.

/**
 * An rrweb event. Opaque here — a bundle is meant to be serialized and replayed
 * with `rrweb-player`. See the `rrweb` package for the full event union.
 */
export type RrwebEvent = {
  type: number;
  timestamp: number;
  data: unknown;
};

export type ConsoleEntry = {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug' | 'group' | 'groupCollapsed' | 'groupEnd';
  tFromStart: number;
  /** Pre-stringified for transport. */
  args: string[];
  stack?: string;
};

export type NetworkEntryPayload = {
  tFromStart: number;
  method: string;
  url: string;
  status: number | null;
  durationMs: number | null;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  responseHeaders: Record<string, string>;
  responseBody: string | null;
  error: string | null;
  initiator: 'fetch' | 'xhr';
};

export type StorageSnapshotPayload = {
  tFromStart: number;
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  cookies: string;
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

/** Meta handed to `onExport` — session meta plus which capture produced it. */
export type ExportMeta = SessionMeta & { mode: 'session' | 'design' };

/** Device/browser/environment snapshot taken once at recording start. */
export interface SystemInfo {
  collectedAt: number;
  browser: {
    userAgent: string;
    brands?: Array<{ brand: string; version: string }>;
    platform?: string;
    mobile?: boolean;
    vendor?: string;
    language: string;
    languages: string[];
    cookieEnabled: boolean;
    doNotTrack: string | null;
    hardwareConcurrency?: number;
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
    orientation?: string;
  };
  viewport: { width: number; height: number };
  connection?: {
    effectiveType?: string;
    downlink?: number;
    rtt?: number;
    saveData?: boolean;
    type?: string;
  };
  locale: {
    timeZone: string;
    timezoneOffsetMin: number;
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

/** One element picked in design mode, with the reviewer's note. */
export interface DesignAnnotation {
  id: string;
  /** A unique CSS selector for the element (so an agent can grep/find it). */
  selector: string;
  tagName: string;
  /** Trimmed visible text (capped). */
  textContent: string;
  /** The element's class attribute, verbatim. */
  cssClasses: string;
  /** Document-absolute bounds at pick time (includes scroll offset). */
  rect: { x: number; y: number; width: number; height: number };
  /** React component name, when detectable via the fiber tree. */
  componentName?: string;
  /**
   * Identifying attributes (id, data-*, aria-label, role, type, href, …) — the
   * breadcrumbs an AI/dev needs to locate this element in the source.
   */
  attributes?: Record<string, string>;
  /** Optional Figma frame/link the reviewer pasted for this element. */
  figmaUrl?: string;
  /** The reviewer's note for this element. */
  note: string;
}

/** One PerformanceResourceTiming entry, captured store-only (M5). */
export interface ResourceTimingEntry {
  name: string;
  initiatorType: string;
  startTime: number;
  duration: number;
  /** 0 when the server omits Timing-Allow-Origin (cross-origin). */
  transferSize: number;
  encodedBodySize: number;
  decodedBodySize: number;
  /** '' when cross-origin without TAO. */
  nextHopProtocol: string;
  /** Chromium only — HTTP status; absent elsewhere. */
  responseStatus?: number;
  /** Cache signal: 'cache' | 'navigational-prefetch' | ''. Absent in Firefox. */
  deliveryType?: string;
  serverTiming?: Array<{ name: string; duration: number; description: string }>;
}

/** One host app-state snapshot, correlated to the rrweb timeline (M6). */
export interface StateSnapshot {
  /** ms from recording start. */
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

/** Jira review-drawer configuration. Requires a configured `endpoint` (Worker). */
export interface JiraConfig {
  /**
   * Atlassian OAuth app client id (public — NOT the secret, which stays in the
   * Worker). When set, the drawer uses per-user OAuth: each reviewer connects
   * their own Atlassian account and the ticket is filed as them.
   */
  clientId?: string;
  /** Legacy service-account flow (Worker files via JIRA_API_TOKEN). Ignored when `clientId` is set. */
  enabled?: boolean;
  /** Optional Epic key to pre-select in the drawer. */
  defaultEpicKey?: string;
}

/** Result of a publish attempt, passed to `onPublished`. */
export interface PublishResult {
  issueKey: string;
  issueUrl: string;
  /**
   * `true` when the Worker is unconfigured and returned a `STUB-` placeholder —
   * this is NOT a real Jira issue. The drawer surfaces it as not-real (never a
   * clickable link), and hosts must not treat it as a filed bug.
   */
  stubbed: boolean;
}
