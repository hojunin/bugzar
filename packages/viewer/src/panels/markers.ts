// VM10 — scrubber error markers + jump-to-error. Pure: derives "notable moment"
// times from a report so the player scrubber can tick them and prev/next-error
// navigation can seek between them. No DOM, no React.

import type { ReportData } from '../report/types';

export interface ErrorMarker {
  /** ms from recording start. */
  t: number;
  kind: 'console' | 'network';
}

/** Console errors + failed requests (`status>=400` or transport error), time-sorted. */
export function errorMarkers(report: ReportData): ErrorMarker[] {
  const markers: ErrorMarker[] = [];
  for (const c of report.console) {
    if (c.level === 'error') markers.push({ t: c.tFromStart, kind: 'console' });
  }
  for (const n of report.network) {
    if ((n.status != null && n.status >= 400) || n.error != null) {
      markers.push({ t: n.tFromStart, kind: 'network' });
    }
  }
  return markers.sort((a, b) => a.t - b.t);
}

/** First marker strictly after `t`, or null past the last. */
export function nextErrorTime(markers: ErrorMarker[], t: number): number | null {
  for (const m of markers) {
    if (m.t > t) return m.t;
  }
  return null;
}

/** Last marker strictly before `t`, or null before the first. */
export function prevErrorTime(markers: ErrorMarker[], t: number): number | null {
  let prev: number | null = null;
  for (const m of markers) {
    if (m.t < t) prev = m.t;
  }
  return prev;
}
