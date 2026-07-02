import type {
  ConsoleEntry,
  NetworkEntryPayload,
  ReportBundle,
  RrwebEvent,
  SessionMeta,
  StateSnapshot,
  StorageSnapshotPayload,
  SystemInfo,
} from '@bugzar/shared';
import { sanitizeUrl } from '@bugzar/shared';
import { installConsolePatch, uninstallConsolePatch } from './console-patch';
import { installNetworkPatch, uninstallNetworkPatch } from './network-patch';
import { flushResourceTiming, installResourceTimingPatch } from './resource-timing-patch';
import { startRecording, stopRecording } from './rrweb-recorder';
import { flushStateSampler, installStateSampler } from './state-sampler';
import { installStorageSnapshot, uninstallStorageSnapshot } from './storage-snapshot';
import { collectSystemInfo } from './system-info';
import { flushVitals, installVitalsPatch } from './vitals-patch';

/**
 * Framework-agnostic capture orchestrator. This is the in-page, single-context
 * equivalent of the extension's `host/index.ts`: it installs the same DOM
 * patches but accumulates everything in memory and returns a `ReportBundle`
 * on stop instead of streaming batches over a postMessage bridge.
 *
 * Zero `chrome.*` — runs in any browser page (the SDK, a test harness, a host
 * web app). The extension keeps its own streaming wiring and consumes the
 * individual patch functions directly.
 */

export interface RecorderOptions {
  /**
   * Mask every text input. Default false — password/sensitive types are always
   * masked by rrweb regardless; this only opts into masking ordinary inputs.
   */
  maskAllInputs?: boolean;
  /** Capture `document.cookie` in storage snapshots. Default false (PII). */
  captureCookies?: boolean;
  /**
   * Inline images + stylesheets into the rrweb snapshot so the replay works
   * OFFLINE (for the self-contained HTML export). Default false — larger
   * captures; the hosted replay reloads assets over the network instead.
   */
  inlineAssets?: boolean;
  /**
   * Sample host app-state (e.g. a dehydrated TanStack cache) into the bundle's
   * `state` timeline at start + stop + throttle. Each snapshot is serialized and
   * redacted (see `serializeState`). Omit to capture no app-state.
   */
  captureState?: () => unknown;
  /** Host redaction applied to each state snapshot (after the built-in masking). */
  redactState?: (state: unknown) => unknown;
  /** State sampling interval while recording (ms). Default 2000. */
  stateThrottleMs?: number;
}

export interface Recorder {
  start(): void;
  stop(): ReportBundle;
  isActive(): boolean;
}

const readMeta = (startedAt: number, endedAt: number): SessionMeta => ({
  // #5: strip credential query/fragment params from the captured page URL.
  url: typeof location !== 'undefined' ? sanitizeUrl(location.href) : '',
  userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
  viewport: {
    width: typeof window !== 'undefined' ? window.innerWidth : 0,
    height: typeof window !== 'undefined' ? window.innerHeight : 0,
  },
  startedAt,
  endedAt,
  durationMs: Math.max(0, endedAt - startedAt),
});

export function createRecorder(options: RecorderOptions = {}): Recorder {
  const {
    maskAllInputs = false,
    captureCookies = false,
    inlineAssets = false,
    captureState,
    redactState,
    stateThrottleMs = 2000,
  } = options;

  let active = false;
  let startedAt = 0;
  let events: RrwebEvent[] = [];
  let consoleEntries: ConsoleEntry[] = [];
  let networkEntries: NetworkEntryPayload[] = [];
  let storageSnapshots: StorageSnapshotPayload[] = [];
  let stateSnapshots: StateSnapshot[] = [];
  // Device/browser snapshot — taken once at start (it's static for the session).
  let system: SystemInfo | null = null;

  const start = (): void => {
    if (active) return;
    active = true;
    startedAt = Date.now();
    events = [];
    consoleEntries = [];
    networkEntries = [];
    storageSnapshots = [];
    stateSnapshots = [];
    system = collectSystemInfo();

    startRecording({
      batchIntervalMs: 1000,
      maskAllInputs,
      inlineImages: inlineAssets,
      onBatch: (batch) => {
        for (const e of batch) events.push(e);
      },
    });
    installConsolePatch({ sessionStart: startedAt, onEntry: (e) => consoleEntries.push(e) });
    installNetworkPatch({ sessionStart: startedAt, onEntry: (e) => networkEntries.push(e) });
    installStorageSnapshot({
      sessionStart: startedAt,
      captureCookies,
      onSnapshot: (s) => storageSnapshots.push(s),
    });
    installVitalsPatch();
    installResourceTimingPatch();
    if (captureState) {
      installStateSampler({
        sessionStart: startedAt,
        captureState,
        throttleMs: stateThrottleMs,
        onSnapshot: (s) => stateSnapshots.push(s),
        ...(redactState ? { redactState } : {}),
      });
    }
  };

  const stop = (): ReportBundle => {
    const endedAt = Date.now();
    if (!active) {
      // Stop without an active session: hand back whatever we have (possibly
      // empty) rather than throwing, so callers can treat stop() as total.
      return {
        events,
        console: consoleEntries,
        network: networkEntries,
        storage: storageSnapshots,
        vitals: {},
        resources: [],
        state: stateSnapshots,
        system: system ?? collectSystemInfo(),
        meta: readMeta(startedAt || endedAt, endedAt),
      };
    }
    active = false;

    stopRecording(); // flushes the trailing rrweb batch through onBatch
    uninstallConsolePatch();
    uninstallNetworkPatch();
    uninstallStorageSnapshot(startedAt, (s) => storageSnapshots.push(s)); // final snapshot
    const vitals = flushVitals();
    const resources = flushResourceTiming();
    flushStateSampler(); // final state sample + stop the sampling timer

    return {
      events,
      console: consoleEntries,
      network: networkEntries,
      storage: storageSnapshots,
      vitals,
      resources,
      state: stateSnapshots,
      system: system ?? collectSystemInfo(),
      meta: readMeta(startedAt, endedAt),
    };
  };

  return { start, stop, isActive: () => active };
}
