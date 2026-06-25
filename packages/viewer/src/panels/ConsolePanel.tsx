import type { ConsoleEntry } from '@bugzar/shared';
import { useState } from 'react';
import { formatConsoleErrorForAI } from '../report/ai-context';
import type { ReportData } from '../report/types';
import { CopyForAiButton } from '../ui/CopyForAiButton';
import { JsonTree, maybeJson } from '../ui/JsonTree';
import { matchesQuery } from './filters';
import { isThirdParty } from './third-party';
import { activeIndex, isFuture } from './timeline';

export interface ConsolePanelProps {
  entries: ConsoleEntry[];
  query: string;
  currentTime: number;
  onSeek: (tFromStart: number) => void;
  /** Include third-party (datadog/amplitude/…) logs. Default false (hidden). */
  includeThirdParty?: boolean;
  /** Full report — enables per-error "Copy for AI" (B2). Omit to hide it. */
  report?: ReportData;
}

const fmt = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

const isExpandable = (e: ConsoleEntry): boolean =>
  !!e.stack ||
  e.args.join(' ').length > 80 ||
  e.args.some((a) => {
    const t = a.trim();
    return t.startsWith('{') || t.startsWith('[');
  });

type Leaf = { kind: 'leaf'; entry: ConsoleEntry; idx: number };
type Group = {
  kind: 'group';
  entry: ConsoleEntry;
  idx: number;
  startCollapsed: boolean;
  children: TreeNode[];
};
type TreeNode = Leaf | Group;

/**
 * Rebuild the `console.group` tree from the flat entries — stack-pairing
 * group/groupCollapsed ↔ groupEnd. Pages that never group render flat.
 */
function buildTree(entries: ConsoleEntry[]): TreeNode[] {
  const root: TreeNode[] = [];
  const stack: TreeNode[][] = [root];
  entries.forEach((entry, idx) => {
    const top = stack[stack.length - 1];
    if (!top) return;
    if (entry.level === 'group' || entry.level === 'groupCollapsed') {
      const group: Group = {
        kind: 'group',
        entry,
        idx,
        startCollapsed: entry.level === 'groupCollapsed',
        children: [],
      };
      top.push(group);
      stack.push(group.children);
    } else if (entry.level === 'groupEnd') {
      if (stack.length > 1) stack.pop();
    } else {
      top.push({ kind: 'leaf', entry, idx });
    }
  });
  return root;
}

/** Visible if it matches the search AND (third-party allowed or not third-party). */
function visible(node: TreeNode, query: string, includeTP: boolean): boolean {
  if (node.kind === 'leaf') {
    if (!includeTP && isThirdParty(`${node.entry.level} ${node.entry.args.join(' ')}`))
      return false;
    return !query || matchesQuery(`${node.entry.level} ${node.entry.args.join(' ')}`, query);
  }
  if (!includeTP && isThirdParty(node.entry.args.join(' '))) return false;
  return node.children.some((c) => visible(c, query, includeTP));
}

export function ConsolePanel({
  entries,
  query,
  currentTime,
  onSeek,
  includeThirdParty = false,
  report,
}: ConsolePanelProps) {
  const tree = buildTree(entries);
  const active = activeIndex(entries, currentTime);

  const [collapsed, setCollapsed] = useState<Set<number>>(() => {
    const s = new Set<number>();
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        if (n.kind === 'group') {
          if (n.startCollapsed) s.add(n.idx);
          walk(n.children);
        }
      }
    };
    walk(tree);
    return s;
  });
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const toggleIn = (set: Set<number>, idx: number): Set<number> => {
    const next = new Set(set);
    if (next.has(idx)) next.delete(idx);
    else next.add(idx);
    return next;
  };

  function renderNodes(nodes: TreeNode[], depth: number) {
    return nodes
      .filter((n) => visible(n, query, includeThirdParty))
      .map((n) => (n.kind === 'group' ? renderGroup(n, depth) : renderLeaf(n, depth)));
  }

  function renderGroup(group: Group, depth: number) {
    const isCollapsed = query ? false : collapsed.has(group.idx);
    return (
      <div key={`g${group.idx}`} className="bugzarv-row-group">
        <button
          type="button"
          className="bugzarv-row bugzarv-row-grouphdr"
          style={{ paddingLeft: `${12 + depth * 14}px` }}
          aria-expanded={!isCollapsed}
          onClick={() => {
            if (!query) setCollapsed((prev) => toggleIn(prev, group.idx));
          }}
        >
          <span className="bugzarv-disclosure">{isCollapsed ? '▸' : '▾'}</span>
          <span className="bugzarv-badge bugzarv-badge-group">group</span>
          <span className="bugzarv-time">{fmt(group.entry.tFromStart)}</span>
          <span className="bugzarv-msg">{group.entry.args.join(' ')}</span>
        </button>
        {isCollapsed ? null : renderNodes(group.children, depth + 1)}
      </div>
    );
  }

  function renderLeaf(leaf: Leaf, depth: number) {
    const e = leaf.entry;
    const open = expanded.has(leaf.idx);
    const canExpand = isExpandable(e);
    const cls = [
      'bugzarv-row',
      e.level === 'error' && 'bugzarv-row-error',
      isFuture(e, currentTime) && 'bugzarv-row-future',
      leaf.idx === active && 'bugzarv-row-active',
    ]
      .filter(Boolean)
      .join(' ');
    return (
      <div key={`l${leaf.idx}`} className="bugzarv-row-group">
        <button
          type="button"
          className={cls}
          style={{ paddingLeft: `${12 + depth * 14}px` }}
          aria-expanded={canExpand ? open : undefined}
          onClick={() => {
            onSeek(e.tFromStart);
            if (canExpand) setExpanded((prev) => toggleIn(prev, leaf.idx));
          }}
        >
          <span className="bugzarv-disclosure">{canExpand ? (open ? '▾' : '▸') : ''}</span>
          <span className={`bugzarv-badge${e.level === 'error' ? ' bugzarv-badge-error' : ''}`}>
            {e.level}
          </span>
          {e.kind === 'unhandledrejection' ? (
            <span className="bugzarv-kind" title="unhandled rejection">
              rejection
            </span>
          ) : null}
          {e.kind === 'csp' ? (
            <span className="bugzarv-kind" title="CSP violation">
              CSP
            </span>
          ) : null}
          <span className="bugzarv-time">{fmt(e.tFromStart)}</span>
          <span className="bugzarv-msg">{e.args.join(' ')}</span>
        </button>
        {open ? (
          <div className="bugzarv-detail">
            {report && e.level === 'error' ? (
              <div className="bugzarv-detail-copy">
                <CopyForAiButton getText={() => formatConsoleErrorForAI(e, report)} />
              </div>
            ) : null}
            {e.args.map((a) => {
              const json = maybeJson(a);
              return json !== null && typeof json === 'object' ? (
                <JsonTree key={a} data={json} />
              ) : (
                <div key={a} className="bugzarv-json-row bugzarv-json-arg">
                  {a}
                </div>
              );
            })}
            {e.stack ? <pre className="bugzarv-detail-body">{e.stack}</pre> : null}
            {e.source ? (
              <div className="bugzarv-detail-meta">
                source: {e.source.file}:{e.source.line}:{e.source.col}
              </div>
            ) : null}
            {e.cause ? <pre className="bugzarv-detail-body">{e.cause}</pre> : null}
          </div>
        ) : null}
      </div>
    );
  }

  return <div className="bugzarv-rows">{renderNodes(tree, 0)}</div>;
}
