// A2 — deterministic reproduction steps for the viewer's Steps panel.
//
// The rrweb INTERPRETATION (snapshot indexing, radio/checkbox + synthesized-
// click de-dup, ancestry collapse) is shared with the backend in
// `@bugzar/shared` (`extractReproActions`) so the two surfaces can't drift. This
// file only does the VIEWER-specific parts: English labels, ×N run-collapsing,
// and ending on the observed failure.
//
// Session-mode only: a design-mode export ships a 2-event snapshot with no
// interactions, so this yields []. No fabricated input — rrweb-masked values are
// labelled, never invented.

import { type ActionTarget, extractReproActions, type ReproAction } from '@bugzar/shared';
import { deriveDiagnostics } from './diagnostics';
import type { ReportData } from './types';

const MAX_STEPS = 12;

export interface ReproStep {
  /** ms from session start — clicking the step seeks the player here. */
  t: number;
  text: string;
}

/** Identifier-first hint: data-testid → aria-label → role → first non-utility class. */
function buildHint(target: ActionTarget): string {
  if (target.testId) return `[data-testid="${target.testId}"]`;
  if (target.ariaLabel) return `[aria-label="${target.ariaLabel.slice(0, 30)}"]`;
  if (target.role) return `[role="${target.role}"]`;
  if (target.className) {
    const first = target.className.split(/\s+/).find((c) => c && !c.startsWith('css-'));
    if (first) return `${target.tag}.${first}`;
  }
  return target.tag;
}

function describeTarget(target: ActionTarget | null): string {
  if (!target) return '(unknown element)';
  const text = target.text ? ` "${target.text}"` : '';
  const hint = buildHint(target);
  return `[${target.tag}${text}${hint !== target.tag ? ` — ${hint}` : ''}]`;
}

function actionToText(a: ReproAction): string {
  if (a.kind === 'navigate') return `Navigate to ${a.href}`;
  if (a.kind === 'type') {
    const suffix = a.masked ? ' (value masked)' : a.value ? ` "${a.value}"` : '';
    return `Type into ${describeTarget(a.target)}${suffix}`;
  }
  return `Click ${describeTarget(a.target)}`;
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
 * Build human reproduction steps: the full user-action trail with the observed
 * failure marked in place, capped to the most recent MAX_STEPS. Empty for
 * design-mode / no-interaction reports. Deterministic.
 */
export function extractReproSteps(data: ReportData): ReproStep[] {
  const sessionStart = data.meta?.startedAt ?? 0;
  const actions = collapseRuns(
    extractReproActions(data.events, sessionStart).map((a) => ({ t: a.t, text: actionToText(a) })),
  );
  if (actions.length === 0) return [];

  const d = deriveDiagnostics(data);
  const failureT = d.jump?.t ?? null;

  // Show the FULL action trail — users expect to see everything they did, not
  // only the actions before the failure. Mark the observed failure IN PLACE (at
  // its moment) so the climax is visible without dropping later actions.
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
