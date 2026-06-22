// @vitest-environment happy-dom
/**
 * ⑤ Motion & polish — a11y floor.
 *
 * The widget's transitions/animations must be disabled under
 * `prefers-reduced-motion: reduce`. The injected stylesheet has no such block
 * today, so this is RED until the motion-design pass adds it.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { injectStyles } from '../styles';

afterEach(() => {
  document.getElementById('bugzar-styles')?.remove();
});

describe('styles — motion (⑤)', () => {
  it('honors prefers-reduced-motion (disables non-essential motion)', () => {
    injectStyles();
    const style = document.getElementById('bugzar-styles');
    expect(style).toBeTruthy();
    expect(style?.textContent).toMatch(/prefers-reduced-motion/);
  });
});
