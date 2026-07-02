/**
 * Guard for URLs that came from outside the SDK — the host's `onExport` return,
 * the backend's `issueUrl`, and design-annotation `figmaUrl` — before they reach
 * an `<a href>` or `window.open()`. A `javascript:` / `data:` / `vbscript:` value
 * would execute in the page's context on click, so only `http:`/`https:` are
 * allowed. Relative URLs resolve against the current page and pass. Parsing via
 * `new URL()` (not string-prefix matching) resists entity/whitespace bypasses.
 *
 * Lives in `@bugzar/shared` so both `@bugzar/sdk` (review-drawer sinks, picker)
 * and `@bugzar/viewer` (design replay href) share one implementation — no drift.
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
