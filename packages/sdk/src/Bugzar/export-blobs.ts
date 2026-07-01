import type { DesignAnnotation, ReportBundle, RrwebEvent, SystemInfo } from '../public-types';

// Lazy-load the heavy export module only when an offline HTML is built, so the
// ~478 KB inlined viewer never enters the core bundle. Runtime stays a bare
// specifier (external, lazy chunk); `as string` suppresses module resolution
// and the cast pulls the type from local source, so the build never depends on
// the prebuilt dist .d.ts.
const loadExport = async (): Promise<typeof import('../export')> =>
  (await import('@bugzar/sdk/export' as string)) as typeof import('../export');

export const buildReplayBlob = async (bundle: ReportBundle): Promise<Blob> =>
  (await loadExport()).exportReportHtml(bundle);

export const buildDesignBlob = (
  annotations: DesignAnnotation[],
  events: RrwebEvent[],
  system: SystemInfo | null,
): Promise<Blob> => loadExport().then((m) => m.exportDesignHtml(annotations, events, system));
