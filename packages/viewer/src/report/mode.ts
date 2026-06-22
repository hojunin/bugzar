// Decide whether a loaded report is a recorded session (rrweb + data panels) or
// a design-feedback report (Pick/click annotations). Drives the App's top-level
// view choice. Pure.

import type { ReportData, ReportMode } from './types';

/**
 * `design` when the SDK stamped `meta.mode === 'design'`, or (fallback) when there
 * are annotations but no rrweb events. `session` otherwise.
 */
export function reportMode(data: ReportData): ReportMode {
  if (data.meta?.mode === 'design') return 'design';
  if (data.design.length > 0 && data.events.length === 0) return 'design';
  return 'session';
}
