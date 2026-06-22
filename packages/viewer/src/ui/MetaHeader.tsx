import type { ReportMeta } from '../report/types';

const pad = (n: number): string => String(n).padStart(2, '0');

/** Local `YYYY-MM-DD HH:MM:SS` — readable at a glance, no timezone noise. */
function formatCapturedAt(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Top bar: captured URL · captured-at · duration · viewport. Session-only fields
 * (startedAt/durationMs/viewport) are absent on design reports — guard each so a
 * design report renders its URL instead of crashing on `new Date(undefined)`.
 */
export function MetaHeader({ meta }: { meta: ReportMeta | null }) {
  if (!meta) return <header className="bugzarv-meta" />;
  // ReportMeta types these as required (SessionMeta), but design reports omit them.
  const m = meta as Partial<ReportMeta>;
  const startedAt = Number(m.startedAt);
  const capturedAt = Number.isFinite(startedAt) ? formatCapturedAt(startedAt) : null;
  const durationMs = Number(m.durationMs);
  const durationS = Number.isFinite(durationMs) ? `${(durationMs / 1000).toFixed(1)}s` : null;
  const viewport = m.viewport ? `${m.viewport.width}×${m.viewport.height}` : null;
  return (
    <header className="bugzarv-meta">
      {m.url ? (
        <span className="bugzarv-meta-url" title={m.url}>
          {m.url}
        </span>
      ) : null}
      {capturedAt ? <span className="bugzarv-meta-field">{capturedAt}</span> : null}
      {durationS ? <span className="bugzarv-meta-field">{durationS}</span> : null}
      {viewport ? <span className="bugzarv-meta-field">{viewport}</span> : null}
    </header>
  );
}
