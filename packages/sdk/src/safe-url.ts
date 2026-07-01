/**
 * Guard for URLs that came from outside the SDK — the host's `onExport` return
 * and the backend's `issueUrl` — before they reach an `<a href>` or
 * `window.open()`. A `javascript:` / `data:` / `vbscript:` value would execute in
 * the host page's context on click, so only `http:`/`https:` are allowed.
 * Relative URLs resolve against the current page and pass.
 */
export function isSafeUrl(value: string | undefined | null): value is string {
  if (!value) return false;
  try {
    const base = typeof location !== 'undefined' ? location.href : 'http://localhost/';
    const { protocol } = new URL(value, base);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}
