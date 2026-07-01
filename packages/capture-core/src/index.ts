// =============================================================================
// @bugzar/capture-core
// =============================================================================
//
// Framework-agnostic, zero-`chrome.*` capture engine extracted from the
// extension's MAIN-world host script. Consumed by both the Chrome extension
// (via the low-level patch functions) and the embeddable SDK (via the
// high-level `createRecorder()` orchestrator).
//
// =============================================================================

// Canonical bundle + payload types (single source of truth in @bugzar/shared)
export type {
  ConsoleEntry,
  NetworkEntryPayload,
  ReportBundle,
  ResourceTimingEntry,
  RrwebEvent,
  SessionMeta,
  StateSnapshot,
  StorageSnapshotPayload,
  SystemInfo,
  WebVitals,
} from '@bugzar/shared';
export { installConsolePatch, uninstallConsolePatch } from './console-patch';
export { installNetworkPatch, uninstallNetworkPatch } from './network-patch';
export type { Recorder, RecorderOptions } from './recorder';
// High-level orchestrator (SDK entry point)
export { createRecorder } from './recorder';
export { flushResourceTiming, installResourceTimingPatch } from './resource-timing-patch';
// Low-level patch functions (extension host wiring)
export { captureSnapshot, startRecording, stopRecording } from './rrweb-recorder';
export { flushStateSampler, installStateSampler } from './state-sampler';
export { installStorageSnapshot, uninstallStorageSnapshot } from './storage-snapshot';
export { collectSystemInfo } from './system-info';
export { flushVitals, installVitalsPatch } from './vitals-patch';
