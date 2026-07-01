import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Issue #21, approach (i): pressing the Bugzar FAB must NOT dismiss an open
// outside-click-dismissable host component (Select/Modal/Popover/Drawer) before
// startPick's captureSnapshot freezes it. A document capture-phase guard, scoped
// to the FAB controls (.bugzar-fab/.bugzar-pill), stops the press from reaching
// the host's document bubble-phase dismiss listener.
//
// These tests are RED until the guard lands in Bugzar/index.tsx, then GREEN.
// happy-dom does not synthesize click from a dispatched pointerdown, nor model
// focus-steal/touch-compat — so the propagation contract is asserted by dispatch
// + spies, and activation is asserted separately via fireEvent.click.

vi.mock('@bugzar/capture-core', () => {
  let active = false;
  return {
    createRecorder: () => ({
      start: () => {
        active = true;
      },
      stop: () => {
        active = false;
        return {};
      },
      isActive: () => active,
    }),
    captureSnapshot: () => [],
    collectSystemInfo: () => null,
  };
});

import { Bugzar } from '../Bugzar';

// Design FAB / Record FAB aria-labels (EN — happy-dom defaults to English).
const DESIGN_FAB = 'Leave design feedback on elements';
const RECORD_FAB = 'Start recording';

const press = (type: string): MouseEvent =>
  new MouseEvent(type, { bubbles: true, cancelable: true });

afterEach(() => {
  cleanup();
  // Real picker mounts to document.body outside React — clear any leftover.
  document.querySelector('.bugzar-pick-root')?.remove();
  for (const n of document.querySelectorAll('.host-select, .bugzar-root, .stray'))
    if (!n.closest('[data-testid]')) n.remove();
});

describe('issue #21 — FAB press preserves an open outside-click component', () => {
  it('stops the FAB press from reaching a page document bubble listener', () => {
    render(<Bugzar />);
    const spy = vi.fn();
    document.addEventListener('pointerdown', spy); // host outside-click (bubble)
    try {
      const ev = press('pointerdown');
      screen.getByLabelText(RECORD_FAB).dispatchEvent(ev);
      expect(spy).not.toHaveBeenCalled(); // capture stopPropagation blocked it
    } finally {
      document.removeEventListener('pointerdown', spy);
    }
  });

  it('keeps an open outside-click-dismiss component open when the FAB is pressed', () => {
    render(<Bugzar />);
    // A host "Select": a container whose dropdown a document bubble pointerdown
    // removes when the press lands outside it (the common dismiss pattern).
    const root = document.createElement('div');
    root.className = 'host-select';
    const dropdown = document.createElement('div');
    dropdown.className = 'host-dropdown';
    root.appendChild(dropdown);
    document.body.appendChild(root);
    const dismiss = (e: Event) => {
      const t = e.target as Node | null;
      if (!t || !root.contains(t)) dropdown.remove();
    };
    document.addEventListener('pointerdown', dismiss);
    try {
      screen.getByLabelText(DESIGN_FAB).dispatchEvent(press('pointerdown'));
      expect(document.querySelector('.host-dropdown')).toBeTruthy(); // stayed open
    } finally {
      document.removeEventListener('pointerdown', dismiss);
      root.remove();
    }
  });

  it('prevents the FAB mousedown default (blocks focus-steal) and stops propagation', () => {
    render(<Bugzar />);
    const spy = vi.fn();
    document.addEventListener('mousedown', spy);
    try {
      const ev = press('mousedown');
      screen.getByLabelText(RECORD_FAB).dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('mousedown', spy);
    }
  });

  it('does NOT preventDefault the FAB pointerdown (touch activation safety)', () => {
    render(<Bugzar />);
    const ev = press('pointerdown');
    screen.getByLabelText(RECORD_FAB).dispatchEvent(ev);
    // preventDefault on pointerdown can swallow the activating click on touch.
    expect(ev.defaultPrevented).toBe(false);
  });

  it('does not swallow mousedown on non-FAB .bugzar-root descendants (drawer form)', () => {
    render(<Bugzar />);
    // The ReviewDrawer shares the .bugzar-root class and contains form inputs;
    // the guard must be scoped to .bugzar-fab/.bugzar-pill, not .bugzar-root.
    const root = document.createElement('div');
    root.className = 'bugzar-root';
    const input = document.createElement('input');
    input.className = 'bugzar-input';
    root.appendChild(input);
    document.body.appendChild(root);
    try {
      const ev = press('mousedown');
      input.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
    } finally {
      root.remove();
    }
  });

  it('leaves ordinary page presses untouched', () => {
    render(<Bugzar />);
    const spy = vi.fn();
    document.addEventListener('pointerdown', spy);
    const btn = document.createElement('button');
    btn.className = 'stray';
    document.body.appendChild(btn);
    try {
      const ev = press('pointerdown');
      btn.dispatchEvent(ev);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(ev.defaultPrevented).toBe(false);
    } finally {
      document.removeEventListener('pointerdown', spy);
      btn.remove();
    }
  });

  it('still enters pick mode on FAB click (guard does not block activation)', () => {
    render(<Bugzar />);
    fireEvent.click(screen.getByLabelText(DESIGN_FAB));
    expect(document.querySelector('.bugzar-pick-root')).toBeTruthy();
  });

  it('removes the document guards on unmount', () => {
    const { unmount } = render(<Bugzar />);
    unmount();
    const spy = vi.fn();
    document.addEventListener('pointerdown', spy);
    // The real FAB is gone after unmount; stand in a .bugzar-fab node and confirm
    // the (now-removed) guard no longer intercepts its press.
    const fab = document.createElement('button');
    fab.className = 'bugzar-fab stray';
    document.body.appendChild(fab);
    try {
      fab.dispatchEvent(press('pointerdown'));
      expect(spy).toHaveBeenCalledTimes(1); // guard torn down → press reaches bubble
    } finally {
      document.removeEventListener('pointerdown', spy);
      fab.remove();
    }
  });
});
