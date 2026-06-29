/**
 * Bugzar backend — generic Workers AI driver.
 *
 * Provider-level concerns shared by every `/jira/draft` mode: a wall-clock
 * timeout wrapper, salvaging a JSON object from a chat-tuned model's loose
 * output, and a schema-constrained call with a single corrective retry.
 *
 * Domain logic (prompts, schemas, repro extraction, stubs) lives in
 * jira-draft.ts and is injected via `RunDraftOptions`.
 */

/**
 * Workers AI default timeout in milliseconds. The model can hang on cold
 * start or large prompts; without an upper bound the SW chain waits
 * indefinitely and the popup spinner never clears. The caller (`worker.ts`)
 * catches the rejection and surfaces a 502 so the SW falls back to
 * AiFallbackView — same path as schema-violation failures.
 *
 * 30s matches the Designer-spec single-step message budget (0/5/15/30s in
 * SubmittingView, PR-11) and leaves headroom under Cloudflare's
 * `cpu_ms / wall_clock_ms` limits.
 */
const AI_TIMEOUT_MS = 30_000;

/**
 * Race a promise against a wall-clock timer. Throws `Error('<label> timed out')`
 * if the timer fires first. The underlying Workers AI call may still complete
 * server-side, but the caller stops waiting — same effect as AbortController
 * for our purposes (we only care that the SubmittingView doesn't hang).
 */
const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });

/**
 * Salvage a JSON object from a Workers AI response.
 *
 * Workers AI is supposed to honor `response_format: json_schema`, but in
 * practice the model (Llama 3.1 8B) regularly returns:
 *   - already-parsed JSON object → use as-is
 *   - clean JSON string         → JSON.parse
 *   - fenced markdown           → ```json\n{...}\n``` or ``` {...} ```
 *   - prose + JSON              → "Here is the JSON:\n{...}"
 *   - JSON + trailing chatter   → "{...}\nLet me know if..."
 *   - leading whitespace / BOM
 *
 * Trying JSON.parse on the raw string fails on every case after the
 * first two. We try multiple extraction strategies in increasing
 * looseness, throwing only when nothing parses. The schema validator
 * downstream is the safety net — we don't need to recognize "this looks
 * like our schema", just "this is a JSON object".
 *
 * Exported for unit-test access; not part of the public worker API.
 */
export const extractJsonFromAiResponse = (raw: unknown): unknown => {
  // Workers AI sometimes hands us the parsed object directly when it
  // honors json_schema. No transformation needed.
  if (raw !== null && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') {
    throw new Error(`AI returned non-JSON response (${typeof raw})`);
  }

  let text = raw.trim();
  // Strip UTF-8 BOM, leading newlines that some models prepend.
  text = text.replace(/^﻿/, '').replace(/^\s+/, '');

  // Strip ```json ... ``` or ``` ... ``` fences (common with chat-tuned models).
  const fenceMatch = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/i);
  if (fenceMatch?.[1]) text = fenceMatch[1].trim();

  // First attempt: direct parse on the (de-fenced) string.
  try {
    return JSON.parse(text);
  } catch {
    // fall through
  }

  // Last resort: scan for a balanced object literal and parse just that
  // slice. Handles "Here's the JSON: {...}" + trailing chatter. We use a
  // depth counter that ignores braces inside string literals so quotes
  // containing `{` don't confuse the bookkeeping.
  const first = text.indexOf('{');
  if (first < 0) throw new Error('AI returned non-JSON response');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = first; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const slice = text.slice(first, i + 1);
        try {
          return JSON.parse(slice);
        } catch {
          // The balanced slice still isn't valid JSON — give up.
          throw new Error('AI returned non-JSON response');
        }
      }
    }
  }
  throw new Error('AI returned non-JSON response');
};

/**
 * PR-19 — default model identifier when no operator override is set. Pinned
 * to llama-4-scout-17b: it honours the schema-constrained (`json_schema`)
 * output and stays well under AI_TIMEOUT_MS, unlike the heavier 70b (which
 * times out). The previous default (`@cf/meta/llama-3.1-8b-instruct`) was
 * deprecated by Workers AI on 2026-05-30. Bumping the model is a deploy-free
 * secret rotation via AI_MODEL_BUG / AI_MODEL_DESIGN.
 */
export const DEFAULT_AI_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';

/** Corrective nudge appended on the single retry after a schema/parse failure. */
const SCHEMA_CORRECTION =
  '이전 응답이 JSON schema 를 위반했습니다. 설명·코드펜스·군더더기 없이 schema 에 맞는 JSON 객체 하나만 출력하세요.';

export interface RunDraftOptions<T> {
  model: string;
  messages: Array<{ role: string; content: string }>;
  schema: unknown;
  maxTokens: number;
  label: string;
  validate: (v: unknown) => v is T;
}

/**
 * Call Workers AI with a JSON-schema constraint, salvage + validate the
 * output, and retry ONCE with a corrective nudge on a parse/schema failure —
 * the model frequently honors the schema on the second ask. Timeouts are NOT
 * retried (that would double the wall-clock wait). Throws if both attempts
 * fail; the caller falls back to the deterministic stub.
 */
export const runDraftModel = async <T>(ai: Ai, opts: RunDraftOptions<T>): Promise<T> => {
  const attempt = async (messages: RunDraftOptions<T>['messages']): Promise<T> => {
    const result = (await withTimeout(
      ai.run(opts.model, {
        messages,
        response_format: { type: 'json_schema', json_schema: opts.schema },
        max_tokens: opts.maxTokens,
      } as Parameters<Ai['run']>[1]),
      AI_TIMEOUT_MS,
      opts.label,
    )) as { response?: unknown } | string;
    const raw =
      typeof result === 'string' ? result : ((result as { response?: unknown }).response ?? result);
    const parsed = extractJsonFromAiResponse(raw);
    if (!opts.validate(parsed)) throw new Error(`${opts.label}: schema violation`);
    return parsed;
  };

  try {
    return await attempt(opts.messages);
  } catch (err) {
    if (/timed out/.test((err as Error).message)) throw err;
    return attempt([...opts.messages, { role: 'user', content: SCHEMA_CORRECTION }]);
  }
};
