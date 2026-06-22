// VM2 — fetch a report's assets in parallel and assemble the ReportData model.
// Each slot is independently optional: a failed fetch/parse degrades that panel
// to empty and is recorded in `failed`, never failing the whole load.

import type {
  ConsoleEntry,
  NetworkEntryPayload,
  ResourceTimingEntry,
  RrwebEvent,
  StateSnapshot,
  StorageSnapshotPayload,
  SystemInfo,
  WebVitals,
} from '@bugzar/shared';
import { checkSchemaVersion } from './schema-version';
import type {
  AssetName,
  DesignElement,
  ReportData,
  ReportLoad,
  ReportMeta,
  ReportParams,
} from './types';

/**
 * The asset slots the viewer fetches per report — one canonical list, used by
 * `loadReport` and drift-guarded against the captured bundle's data slots
 * (`replay.html` is excluded: the viewer renders `events` itself).
 */
export const ASSET_NAMES: AssetName[] = [
  'meta',
  'events',
  'console',
  'network',
  'storage',
  'resources',
  'state',
  'vitals',
  'system',
  'design',
];

export async function loadReport(params: ReportParams): Promise<ReportLoad> {
  const base = `${params.endpoint}/reports/${params.id}`;
  const failed: AssetName[] = [];

  const fetchSlot = async (name: AssetName): Promise<unknown> => {
    try {
      const res = await fetch(`${base}/${name}.json`);
      if (!res.ok) {
        failed.push(name);
        return undefined;
      }
      return await res.json();
    } catch {
      failed.push(name);
      return undefined;
    }
  };

  const results = await Promise.all(ASSET_NAMES.map(fetchSlot));
  const byName = Object.fromEntries(ASSET_NAMES.map((n, i) => [n, results[i]])) as Record<
    AssetName,
    unknown
  >;

  const data: ReportData = {
    meta: (byName.meta as ReportMeta) ?? null,
    events: (byName.events as RrwebEvent[]) ?? [],
    console: (byName.console as ConsoleEntry[]) ?? [],
    network: (byName.network as NetworkEntryPayload[]) ?? [],
    storage: (byName.storage as StorageSnapshotPayload[]) ?? [],
    resources: (byName.resources as ResourceTimingEntry[]) ?? [],
    state: (byName.state as StateSnapshot[]) ?? [],
    vitals: (byName.vitals as WebVitals) ?? {},
    system: (byName.system as SystemInfo) ?? null,
    design: (byName.design as DesignElement[]) ?? [],
  };

  return { data, failed, version: checkSchemaVersion(data.meta?.schemaVersion) };
}
