// Collapsible JSON tree — each object/array node folds independently. Strings
// that themselves hold JSON (e.g. a serialized `body`) are parsed and shown as
// nested trees. Deep/large nodes start collapsed; huge arrays are capped.

import { useState } from 'react';

const OPEN_DEPTH = 3; // expandable nodes at/below this depth start collapsed
const SIZE_THRESHOLD = 30; // objects/arrays larger than this start collapsed
const MAX_CHILDREN = 200; // cap rendered children of one node

type Container = Record<string, unknown> | unknown[];

const isContainer = (v: unknown): v is Container => v !== null && typeof v === 'object';

/** If a string holds a JSON object/array, parse it; otherwise return as-is. */
export function maybeJson(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (t[0] !== '{' && t[0] !== '[') return v;
  try {
    const parsed = JSON.parse(t);
    return isContainer(parsed) ? parsed : v;
  } catch {
    return v;
  }
}

const entriesOf = (v: Container): [string, unknown][] =>
  Array.isArray(v) ? v.map((x, i) => [String(i), x]) : Object.entries(v);

function Primitive({ value }: { value: unknown }) {
  if (value === null) return <span className="bugzarv-json-null">null</span>;
  if (value === undefined) return <span className="bugzarv-json-null">undefined</span>;
  const t = typeof value;
  if (t === 'string') return <span className="bugzarv-json-str">"{value as string}"</span>;
  if (t === 'number') return <span className="bugzarv-json-num">{String(value)}</span>;
  if (t === 'boolean') return <span className="bugzarv-json-bool">{String(value)}</span>;
  return <span>{String(value)}</span>;
}

interface NodeProps {
  name: string | null;
  value: unknown;
  path: string;
  depth: number;
  overrides: Set<string>;
  toggle: (p: string) => void;
}

function JsonNode({ name, value: raw, path, depth, overrides, toggle }: NodeProps) {
  const value = maybeJson(raw);
  const label = name !== null ? <span className="bugzarv-json-key">{name}:</span> : null;
  const indent = { paddingLeft: `${depth * 14}px` };

  if (!isContainer(value)) {
    return (
      <div className="bugzarv-json-row" style={indent}>
        {label} <Primitive value={value} />
      </div>
    );
  }

  const entries = entriesOf(value);
  const base = depth >= OPEN_DEPTH || entries.length > SIZE_THRESHOLD;
  const collapsed = overrides.has(path) ? !base : base;
  const [ob, cb] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
  const shown = entries.slice(0, MAX_CHILDREN);
  const more = entries.length - shown.length;

  return (
    <div className="bugzarv-json-node">
      <button
        type="button"
        className="bugzarv-json-row bugzarv-json-toggle"
        style={indent}
        aria-expanded={!collapsed}
        onClick={() => toggle(path)}
      >
        <span className="bugzarv-json-disc">{collapsed ? '▸' : '▾'}</span>
        {label}{' '}
        <span className="bugzarv-json-sum">{`${ob}${collapsed ? '…' : ''}${cb} ${entries.length}`}</span>
      </button>
      {collapsed
        ? null
        : shown.map(([k, v]) => (
            <JsonNode
              key={k}
              name={k}
              value={v}
              path={`${path}.${k}`}
              depth={depth + 1}
              overrides={overrides}
              toggle={toggle}
            />
          ))}
      {!collapsed && more > 0 ? (
        <div
          className="bugzarv-json-row bugzarv-json-more"
          style={{ paddingLeft: `${(depth + 1) * 14}px` }}
        >
          … {more} more
        </div>
      ) : null}
    </div>
  );
}

export function JsonTree({ data }: { data: unknown }) {
  const [overrides, setOverrides] = useState<Set<string>>(() => new Set());
  const toggle = (p: string) =>
    setOverrides((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  return (
    <div className="bugzarv-json">
      <JsonNode name={null} value={data} path="$" depth={0} overrides={overrides} toggle={toggle} />
    </div>
  );
}
