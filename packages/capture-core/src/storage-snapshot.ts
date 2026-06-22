import { redactFreeText, type StorageSnapshotPayload, sanitizeStorageValue } from '@bugzar/shared';

/**
 * Captures localStorage, sessionStorage, and document.cookie.
 *
 * Strategy:
 *  - Take one snapshot at start
 *  - Take another every 2s
 *  - Take a final snapshot at stop
 *
 * For M1+ we just snapshot full state. Diff-based capture is a future
 * optimization (negligible cost for small storage; worth it for sites
 * that stash megabytes in localStorage).
 */

const SNAPSHOT_INTERVAL_MS = 2000;

type Options = {
  sessionStart: number;
  onSnapshot: (snap: StorageSnapshotPayload) => void;
  /**
   * When false (default) we omit `document.cookie` from the snapshot —
   * cookies often carry auth/session ids that are PII for QA replays.
   * Threaded from the SW (Options page "쿠키 캡처" toggle, §5.3).
   */
  captureCookies?: boolean;
};

let timer: ReturnType<typeof setInterval> | null = null;
let active = false;
let captureCookiesFlag = false;

const snapshotOnce = (sessionStart: number): StorageSnapshotPayload => {
  // Values are redacted at capture time (sensitive key / bare JWT / JSON token
  // leaves) so auth tokens stashed in storage never reach the public replay.
  const localStorageEntries: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key != null)
        localStorageEntries[key] = sanitizeStorageValue(key, localStorage.getItem(key) ?? '');
    }
  } catch {
    // SecurityError on some origins (e.g., sandboxed iframes)
  }

  const sessionStorageEntries: Record<string, string> = {};
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key != null)
        sessionStorageEntries[key] = sanitizeStorageValue(key, sessionStorage.getItem(key) ?? '');
    }
  } catch {
    // SecurityError
  }

  let cookies = '';
  if (captureCookiesFlag) {
    try {
      cookies = redactFreeText(document.cookie);
    } catch {
      cookies = '';
    }
  }

  return {
    tFromStart: Date.now() - sessionStart,
    localStorage: localStorageEntries,
    sessionStorage: sessionStorageEntries,
    cookies,
  };
};

export const installStorageSnapshot = ({
  sessionStart,
  onSnapshot,
  captureCookies = false,
}: Options): void => {
  if (active) return;
  active = true;
  captureCookiesFlag = captureCookies;
  // Initial
  onSnapshot(snapshotOnce(sessionStart));
  timer = setInterval(() => {
    onSnapshot(snapshotOnce(sessionStart));
  }, SNAPSHOT_INTERVAL_MS);
};

export const uninstallStorageSnapshot = (
  sessionStart: number,
  onSnapshot?: (snap: StorageSnapshotPayload) => void,
): void => {
  if (!active) return;
  active = false;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  // Final snapshot for the moment we stopped — useful for "ended state"
  if (onSnapshot) onSnapshot(snapshotOnce(sessionStart));
  // Reset so the next start defaults clean if no flag is passed.
  captureCookiesFlag = false;
};
