// Deterministic interpretation of raw rrweb events into normalized user actions.
// THE single source of truth shared by the viewer (human-readable Steps panel)
// and the backend (Jira / AI draft). Each consumer formats + curates these
// language-agnostic actions itself; the hard part — mapping noisy low-level DOM
// events to ONE logical user action — lives here so the two surfaces can't drift.
//
// Why this normalization is necessary (grounded in rrweb's own observers):
//   • rrweb records EVERY click DOM event (capture phase, composedPath target)
//     with no de-dup and no `userTriggered` flag. So a custom (design-system)
//     radio/checkbox fires a click on the styled control + browser-synthesized
//     clicks on the hidden native <input> + bubbled container clicks — all as
//     separate events for ONE physical click.
//   • rrweb's Input event also fires for radio/checkbox value-changes, where
//     `text` is the control's `value` ("on"/"5") — a selection, not typing. It
//     even cross-fires sibling radios (isChecked:false) when a group changes.
// We therefore: drop radio/checkbox input echoes, drop synthesized native-input
// clicks, climb a click to its nearest real control, and merge clicks landing on
// the same DOM lineage within a short window into one action.

import type { RrwebEvent } from './bundle';

/** A resolved interaction target — raw identity so each consumer builds its own label. */
export interface ActionTarget {
  tag: string;
  text: string;
  testId?: string;
  ariaLabel?: string;
  role?: string;
  className?: string;
  /** Lowercased `type` attr for `<input>` — radio/checkbox are selections, not typing. */
  inputType?: string;
  /** A control worth climbing to as a click's representative (button/a/input/[role=radio…]). */
  interactive: boolean;
  /** Carries its own identity (interactive | role | test-id | aria) — wins over a bare container. */
  specific: boolean;
}

export type ReproAction =
  | { kind: 'navigate'; t: number; href: string }
  | { kind: 'click'; t: number; target: ActionTarget | null }
  | { kind: 'type'; t: number; target: ActionTarget | null; value: string; masked: boolean };

// --- snapshot indexing ---

interface SerializedNode {
  type?: number;
  id?: number;
  tagName?: string;
  attributes?: Record<string, string | number | boolean | null>;
  textContent?: string;
  childNodes?: SerializedNode[];
}

interface NodeInfo extends ActionTarget {
  /** Inside Bugzar's own recorder UI (class `bugzar-…`) — never a repro step. */
  isBugzar: boolean;
}

interface SnapshotIndex {
  info: Map<number, NodeInfo>;
  /** child id → parent element id (for ancestry-based de-duplication). */
  parent: Map<number, number>;
}

const INTERACTIVE_TAGS = new Set([
  'button',
  'a',
  'input',
  'select',
  'textarea',
  'label',
  'summary',
]);
const INTERACTIVE_ROLES = new Set([
  'button',
  'radio',
  'checkbox',
  'switch',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'link',
  'option',
]);
/** Browser-synthesized native-input clicks fire within a few ms of the real one. */
const SYNTH_MS = 250;
/** A wrapper/container click and its inner control click belong to one interaction. */
const CLUSTER_MS = 800;
/** rrweb masks input values to runs of `*` (and a few other glyphs) — never invent a value. */
const MASKED_VALUE = /^[*•·\s]+$/;

function collectInnerText(node: SerializedNode | undefined, budget = 60): string {
  if (!node || budget <= 0) return '';
  if (node.type === 3 && typeof node.textContent === 'string')
    return node.textContent.slice(0, budget);
  let acc = '';
  for (const child of node.childNodes ?? []) {
    if (acc.length >= budget) break;
    acc += collectInnerText(child, budget - acc.length);
  }
  return acc;
}

const strAttr = (
  attrs: Record<string, string | number | boolean | null> | undefined,
  key: string,
): string | undefined => {
  const v = attrs?.[key];
  return typeof v === 'string' && v ? v : undefined;
};

function walkSnapshot(
  node: SerializedNode | undefined,
  idx: SnapshotIndex,
  inBugzar = false,
  parentId?: number,
): void {
  if (!node) return;
  const className = strAttr(node.attributes, 'class') ?? strAttr(node.attributes, 'className');
  const bugzar = inBugzar || (!!className && /\bbugzar-/.test(className));
  let elementId = parentId;
  if (node.type === 2 && typeof node.id === 'number' && typeof node.tagName === 'string') {
    const tag = node.tagName.toLowerCase();
    const attrs = node.attributes;
    const role = strAttr(attrs, 'role');
    const testId =
      strAttr(attrs, 'data-testid') ?? strAttr(attrs, 'data-test') ?? strAttr(attrs, 'data-cy');
    const ariaLabel = strAttr(attrs, 'aria-label');
    const inputType =
      tag === 'input' && typeof attrs?.type === 'string' ? attrs.type.toLowerCase() : undefined;
    const interactive = INTERACTIVE_TAGS.has(tag) || (!!role && INTERACTIVE_ROLES.has(role));
    idx.info.set(node.id, {
      tag,
      text: collectInnerText(node).trim().replace(/\s+/g, ' '),
      ...(testId ? { testId } : {}),
      ...(ariaLabel ? { ariaLabel } : {}),
      ...(role ? { role } : {}),
      ...(className ? { className } : {}),
      ...(inputType ? { inputType } : {}),
      interactive,
      specific: interactive || !!role || !!testId || !!ariaLabel,
      isBugzar: bugzar,
    });
    if (parentId !== undefined) idx.parent.set(node.id, parentId);
    elementId = node.id;
  }
  for (const child of node.childNodes ?? []) walkSnapshot(child, idx, bugzar, elementId);
}

function indexFullSnapshots(events: RrwebEvent[]): SnapshotIndex {
  const idx: SnapshotIndex = { info: new Map(), parent: new Map() };
  for (const ev of events) {
    const e = ev as { type?: number; data?: { node?: SerializedNode } };
    if (e?.type !== 2) continue;
    walkSnapshot(e.data?.node, idx);
  }
  return idx;
}

// --- ancestry helpers ---

/** Nearest ancestor-or-self that is a real control — the click's representative. */
function climb(id: number, idx: SnapshotIndex): number {
  let cur: number | undefined = id;
  for (let i = 0; i <= 4 && cur !== undefined; i++) {
    if (idx.info.get(cur)?.interactive) return cur;
    cur = idx.parent.get(cur);
  }
  return id;
}

const isAncestor = (a: number, b: number, parent: Map<number, number>): boolean => {
  let cur = parent.get(b);
  while (cur !== undefined) {
    if (cur === a) return true;
    cur = parent.get(cur);
  }
  return false;
};
/** a and b are on the same lineage (one contains the other) — same logical target. */
const related = (a: number, b: number, parent: Map<number, number>): boolean =>
  a !== b && (isAncestor(a, b, parent) || isAncestor(b, a, parent));

const skip = (info: NodeInfo | undefined): boolean =>
  !!info && (info.isBugzar || info.tag === 'html' || info.tag === 'body');
const isFormControl = (info: NodeInfo | undefined): boolean =>
  info?.tag === 'input' && (info.inputType === 'radio' || info.inputType === 'checkbox');

interface PendingClick {
  t: number;
  repId: number;
  target: NodeInfo;
}

/**
 * Turn raw rrweb events into normalized user actions (navigate / click / type),
 * with the noise from custom form controls and bubbled container clicks removed.
 * Deterministic; returns [] for a no-interaction (design-mode) report.
 */
export function extractReproActions(events: RrwebEvent[], sessionStart: number): ReproAction[] {
  const idx = indexFullSnapshots(events);
  // All real click times — to spot browser-synthesized native-input clicks.
  const clickTimes: { t: number; id: number }[] = [];
  for (const ev of events) {
    const e = ev as {
      type?: number;
      timestamp?: number;
      data?: { source?: number; id?: number; type?: number };
    };
    if (
      e?.type === 3 &&
      e.data?.source === 2 &&
      e.data?.type === 2 &&
      typeof e.data?.id === 'number'
    )
      clickTimes.push({ t: (e.timestamp ?? 0) - sessionStart, id: e.data.id });
  }

  // Clicks carry repId/target so we can collapse one interaction split across nodes;
  // type/navigate pass through untouched (no ancestry merge).
  const clicks: PendingClick[] = [];
  const others: ReproAction[] = [];
  let lastUrl: string | undefined;

  for (const ev of events) {
    const e = ev as {
      type?: number;
      timestamp?: number;
      data?: { href?: string; source?: number; id?: number; text?: string; type?: number };
    };
    if (typeof e?.timestamp !== 'number') continue;
    const t = e.timestamp - sessionStart;

    if (e.type === 4 && typeof e.data?.href === 'string') {
      if (e.data.href !== lastUrl) {
        if (lastUrl !== undefined) others.push({ kind: 'navigate', t, href: e.data.href });
        lastUrl = e.data.href;
      }
      continue;
    }
    if (e.type !== 3) continue;
    const source = e.data?.source;

    if (source === 5 && typeof e.data?.id === 'number') {
      const info = idx.info.get(e.data.id);
      if (skip(info)) continue;
      // A radio/checkbox value-change is the echo of a click, not typing — drop it.
      if (isFormControl(info)) continue;
      const raw = typeof e.data.text === 'string' ? e.data.text.slice(0, 40) : '';
      const masked = !!raw && MASKED_VALUE.test(raw);
      others.push({ kind: 'type', t, target: info ?? null, value: masked ? '' : raw, masked });
      continue;
    }

    if (source === 2 && e.data?.type === 2 && typeof e.data?.id === 'number') {
      const id = e.data.id;
      const info = idx.info.get(id);
      if (skip(info)) continue;
      // Drop the browser-synthesized click on the hidden native radio/checkbox
      // input — the user clicked the styled control, which fires alongside it.
      if (
        isFormControl(info) &&
        clickTimes.some((c) => c.id !== id && Math.abs(c.t - t) <= SYNTH_MS)
      )
        continue;
      const repId = climb(id, idx);
      const rep = idx.info.get(repId);
      if (skip(rep) || !rep) continue;
      // Fold into a nearby click on the same lineage (label / wrapper / control /
      // container of one physical interaction), keeping the more specific target.
      const near = clicks.find(
        (c) => Math.abs(c.t - t) <= CLUSTER_MS && related(repId, c.repId, idx.parent),
      );
      if (near) {
        const deeper = isAncestor(near.repId, repId, idx.parent);
        if (
          (rep.specific && !near.target.specific) ||
          (rep.specific === near.target.specific && deeper)
        ) {
          near.t = t;
          near.repId = repId;
          near.target = rep;
        }
        continue;
      }
      clicks.push({ t, repId, target: rep });
    }
  }

  const clickActions: ReproAction[] = clicks.map((c) => ({
    kind: 'click',
    t: c.t,
    target: c.target,
  }));
  // Merging can move a click's time forward; restore chronological order across all actions.
  return [...others, ...clickActions].sort((a, b) => a.t - b.t);
}
