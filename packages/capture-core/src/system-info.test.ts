import { describe, expect, it } from 'vitest';
import { collectSystemInfo } from './system-info';

describe('collectSystemInfo', () => {
  it('returns a well-formed snapshot from the environment', () => {
    const s = collectSystemInfo();
    expect(typeof s.collectedAt).toBe('number');
    expect(typeof s.browser.userAgent).toBe('string');
    expect(Array.isArray(s.browser.languages)).toBe(true);
    expect(typeof s.browser.online).toBe('boolean');
    expect(typeof s.screen.devicePixelRatio).toBe('number');
    expect(typeof s.viewport.width).toBe('number');
    expect(typeof s.locale.timezoneOffsetMin).toBe('number');
    expect(s.page.prefersColorScheme).toMatch(/^(dark|light|no-preference)$/);
  });
});
