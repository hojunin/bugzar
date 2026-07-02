import { getStrings, type Strings } from '../i18n';
import type { DesignAnnotation } from '../public-types';
import { isSafeUrl } from '../safe-url';
import { injectStyles } from '../styles';
import { extractAnnotation } from './meta';

// Pointer/mouse events the picker swallows over the host page, so reviewing an
// element never fires the page's real behavior — focus, :active, drag, and any
// custom pointerdown/mousedown/dbl-click/context-menu handlers. `click` is
// handled separately (it opens the note popover); `mousemove` is intentionally
// excluded — hover detection needs it.
const SUPPRESSED_EVENTS = [
  'pointerdown',
  'mousedown',
  'pointerup',
  'mouseup',
  'dblclick',
  'contextmenu',
  'auxclick',
] as const;

export interface PickerHandle {
  stop(): void;
  isActive(): boolean;
}

type Corner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

export interface PickerOptions {
  onComplete: (annotations: DesignAnnotation[]) => void;
  onCancel?: () => void;
  /** Corner the collection bar anchors to. @default 'bottom-right' */
  position?: Corner;
  /** Corner inset (px) fed to the shared position CSS variables. */
  offset?: { x: number; y: number };
}

/**
 * Lean in-page element picker. Activates a hover-highlight + click-to-select flow
 * over the host page. Clicking an element opens a small popover anchored to it
 * where you write the note; saved picks get a numbered outline and collect into a
 * floating bar. `onComplete` receives all annotations when you press Done.
 *
 * Vanilla DOM on purpose — it lives on document-level pointer events and
 * absolutely-positioned outlines, which is simpler imperatively than in React.
 * Styles are the shared injected sheet (bugzar-pick-* classes).
 */
export function startDesignPick({
  onComplete,
  onCancel,
  position = 'bottom-right',
  offset,
}: PickerOptions): PickerHandle {
  injectStyles();
  const t: Strings = getStrings();

  const container = document.createElement('div');
  container.className = 'bugzar-pick-root';

  const hoverBox = document.createElement('div');
  hoverBox.className = 'bugzar-pick-hover';
  hoverBox.style.display = 'none';
  container.appendChild(hoverBox);

  const bar = document.createElement('div');
  // Share the toolbar's corner system so the bar honors `position` (+ offset)
  // instead of a hardcoded bottom-right. The toolbar is hidden while picking, so
  // the bar can safely take the same corner.
  bar.className = `bugzar-pick-bar bugzar-${position}`;
  if (offset) {
    bar.style.setProperty('--bugzar-offset-x', `${offset.x}px`);
    bar.style.setProperty('--bugzar-offset-y', `${offset.y}px`);
  }
  container.appendChild(bar);

  document.body.appendChild(container);

  const annotations: DesignAnnotation[] = [];
  const refs = new Map<string, Element>();
  const outlines = new Map<string, HTMLElement>();
  // The element currently being annotated (popover open), if any.
  let pending: { el: Element; ann: DesignAnnotation; pop: HTMLElement; isNew: boolean } | null =
    null;
  let stopped = false;

  const isOurNode = (node: EventTarget | null): boolean =>
    node instanceof Node && container.contains(node);

  const showHover = (el: Element | null): void => {
    if (!el || pending) {
      hoverBox.style.display = 'none';
      return;
    }
    const r = el.getBoundingClientRect();
    hoverBox.style.display = 'block';
    hoverBox.style.transform = `translate(${r.left}px, ${r.top}px)`;
    hoverBox.style.width = `${r.width}px`;
    hoverBox.style.height = `${r.height}px`;
  };

  const drawOutline = (id: string, index: number): void => {
    const el = refs.get(id);
    if (!el) return;
    const r = el.getBoundingClientRect();
    let box = outlines.get(id);
    if (!box) {
      box = document.createElement('div');
      box.className = 'bugzar-pick-selected';
      const badge = document.createElement('span');
      badge.className = 'bugzar-pick-badge';
      badge.title = t.edit;
      // Click the on-canvas number to re-open this pick's note for editing.
      badge.addEventListener('click', () => editAnnotation(id));
      box.appendChild(badge);
      container.appendChild(box);
      outlines.set(id, box);
    }
    (box.firstChild as HTMLElement).textContent = String(index);
    box.style.transform = `translate(${r.left}px, ${r.top}px)`;
    box.style.width = `${r.width}px`;
    box.style.height = `${r.height}px`;
  };

  const redrawOutlines = (): void => {
    annotations.forEach((a, i) => {
      drawOutline(a.id, i + 1);
    });
  };

  const teardown = (): void => {
    if (stopped) return;
    stopped = true;
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    for (const name of SUPPRESSED_EVENTS) document.removeEventListener(name, swallow, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onReflow, true);
    window.removeEventListener('resize', onReflow, true);
    container.remove();
  };

  const finish = (): void => {
    const out = annotations.map((a) => ({ ...a }));
    teardown();
    onComplete(out);
  };

  const cancel = (): void => {
    teardown();
    onCancel?.();
  };

  const removeAnnotation = (id: string): void => {
    const idx = annotations.findIndex((a) => a.id === id);
    if (idx < 0) return;
    annotations.splice(idx, 1);
    refs.delete(id);
    outlines.get(id)?.remove();
    outlines.delete(id);
    redrawOutlines();
    renderBar();
  };

  const closePopover = (): void => {
    pending?.pop.remove();
    pending = null;
  };

  const placePopover = (el: Element, pop: HTMLElement): void => {
    const r = el.getBoundingClientRect();
    const w = pop.offsetWidth || 260;
    const h = pop.offsetHeight || 150;
    const left = Math.min(Math.max(r.left, 8), window.innerWidth - w - 8);
    let top = r.bottom + 8;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  };

  const openPopover = (el: Element, existing?: DesignAnnotation): void => {
    const ann = existing ?? extractAnnotation(el);
    const isNew = !existing;
    const pop = document.createElement('div');
    pop.className = 'bugzar-pick-popover';

    // Rich identity block — tag + selector + key attrs + text, so the reviewer
    // (and later an AI reading the report) can tell exactly which element it is.
    const head = document.createElement('div');
    head.className = 'bugzar-pick-pop-head';
    const tagLine = document.createElement('div');
    tagLine.className = 'bugzar-pick-pop-tag';
    tagLine.textContent = `<${ann.tagName}>${ann.componentName ? `  ·  ${ann.componentName}` : ''}`;
    head.appendChild(tagLine);
    const selLine = document.createElement('div');
    selLine.className = 'bugzar-pick-pop-sel';
    selLine.textContent = ann.selector;
    head.appendChild(selLine);
    if (ann.textContent) {
      const textLine = document.createElement('div');
      textLine.className = 'bugzar-pick-pop-eltext';
      textLine.textContent = `“${ann.textContent}”`;
      head.appendChild(textLine);
    }
    pop.appendChild(head);

    const note = document.createElement('textarea');
    note.className = 'bugzar-pick-pop-note';
    note.placeholder = t.notePlaceholder(ann.tagName);
    note.rows = 3;
    note.value = ann.note;
    pop.appendChild(note);

    const figma = document.createElement('input');
    figma.className = 'bugzar-pick-pop-figma';
    figma.type = 'url';
    figma.placeholder = t.figmaPlaceholder;
    if (ann.figmaUrl) figma.value = ann.figmaUrl;
    pop.appendChild(figma);

    const actions = document.createElement('div');
    actions.className = 'bugzar-pick-pop-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'bugzar-pick-btn bugzar-pick-btn-ghost';
    cancelBtn.textContent = t.cancel;
    cancelBtn.addEventListener('click', closePopover);
    actions.appendChild(cancelBtn);

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'bugzar-pick-btn bugzar-pick-btn-primary';
    addBtn.textContent = isNew ? t.add : t.save;
    addBtn.addEventListener('click', commitPending);
    actions.appendChild(addBtn);

    pop.appendChild(actions);
    container.appendChild(pop);

    // Enter saves (Shift+Enter / Esc handled too); newline via Shift+Enter.
    note.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        commitPending();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closePopover();
      }
    });

    pending = { el, ann, pop, isNew };
    showHover(null);
    placePopover(el, pop);
    note.focus();
  };

  // Re-open an existing pick (from its on-canvas number or the list) to edit its
  // note / Figma link in place — no new annotation is created.
  const editAnnotation = (id: string): void => {
    if (pending) return; // finish the open note first
    const el = refs.get(id);
    const ann = annotations.find((a) => a.id === id);
    if (el && ann) openPopover(el, ann);
  };

  function commitPending(): void {
    if (!pending) return;
    const textarea = pending.pop.querySelector('textarea');
    const figmaInput = pending.pop.querySelector<HTMLInputElement>('.bugzar-pick-pop-figma');
    pending.ann.note = textarea ? textarea.value : '';
    // #1: only store http/https — never persist a javascript:/data: figmaUrl
    // that would later render as an executable href in the exported report.
    const figmaUrl = figmaInput?.value.trim();
    if (isSafeUrl(figmaUrl)) pending.ann.figmaUrl = figmaUrl;
    else delete pending.ann.figmaUrl;
    // New picks are appended; an edit mutates the existing annotation in place.
    if (pending.isNew) {
      annotations.push(pending.ann);
      refs.set(pending.ann.id, pending.el);
    }
    closePopover();
    redrawOutlines();
    renderBar();
  }

  function renderBar(): void {
    bar.replaceChildren();

    const header = document.createElement('div');
    header.className = 'bugzar-pick-bar-head';
    header.textContent = annotations.length ? t.selected(annotations.length) : t.pickHint;
    bar.appendChild(header);

    if (annotations.length) {
      const list = document.createElement('div');
      list.className = 'bugzar-pick-bar-list';
      annotations.forEach((a, i) => {
        const chip = document.createElement('div');
        chip.className = 'bugzar-pick-chip';

        // Badge + note form one clickable button — opens this pick for editing.
        const main = document.createElement('button');
        main.type = 'button';
        main.className = 'bugzar-pick-chip-main';
        main.title = t.edit;
        main.addEventListener('click', () => editAnnotation(a.id));

        const badge = document.createElement('span');
        badge.className = 'bugzar-pick-itembadge';
        badge.textContent = String(i + 1);
        main.appendChild(badge);

        const text = document.createElement('span');
        text.className = 'bugzar-pick-chip-text';
        text.textContent = a.note || `<${a.tagName}>`;
        main.appendChild(text);

        chip.appendChild(main);

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'bugzar-pick-del';
        del.setAttribute('aria-label', t.remove);
        del.textContent = '×';
        del.addEventListener('click', () => removeAnnotation(a.id));
        chip.appendChild(del);

        list.appendChild(chip);
      });
      bar.appendChild(list);
    }

    const footer = document.createElement('div');
    footer.className = 'bugzar-pick-bar-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'bugzar-pick-btn bugzar-pick-btn-ghost';
    cancelBtn.textContent = t.cancel;
    cancelBtn.addEventListener('click', cancel);
    footer.appendChild(cancelBtn);

    const doneBtn = document.createElement('button');
    doneBtn.type = 'button';
    doneBtn.className = 'bugzar-pick-btn bugzar-pick-btn-primary';
    doneBtn.textContent = t.done;
    doneBtn.disabled = annotations.length === 0;
    doneBtn.addEventListener('click', finish);
    footer.appendChild(doneBtn);

    bar.appendChild(footer);
  }

  const onMove = (e: MouseEvent): void => {
    if (stopped || pending) return;
    const target = e.target as Element | null;
    showHover(!target || isOurNode(target) ? null : target);
  };

  const onClick = (e: MouseEvent): void => {
    if (stopped) return;
    const target = e.target as Element | null;
    if (!target || isOurNode(target)) return; // our UI handles its own clicks
    e.preventDefault();
    e.stopPropagation();
    if (pending) return; // already writing a note — ignore page clicks
    openPopover(target);
  };

  // Suppress the page's press/secondary pointer events during a pick (our own UI
  // is excluded so its popover/bar stay interactive).
  const swallow = (e: Event): void => {
    if (stopped) return;
    const target = e.target as Element | null;
    if (!target || isOurNode(target)) return;
    e.preventDefault();
    e.stopPropagation();
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    if (pending) closePopover();
    else cancel();
  };

  const onReflow = (): void => {
    redrawOutlines();
    if (pending) placePopover(pending.el, pending.pop);
  };

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  for (const name of SUPPRESSED_EVENTS) document.addEventListener(name, swallow, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', onReflow, true);
  window.addEventListener('resize', onReflow, true);

  renderBar();

  return { stop: teardown, isActive: () => !stopped };
}
