// Design-mode (Pick/click) view. When the report carries a page snapshot, render
// the actual screen (read-only rrweb replay) with a numbered pin on each
// annotated element + a side panel of messages — so a reviewer can see WHERE each
// note applies. Falls back to imageless cards when no snapshot was captured.

import type { RrwebEvent, WebVitals } from '@bugzar/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Replayer } from 'rrweb';
import { SystemInfoPanel } from '../panels/SystemInfoPanel';
import type { DesignElement, ReportData, ReportMeta } from '../report/types';

export interface DesignViewProps {
  elements: DesignElement[];
  events: RrwebEvent[];
  /** Captured page URL — included in the copy-for-AI header. */
  pageUrl?: string;
  /** Device/browser snapshot for the System tab (null on reports captured before it). */
  system?: ReportData['system'];
  meta?: ReportMeta | null;
  vitals?: WebVitals;
}

/** A structured, paste-into-an-AI description of one annotated element. */
function formatForAI(el: DesignElement, i: number): string {
  const lines = [`[Design QA #${i + 1}]`];
  lines.push(`Element: <${el.tagName}${el.cssClasses ? ` class="${el.cssClasses}"` : ''}>`);
  lines.push(`Selector: ${el.selector}`);
  if (el.componentName) lines.push(`Component: ${el.componentName}`);
  if (el.textContent) lines.push(`Text: "${el.textContent}"`);
  if (el.attributes && Object.keys(el.attributes).length > 0) {
    const attrs = Object.entries(el.attributes)
      .map(([k, v]) => `${k}="${v}"`)
      .join(' ');
    lines.push(`Attributes: ${attrs}`);
  }
  lines.push(`Fix requested: ${el.userNote || '(none)'}`);
  if (el.figmaUrl) lines.push(`Figma: ${el.figmaUrl}`);
  return lines.join('\n');
}

function formatAll(elements: DesignElement[], pageUrl?: string): string {
  const header = pageUrl ? `Design QA report — ${pageUrl}` : 'Design QA report';
  return [header, '', elements.map((el, i) => formatForAI(el, i)).join('\n\n')].join('\n');
}

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

/** Imageless fallback (old reports / snapshot capture failed). */
function CardList({ elements }: { elements: DesignElement[] }) {
  return (
    <div className="bugzarv-design">
      {elements.map((el) => (
        <article key={`${el.selector}-${el.userNote}`} className="bugzarv-card">
          <div className="bugzarv-card-selector">{el.selector}</div>
          <div className="bugzarv-card-tag">{el.tagName}</div>
          {el.componentName ? (
            <div className="bugzarv-card-component">{el.componentName}</div>
          ) : null}
          <p className="bugzarv-card-note">{el.userNote}</p>
        </article>
      ))}
    </div>
  );
}

export function DesignView({ elements, events, pageUrl, system, meta, vitals }: DesignViewProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  // Pin rects re-measured from the element's actual position in the rendered
  // snapshot (null until measured → fall back to the captured rects).
  const [pinRects, setPinRects] = useState<DesignElement['rect'][] | null>(null);
  const [canvasW, setCanvasW] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [copied, setCopied] = useState<number | 'all' | null>(null);
  const [tab, setTab] = useState<'notes' | 'system'>('notes');

  const copy = (text: string, key: number | 'all') => {
    void navigator.clipboard?.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
  };

  const hasSnapshot = events.length >= 2;

  // Build a read-only replay of the page snapshot, then grow the iframe to the
  // full document size so the whole page lays out with no internal scroll (pins
  // are then positioned in the same document-coordinate space).
  useEffect(() => {
    if (!hasSnapshot || !stageRef.current) return;
    let replayer: Replayer | null = null;
    let cancelled = false;
    const measure = () => {
      const stage = stageRef.current;
      if (cancelled || !stage) return;
      const wrapper = stage.querySelector('.replayer-wrapper') as HTMLElement | null;
      const iframe = stage.querySelector('iframe') as HTMLIFrameElement | null;
      const doc = iframe?.contentDocument;
      if (!iframe || !doc) return;
      // Un-clip the annotated elements' ancestor chains first so the whole page
      // contributes to the measured height (otherwise post-scroll pins land over
      // clipped content). Scoped to those chains so unrelated widgets are spared.
      expandScrollContainers(doc, elements.map((el) => el.selector).filter(Boolean));
      const w = Math.max(doc.documentElement.scrollWidth, doc.body?.scrollWidth ?? 0);
      const h = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0);
      if (w > 0 && h > 0) {
        iframe.style.width = `${w}px`;
        iframe.style.height = `${h}px`;
        if (wrapper) {
          wrapper.style.width = `${w}px`;
          wrapper.style.height = `${h}px`;
          wrapper.style.overflow = 'visible';
        }
        setDims({ w, h });
        // Pin each annotation at its ACTUAL position in the rendered (expanded)
        // snapshot — robust to scroll containers / fixed panels that shift the
        // layout. Fall back to the captured rect if the selector can't resolve.
        setPinRects(
          elements.map((el) => {
            if (el.selector) {
              try {
                const node = doc.querySelector(el.selector) as HTMLElement | null;
                if (node) {
                  const r = node.getBoundingClientRect();
                  return { x: r.left, y: r.top, width: r.width, height: r.height };
                }
              } catch {
                // unsupported/invalid selector — fall back to the captured rect
              }
            }
            return el.rect;
          }),
        );
      }
    };
    try {
      replayer = new Replayer(events as ConstructorParameters<typeof Replayer>[0], {
        root: stageRef.current,
        skipInactive: false,
        mouseTail: false,
        liveMode: false,
      });
      replayer.pause(0);
      measure();
      // Re-measure once assets (images/fonts) have settled — they change height.
      const re = setTimeout(measure, 600);
      return () => {
        cancelled = true;
        clearTimeout(re);
        replayer?.destroy?.();
      };
    } catch {
      // rrweb failed to build — the card fallback still renders.
      return () => {
        cancelled = true;
      };
    }
  }, [events, hasSnapshot, elements]);

  // Track the available canvas width so we can scale the page to fit.
  useLayoutEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === 'undefined') {
      if (el) setCanvasW(el.clientWidth);
      return;
    }
    const ro = new ResizeObserver(() => setCanvasW(el.clientWidth));
    ro.observe(el);
    setCanvasW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  if (elements.length === 0 && !hasSnapshot) {
    return <div className="bugzarv-empty">No annotated elements in this design report.</div>;
  }
  if (!hasSnapshot) return <CardList elements={elements} />;

  const scale = dims && canvasW ? Math.min(canvasW / dims.w, 1) : 1;

  const selectPin = (i: number) => {
    setSelected(i);
    const r = pinRects?.[i] ?? elements[i]?.rect;
    const scroll = canvasRef.current;
    if (r && scroll && dims) {
      scroll.scrollTo({ top: Math.max(0, r.y * scale - 48), behavior: 'smooth' });
    }
  };

  return (
    <div className="bugzarv-dz">
      <div className="bugzarv-dz-canvas" ref={canvasRef}>
        <div
          className="bugzarv-dz-zoom"
          style={dims ? { width: dims.w * scale, height: dims.h * scale } : undefined}
        >
          <div
            className="bugzarv-dz-inner"
            style={
              dims ? { width: dims.w, height: dims.h, transform: `scale(${scale})` } : undefined
            }
          >
            <div ref={stageRef} className="bugzarv-dz-stage" />
          </div>
          {/* Pins live OUTSIDE the scaled page (positioned at scaled coords) so
              the badges/notes stay readable at any zoom. */}
          {dims ? (
            <div className="bugzarv-dz-pins">
              {elements.map((el, i) => {
                const r = pinRects?.[i] ?? el.rect;
                return (
                  <button
                    type="button"
                    key={`${el.selector}-${el.userNote}-${i}`}
                    className={`bugzarv-dz-pin${selected === i ? ' bugzarv-dz-pin-on' : ''}`}
                    style={{
                      left: `${r.x * scale}px`,
                      top: `${r.y * scale}px`,
                      width: `${Math.max(r.width * scale, 12)}px`,
                      height: `${Math.max(r.height * scale, 12)}px`,
                    }}
                    onClick={() => setSelected(i)}
                    aria-label={`Annotation ${i + 1}: ${el.userNote}`}
                  >
                    <span className="bugzarv-dz-pin-num">{i + 1}</span>
                    {selected === i && el.userNote ? (
                      <span className="bugzarv-dz-pin-note">{el.userNote}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
        {!dims ? <div className="bugzarv-dz-loading">Rendering screen…</div> : null}
      </div>
      <aside className="bugzarv-dz-list">
        <div className="bugzarv-dz-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'notes'}
            className={`bugzarv-dz-tab${tab === 'notes' ? ' bugzarv-dz-tab-on' : ''}`}
            onClick={() => setTab('notes')}
          >
            Annotations {elements.length}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'system'}
            className={`bugzarv-dz-tab${tab === 'system' ? ' bugzarv-dz-tab-on' : ''}`}
            onClick={() => setTab('system')}
          >
            System
          </button>
        </div>
        {tab === 'system' ? (
          <SystemInfoPanel system={system ?? null} meta={meta ?? null} vitals={vitals ?? {}} />
        ) : (
          <>
            <div className="bugzarv-dz-list-head">
              <button
                type="button"
                className="bugzarv-dz-copyall"
                onClick={() => copy(formatAll(elements, pageUrl), 'all')}
              >
                {copied === 'all' ? 'Copied ✓' : 'Copy all'}
              </button>
            </div>
            {elements.map((el, i) => (
              <div
                key={`${el.selector}-${el.userNote}-${i}`}
                className={`bugzarv-dz-item${selected === i ? ' bugzarv-dz-item-on' : ''}`}
              >
                <button type="button" className="bugzarv-dz-itemmain" onClick={() => selectPin(i)}>
                  <span className="bugzarv-dz-itembadge">{i + 1}</span>
                  <span className="bugzarv-dz-itembody">
                    <code className="bugzarv-dz-itemsel">{el.selector}</code>
                    <span className="bugzarv-dz-itemtag">
                      {`<${el.tagName}>`}
                      {el.componentName ? ` · ${el.componentName}` : ''}
                    </span>
                    {el.textContent ? (
                      <span className="bugzarv-dz-itemtext">“{el.textContent}”</span>
                    ) : null}
                    {el.attributes && Object.keys(el.attributes).length > 0 ? (
                      <span className="bugzarv-dz-attrs">
                        {Object.entries(el.attributes).map(([k, v]) => (
                          <span className="bugzarv-dz-attr" key={k}>
                            <span className="bugzarv-dz-attr-k">{k}</span>=&quot;{v}&quot;
                          </span>
                        ))}
                      </span>
                    ) : null}
                    <span className="bugzarv-dz-itemnote">{el.userNote || '—'}</span>
                  </span>
                </button>
                <div className="bugzarv-dz-itemactions">
                  {el.figmaUrl ? (
                    <a
                      className="bugzarv-dz-figma"
                      href={el.figmaUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      🔗 Figma
                    </a>
                  ) : null}
                  <button
                    type="button"
                    className="bugzarv-dz-copy"
                    onClick={() => copy(formatForAI(el, i), i)}
                  >
                    {copied === i ? 'Copied ✓' : 'Copy for AI'}
                  </button>
                </div>
              </div>
            ))}
          </>
        )}
      </aside>
    </div>
  );
}
