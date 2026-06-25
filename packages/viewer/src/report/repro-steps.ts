// A2 — deterministic reproduction steps from raw rrweb events. Two halves:
//   1) ACTION EXTRACTION (ported from the backend's buildTimeline): index the
//      FullSnapshot (type===2) node map, then resolve MouseInteraction/Input
//      target ids to identifier-first labels `[tag "text" — hint]`.
//   2) CURATION (NEW, viewer-only — the backend leaves this to an LLM, so there
//      is no function to reuse): window to the failure, dedup, mask-safe input,
//      end on the observed symptom.
//
// Session-mode only: a design-mode export ships a 2-event snapshot with no
// interactions, so this yields []. No fabricated input — rrweb-masked values are
// labelled, never invented.

import type { RrwebEvent } from '@bugzar/shared';
import { deriveDiagnostics } from './diagnostics';
import type { ReportData } from './types';

const MAX_STEPS = 12;

export interface ReproStep {
  /** ms from session start — clicking the step seeks the player here. */
  t: number;
  text: string;
}

// --- ported node-map indexing (mirrors backend jira-draft.ts) ---

interface SerializedNode {
  type?: number;
  id?: number;
  tagName?: string;
  attributes?: Record<string, string | number | boolean | null>;
  textContent?: string;
  childNodes?: SerializedNode[];
}
interface ElementInfo {
  tag: string;
  text: string;
  hint: string;
  /** Node is inside Bugzar's own recorder UI (class `bugzar-…`) — not a repro step. */
  isBugzar: boolean;
}

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

function buildHint(
  tag: string,
  attrs: Record<string, string | number | boolean | null> | undefined,
): string {
  if (!attrs) return tag;
  const testId = attrs['data-testid'] ?? attrs['data-test'] ?? attrs['data-cy'];
  if (typeof testId === 'string' && testId) return `[data-testid="${testId}"]`;
  const aria = attrs['aria-label'];
  if (typeof aria === 'string' && aria) return `[aria-label="${aria.slice(0, 30)}"]`;
  const role = attrs.role;
  if (typeof role === 'string' && role) return `[role="${role}"]`;
  const className = attrs.class ?? attrs.className;
  if (typeof className === 'string' && className) {
    const first = className.split(/\s+/).find((c) => c && !c.startsWith('css-'));
    if (first) return `${tag}.${first}`;
  }
  return tag;
}

const classOf = (n: SerializedNode): string => {
  const c = n.attributes?.class ?? n.attributes?.className;
  return typeof c === 'string' ? c : '';
};

function walkSnapshot(
  node: SerializedNode | undefined,
  index: Map<number, ElementInfo>,
  inBugzar = false,
): void {
  if (!node) return;
  // Bugzar's widget root carries a `bugzar-` class — mark it and everything under
  // it so clicks anywhere in the recorder toolbar are excluded from repro steps.
  const bugzar = inBugzar || /\bbugzar-/.test(classOf(node));
  if (node.type === 2 && typeof node.id === 'number' && typeof node.tagName === 'string') {
    index.set(node.id, {
      tag: node.tagName.toLowerCase(),
      text: collectInnerText(node).trim().replace(/\s+/g, ' '),
      hint: buildHint(node.tagName.toLowerCase(), node.attributes),
      isBugzar: bugzar,
    });
  }
  for (const child of node.childNodes ?? []) walkSnapshot(child, index, bugzar);
}

function indexFullSnapshots(events: RrwebEvent[]): Map<number, ElementInfo> {
  const index = new Map<number, ElementInfo>();
  for (const ev of events) {
    const e = ev as { type?: number; data?: { node?: SerializedNode } };
    if (e?.type !== 2) continue;
    walkSnapshot(e.data?.node, index);
  }
  return index;
}

function describeTarget(node: ElementInfo | undefined): string {
  if (!node) return '(unknown element)';
  const text = node.text ? ` "${node.text}"` : '';
  const hint = node.hint !== node.tag ? ` — ${node.hint}` : '';
  return `[${node.tag}${text}${hint}]`;
}

/** rrweb strict-masks input values to runs of `*`; never invent a real value. */
const isMasked = (v: string): boolean => /^\*+$/.test(v);

/** Skip Bugzar's own recorder UI and bare background (html/body) clicks. */
const skipTarget = (info: ElementInfo | undefined): boolean =>
  !!info && (info.isBugzar || info.tag === 'html' || info.tag === 'body');

// --- extraction + curation ---

function extractActions(events: RrwebEvent[], sessionStart: number): ReproStep[] {
  const idx = indexFullSnapshots(events);
  const out: ReproStep[] = [];
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
        if (lastUrl !== undefined) out.push({ t, text: `Navigate to ${e.data.href}` });
        lastUrl = e.data.href;
      }
      continue;
    }
    if (e.type !== 3) continue;
    const source = e.data?.source;
    if (source === 2 && e.data?.type === 2 && typeof e.data?.id === 'number') {
      const info = idx.get(e.data.id);
      if (skipTarget(info)) continue; // recorder toolbar / background click
      out.push({ t, text: `Click ${describeTarget(info)}` });
    } else if (source === 5 && typeof e.data?.id === 'number') {
      const info = idx.get(e.data.id);
      if (skipTarget(info)) continue;
      const raw = typeof e.data.text === 'string' ? e.data.text : '';
      const suffix = !raw ? '' : isMasked(raw) ? ' (value masked)' : ` "${raw.slice(0, 40)}"`;
      out.push({ t, text: `Type into ${describeTarget(info)}${suffix}` });
    }
  }
  return out;
}

/**
 * Collapse CONSECUTIVE identical actions into one, annotated `(×N)`. Repeated
 * clicks on the same target (e.g. Count pressed 5×) are real and must be counted,
 * not dropped — only a same-text run is merged (interleaved actions are kept).
 */
function collapseRuns(actions: ReproStep[]): ReproStep[] {
  const out: ReproStep[] = [];
  for (let i = 0; i < actions.length; ) {
    let j = i + 1;
    while (j < actions.length && actions[j]?.text === actions[i]?.text) j++;
    const base = actions[i] as ReproStep;
    const n = j - i;
    out.push(n > 1 ? { t: base.t, text: `${base.text} (×${n})` } : base);
    i = j;
  }
  return out;
}

/**
 * Build human reproduction steps: windowed user actions ending on the observed
 * failure. Empty for design-mode / no-interaction reports. Deterministic.
 */
export function extractReproSteps(data: ReportData): ReproStep[] {
  const sessionStart = data.meta?.startedAt ?? 0;
  const actions = collapseRuns(extractActions(data.events, sessionStart));
  if (actions.length === 0) return [];

  const d = deriveDiagnostics(data);
  const failureT = d.jump?.t ?? null;

  // Show the FULL action trail — users expect to see everything they did, not
  // only the actions before the failure. Mark the observed failure IN PLACE (at
  // its moment) so the climax is visible without dropping later actions; cap to
  // the most recent MAX_STEPS.
  const steps: ReproStep[] = [...actions];
  if (d.severity !== 'ok' && failureT != null) {
    const obs: ReproStep = { t: failureT, text: `Observed: ${d.headline}` };
    const at = steps.findIndex((s) => s.t > failureT);
    if (at === -1) steps.push(obs);
    else steps.splice(at, 0, obs);
  }
  return steps.slice(-MAX_STEPS);
}

/** Step text only — for folding into the AI-context copy (B1). */
export const reproStepText = (steps: ReproStep[]): string[] => steps.map((s) => s.text);
