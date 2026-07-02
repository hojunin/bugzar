// Design-mode (Pick/click) view. When the report carries a page snapshot, render
// the actual screen (read-only rrweb replay) with a numbered pin on each
// annotated element + a side panel of messages — so a reviewer can see WHERE each
// note applies. Falls back to imageless cards when no snapshot was captured.

import type { RrwebEvent, WebVitals } from '@bugzar/shared';
import { isSafeUrl } from '@bugzar/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Replayer } from 'rrweb';
import { SystemInfoPanel } from '../panels/SystemInfoPanel';
import type { DesignElement, ReportData, ReportMeta } from '../report/types';
import { expandScrollContainers } from './expand-scroll-containers';
import { formatAll, formatForAI } from './format-for-ai';

// Re-exported so the existing test can import it from './DesignView'.
export { expandScrollContainers } from './expand-scroll-containers';

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
                    // biome-ignore lint/suspicious/noArrayIndexKey: selector+userNote can collide across annotations; the index is a uniqueness tiebreaker and the list never reorders.
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
                // biome-ignore lint/suspicious/noArrayIndexKey: selector+userNote can collide across annotations; the index is a uniqueness tiebreaker and the list never reorders.
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
                  {/* #1: only http/https figmaUrls render — a javascript:/data:
                      value would execute in the public-by-URL report on click. */}
                  {isSafeUrl(el.figmaUrl) ? (
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
