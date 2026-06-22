import type { StorageSnapshotPayload } from '@bugzar/shared';
import { JsonTree } from '../ui/JsonTree';
import { snapshotAt } from './timeline';

export interface StoragePanelProps {
  snapshots: StorageSnapshotPayload[];
  currentTime: number;
}

/** `a=1; b=2` → `{ a: '1', b: '2' }`. */
function parseCookies(cookies: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of cookies.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (k) out[k] = part.slice(eq + 1).trim();
  }
  return out;
}

/** Always render the store (so all three are visible); empty → a muted note. */
function Section({ title, data }: { title: string; data: Record<string, string> }) {
  const n = Object.keys(data).length;
  return (
    <div className="bugzarv-storage-section">
      <h3 className="bugzarv-card-tag">
        {title} <span className="bugzarv-storage-count">{n}</span>
      </h3>
      {n === 0 ? <div className="bugzarv-storage-empty">(empty)</div> : <JsonTree data={data} />}
    </div>
  );
}

export function StoragePanel({ snapshots, currentTime }: StoragePanelProps) {
  const snap = snapshotAt(snapshots, currentTime) ?? snapshots[0] ?? null;
  if (!snap) return <div className="bugzarv-empty">No storage captured.</div>;
  return (
    <div className="bugzarv-storage">
      <Section title="localStorage" data={snap.localStorage} />
      <Section title="sessionStorage" data={snap.sessionStorage} />
      <Section title="cookies" data={parseCookies(snap.cookies)} />
    </div>
  );
}
