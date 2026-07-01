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

describe('styles — pointer events under a host modal', () => {
  it('pins .bugzar-root to pointer-events:auto so a body{pointer-events:none} scroll-lock cannot make the widget click-transparent', () => {
    // The toolbar portals to <body>. Host modals (Radix/Headless UI/react-remove-scroll)
    // set body { pointer-events: none } while open; without an explicit value the root
    // inherits none and clicks fall through to whatever is beneath it.
    injectStyles();
    const raw = document.getElementById('bugzar-styles')?.textContent ?? '';
    // Strip CSS comments first — they can contain braces (e.g. an illustrative
    // `body { pointer-events: none }`) that would break a naive block match.
    const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
    const rootBlock = css.match(/\.bugzar-root\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rootBlock).toMatch(/pointer-events:\s*auto/);
  });
});
