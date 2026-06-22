// Pure timeline math — maps the rrweb-player playhead (ms from start) onto the
// `tFromStart` / `startTime` carried by every captured entry. No DOM, no React.

/** Anything correlated to the recording start. */
export interface Timed {
  tFromStart: number;
}

/** Index of the last entry whose `tFromStart <= t`; -1 if none has happened yet. */
export function activeIndex(entries: Timed[], t: number): number {
  let idx = -1;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e && e.tFromStart <= t) idx = i;
  }
  return idx;
}

/** True when the entry has not happened yet at playhead `t` (dimmed in the UI). */
export function isFuture(entry: Timed, t: number): boolean {
  return entry.tFromStart > t;
}

/** The snapshot in effect at playhead `t` = the last one at/just-before `t`. */
export function snapshotAt<T extends Timed>(snaps: T[], t: number): T | null {
  let found: T | null = null;
  for (const s of snaps) {
    if (s.tFromStart <= t) found = s;
  }
  return found;
}

/** Waterfall bar geometry for a resource, scaled into `width` px. */
export function barGeometry(
  entry: { startTime: number; duration: number },
  scale: { min: number; max: number; width: number },
): { x: number; width: number } {
  const span = scale.max - scale.min || 1;
  return {
    x: ((entry.startTime - scale.min) / span) * scale.width,
    width: (entry.duration / span) * scale.width,
  };
}
