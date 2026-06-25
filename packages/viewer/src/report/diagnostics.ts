// Diagnostic derivation — promotes the existing console/network/meta signals into
// a one-line "what went wrong" summary for the diagnostic bar (A1). Pure, no DOM,
// no React, NO new capture: everything here is derived from data already in the
// report. The same derivation feeds the AI-context copy (B1).

import type { ConsoleEntry, NetworkEntryPayload, SystemInfo } from '@bugzar/shared';
import type { TabKey } from '../panels/tabs';
import type { ReportData, ReportMeta } from './types';

export interface Diagnostics {
  /** Worst observed signal: a server/script error, a client failure, or none. */
  severity: 'error' | 'warn' | 'ok';
  /** Human headline naming the actual symptom (not a generic string). */
  headline: string;
  /** Where the headline points — so the bar can jump to it. */
  jump: { tab: TabKey; t: number } | null;
  /** console.error count. */
  errorCount: number;
  /** Failed requests: status>=400 or transport error. */
  failedCount: number;
  durationMs: number;
  url: string;
  /** One-line environment: browser · OS · viewport. */
  env: string;
}

/** Failed request: HTTP status >= 400 OR a transport-level error. */
export const isFailedRequest = (n: NetworkEntryPayload): boolean =>
  (n.status != null && n.status >= 400) || n.error != null;
const is5xx = (n: NetworkEntryPayload): boolean => n.status != null && n.status >= 500;

/** Path (no origin/query) for a compact headline; falls back to the raw string. */
export function shortPath(url: string): string {
  try {
    return new URL(url).pathname || url;
  } catch {
    return url.split('?')[0] ?? url;
  }
}

/** ±window for "this error is correlated with that failed request" (R1b). */
const LEAD_WINDOW_MS = 2500;

/** A failed request's headline form: `METHOD /path → 500`. */
export function requestHeadline(n: NetworkEntryPayload): string {
  const status = n.error ? n.error : n.status != null ? String(n.status) : 'failed';
  return `${n.method} ${shortPath(n.url)} → ${status}`;
}

/** First meaningful line of a console error (the message), trimmed. */
function consoleHeadline(c: ConsoleEntry): string {
  const msg = c.args.join(' ').trim().split('\n')[0] ?? '';
  return msg.length > 140 ? `${msg.slice(0, 140)}…` : msg;
}

/** Concise `browser · OS · WxH` from system info, falling back to the UA string. */
export function envLine(system: SystemInfo | null, meta: ReportMeta | null): string {
  const vp = meta?.viewport ?? system?.viewport;
  const size = vp ? `${vp.width}×${vp.height}` : '';
  const browserInfo = system?.browser;
  if (browserInfo) {
    const brand = browserInfo.brands
      ?.filter((b) => !/not.*a.*brand/i.test(b.brand))
      .map((b) => `${b.brand} ${b.version}`)
      .at(-1);
    const browser = brand || browserInfo.vendor || '';
    const os = browserInfo.platform || '';
    return [browser, os, size].filter(Boolean).join(' · ');
  }
  const ua = meta?.userAgent ?? '';
  return [ua.slice(0, 80), size].filter(Boolean).join(' · ');
}

/**
 * Derive the diagnostic summary. Root-cause score (R1b): among console errors +
 * 5xx requests, prefer a console error WITH a stack and/or one correlated with a
 * failed request (a 5xx is a strong signal too); tiebreak = earliest. Falls back
 * to the first client failure (4xx/transport); else "no signal". Deterministic.
 * Keeps the earliest-correct cases stable (a stackless console error correlated
 * with a later 5xx still leads, as it did under the earlier earliest rule).
 */
export function deriveDiagnostics(data: ReportData): Diagnostics {
  const errors = data.console.filter((c) => c.level === 'error');
  const failed = data.network.filter(isFailedRequest);

  let severity: Diagnostics['severity'] = 'ok';
  let headline = '정상 흐름 — 진단 신호 없음';
  let jump: Diagnostics['jump'] = null;

  const near = (t: number, arr: ReadonlyArray<{ tFromStart: number }>): boolean =>
    arr.some((x) => Math.abs(x.tFromStart - t) <= LEAD_WINDOW_MS);
  type Cand =
    | { kind: 'con'; t: number; score: number; con: ConsoleEntry }
    | { kind: 'net'; t: number; score: number; net: NetworkEntryPayload };
  const cands: Cand[] = [];
  for (const c of errors) {
    cands.push({
      kind: 'con',
      t: c.tFromStart,
      con: c,
      score: 2 + (c.stack ? 2 : 0) + (near(c.tFromStart, failed) ? 1 : 0),
    });
  }
  for (const n of data.network) {
    if (is5xx(n)) {
      cands.push({
        kind: 'net',
        t: n.tFromStart,
        net: n,
        score: 2 + (near(n.tFromStart, errors) ? 1 : 0),
      });
    }
  }
  cands.sort((a, b) => b.score - a.score || a.t - b.t);
  const lead = cands[0];

  if (lead?.kind === 'net') {
    severity = 'error';
    headline = requestHeadline(lead.net);
    jump = { tab: 'network', t: lead.net.tFromStart };
  } else if (lead?.kind === 'con') {
    severity = 'error';
    headline = consoleHeadline(lead.con);
    jump = { tab: 'console', t: lead.con.tFromStart };
  } else if (failed[0]) {
    // No 5xx / no console error, but a client-side failure (4xx / transport).
    severity = 'warn';
    headline = requestHeadline(failed[0]);
    jump = { tab: 'network', t: failed[0].tFromStart };
  }

  return {
    severity,
    headline,
    jump,
    errorCount: errors.length,
    failedCount: failed.length,
    durationMs: data.meta?.durationMs ?? 0,
    url: data.meta?.url ?? '',
    env: envLine(data.system, data.meta),
  };
}
