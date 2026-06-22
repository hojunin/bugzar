const LAST_EPIC_KEY = 'bugzar:last-epic';

/** The epic last published to — prefilled next time (a convenience for repeated
 *  reports to the same epic). Skipped silently if storage is unavailable. */
export function loadLastEpic(): { key: string; summary: string } | null {
  try {
    const raw = localStorage.getItem(LAST_EPIC_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { key?: string; summary?: string };
    return v?.key ? { key: v.key, summary: v.summary ?? v.key } : null;
  } catch {
    return null;
  }
}

export function saveLastEpic(key: string, summary: string): void {
  try {
    localStorage.setItem(LAST_EPIC_KEY, JSON.stringify({ key, summary }));
  } catch {
    // private mode / storage disabled — prefill just won't persist
  }
}
