import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { extractAnnotation } from '../picker/meta';
import { startDesignPick } from '../picker/picker';

// happy-dom may lack CSS.escape, which the selector builder uses.
beforeAll(() => {
  const g = globalThis as unknown as { CSS?: { escape?: (s: string) => string } };
  if (!g.CSS) g.CSS = {};
  if (!g.CSS.escape) g.CSS.escape = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
});

afterEach(() => {
  document.querySelector('.bugzar-pick-root')?.remove();
  document.body.replaceChildren();
});

describe('extractAnnotation', () => {
  it('captures tag, text, classes, a selector, and an empty note', () => {
    const el = document.createElement('button');
    el.className = 'btn primary';
    el.textContent = '  Submit  ';
    document.body.appendChild(el);

    const a = extractAnnotation(el);
    expect(a.tagName).toBe('button');
    expect(a.textContent).toBe('Submit');
    expect(a.cssClasses).toBe('btn primary');
    expect(typeof a.selector).toBe('string');
    expect(a.selector.length).toBeGreaterThan(0);
    expect(a.note).toBe('');
    expect(a.id).toBeTruthy();
  });

  it('captures identifying attributes (id, data-*, aria-label) for code lookup', () => {
    const el = document.createElement('button');
    el.id = 'submit-btn';
    el.setAttribute('data-testid', 'checkout-submit');
    el.setAttribute('aria-label', 'Submit order');
    el.setAttribute('type', 'submit');
    document.body.appendChild(el);

    const a = extractAnnotation(el);
    expect(a.attributes).toMatchObject({
      id: 'submit-btn',
      'data-testid': 'checkout-submit',
      'aria-label': 'Submit order',
      type: 'submit',
    });
  });

  it('adds scrollable-ancestor offsets to the document rect (in-container scroll)', () => {
    const scroller = document.createElement('div');
    const child = document.createElement('button');
    scroller.appendChild(child);
    document.body.appendChild(scroller);
    // Simulate a container scrolled down — window stays at 0, which is exactly the
    // case that used to pin post-scroll picks to the first screen.
    Object.defineProperty(scroller, 'scrollTop', { value: 500, configurable: true });
    Object.defineProperty(scroller, 'scrollLeft', { value: 20, configurable: true });

    const a = extractAnnotation(child);
    // getBoundingClientRect is 0 in happy-dom; the offset comes from the ancestor.
    expect(a.rect.y).toBe(500);
    expect(a.rect.x).toBe(20);
  });
});

describe('startDesignPick', () => {
  it('mounts an overlay and tears it down on stop', () => {
    const handle = startDesignPick({ onComplete: () => {} });
    expect(document.querySelector('.bugzar-pick-root')).toBeTruthy();
    expect(document.querySelector('.bugzar-pick-bar')).toBeTruthy();
    expect(handle.isActive()).toBe(true);

    handle.stop();
    expect(document.querySelector('.bugzar-pick-root')).toBeFalsy();
    expect(handle.isActive()).toBe(false);
  });

  it('anchors the collection bar to the given position + offset (#55)', () => {
    const handle = startDesignPick({
      onComplete: () => {},
      position: 'top-left',
      offset: { x: 40, y: 12 },
    });
    const bar = document.querySelector('.bugzar-pick-bar') as HTMLElement;
    expect(bar.classList.contains('bugzar-top-left')).toBe(true);
    expect(bar.style.getPropertyValue('--bugzar-offset-x')).toBe('40px');
    expect(bar.style.getPropertyValue('--bugzar-offset-y')).toBe('12px');
    handle.stop();
  });

  it('defaults the bar to bottom-right when no position is passed (#55)', () => {
    const handle = startDesignPick({ onComplete: () => {} });
    const bar = document.querySelector('.bugzar-pick-bar') as HTMLElement;
    expect(bar.classList.contains('bugzar-bottom-right')).toBe(true);
    // No offset → inherit the stylesheet's 20px default (no inline override).
    expect(bar.style.getPropertyValue('--bugzar-offset-x')).toBe('');
    handle.stop();
  });

  it('swallows the page press/secondary events so the real element never reacts', () => {
    const target = document.createElement('button');
    target.textContent = 'Buy';
    document.body.appendChild(target);

    const handle = startDesignPick({ onComplete: () => {} });

    // mousedown/mouseup/contextmenu/dblclick on the page are prevented — no focus,
    // :active, drag, or context menu fires on the real element.
    for (const type of ['mousedown', 'mouseup', 'contextmenu', 'dblclick']) {
      const ev = new MouseEvent(type, { bubbles: true, cancelable: true });
      target.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
    }

    // Our own picker UI is excluded — its events pass through untouched.
    const bar = document.querySelector('.bugzar-pick-bar') as HTMLElement;
    const ours = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    bar.dispatchEvent(ours);
    expect(ours.defaultPrevented).toBe(false);

    handle.stop();

    // After teardown the listeners are gone — page events react normally again.
    const after = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    target.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it('clicking an element opens a note popover; Add collects it and Done returns it', () => {
    const target = document.createElement('a');
    target.textContent = 'Link';
    document.body.appendChild(target);

    let result: { tagName: string; note: string }[] | null = null;
    startDesignPick({ onComplete: (anns) => (result = anns as typeof result) });

    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    // A popover appears for writing the note (not the old bottom-list input).
    const popover = document.querySelector('.bugzar-pick-popover');
    expect(popover).toBeTruthy();
    const textarea = popover?.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = 'too small';
    // Optional Figma link input.
    const figma = popover?.querySelector('.bugzar-pick-pop-figma') as HTMLInputElement;
    expect(figma).toBeTruthy();
    figma.value = 'https://figma.com/file/abc';
    const add = [
      ...document.querySelectorAll('.bugzar-pick-popover .bugzar-pick-btn-primary'),
    ].find((b) => b.textContent === 'Add') as HTMLButtonElement | undefined;
    expect(add).toBeTruthy();
    add?.click();

    // Popover closes; the pick is collected in the bar.
    expect(document.querySelector('.bugzar-pick-popover')).toBeFalsy();

    const done = [...document.querySelectorAll('.bugzar-pick-btn-primary')].find(
      (b) => b.textContent === 'Done',
    ) as HTMLButtonElement | undefined;
    expect(done).toBeTruthy();
    done?.click();

    // Cast un-narrows `result` — TS only sees the `= null` init (the callback
    // assignment is invisible to linear flow), which would make `result?.[0]` never.
    const captured = result as { tagName: string; note: string; figmaUrl?: string }[] | null;
    expect(captured).not.toBeNull();
    expect(captured).toHaveLength(1);
    expect(captured?.[0]?.tagName).toBe('a');
    expect(captured?.[0]?.note).toBe('too small');
    expect(captured?.[0]?.figmaUrl).toBe('https://figma.com/file/abc');
  });

  // Helper: pick `target` and save a note, returning when the bar shows the chip.
  const pickWithNote = (target: Element, note: string): void => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const textarea = document.querySelector('.bugzar-pick-popover textarea') as HTMLTextAreaElement;
    textarea.value = note;
    const add = [
      ...document.querySelectorAll('.bugzar-pick-popover .bugzar-pick-btn-primary'),
    ].find((b) => b.textContent === 'Add') as HTMLButtonElement;
    add.click();
  };

  it('re-opens an existing pick from the list to edit its note (no duplicate added)', () => {
    const target = document.createElement('a');
    target.textContent = 'Link';
    document.body.appendChild(target);

    let result: { note: string }[] | null = null;
    startDesignPick({ onComplete: (anns) => (result = anns as typeof result) });
    pickWithNote(target, 'small');

    // Click its chip in the bottom-right list → the note popover reopens, prefilled.
    const chipMain = document.querySelector('.bugzar-pick-chip-main') as HTMLButtonElement;
    expect(chipMain).toBeTruthy();
    chipMain.click();
    const pop = document.querySelector('.bugzar-pick-popover') as HTMLElement;
    expect(pop).toBeTruthy();
    const textarea = pop.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.value).toBe('small');

    // The primary action is "Save" (editing), not "Add".
    const save = [...pop.querySelectorAll('.bugzar-pick-btn-primary')].find(
      (b) => b.textContent === 'Save',
    ) as HTMLButtonElement;
    expect(save).toBeTruthy();
    textarea.value = 'tiny';
    save.click();

    const done = [...document.querySelectorAll('.bugzar-pick-btn-primary')].find(
      (b) => b.textContent === 'Done',
    ) as HTMLButtonElement;
    done.click();

    const captured = result as { note: string }[] | null;
    expect(captured).toHaveLength(1); // edited in place, not duplicated
    expect(captured?.[0]?.note).toBe('tiny');
  });

  it('re-opens an existing pick by clicking its on-canvas number badge', () => {
    const target = document.createElement('button');
    target.textContent = 'Buy';
    document.body.appendChild(target);

    startDesignPick({ onComplete: () => {} });
    pickWithNote(target, 'spacing');

    // The on-canvas marker carries a clickable number badge.
    const badge = document.querySelector('.bugzar-pick-selected .bugzar-pick-badge') as HTMLElement;
    expect(badge.textContent).toBe('1');
    badge.click();

    // Editing view reopens, prefilled with the saved note.
    const reopened = document.querySelector('.bugzar-pick-popover textarea') as HTMLTextAreaElement;
    expect(reopened).toBeTruthy();
    expect(reopened.value).toBe('spacing');
  });
});
