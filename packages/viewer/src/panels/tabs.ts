// Which sidebar tabs to show for a report, with counts. The State tab (M6) is
// conditional — it appears ONLY when state was captured (opt-in via the host's
// `captureState`), so a report without it shows no empty State tab.

import type { ReportData } from '../report/types';

export type TabKey = 'repro' | 'console' | 'network' | 'storage' | 'resources' | 'state' | 'system';

export interface Tab {
  key: TabKey;
  label: string;
  /** Omitted for non-countable tabs (e.g. System Info) — no badge is shown. */
  count?: number;
}

/**
 * Core tabs always; `state` only when `report.state` is non-empty. System Info
 * is always last — it derives from `meta` even when no `system` asset exists.
 */
export function visibleTabs(report: ReportData): Tab[] {
  const tabs: Tab[] = [
    { key: 'console', label: 'Console', count: report.console.length },
    { key: 'network', label: 'Network', count: report.network.length },
    // Storage tab hidden per request — uncomment to restore.
    // { key: 'storage', label: 'Storage', count: report.storage.length },
    { key: 'resources', label: 'Resources', count: report.resources.length },
  ];
  if (report.state.length > 0) {
    tabs.push({ key: 'state', label: 'State', count: report.state.length });
  }
  tabs.push({ key: 'system', label: 'System Info' });
  return tabs;
}
