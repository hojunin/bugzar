// The viewer's internal report model. Built from the canonical `@bugzar/shared`
// capture types — the viewer never re-declares a payload shape.

import type {
  ConsoleEntry,
  NetworkEntryPayload,
  ResourceTimingEntry,
  RrwebEvent,
  SessionMeta,
  StateSnapshot,
  StorageSnapshotPayload,
  SystemInfo,
  WebVitals,
} from '@bugzar/shared';

/** The report asset slots the viewer fetches (one JSON each). */
export type AssetName =
  | 'meta'
  | 'events'
  | 'console'
  | 'network'
  | 'storage'
  | 'resources'
  | 'state'
  | 'vitals'
  | 'system'
  | 'design';

/**
 * One element annotated in the SDK's design (Pick/click) mode, as stored in
 * `design.json`. Mirrors the SDK's uploaded shape — note the backend-facing
 * `userNote` field (the SDK maps its `note` → `userNote` on upload).
 */
export interface DesignElement {
  selector: string;
  tagName: string;
  textContent: string;
  cssClasses: string;
  rect: { x: number; y: number; width: number; height: number };
  componentName?: string;
  /** Identifying attributes (id, data-*, aria-label, …) for locating it in code. */
  attributes?: Record<string, string>;
  /** Figma frame/link the reviewer attached. */
  figmaUrl?: string;
  userNote: string;
}

/** A report is either a recorded session or a design-feedback (annotations) report. */
export type ReportMode = 'session' | 'design';

/** Normalized URL params — `endpoint` has no trailing slash. */
export interface ReportParams {
  endpoint: string;
  id: string;
}

/** Returned by `parseReportParams` when the required `id` is absent. */
export type ParamsError = { error: 'missing-id' };

/** Meta as uploaded by the SDK: `SessionMeta` + the stamped contract version. */
export type ReportMeta = SessionMeta & {
  schemaVersion?: number;
  mode?: string;
  source?: string;
};

/** Schema-compatibility verdict of a loaded report vs. this viewer. */
export type VersionStatus = 'ok' | 'older' | 'newer' | 'unknown';

/** All of a report's data, after loading. Missing slots default to empty. */
export interface ReportData {
  meta: ReportMeta | null;
  events: RrwebEvent[];
  console: ConsoleEntry[];
  network: NetworkEntryPayload[];
  storage: StorageSnapshotPayload[];
  resources: ResourceTimingEntry[];
  state: StateSnapshot[];
  vitals: WebVitals;
  /** Device/browser snapshot — null when the report predates System Info capture. */
  system: SystemInfo | null;
  /** Design-mode annotations (empty for a session report). */
  design: DesignElement[];
}

/** Result of `loadReport` — data + which slots failed + version verdict. */
export interface ReportLoad {
  data: ReportData;
  failed: AssetName[];
  version: VersionStatus;
}
