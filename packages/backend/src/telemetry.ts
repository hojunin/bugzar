/**
 * Bugzar backend — telemetry surface.
 *
 *   POST /telemetry/event      — validate + forward a usage event to the
 *                                Workers Analytics Engine binding (console
 *                                fallback when unbound).
 *   POST /telemetry/ai-quality — coarse pass/fail heuristic on AI repro steps.
 *   GET  /telemetry/summary    — report the active telemetry sink.
 *
 * Extracted from worker.ts.
 */

import { type AnalyticsEngineDataPoint, type Env, errorResponse, jsonResponse } from './runtime';

// ────────────────────────────────────────────────────────────────────────
// Telemetry (Phase 2 Task 27 / R27)
//
// POST /telemetry/event accepts `{name, props, sessionIdHash?, accountIdHash?,
// extVersion, ts}` from the extension. Body validation rejects anything that
// could leak PII (selectors, raw ids, free text). When the Analytics Engine
// binding is unset, we just log the event — useful for local dev + as a
// graceful fallback if the AE dataset is misconfigured in prod.
// ────────────────────────────────────────────────────────────────────────

const TELEMETRY_EVENT_NAMES = [
  'mode_picked',
  'submit_started',
  'submit_succeeded',
  'submit_failed',
  'ai_schema_violation',
  'oauth_succeeded',
  'picker_started',
  'picker_completed',
  // PR-13 신규
  'ai_fallback', // props.reason: 'timeout' | 'schema_violation' | 'parse_error' | 'api_error'
  'recording_started', // props.mode: 'bug' | 'design'
  'recording_completed', // props.durationMs: number
] as const;
type TelemetryEventName = (typeof TELEMETRY_EVENT_NAMES)[number];
const isTelemetryEventName = (s: string): s is TelemetryEventName =>
  (TELEMETRY_EVENT_NAMES as readonly string[]).includes(s);

/** Hash field length sanity check — see `hashId` in lib/telemetry-core. */
const isShortHexHash = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8,64}$/i.test(v);

interface ValidatedTelemetryEvent {
  name: TelemetryEventName;
  props: Record<string, string | number | boolean | null>;
  sessionIdHash: string | null;
  accountIdHash: string | null;
  extVersion: string;
  ts: number;
}

/**
 * Coerce the incoming JSON body into a validated event. We refuse anything
 * we don't recognize so a typo or a malicious client can't poison the AE
 * dataset with high-cardinality / PII-shaped data.
 */
const validateTelemetryEvent = (raw: unknown): ValidatedTelemetryEvent | { error: string } => {
  if (!raw || typeof raw !== 'object') return { error: 'body must be an object' };
  const o = raw as Record<string, unknown>;

  if (typeof o.name !== 'string' || !isTelemetryEventName(o.name)) {
    return { error: `unknown event name: ${String(o.name)}` };
  }

  const propsIn =
    o.props && typeof o.props === 'object' ? (o.props as Record<string, unknown>) : {};
  const props: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(propsIn)) {
    if (k.length > 32) continue;
    if (v === null || typeof v === 'boolean') {
      props[k] = v;
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      props[k] = v;
    } else if (typeof v === 'string') {
      // Strings get hard-trimmed so a client can't smuggle a long URL or
      // free-text note into "props" — coarse vocabulary only.
      if (v.length > 64) continue;
      props[k] = v;
    }
  }

  const sessionIdHash =
    o.sessionIdHash === null || o.sessionIdHash === undefined
      ? null
      : isShortHexHash(o.sessionIdHash)
        ? (o.sessionIdHash as string)
        : null;
  const accountIdHash =
    o.accountIdHash === null || o.accountIdHash === undefined
      ? null
      : isShortHexHash(o.accountIdHash)
        ? (o.accountIdHash as string)
        : null;
  const extVersion = typeof o.extVersion === 'string' ? o.extVersion.slice(0, 32) : '0.0.0';
  const ts = typeof o.ts === 'number' && Number.isFinite(o.ts) ? o.ts : Date.now();

  return { name: o.name, props, sessionIdHash, accountIdHash, extVersion, ts };
};

/**
 * Project the validated event into the Analytics Engine column model
 * (indexes / blobs / doubles). Kept tiny and explicit — every blob/index
 * slot is documented so the AE schema doesn't drift silently.
 */
const eventToDataPoint = (ev: ValidatedTelemetryEvent): AnalyticsEngineDataPoint => {
  const mode = typeof ev.props.mode === 'string' ? ev.props.mode : '';
  const step = typeof ev.props.step === 'string' ? ev.props.step : '';
  // `ai_fallback`은 `reason`을 blob3 slot에 재사용한다. 기존 `errorType` 슬롯과
  // 동일 컬럼을 쓰므로 AE 스키마가 늘어나지 않는다.
  const errorType =
    typeof ev.props.errorType === 'string'
      ? ev.props.errorType
      : typeof ev.props.reason === 'string'
        ? ev.props.reason
        : '';
  const elementCount = typeof ev.props.elementCount === 'number' ? ev.props.elementCount : 0;
  const durationMs = typeof ev.props.durationMs === 'number' ? ev.props.durationMs : 0;

  return {
    // index = primary group key. Event name has low cardinality (8 values).
    indexes: [ev.name],
    // blobs = high-readability tags. Order is stable — never reshuffle.
    //   blob1 = mode, blob2 = step, blob3 = errorType, blob4 = extVersion,
    //   blob5 = sessionIdHash, blob6 = accountIdHash.
    blobs: [mode, step, errorType, ev.extVersion, ev.sessionIdHash ?? '', ev.accountIdHash ?? ''],
    // doubles = numeric metrics.
    //   double1 = elementCount, double2 = durationMs.
    doubles: [elementCount, durationMs],
  };
};

export const handleTelemetryEvent = async (req: Request, env: Env): Promise<Response> => {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return errorResponse(400, 'invalid json');
  }
  const ev = validateTelemetryEvent(parsed);
  if ('error' in ev) return errorResponse(400, ev.error);

  if (env.BUGZAR_ANALYTICS) {
    try {
      env.BUGZAR_ANALYTICS.writeDataPoint(eventToDataPoint(ev));
    } catch (err) {
      console.warn('[telemetry] writeDataPoint failed', (err as Error).message);
    }
  } else {
    // No binding → log it. Useful for `wrangler dev` and as a safety net so
    // misconfigured prod still leaves a breadcrumb.
    console.log('[telemetry]', ev.name, JSON.stringify(ev.props));
  }

  return jsonResponse(202, { ok: true });
};

/**
 * PR-19 — LLM-as-a-judge quality check. The popup (or a CI test rig) POSTs
 * the reproSteps array from the rendered draft; we score it on a fixed
 * heuristic (count >= 3 AND avg length >= 10) and emit a coarse pass/fail
 * to telemetry. Heavier judging (semantic correctness via a second LLM
 * call) can layer on without changing the wire shape.
 */
interface AiQualityRequest {
  reproSteps?: unknown;
  mode?: unknown;
}
export const handleAiQuality = async (req: Request, env: Env): Promise<Response> => {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return errorResponse(400, 'invalid json');
  }
  if (!parsed || typeof parsed !== 'object') return errorResponse(400, 'body must be an object');
  const body = parsed as AiQualityRequest;
  const reproSteps = Array.isArray(body.reproSteps)
    ? body.reproSteps.filter((s): s is string => typeof s === 'string')
    : [];
  const count = reproSteps.length;
  const totalLen = reproSteps.reduce((s, r) => s + r.length, 0);
  const avgLen = count > 0 ? Math.round(totalLen / count) : 0;
  const qualityPass = count >= 3 && avgLen >= 10;
  const mode = body.mode === 'design' ? 'design' : 'bug';

  if (env.BUGZAR_ANALYTICS) {
    try {
      env.BUGZAR_ANALYTICS.writeDataPoint({
        indexes: ['ai_quality_check'],
        blobs: [mode, qualityPass ? 'pass' : 'fail'],
        doubles: [count, avgLen],
      });
    } catch (err) {
      console.warn('[ai-quality] telemetry write failed', (err as Error).message);
    }
  } else {
    console.log('[ai-quality]', { mode, qualityPass, count, avgLen });
  }

  return jsonResponse(200, { ok: true, qualityPass, count, avgLen });
};

/**
 * Lightweight discovery endpoint — returns the registered telemetry event
 * names and the current binding mode. Useful for ops debugging and as a
 * sanity check from CI: when `telemetryMode === 'analytics-engine'` the
 * dashboard should be receiving writes.
 *
 * NOTE: We can't query Analytics Engine from inside a Worker — DDSQL runs
 * out-of-band via the Cloudflare dashboard. Aggregated stats therefore live
 * in `docs/telemetry-queries.md`, not here.
 */
export const handleTelemetrySummary = (env: Env): Response => {
  return jsonResponse(200, {
    telemetryMode: env.BUGZAR_ANALYTICS ? 'analytics-engine' : 'console',
    events: TELEMETRY_EVENT_NAMES,
    queryEndpoint: 'https://dash.cloudflare.com/?to=/:account/workers/analytics-engine',
  });
};
