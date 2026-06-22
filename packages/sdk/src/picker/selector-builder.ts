import { findUniqueSelector } from './vendor/find-unique-selector';

const TIMEOUT_MS = 300;

// Priority list mirrors spec §5.8: id / data-testid / aria-label / unique class / nth-of-type.
// react-grab's heuristic accepts a callback-driven attr filter, so we channel
// our preference order through that.
const ATTR_PRIORITY = new Set(['data-testid', 'data-test', 'data-cy', 'aria-label', 'name']);

const ourAttrFilter = (name: string, value: string): boolean => {
  if (!value || value.length === 0) return false;
  if (value.length > 100) return false;
  if (ATTR_PRIORITY.has(name)) return true;
  if (name.startsWith('data-')) {
    // Accept data-* whose values look stable (word-like, not random hashes).
    return /^[a-z][a-z0-9_-]{2,}$/i.test(value);
  }
  return false;
};

const tryDirectSimpleSelector = (el: Element): string | null => {
  // Fast path 1 — id, but only word-like (avoid framework-generated random ids).
  const id = el.getAttribute('id');
  if (id && /^[a-zA-Z][a-zA-Z0-9_-]{2,}$/.test(id)) {
    const sel = `#${CSS.escape(id)}`;
    if (el.ownerDocument?.querySelectorAll(sel).length === 1) return sel;
  }
  // Fast path 2 — data-testid (Cypress / RTL convention).
  for (const attr of ['data-testid', 'data-test', 'data-cy']) {
    const v = el.getAttribute(attr);
    if (v) {
      const sel = `[${attr}="${CSS.escape(v)}"]`;
      if (el.ownerDocument?.querySelectorAll(sel).length === 1) return sel;
    }
  }
  return null;
};

export const buildSelector = (el: Element): string => {
  const fast = tryDirectSimpleSelector(el);
  if (fast) return fast;
  const root = el.ownerDocument ?? document;
  return findUniqueSelector(el, root, TIMEOUT_MS, ourAttrFilter);
};
