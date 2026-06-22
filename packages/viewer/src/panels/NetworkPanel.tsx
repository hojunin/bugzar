import type { NetworkEntryPayload } from '@bugzar/shared';
import { type ReactNode, useState } from 'react';
import { JsonTree, maybeJson } from '../ui/JsonTree';
import { matchesQuery } from './filters';
import { isThirdParty } from './third-party';
import { activeIndex, isFuture } from './timeline';

export interface NetworkPanelProps {
  entries: NetworkEntryPayload[];
  query: string;
  currentTime: number;
  onSeek: (tFromStart: number) => void;
  /** Include third-party (datadog/amplitude/…) requests. Default false (hidden). */
  includeThirdParty?: boolean;
}

const fmtDur = (ms: number | null) => (ms != null ? `${Math.round(ms)} ms` : '—');

/** Status → colored tag bucket (2xx/3xx/4xx/5xx, plus error/pending). */
function statusTag(status: number | null, error: string | null): { cls: string; label: string } {
  if (error) return { cls: 'bugzarv-tag-err', label: 'ERR' };
  if (status == null) return { cls: 'bugzarv-tag-pending', label: '(pending)' };
  const bucket =
    status >= 500
      ? '5xx'
      : status >= 400
        ? '4xx'
        : status >= 300
          ? '3xx'
          : status >= 200
            ? '2xx'
            : 'info';
  return { cls: `bugzarv-tag-${bucket}`, label: String(status) };
}

function HeadersTable({ headers }: { headers: Record<string, string> }) {
  const items = Object.entries(headers);
  if (items.length === 0) return <div className="bugzarv-net-empty">—</div>;
  return (
    <table className="bugzarv-kv">
      <tbody>
        {items.map(([k, v]) => (
          <tr key={k}>
            <td className="bugzarv-kv-k">{k}</td>
            <td className="bugzarv-kv-v">{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BodyBlock({ body }: { body: string | null }) {
  if (!body) return <div className="bugzarv-net-empty">—</div>;
  const json = maybeJson(body);
  return json !== null && typeof json === 'object' ? (
    <JsonTree data={json} />
  ) : (
    <pre className="bugzarv-detail-body">{body}</pre>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="bugzarv-net-section">
      <h4 className="bugzarv-net-section-title">{title}</h4>
      {children}
    </section>
  );
}

function Detail({ e }: { e: NetworkEntryPayload }) {
  const tag = statusTag(e.status, e.error);
  return (
    <div className="bugzarv-detail">
      <Section title="General">
        <table className="bugzarv-kv">
          <tbody>
            <tr>
              <td className="bugzarv-kv-k">Request URL</td>
              <td className="bugzarv-kv-v">{e.url}</td>
            </tr>
            <tr>
              <td className="bugzarv-kv-k">Method</td>
              <td className="bugzarv-kv-v">{e.method}</td>
            </tr>
            <tr>
              <td className="bugzarv-kv-k">Status</td>
              <td className="bugzarv-kv-v">
                <span className={`bugzarv-tag ${tag.cls}`}>{tag.label}</span>
              </td>
            </tr>
            <tr>
              <td className="bugzarv-kv-k">Duration</td>
              <td className="bugzarv-kv-v">{fmtDur(e.durationMs)}</td>
            </tr>
            <tr>
              <td className="bugzarv-kv-k">Initiator</td>
              <td className="bugzarv-kv-v">{e.initiator}</td>
            </tr>
            {e.error ? (
              <tr>
                <td className="bugzarv-kv-k">Error</td>
                <td className="bugzarv-kv-v bugzarv-status-bad">{e.error}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Section>

      <Section title="Request">
        <h5 className="bugzarv-net-sub">Headers</h5>
        <HeadersTable headers={e.requestHeaders} />
        <h5 className="bugzarv-net-sub">Body</h5>
        <BodyBlock body={e.requestBody} />
      </Section>

      <Section title="Response">
        <h5 className="bugzarv-net-sub">Headers</h5>
        <HeadersTable headers={e.responseHeaders} />
        <h5 className="bugzarv-net-sub">Body</h5>
        <BodyBlock body={e.responseBody} />
      </Section>
    </div>
  );
}

export function NetworkPanel({
  entries,
  query,
  currentTime,
  onSeek,
  includeThirdParty = false,
}: NetworkPanelProps) {
  // Keyed by ORIGINAL entry index — (tFromStart,method,url) can collide, so a
  // content key would dup and break reconciliation when the search/3rd-party
  // filter changes.
  const [open, setOpen] = useState<Set<number>>(new Set());
  const rows = entries
    .map((e, i) => ({ e, i }))
    .filter(
      ({ e }) =>
        (includeThirdParty || !isThirdParty(e.url)) &&
        matchesQuery(`${e.method} ${e.url} ${e.status ?? ''}`, query),
    );
  const active = activeIndex(
    rows.map((r) => r.e),
    currentTime,
  );

  const toggle = (idx: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });

  return (
    <div className="bugzarv-rows">
      {rows.map(({ e, i }, displayIdx) => {
        const isOpen = open.has(i);
        const tag = statusTag(e.status, e.error);
        const cls = [
          'bugzarv-row',
          'bugzarv-net-row',
          isFuture(e, currentTime) && 'bugzarv-row-future',
          displayIdx === active && 'bugzarv-row-active',
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <div key={i} className="bugzarv-row-group">
            <button
              type="button"
              className={cls}
              aria-expanded={isOpen}
              onClick={() => {
                onSeek(e.tFromStart);
                toggle(i);
              }}
            >
              <span className="bugzarv-disclosure">{isOpen ? '▾' : '▸'}</span>
              <span className={`bugzarv-method bugzarv-method-${e.method.toLowerCase()}`}>
                {e.method}
              </span>
              <span className="bugzarv-msg">{e.url}</span>
              <span className={`bugzarv-tag ${tag.cls}`}>{tag.label}</span>
              <span className="bugzarv-time">{fmtDur(e.durationMs)}</span>
            </button>
            {isOpen ? <Detail e={e} /> : null}
          </div>
        );
      })}
    </div>
  );
}
