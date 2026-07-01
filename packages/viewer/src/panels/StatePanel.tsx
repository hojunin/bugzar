import type { StateSnapshot } from '@bugzar/shared';
import { JsonTree } from '../ui/JsonTree';
import { snapshotAt } from './timeline';

export interface StatePanelProps {
  snapshots: StateSnapshot[];
  currentTime: number;
}

export function StatePanel({ snapshots, currentTime }: StatePanelProps) {
  const snap = snapshotAt(snapshots, currentTime) ?? snapshots[0] ?? null;
  if (!snap) return <div className="bugzarv-empty">No state captured.</div>;
  return <JsonTree data={snap.data} />;
}
