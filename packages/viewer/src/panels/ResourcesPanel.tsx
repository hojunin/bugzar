import type { ResourceTimingEntry } from '@bugzar/shared';
import { useState } from 'react';
import { barGeometry } from './timeline';

export interface ResourcesPanelProps {
  entries: ResourceTimingEntry[];
}

type Cat = 'js' | 'css' | 'img' | 'font' | 'fetch' | 'doc' | 'other';
const CAT_ORDER: Cat[] = ['js', 'css', 'img', 'font', 'fetch', 'doc', 'other'];
const CAT_LABEL: Record<Cat, string> = {
  js: 'JS',
  css: 'CSS',
  img: 'Img',
  font: 'Font',
  fetch: 'Fetch/XHR',
  doc: 'Doc',
  other: 'Other',
};

const IMG_EXT = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'ico', 'bmp'];
const FONT_EXT = ['woff', 'woff2', 'ttf', 'otf', 'eot'];

/** Bucket a resource by file extension first, then its initiatorType. */
function categorize(e: ResourceTimingEntry): Cat {
  const path = e.name.toLowerCase().split(/[?#]/)[0] ?? '';
  const ext = path.includes('.') ? (path.split('.').pop() ?? '') : '';
  if (['js', 'mjs', 'cjs'].includes(ext)) return 'js';
  if (ext === 'css') return 'css';
  if (IMG_EXT.includes(ext)) return 'img';
  if (FONT_EXT.includes(ext)) return 'font';
  const t = e.initiatorType.toLowerCase();
  if (t === 'script') return 'js';
  if (t === 'img') return 'img';
  if (t === 'css' || t === 'link') return 'css';
  if (t === 'fetch' || t === 'xmlhttprequest' || ext === 'json') return 'fetch';
  if (t === 'navigation') return 'doc';
  return 'other';
}

const fmtSize = (bytes: number) => (bytes > 0 ? `${(bytes / 1024).toFixed(1)} KB` : '—');
const fmtMs = (ms: number) => `${Math.round(ms)} ms`;

function Row({ k, v }: { k: string; v: string | number }) {
  return (
    <tr>
      <td className="bugzarv-kv-k">{k}</td>
      <td className="bugzarv-kv-v">{v}</td>
    </tr>
  );
}

export function ResourcesPanel({ entries }: ResourcesPanelProps) {
  // Keyed by ORIGINAL entry index — (startTime,name) can collide (ms-rounded),
  // so a content key would dup and break list reconciliation on filter.
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState<Cat | 'all'>('all');

  const tagged = entries.map((e, i) => ({ e, cat: categorize(e), i }));
  const counts = tagged.reduce<Partial<Record<Cat, number>>>((acc, { cat }) => {
    acc[cat] = (acc[cat] ?? 0) + 1;
    return acc;
  }, {});
  const present = CAT_ORDER.filter((c) => counts[c]);
  const shown = filter === 'all' ? tagged : tagged.filter((t) => t.cat === filter);
  const max = Math.max(1, ...entries.map((e) => e.startTime + e.duration));

  const toggle = (idx: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });

  const chip = (key: Cat | 'all', label: string, count: number) => (
    <button
      key={key}
      type="button"
      className={`bugzarv-rfilter-chip${filter === key ? ' bugzarv-rfilter-on' : ''}`}
      onClick={() => setFilter(key)}
    >
      {label} <span className="bugzarv-rfilter-count">{count}</span>
    </button>
  );

  return (
    <div className="bugzarv-respanel">
      <div className="bugzarv-rfilter">
        {chip('all', 'All', entries.length)}
        {present.map((c) => chip(c, CAT_LABEL[c], counts[c] ?? 0))}
      </div>
      <div className="bugzarv-rows">
        {shown.map(({ e, cat, i }) => {
          const isOpen = open.has(i);
          const g = barGeometry(e, { min: 0, max, width: 100 });
          return (
            <div key={i} className="bugzarv-row-group">
              <button
                type="button"
                className="bugzarv-row bugzarv-net-row"
                aria-expanded={isOpen}
                onClick={() => toggle(i)}
              >
                <span className="bugzarv-disclosure">{isOpen ? '▾' : '▸'}</span>
                <span className={`bugzarv-tag bugzarv-rtag-${cat}`}>{CAT_LABEL[cat]}</span>
                <span className="bugzarv-msg">{e.name}</span>
                <span className="bugzarv-time">{fmtSize(e.transferSize)}</span>
                <div className="bugzarv-bar-track">
                  <div
                    className="bugzarv-bar"
                    style={{ left: `${g.x}%`, width: `${Math.max(g.width, 0.5)}%` }}
                  />
                </div>
              </button>
              {isOpen ? (
                <div className="bugzarv-detail">
                  <table className="bugzarv-kv">
                    <tbody>
                      <Row k="Name" v={e.name} />
                      <Row k="Type" v={`${CAT_LABEL[cat]} (${e.initiatorType})`} />
                      <Row k="Protocol" v={e.nextHopProtocol || '—'} />
                      <Row k="Start" v={fmtMs(e.startTime)} />
                      <Row k="Duration" v={fmtMs(e.duration)} />
                      <Row k="Transfer size" v={fmtSize(e.transferSize)} />
                      <Row k="Encoded body" v={fmtSize(e.encodedBodySize)} />
                      <Row k="Decoded body" v={fmtSize(e.decodedBodySize)} />
                      {e.responseStatus != null ? <Row k="Status" v={e.responseStatus} /> : null}
                      {e.deliveryType ? <Row k="Delivery" v={e.deliveryType} /> : null}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
