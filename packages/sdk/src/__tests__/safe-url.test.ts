import { describe, expect, it } from 'vitest';
import { isSafeUrl } from '../safe-url';

// #52 — host onExport / backend issueUrl feed <a href> and window.open. Only
// http(s) may pass; a javascript:/data: value would execute in the host page.
describe('isSafeUrl (#52)', () => {
  it('allows http and https', () => {
    expect(isSafeUrl('https://example.com/r/abc')).toBe(true);
    expect(isSafeUrl('http://localhost:3000/report')).toBe(true);
  });

  it('allows relative URLs (resolved against the page)', () => {
    expect(isSafeUrl('/r/abc')).toBe(true);
    expect(isSafeUrl('report.html')).toBe(true);
  });

  it('rejects script-executing schemes', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeUrl('JavaScript:alert(1)')).toBe(false);
    expect(isSafeUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isSafeUrl('vbscript:msgbox(1)')).toBe(false);
  });

  it('rejects non-web schemes', () => {
    expect(isSafeUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeUrl('mailto:a@b.com')).toBe(false);
    expect(isSafeUrl('tel:+123')).toBe(false);
  });

  it('rejects empty / nullish', () => {
    expect(isSafeUrl(undefined)).toBe(false);
    expect(isSafeUrl(null)).toBe(false);
    expect(isSafeUrl('')).toBe(false);
  });
});
