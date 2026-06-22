// =============================================================================
// @bugzar/sdk
// =============================================================================
//
// Embeddable in-app QA session recorder for React frontends.
//
//   import { Bugzar } from '@bugzar/sdk';
//   <Bugzar onSubmit={(bundle) => sendToYourBackend(bundle)} />
//
// =============================================================================

export type { BugzarProps } from './Bugzar';
export { Bugzar } from './Bugzar';
export type { PickerHandle, PickerOptions } from './picker/picker';
// Programmatic design picker (also driven by the toolbar "Pick" button).
export { startDesignPick } from './picker/picker';
// Bundle/data types live locally so the published .d.ts is self-contained
// (no reference to the private @bugzar/* packages bundled into dist).
export type {
  ConsoleEntry,
  DesignAnnotation,
  ExportMeta,
  JiraConfig,
  NetworkEntryPayload,
  PublishResult,
  ReportBundle,
  ResourceTimingEntry,
  RrwebEvent,
  SessionMeta,
  StateSnapshot,
  StorageSnapshotPayload,
  SystemInfo,
  WebVitals,
} from './public-types';
export type { Endpoint } from './upload';
export type { BugzarControls, UseBugzarOptions } from './use-bugzar';
// Headless engine — drive recording from your own UI (no FAB).
export { useBugzar } from './use-bugzar';
