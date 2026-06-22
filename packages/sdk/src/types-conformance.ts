// Drift guard — typecheck-only, NOT exported from index.ts → never bundled into
// dist or the published .d.ts. `public-types.ts` is a deliberate self-contained
// mirror of the canonical @bugzar/shared bundle shapes (so the published .d.ts
// references no private @bugzar/* package). These bidirectional-assignability
// assertions fail `tsc --noEmit` the moment the mirror drifts from the canonical
// types — e.g. when an M5/M6 field is added to one side but not the other.

// Canonical types come via @bugzar/capture-core (the SDK's dep), which re-exports
// them from the single source @bugzar/shared.
import type {
  ReportBundle as CanonBundle,
  ConsoleEntry as CanonConsole,
  RrwebEvent as CanonEvent,
  SessionMeta as CanonMeta,
  NetworkEntryPayload as CanonNetwork,
  StorageSnapshotPayload as CanonStorage,
  WebVitals as CanonVitals,
} from '@bugzar/capture-core';
import type {
  ReportBundle as PubBundle,
  ConsoleEntry as PubConsole,
  RrwebEvent as PubEvent,
  SessionMeta as PubMeta,
  NetworkEntryPayload as PubNetwork,
  StorageSnapshotPayload as PubStorage,
  WebVitals as PubVitals,
} from './public-types';

// Each entry forces canonical→public (slot 0) AND public→canonical (slot 1)
// assignability; a required field added/removed on either side breaks tsc.
export const _typeConformance = {
  bundle: (a: CanonBundle, b: PubBundle): [PubBundle, CanonBundle] => [a, b],
  meta: (a: CanonMeta, b: PubMeta): [PubMeta, CanonMeta] => [a, b],
  event: (a: CanonEvent, b: PubEvent): [PubEvent, CanonEvent] => [a, b],
  vitals: (a: CanonVitals, b: PubVitals): [PubVitals, CanonVitals] => [a, b],
  console: (a: CanonConsole, b: PubConsole): [PubConsole, CanonConsole] => [a, b],
  network: (a: CanonNetwork, b: PubNetwork): [PubNetwork, CanonNetwork] => [a, b],
  storage: (a: CanonStorage, b: PubStorage): [PubStorage, CanonStorage] => [a, b],
};
