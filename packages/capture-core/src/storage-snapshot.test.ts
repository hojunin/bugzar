// @vitest-environment happy-dom
/**
 * §5.3: the "쿠키 캡처" Options-page toggle threads through to
 * `installStorageSnapshot({ captureCookies })`. Previously the snapshot
 * always read `document.cookie`; now it must respect the flag so users who
 * opt out get empty `cookies` in every payload. localStorage / sessionStorage
 * are always captured regardless — the toggle is cookie-specific.
 */

import type { StorageSnapshotPayload } from '@bugzar/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installStorageSnapshot, uninstallStorageSnapshot } from './storage-snapshot';

describe('installStorageSnapshot — captureCookies flag', () => {
  beforeEach(() => {
    // happy-dom keeps state between tests by default — wipe it.
    localStorage.clear();
    sessionStorage.clear();
    // biome-ignore lint/suspicious/noDocumentCookie: test fixture seeds a cookie to exercise capture
    document.cookie = 'test=1; path=/';
    localStorage.setItem('saved-key', 'value');
    sessionStorage.setItem('session-key', 'sess-value');
  });

  afterEach(() => {
    // Make sure no timer from a prior test bleeds in.
    uninstallStorageSnapshot(0);
    localStorage.clear();
    sessionStorage.clear();
  });

  it('omits cookies when captureCookies is false (default)', () => {
    const snapshots: StorageSnapshotPayload[] = [];
    installStorageSnapshot({
      sessionStart: Date.now(),
      onSnapshot: (snap) => snapshots.push(snap),
    });
    uninstallStorageSnapshot(Date.now(), (snap) => snapshots.push(snap));
    expect(snapshots.length).toBeGreaterThan(0);
    for (const snap of snapshots) {
      expect(snap.cookies).toBe('');
      // localStorage / sessionStorage still captured.
      expect(snap.localStorage['saved-key']).toBe('value');
      expect(snap.sessionStorage['session-key']).toBe('sess-value');
    }
  });

  it('includes document.cookie when captureCookies is true', () => {
    const snapshots: StorageSnapshotPayload[] = [];
    installStorageSnapshot({
      sessionStart: Date.now(),
      captureCookies: true,
      onSnapshot: (snap) => snapshots.push(snap),
    });
    uninstallStorageSnapshot(Date.now(), (snap) => snapshots.push(snap));
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots[0]?.cookies).toContain('test=1');
  });

  it('resets the flag between sessions — captureCookies does not leak', () => {
    // First session with cookies on.
    let snapshots: StorageSnapshotPayload[] = [];
    installStorageSnapshot({
      sessionStart: 1,
      captureCookies: true,
      onSnapshot: (snap) => snapshots.push(snap),
    });
    uninstallStorageSnapshot(1, (snap) => snapshots.push(snap));
    expect(snapshots[0]?.cookies).toContain('test=1');

    // Second session with cookies off — must not inherit the prior flag.
    snapshots = [];
    installStorageSnapshot({
      sessionStart: 2,
      onSnapshot: (snap) => snapshots.push(snap),
    });
    uninstallStorageSnapshot(2, (snap) => snapshots.push(snap));
    for (const snap of snapshots) {
      expect(snap.cookies).toBe('');
    }
  });
});

// S-1: storage values often hold auth tokens (Supabase/Firebase/Auth0 stash JWTs
// in localStorage). The snapshot must redact them so they never reach the
// public-by-URL replay.
describe('installStorageSnapshot — value redaction', () => {
  const JWT =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => {
    uninstallStorageSnapshot(0);
    localStorage.clear();
    sessionStorage.clear();
  });

  it('redacts sensitive keys and token-shaped values, keeps benign ones', () => {
    localStorage.setItem(
      'sb-ref-auth-token',
      JSON.stringify({ access_token: JWT, refresh_token: 'r' }),
    );
    localStorage.setItem('theme', 'dark');
    sessionStorage.setItem('cache', JWT);

    const snapshots: StorageSnapshotPayload[] = [];
    installStorageSnapshot({ sessionStart: Date.now(), onSnapshot: (s) => snapshots.push(s) });
    uninstallStorageSnapshot(Date.now(), (s) => snapshots.push(s));

    const snap = snapshots[0]!;
    expect(snap.localStorage['sb-ref-auth-token']).toBe('[REDACTED]'); // key matches "token"
    expect(snap.localStorage.theme).toBe('dark'); // benign
    expect(snap.sessionStorage.cache).toBe('[REDACTED]'); // bare JWT value
    // Belt-and-suspenders: the raw token never appears anywhere in the payload.
    expect(JSON.stringify(snap)).not.toContain(JWT);
  });
});
