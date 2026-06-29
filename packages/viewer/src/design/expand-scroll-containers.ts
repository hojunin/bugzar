/**
 * Un-clip the captured page so each annotated element lays out and is visible.
 * App shells scroll inside a container (`overflow:auto`) under a `100vh` /
 * `overflow:hidden` ancestor, sometimes wrapped in a `position:fixed` panel — all
 * of which clip below-the-fold content and leave post-scroll pins over a blank
 * area. We free the document root, then walk ONLY the ancestor chain of each
 * annotated element and neutralize the clipping/fixed boxes there. Touching every
 * element instead would balloon unrelated floating widgets (e.g. the TanStack
 * Query devtools button) once their size constraint is removed.
 */
export function expandScrollContainers(doc: Document, selectors: string[]): void {
  const win = doc.defaultView;
  if (!win) return;
  // Let the document root itself grow to its content.
  for (const root of [doc.documentElement, doc.body]) {
    if (!root) continue;
    root.style.setProperty('height', 'auto', 'important');
    root.style.setProperty('min-height', '0', 'important');
    root.style.setProperty('max-height', 'none', 'important');
    root.style.setProperty('overflow', 'visible', 'important');
  }
  const seen = new Set<Element>();
  for (const sel of selectors) {
    let node: Element | null = null;
    try {
      node = doc.querySelector(sel);
    } catch {
      node = null; // unsupported selector — skip
    }
    for (
      let el = node?.parentElement ?? null;
      el && el !== doc.documentElement && el !== doc.body;
      el = el.parentElement
    ) {
      if (seen.has(el)) break; // shared ancestors already handled
      seen.add(el);
      let cs: CSSStyleDeclaration;
      try {
        cs = win.getComputedStyle(el);
      } catch {
        continue;
      }
      const h = el as HTMLElement;
      // A clipping/scrolling box → expand it so its content lays out fully.
      if (/auto|scroll|hidden|clip/.test(`${cs.overflow} ${cs.overflowX} ${cs.overflowY}`)) {
        h.style.setProperty('overflow', 'visible', 'important');
        h.style.setProperty('height', 'auto', 'important');
        h.style.setProperty('max-height', 'none', 'important');
      }
      // Fixed/sticky ancestors don't add to the document height — drop into flow.
      if (cs.position === 'fixed' || cs.position === 'sticky') {
        h.style.setProperty('position', 'static', 'important');
      }
    }
  }
}
