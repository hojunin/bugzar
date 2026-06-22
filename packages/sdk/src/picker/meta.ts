import type { DesignAnnotation } from '../public-types';
import { buildSelector } from './selector-builder';

// React component-name detection via the fiber tree — the same trick the
// extension's picker uses, so "the <PrimaryButton>" shows up in the output.
type FiberLike = { type?: unknown; return?: FiberLike };

const getReactFiber = (el: Element): FiberLike | null => {
  for (const key of Object.keys(el)) {
    if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
      return (el as unknown as Record<string, FiberLike>)[key] ?? null;
    }
  }
  return null;
};

const getDisplayName = (type: unknown): string | null => {
  if (!type) return null;
  if (typeof type === 'string') return type;
  if (typeof type === 'function') {
    const fn = type as { displayName?: string; name?: string };
    return fn.displayName ?? fn.name ?? null;
  }
  if (typeof type === 'object') {
    const t = type as { displayName?: string; render?: { displayName?: string; name?: string } };
    if (t.displayName) return t.displayName;
    if (t.render) return t.render.displayName ?? t.render.name ?? null;
  }
  return null;
};

const isMeaningfulName = (name: string | null): name is string =>
  !!name && name.length > 2 && name !== name.toLowerCase();

const getComponentName = (el: Element): string | undefined => {
  const fiber = getReactFiber(el);
  let cursor: FiberLike | null = fiber?.return ?? null;
  let safety = 0;
  while (cursor && safety++ < 50) {
    const name = getDisplayName(cursor.type);
    if (isMeaningfulName(name)) return name;
    cursor = cursor.return ?? null;
  }
  return undefined;
};

const newId = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `qae-${Math.random().toString(36).slice(2)}`;

// Attributes that help a dev/AI pin down the element in source. data-* attrs
// (testids, etc.) are collected wholesale; the rest are an explicit allowlist.
const IDENTIFYING_ATTRS = [
  'id',
  'name',
  'type',
  'role',
  'href',
  'placeholder',
  'alt',
  'title',
  'value',
  'aria-label',
  'aria-labelledby',
  'for',
];

/** Identifying attributes (allowlist + every data-*), non-empty values only. */
function collectAttributes(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of IDENTIFYING_ATTRS) {
    const v = el.getAttribute(name);
    if (v) out[name] = v.length > 120 ? `${v.slice(0, 120)}…` : v;
  }
  for (const attr of Array.from(el.attributes)) {
    if (attr.name.startsWith('data-') && attr.value) out[attr.name] = attr.value;
  }
  return out;
}

/**
 * Document-absolute top-left of `el`, robust to in-container scrolling.
 *
 * `getBoundingClientRect()` is viewport-relative, so the report (which lays the
 * whole page out at scroll 0 and pins by document coords) needs the scroll offset
 * added back. Adding only `window.scrollX/Y` is wrong for apps that scroll inside
 * a container (overflow:auto) — there the window never scrolls, so every pick made
 * after scrolling landed on the first screen. Sum each scrollable ancestor's
 * offset, then the root (window) scroll once.
 */
function documentOffset(el: Element): { x: number; y: number } {
  const rect = el.getBoundingClientRect();
  let x = rect.left;
  let y = rect.top;
  let node = el.parentElement;
  while (node && node !== document.documentElement && node !== document.body) {
    x += node.scrollLeft;
    y += node.scrollTop;
    node = node.parentElement;
  }
  return { x: x + window.scrollX, y: y + window.scrollY };
}

/** Extract a structured annotation for a picked element (selector + metadata). */
export function extractAnnotation(el: Element): DesignAnnotation {
  const rect = el.getBoundingClientRect();
  const { x, y } = documentOffset(el);
  const component = getComponentName(el);
  const attributes = collectAttributes(el);
  return {
    id: newId(),
    selector: buildSelector(el),
    tagName: el.tagName.toLowerCase(),
    textContent: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
    cssClasses: typeof el.className === 'string' ? el.className : '',
    rect: { x, y, width: rect.width, height: rect.height },
    ...(component ? { componentName: component } : {}),
    ...(Object.keys(attributes).length ? { attributes } : {}),
    note: '',
  };
}
