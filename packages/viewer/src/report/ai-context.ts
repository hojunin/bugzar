// AI-context formatters (B1 / B2). Turn a report — or a single error/request —
// into a curated, token-efficient Markdown block to paste into a coding agent
// (Cursor / Claude Code). Symptom-first: lead with what broke, then the failing
// request WITH its request payload + response body (R1a), then errors+stack,
// reproduction, and a "where to look" digest of OBSERVED facts only (R1c — no
// file/component guessing, which would just mislead the agent).
//
// Safety: captured data is already redacted at capture time (per-value, inline).
// These outputs add nothing that bypasses that boundary, and every assembled
// string gets a final `redactFreeText` pass. Surfacing full bodies widens the
// blast radius of capture-time key-list gaps (benign-key PII like email/ssn is
// NOT masked by the capture key-list) — a documented capture-layer limitation,
// tested adversarially for the patterns we DO catch (JWT/Bearer).

import { type ConsoleEntry, type NetworkEntryPayload, redactFreeText } from '@bugzar/shared';
import {
  type Diagnostics,
  deriveDiagnostics,
  isFailedRequest,
  requestHeadline,
} from './diagnostics';
import type { ReportData } from './types';

const ERROR_CAP = 10;
const FAILED_CAP = 8;
const FRAME_CAP = 4;
/** Correlation window for "what failed around this moment". */
const CORRELATE_MS = 2500;
/** Total budget for full request+response bodies in the session copy (R1a). */
const FULL_BODY_BUDGET = 3000;
/** Per-item full body cap (per-item copy, or a single session item). */
const PER_ITEM_CAP = 2000;

const is5xx = (n: NetworkEntryPayload): boolean => n.status != null && n.status >= 500;

/** Top stack frames (already-redacted), trimmed — symbolication is out of scope. */
function topFrames(stack: string | undefined): string[] {
  if (!stack) return [];
  return stack
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, FRAME_CAP);
}

/**
 * Pull the human error hint OUT OF the already-redacted `responseBody` string
 * (no re-fetch / re-derivation): a JSON `message|error|code|…`, else a short
 * prefix. Redacted again so an un-patterned token in an error body can't leak.
 */
export function extractErrorHint(body: string | null): string {
  if (!body) return '';
  const t = body.trim();
  let hint = '';
  try {
    const j = JSON.parse(t) as Record<string, unknown>;
    if (j && typeof j === 'object') {
      for (const k of ['message', 'error_description', 'detail', 'error', 'title', 'code']) {
        const v = j[k];
        if (typeof v === 'string' && v.trim()) {
          hint = v.trim();
          break;
        }
        if (typeof v === 'number') {
          hint = String(v);
          break;
        }
      }
    }
  } catch {
    /* not JSON — fall through to a prefix */
  }
  if (!hint) hint = t.length > 120 ? `${t.slice(0, 120)}…` : t;
  return redactFreeText(hint).replace(/\s+/g, ' ').trim();
}

/**
 * Truncate a (already-redacted) body to `budget` chars while PRESERVING signal:
 * for JSON objects, keep error-relevant keys first; otherwise head+tail so the
 * start (often the error) and the end both survive. Never a blind head slice.
 */
function truncateForCopy(body: string, budget: number): string {
  if (body.length <= budget) return body;
  try {
    const j = JSON.parse(body);
    if (j && typeof j === 'object' && !Array.isArray(j)) {
      const keys = ['error', 'message', 'error_description', 'detail', 'title', 'code', 'errors'];
      const kept: Record<string, unknown> = {};
      for (const k of keys)
        if (k in (j as Record<string, unknown>)) kept[k] = (j as Record<string, unknown>)[k];
      const total = Object.keys(j as Record<string, unknown>).length;
      const compact = JSON.stringify(kept);
      if (Object.keys(kept).length && compact.length <= budget) {
        const omitted = total - Object.keys(kept).length;
        return omitted > 0 ? `${compact}  …[+${omitted} more keys]` : compact;
      }
    }
  } catch {
    /* not JSON */
  }
  const head = Math.floor(budget * 0.6);
  const tail = budget - head;
  return `${body.slice(0, head)}\n…[${body.length - budget} chars omitted]\n${body.slice(body.length - tail)}`;
}

const fence = (s: string): string[] => ['```', s, '```'];

/** A failed request rendered WITH its request payload + response body (R1a). */
function fullRequestBlock(n: NetworkEntryPayload, budget: number): string[] {
  const dur = n.durationMs != null ? ` (${Math.round(n.durationMs)}ms)` : '';
  const out = [`**${requestHeadline(n)}**${dur}`];
  if (n.requestBody) {
    out.push('Request:', ...fence(truncateForCopy(n.requestBody, Math.floor(budget / 2))));
  }
  if (n.responseBody) {
    out.push('Response:', ...fence(truncateForCopy(n.responseBody, Math.ceil(budget / 2))));
  }
  if (n.error) out.push(`Transport error: ${n.error}`);
  if (n.corsLikely) out.push(CORS_NOTE);
  return out;
}

// R2c — heuristic, evidence-bearing (an opaque failure isn't always CORS).
const CORS_NOTE =
  'likely CORS — opaque fetch failure (status 0, no body); check server CORS / proxy';

/** One-line failed request (the non-headline tail). */
function failedLine(n: NetworkEntryPayload): string {
  const hint = extractErrorHint(n.responseBody);
  const cors = n.corsLikely ? ` — ${CORS_NOTE}` : '';
  return `- ${requestHeadline(n)}${hint ? ` — ${hint}` : ''}${cors}`;
}

const firstLine = (c: ConsoleEntry): string => c.args.join(' ').split('\n')[0]?.trim() ?? '';

/** Cap on cause lines folded into the copy (capture already frame-caps each hop). */
const CAUSE_LINE_CAP = 6;

/** A hashed prod bundle (`app.4f3a.js`) — its frames are minified, not symbolic. */
const HASHED_BUNDLE = /\.[a-z0-9]{6,}\.(?:js|mjs|cjs)\b/i;

/** A stack frame usable as a *location* (real source file:line or named fn) —
 *  NOT a minified bundle (`app.4f3a.js`) or a line-1 huge-column bundled frame. */
function isSymbolicFrame(frame: string): boolean {
  if (HASHED_BUNDLE.test(frame)) return false;
  if (/:1:\d{4,}\)?\s*$/.test(frame)) return false;
  return (
    /\.(tsx?|jsx?|vue|svelte):\d+/.test(frame) || /\bat [A-Za-z][A-Za-z0-9_$.]{1,}/.test(frame)
  );
}

function errorLines(e: ConsoleEntry): string[] {
  const label = e.kind === 'unhandledrejection' ? ' (unhandled rejection)' : '';
  const out = [`- ${firstLine(e)}${label}`];
  for (const f of topFrames(e.stack)) out.push(`    ${f}`);
  if (e.source) out.push(`    source: ${e.source.file}:${e.source.line}:${e.source.col}`);
  if (e.cause) for (const l of e.cause.split('\n').slice(0, CAUSE_LINE_CAP)) out.push(`    ${l}`);
  return out;
}

interface AiOpts {
  /** Human reproduction steps (A2). Included verbatim when present. */
  reproSteps?: string[];
}

/** The failed request the diagnostic headline points at (if it's a network lead). */
function headlineRequest(data: ReportData, d: Diagnostics): NetworkEntryPayload | undefined {
  if (d.jump?.tab !== 'network') return undefined;
  return data.network.find((n) => isFailedRequest(n) && n.tFromStart === d.jump?.t);
}

/**
 * Full-session AI context (R1a/R1b/R1c). Order: symptom → failing request(s)
 * (payload+response) → errors(+stack) → reproduction → where-to-look (observed
 * facts only) → environment. Curated, budgeted, redacted, deterministic.
 */
export function formatSessionForAI(data: ReportData, opts: AiOpts = {}): string {
  const d = deriveDiagnostics(data);
  const lines: string[] = [`# Bug report — ${d.headline}`];
  if (d.url) lines.push(`URL: ${d.url}`);
  if (data.meta?.durationMs != null) lines.push(`Session: ${(d.durationMs / 1000).toFixed(1)}s`);
  lines.push('');

  // --- Failing requests: headline + other 5xx get FULL bodies (budgeted,
  // headline first); the rest are one-liners. (R1a)
  const failed = data.network.filter(isFailedRequest);
  if (failed.length) {
    // The "primary" failing request gets a full body: the headline request when
    // the lead IS a network failure, else the failed request correlated with the
    // lead console error (the network failure behind the symptom — e.g. a timeout
    // that surfaced as an unhandled rejection). All 5xx also get full bodies.
    const headline = headlineRequest(data, d);
    const leadT = d.jump?.t;
    const primary =
      headline ??
      (leadT != null
        ? failed.find((n) => Math.abs(n.tFromStart - leadT) <= CORRELATE_MS)
        : undefined);
    const fullSet = new Set<NetworkEntryPayload>();
    if (primary) fullSet.add(primary);
    for (const n of failed) if (is5xx(n)) fullSet.add(n);
    const ordered = [...(primary ? [primary] : []), ...failed.filter((n) => n !== primary)];

    lines.push(`## Failing request${failed.length > 1 ? 's' : ''} (${failed.length})`);
    let budget = FULL_BODY_BUDGET;
    let shownFull = 0;
    for (const n of ordered) {
      if (fullSet.has(n) && budget > 200) {
        const per = Math.min(PER_ITEM_CAP, budget);
        lines.push(...fullRequestBlock(n, per));
        budget -= per;
        shownFull++;
      } else {
        lines.push(failedLine(n));
      }
      if (shownFull >= FAILED_CAP) break;
    }
    lines.push('');
  }

  // --- Errors + stack
  const errors = data.console.filter((c) => c.level === 'error');
  if (errors.length) {
    lines.push(`## Errors (${errors.length})`);
    for (const e of errors.slice(0, ERROR_CAP)) lines.push(...errorLines(e));
    if (errors.length > ERROR_CAP) lines.push(`- …and ${errors.length - ERROR_CAP} more`);
    lines.push('');
  }

  // --- Reproduction
  if (opts.reproSteps?.length) {
    lines.push('## Reproduction');
    opts.reproSteps.forEach((s, i) => {
      lines.push(`${i + 1}. ${s}`);
    });
    lines.push('');
  }

  // --- Where to look: OBSERVED facts only (no file/component guessing — R1c).
  const look = whereToLook(data, d, opts.reproSteps);
  if (look.length) {
    lines.push('## Where to look', ...look, '');
  }

  lines.push('## Environment', d.env);
  return redactFreeText(lines.join('\n').trim());
}

/** Observed pointers — failing endpoint, correlated error, last action, error origin frame. */
function whereToLook(data: ReportData, d: Diagnostics, reproSteps?: string[]): string[] {
  const out: string[] = [];
  const headline = headlineRequest(data, d);
  if (headline) {
    out.push(`- failing endpoint: ${requestHeadline(headline)}`);
    const near = data.console.find(
      (c) => c.level === 'error' && Math.abs(c.tFromStart - headline.tFromStart) <= CORRELATE_MS,
    );
    if (near) {
      const dt = ((near.tFromStart - headline.tFromStart) / 1000).toFixed(1);
      out.push(`- correlated console error at ${dt}s: ${firstLine(near)}`);
    }
  } else if (d.jump?.tab === 'console') {
    // lead is a console error — promote a location ONLY if a SYMBOLIC frame exists
    // (real source file:line / named fn). A minified bundle frame (app.4f3a.js:1:N)
    // is useless and misleading, so it stays cited in the error section, not here.
    const lead = data.console.find((c) => c.level === 'error' && c.tFromStart === d.jump?.t);
    const symbolic = topFrames(lead?.stack).find(isSymbolicFrame);
    if (symbolic) out.push(`- error origin (observed): ${symbolic}`);
  }
  // last user action before the failure (from repro, the step before "Observed:")
  const actions = (reproSteps ?? []).filter((s) => !s.startsWith('Observed:'));
  const last = actions[actions.length - 1];
  if (last) out.push(`- last action: ${last}`);
  return out;
}

/** Failures within ±window of `t` — "what else was happening" (one-liners). */
function correlate(data: ReportData, t: number): string[] {
  const out: string[] = [];
  for (const n of data.network) {
    if (isFailedRequest(n) && Math.abs(n.tFromStart - t) <= CORRELATE_MS) out.push(failedLine(n));
  }
  return out;
}

/** Single console error + frames + nearby failed requests (B2 per-item copy). */
export function formatConsoleErrorForAI(e: ConsoleEntry, data: ReportData): string {
  const lines = ['# Console error', ...errorLines(e)];
  const near = correlate(data, e.tFromStart);
  if (near.length) lines.push('', '## Around this moment', ...near);
  lines.push('', '## Environment', deriveDiagnostics(data).env);
  return redactFreeText(lines.join('\n').trim());
}

/**
 * Single failed request — FULL request payload + response body (R1a per-item:
 * the item the user explicitly copied always gets its full body) + nearby
 * console errors.
 */
export function formatRequestForAI(n: NetworkEntryPayload, data: ReportData): string {
  const lines = ['# Failed request', ...fullRequestBlock(n, PER_ITEM_CAP)];
  const nearErr = data.console.filter(
    (c) => c.level === 'error' && Math.abs(c.tFromStart - n.tFromStart) <= CORRELATE_MS,
  );
  if (nearErr.length) {
    lines.push('', '## Around this moment');
    for (const e of nearErr) lines.push(...errorLines(e));
  }
  lines.push('', '## Environment', deriveDiagnostics(data).env);
  return redactFreeText(lines.join('\n').trim());
}

export type { Diagnostics };
