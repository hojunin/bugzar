/**
 * Workers AI driver for `/jira/draft`.
 *
 * Input: the raw artifacts of one report (meta / events / console / network /
 * storage) + the user's one-line description of the bug. Output: a `BugDraft`
 * struct (see `adf.ts`) that the route handler converts to ADF and either
 * returns to the SW (M1) or posts to Jira (M2).
 *
 * Everything model-facing flows through `sanitizeForAI` (Authorization /
 * Cookie / JWT redaction) — see `sanitize.ts`.
 *
 * The model is invoked with `response_format: { type: 'json_schema', ... }`
 * so the output is parse-able JSON or the Worker errors out. We don't try to
 * "fix up" partial responses — the route handler reports the failure and the
 * popup falls back to manual entry (Phase 2 §5.7b).
 */

import type { BugDraft, DesignDraft } from './adf';
import { redactJwt, sanitizeForAI } from './sanitize';

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
 * JSON schema enforced on Workers AI output. Mirrors `BugDraft` exactly —
 * keep them in sync if either changes. Workers AI accepts a permissive
 * subset of JSON Schema (object/array/string + required + items).
 */
export const BUG_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    overview: { type: 'string' },
    reproSteps: { type: 'array', items: { type: 'string' } },
    envBullets: { type: 'array', items: { type: 'string' } },
    attachments: {
      type: 'object',
      properties: {
        consoleError: { type: ['string', 'null'] },
        failedRequest: { type: ['string', 'null'] },
      },
      required: ['consoleError', 'failedRequest'],
    },
  },
  required: ['title', 'overview', 'reproSteps', 'envBullets', 'attachments'],
} as const;

/**
 * The full set of artifacts the handler hands to the model. All optional —
 * a report missing console.json (because nothing was logged) is fine.
 */
export interface DraftInputArtifacts {
  meta?: unknown;
  events?: unknown;
  console?: unknown;
  network?: unknown;
  storage?: unknown;
}

const MAX_ITEMS = 3;
const MAX_STR = 400;
// User-action timeline cap. Bigger than `MAX_ITEMS` because the trace
// is the most important signal — without enough interactions the AI
// can't infer reproSteps and ends up parroting the user's one-line
// description. We trim down by deduping consecutive duplicates instead
// of slicing aggressively at the source.
const MAX_INTERACTIONS = 20;

// ── rrweb snapshot decoding ─────────────────────────────────────────
//
// rrweb captures a full DOM snapshot (event.type === 2) at recording
// start and again whenever it loses track. Each element gets a numeric
// `id`. Later incremental events (clicks, inputs, mutations) reference
// that id. Without an index map, an event like
// `{ source: 2, type: 2, id: 374 }` is opaque — the AI sees "click on
// node 374" and can't write a reproduction step. Indexing the snapshot
// turns it into "click on <button> '필터 열기'".

interface SerializedNode {
  type?: number; // 1=Document, 2=Element, 3=Text, 4=CDATA, 5=Comment
  id?: number;
  tagName?: string;
  attributes?: Record<string, string | number | boolean | null>;
  textContent?: string;
  childNodes?: SerializedNode[];
}

interface ElementInfo {
  tag: string;
  text: string;
  // Stable identifier we can put in the prompt — `data-testid` or
  // `aria-label` if present, else a class selector. This is what a
  // reviewer can grep for in code when reproducing.
  hint: string;
}

const collectInnerText = (node: SerializedNode | undefined, budget = 80): string => {
  if (!node || budget <= 0) return '';
  if (node.type === 3 && typeof node.textContent === 'string') {
    return node.textContent.slice(0, budget);
  }
  let acc = '';
  for (const child of node.childNodes ?? []) {
    if (acc.length >= budget) break;
    acc += collectInnerText(child, budget - acc.length);
  }
  return acc;
};

const buildHint = (
  tag: string,
  attrs: Record<string, string | number | boolean | null> | undefined,
): string => {
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
};

const walkSnapshot = (node: SerializedNode | undefined, index: Map<number, ElementInfo>): void => {
  if (!node) return;
  if (node.type === 2 && typeof node.id === 'number' && typeof node.tagName === 'string') {
    index.set(node.id, {
      tag: node.tagName.toLowerCase(),
      text: collectInnerText(node, 60).trim().replace(/\s+/g, ' '),
      hint: buildHint(node.tagName.toLowerCase(), node.attributes),
    });
  }
  for (const child of node.childNodes ?? []) walkSnapshot(child, index);
};

const indexFullSnapshots = (events: unknown[]): Map<number, ElementInfo> => {
  const index = new Map<number, ElementInfo>();
  for (const ev of events) {
    const e = ev as { type?: number; data?: { node?: SerializedNode } } | null;
    if (e?.type !== 2) continue;
    walkSnapshot(e.data?.node, index);
  }
  return index;
};

/**
 * Format: `[tag "text" — selector]` (square brackets) instead of
 * `<tag "text" (selector)>` (angle brackets).
 *
 * Angle-bracket form looked clean in the prompt but Llama treats `<i...>` /
 * `<b...>` / `<s...>` etc. as inline HTML tags (italic/bold/strike) and
 * auto-strips them in its own response — so `<input "값" (...)>` came back
 * as `<nput "값" (...)>` with the leading char eaten in the rendered Jira
 * description. Square brackets are not HTML so the model passes them
 * through verbatim.
 */
const describeTarget = (node: ElementInfo | undefined): string => {
  if (!node) return '(unknown element)';
  const text = node.text ? ` "${node.text}"` : '';
  const hint = node.hint !== node.tag ? ` — ${node.hint}` : '';
  return `[${node.tag}${text}${hint}]`;
};

interface TimelineEntry {
  tFromStart: number;
  text: string;
}

const buildTimeline = (
  events: unknown[],
  consoleArr: unknown[],
  netArr: unknown[],
  sessionStart: number,
): TimelineEntry[] => {
  const idx = indexFullSnapshots(events);
  const entries: TimelineEntry[] = [];

  // Track URL changes from rrweb meta events (type 4) — gives us "user
  // navigated from /list to /detail/123" which is a huge repro hint.
  let lastUrl: string | undefined;
  for (const ev of events) {
    const e = ev as {
      type?: number;
      timestamp?: number;
      data?: { href?: string; source?: number; id?: number; text?: string; type?: number };
    } | null;
    if (!e || typeof e.timestamp !== 'number') continue;
    const t = e.timestamp - sessionStart;

    // type 4 = Meta event (carries the page URL at recording-start +
    // every history navigation).
    if (e.type === 4 && typeof e.data?.href === 'string') {
      if (e.data.href !== lastUrl) {
        if (lastUrl !== undefined) {
          entries.push({ tFromStart: t, text: `NAVIGATE → ${e.data.href}` });
        }
        lastUrl = e.data.href;
      }
      continue;
    }

    if (e.type !== 3) continue;
    const source = e.data?.source;
    // source 2 = mouse interaction. data.type 2 inside is a click.
    if (source === 2 && e.data?.type === 2 && typeof e.data?.id === 'number') {
      const target = describeTarget(idx.get(e.data.id));
      entries.push({ tFromStart: t, text: `CLICK ${target}` });
    } else if (source === 5 && typeof e.data?.id === 'number') {
      // source 5 = input. data.text is the new value (after rrweb's
      // masking — strict-masked sessions hand us `*` characters).
      const target = describeTarget(idx.get(e.data.id));
      const value = typeof e.data?.text === 'string' ? e.data.text.slice(0, 40) : '';
      entries.push({
        tFromStart: t,
        text: `INPUT ${target}${value ? ` value="${value}"` : ''}`,
      });
    }
  }

  // Failed network calls — interleaved into the timeline so the AI can
  // correlate "clicked filter → request to /graphql returned 0 items"
  // even though that request was a 200. We include both >=400 AND any
  // request flagged with a non-empty `error` (network-layer failures,
  // CORS denials, etc.) so the AI doesn't miss silent breakage.
  for (const ev of netArr) {
    const e = ev as {
      tFromStart?: number;
      method?: string;
      url?: string;
      status?: number | null;
      error?: string | null;
    } | null;
    if (!e || typeof e.tFromStart !== 'number') continue;
    const isFail = (typeof e.status === 'number' && e.status >= 400) || !!e.error;
    if (!isFail) continue;
    entries.push({
      tFromStart: e.tFromStart,
      text: `NETWORK ${e.method ?? 'GET'} ${e.url ?? '?'} → ${e.status ?? 'ERR'}${e.error ? ` (${e.error})` : ''}`.slice(
        0,
        MAX_STR,
      ),
    });
  }

  // Console errors with their position in time — so the AI can say
  // "the error fires AFTER the click" instead of just attaching it.
  for (const ev of consoleArr) {
    const e = ev as { tFromStart?: number; level?: string; args?: unknown[] } | null;
    if (!e || typeof e.tFromStart !== 'number') continue;
    if (e.level !== 'error') continue;
    const text = (e.args ?? [])
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ')
      .slice(0, MAX_STR);
    entries.push({ tFromStart: e.tFromStart, text: `CONSOLE.ERROR ${text}` });
  }

  entries.sort((a, b) => a.tFromStart - b.tFromStart);
  // Drop consecutive duplicates (rrweb fires mousedown/mouseup/click in
  // a row for the same target — collapse into a single CLICK in the
  // narrative).
  const deduped: TimelineEntry[] = [];
  for (const entry of entries) {
    const last = deduped[deduped.length - 1];
    if (last && last.text === entry.text && entry.tFromStart - last.tFromStart < 500) continue;
    deduped.push(entry);
  }
  return deduped.slice(0, MAX_INTERACTIONS);
};

const formatTimeline = (entries: TimelineEntry[]): string => {
  if (entries.length === 0) return '(상호작용 없음)';
  return entries.map((e) => `    [+${(e.tFromStart / 1000).toFixed(1)}s] ${e.text}`).join('\n');
};

/**
 * Pull human-readable nuggets out of the noisy raw arrays. The model
 * gets a structured timeline of user actions + URL changes + failed
 * requests + console errors so it can write actual reproduction steps,
 * not just parrot the user's one-line description.
 */
export const summarizeForPrompt = (input: DraftInputArtifacts): string => {
  const meta = (input.meta ?? {}) as Record<string, unknown>;
  const url = typeof meta.url === 'string' ? meta.url : '(unknown)';
  const userAgent = typeof meta.userAgent === 'string' ? (meta.userAgent as string) : '(unknown)';
  const viewport =
    meta.viewport && typeof meta.viewport === 'object'
      ? JSON.stringify(meta.viewport)
      : '(unknown)';
  const startedAt =
    typeof meta.startedAt === 'number' ? new Date(meta.startedAt).toISOString() : '(?)';
  const endedAt = typeof meta.endedAt === 'number' ? new Date(meta.endedAt).toISOString() : '(?)';
  const sessionStart = typeof meta.startedAt === 'number' ? (meta.startedAt as number) : 0;
  const durationMs =
    typeof meta.endedAt === 'number' && typeof meta.startedAt === 'number'
      ? (meta.endedAt as number) - sessionStart
      : null;

  const consoleArr = Array.isArray(input.console) ? (input.console as unknown[]) : [];
  const errors = consoleArr
    .filter((e) => {
      const ev = e as { level?: string } | null;
      return ev?.level === 'error';
    })
    .slice(0, MAX_ITEMS)
    .map((e) => {
      const ev = e as { args?: unknown[] };
      const text = (ev.args ?? [])
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ');
      return text.slice(0, MAX_STR);
    });

  const netArr = Array.isArray(input.network) ? (input.network as unknown[]) : [];
  const failed = netArr
    .filter((e) => {
      const ev = e as { status?: number; error?: string | null } | null;
      return (
        (typeof ev?.status === 'number' && ev.status >= 400) ||
        !!(ev?.error as string | null | undefined)
      );
    })
    .slice(0, MAX_ITEMS)
    .map((e) => {
      const ev = e as { method?: string; url?: string; status?: number; error?: string | null };
      return `${ev.method ?? 'GET'} ${ev.url ?? '?'} → ${ev.status ?? 'ERR'}${ev.error ? ` (${ev.error})` : ''}`.slice(
        0,
        MAX_STR,
      );
    });

  const eventsArr = Array.isArray(input.events) ? (input.events as unknown[]) : [];
  const timeline = buildTimeline(eventsArr, consoleArr, netArr, sessionStart);

  const lines: string[] = [
    `- URL: ${url}`,
    `- 시간: ${startedAt} ~ ${endedAt}${durationMs !== null ? ` (지속 ${durationMs}ms)` : ''}`,
    `- Viewport: ${viewport}`,
    `- User-Agent: ${userAgent.slice(0, 160)}`,
    `- console errors (${errors.length}건${errors.length === 0 ? ', 없음' : ''})${errors.length ? ':' : ''}`,
    ...errors.map((s) => `    · ${s}`),
    `- failed requests (${failed.length}건${failed.length === 0 ? ', 없음' : ''})${failed.length ? ':' : ''}`,
    ...failed.map((s) => `    · ${s}`),
    `- 사용자 행동 타임라인 (시간순, 최대 ${MAX_INTERACTIONS}건):`,
    formatTimeline(timeline),
  ];

  return redactJwt(lines.join('\n'));
};

const SYSTEM_PROMPT = `당신은 한국어로 QA 리포트를 작성하는 어시스턴트입니다.
사용자가 보고한 문제와 캡처된 브라우저 세션 정보(타임라인)를 바탕으로 JSON schema 에 맞춘 응답만 생성하세요.

각 필드 작성 규칙:
- title: 한 줄, 50자 이내. "어디서 / 무엇이 / 어떻게" 핵심을 담을 것. 사용자 입력이 짧으면 타임라인의 첫 CLICK 대상 + 결과적 에러로 합성.
- overview: 1-3 문장. "사용자가 X 화면에서 Y 액션을 했을 때 Z 가 발생/실패함" 구조. 가능하면 타임라인의 NAVIGATE / CONSOLE.ERROR / 실패한 NETWORK 호출과 연결.
- reproSteps: 한 단계 한 문자열, 3-7 단계 권장. **사용자 입력이 짧을 때는 타임라인의 CLICK / INPUT / NAVIGATE 이벤트에서 직접 합성하세요** ("절차 모르겠음" 같은 자리표시자 금지).
  타임라인은 [tag "text" — selector] 형식 (대괄호 + dash) 으로 요소를 가리킵니다 — 이 대괄호 표기를 그대로 reproSteps 에 옮겨 적으세요. **angle bracket 형식 (꺾쇠 < > 안에 tag) 으로 바꾸지 말 것** — Jira 가 HTML 태그로 오해해서 첫 글자가 잘려 보일 수 있습니다.
  예:
  · "1. https://example.com/page 페이지로 이동"
  · '2. [button "판매중"] 클릭'
  · "3. 결과 없음 / 에러 X 발생"
- envBullets: URL, 발생 시각(UTC 또는 KST), 지속시간을 포함. (Viewport / Browser / User-Agent 는 넣지 말 것.)
- attachments.consoleError: 첫 error 의 message 그대로(없으면 null).
- attachments.failedRequest: "<METHOD> <URL> → <status>" 형식(없으면 null).

원칙 (Anti-hallucination — 어기면 부정확한 리포트가 발행됨):
- **숫자 추정 금지**: "N회 반복", "X자리 비밀번호", "Y번째 시도" 같이 정확한 횟수/길이/순번을 단정하지 말 것. 타임라인에 실제로 등장한 이벤트만 세어서 표기. 모호하면 "여러 번", "반복적으로" 같이 정성 표현 사용.
- **입력값 추정 금지**: 사용자가 무엇을 입력했는지는 timeline INPUT 이벤트의 따옴표 안 값만 사용. 마스킹된 값 (asterisk 3개 또는 "(masked)") 은 "(입력값 마스킹됨)" 으로 표기하고 자릿수/내용/타입(비밀번호인지 이메일인지 등) 절대 추정 금지.
- **개요와 reproSteps 정합**: overview 에서 언급한 횟수/이벤트는 반드시 reproSteps 와 일치해야 함. "5번 클릭" 적었으면 reproSteps 에 클릭이 정확히 5번 나와야 함.
- **입력 type 추정 금지**: input 의 type 속성이 timeline 에 명시되지 않은 한 "비밀번호 입력" / "이메일 입력" 등 단정 금지. tag/selector 만 보고 일반 input 으로 표기.
- 타임라인이 비어있어도 사용자 입력 + 환경 정보만으로 가능한 한 자세히 작성.
- 캡처되지 않아 추측한 내용은 "(추정)" 접미사로 표시.
- console error 의 raw 텍스트를 reproSteps 에 그대로 복사하지 말 것 — 의미를 풀어서 적기.`;

const buildUserPrompt = (userInput: string, summary: string): string =>
  `사용자 입력:\n"${userInput}"\n\n캡처된 데이터 요약:\n${summary}`;

/**
 * Best-effort sniff for the first console error / first failed request that
 * `summarizeForPrompt` already surfaces. We pass these to the model in the
 * prompt, but also keep them as a fallback in case the model returns nulls
 * for the `attachments` field — the ADF block still gets useful evidence.
 */
export const sniffAttachments = (
  input: DraftInputArtifacts,
): { consoleError: string | null; failedRequest: string | null } => {
  const consoleArr = Array.isArray(input.console) ? (input.console as unknown[]) : [];
  const firstError = consoleArr.find((e) => {
    const ev = e as { level?: string } | null;
    return ev?.level === 'error';
  }) as { args?: unknown[] } | undefined;
  const consoleError = firstError
    ? redactJwt(
        (firstError.args ?? [])
          .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
          .join(' ')
          .slice(0, MAX_STR),
      )
    : null;

  const netArr = Array.isArray(input.network) ? (input.network as unknown[]) : [];
  const firstFailed = netArr.find((e) => {
    const ev = e as { status?: number } | null;
    return typeof ev?.status === 'number' && ev.status >= 400;
  }) as { method?: string; url?: string; status?: number } | undefined;
  const failedRequest = firstFailed
    ? `${firstFailed.method ?? 'GET'} ${firstFailed.url ?? '?'} → ${firstFailed.status ?? '?'}`
    : null;

  return { consoleError, failedRequest };
};

const isBugDraft = (v: unknown): v is BugDraft => {
  if (!v || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  if (typeof obj.title !== 'string') return false;
  if (typeof obj.overview !== 'string') return false;
  if (!Array.isArray(obj.reproSteps) || !obj.reproSteps.every((s) => typeof s === 'string'))
    return false;
  if (!Array.isArray(obj.envBullets) || !obj.envBullets.every((s) => typeof s === 'string'))
    return false;
  const att = obj.attachments as Record<string, unknown> | undefined;
  if (!att || typeof att !== 'object') return false;
  if (att.consoleError !== null && typeof att.consoleError !== 'string') return false;
  if (att.failedRequest !== null && typeof att.failedRequest !== 'string') return false;
  return true;
};

export interface GenerateBugDraftOptions {
  artifacts: DraftInputArtifacts;
  userInput: string;
  /** PR-19 — operator-supplied model override. Defaults to llama-4-scout-17b. */
  model?: string;
}

/**
 * Call Workers AI with the structured-output schema. Returns the parsed
 * `BugDraft` or throws — the caller (worker.ts) catches and surfaces a
 * 502 / fallback shape to the SW.
 */
// ────────────────────────────────────────────────────────────────────────
// Design mode draft (Phase 2 Task 19)
// ────────────────────────────────────────────────────────────────────────

/**
 * JSON schema for the Design mode output. Mirrors `DesignDraft` in `adf.ts`.
 *
 * `selector` is intentionally an exact echo of the input — the system
 * prompt tells the model to copy it verbatim so the ADF builder can
 * re-link each item to its source element.
 */
export const DESIGN_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    overview: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          selector: { type: 'string' },
          location: { type: 'string' },
          issue: { type: 'string' },
          suggestion: { type: 'string' },
          severityHint: { type: 'string', enum: ['minor', 'major', 'critical'] },
        },
        required: ['selector', 'location', 'issue', 'suggestion', 'severityHint'],
      },
    },
    envBullets: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'overview', 'items', 'envBullets'],
} as const;

/** Narrow shape of `SelectedElement` that the prompt summarizer reads. */
export interface DesignElementInput {
  id: string;
  selector: string;
  tagName?: string;
  textContent?: string;
  componentName?: string;
  userNote?: string;
  rect?: { x: number; y: number; width: number; height: number };
}

const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Format the per-element block for the design prompt. We keep each row
 * compact — the model only needs selector + tag + textContent + the user's
 * memo to write a sensible issue/suggestion pair.
 */
const summarizeDesignElement = (el: DesignElementInput): string => {
  const tag = (el.tagName ?? '').toLowerCase();
  const text = truncate((el.textContent ?? '').trim(), 80);
  const note = truncate(redactJwt((el.userNote ?? '').trim()), 200);
  const comp = el.componentName ? ` <${el.componentName}>` : '';
  const sizeStr = el.rect ? ` (${Math.round(el.rect.width)}×${Math.round(el.rect.height)})` : '';
  const parts = [
    `selector: ${el.selector}`,
    `tag: ${tag}${comp}${sizeStr}`,
    text ? `text: ${text}` : null,
    note ? `사용자 메모: ${note}` : 'note: (메모 없음)',
  ].filter((s): s is string => Boolean(s));
  return parts.join('\n  ');
};

const summarizeDesignInput = (
  elements: DesignElementInput[],
  meta: Record<string, unknown> | undefined,
): string => {
  const url = typeof meta?.url === 'string' ? meta.url : '(unknown)';
  const viewport =
    meta?.viewport && typeof meta.viewport === 'object'
      ? JSON.stringify(meta.viewport)
      : '(unknown)';
  const userAgent = typeof meta?.userAgent === 'string' ? meta.userAgent : '(unknown)';
  const header = [
    `- URL: ${url}`,
    `- Viewport: ${viewport}`,
    `- UA: ${truncate(userAgent, 200)}`,
  ].join('\n');
  const items = elements
    .map((el, idx) => `[${idx + 1}]\n  ${summarizeDesignElement(el)}`)
    .join('\n');
  return `${header}\n\n선택된 요소 (${elements.length}개):\n${items || '(선택 없음)'}`;
};

const DESIGN_SYSTEM_PROMPT = `당신은 한국어로 디자인 피드백 리포트를 작성하는 어시스턴트입니다.
입력으로 사용자가 한 페이지에서 선택한 UI 요소들 + 사용자 코멘트가 주어집니다.
JSON schema 에 맞춘 응답만 생성하세요.
- title: "[디자인]" 으로 시작하는 한 줄, 60자 이내.
- overview: 1~2 문장으로 전체 의도.
- items: 입력의 각 요소에 대해 한 row. selector 는 입력값을 절대 변형하지 말고 그대로 복사.
  · location: 사용자에게 보일 위치 설명 ("헤더의 검색 버튼" 등).
  · issue: 사용자 메모를 다듬은 문장 (메모가 비어 있으면 element 정보로 합리적 추정).
  · suggestion: 개선 방향을 짧은 한 문장으로.
  · severityHint: minor | major | critical 중 하나.
- envBullets: ["URL: ...", "발생 시각: ..."] 형태. (Viewport / Browser 는 넣지 말 것.)
모든 필드는 한국어로.`;

const buildDesignUserPrompt = (userInput: string, summary: string): string =>
  `사용자 전체 코멘트:\n"${userInput || '(전체 코멘트 없음)'}"\n\n캡처된 디자인 정보:\n${summary}`;

const isDesignDraft = (v: unknown): v is DesignDraft => {
  if (!v || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  if (typeof obj.title !== 'string') return false;
  if (typeof obj.overview !== 'string') return false;
  if (!Array.isArray(obj.envBullets) || !obj.envBullets.every((s) => typeof s === 'string'))
    return false;
  if (!Array.isArray(obj.items)) return false;
  for (const it of obj.items) {
    if (!it || typeof it !== 'object') return false;
    const item = it as Record<string, unknown>;
    if (typeof item.selector !== 'string') return false;
    if (typeof item.location !== 'string') return false;
    if (typeof item.issue !== 'string') return false;
    if (typeof item.suggestion !== 'string') return false;
    if (
      item.severityHint !== 'minor' &&
      item.severityHint !== 'major' &&
      item.severityHint !== 'critical'
    )
      return false;
  }
  return true;
};

export interface GenerateDesignDraftOptions {
  elements: DesignElementInput[];
  userInput: string;
  meta?: Record<string, unknown>;
  /** PR-19 — operator-supplied model override. Defaults to llama-4-scout-17b. */
  model?: string;
}

/**
 * PR-19 — default model identifier when no operator override is set. Pinned
 * to llama-4-scout-17b: it honours the schema-constrained (`json_schema`)
 * output and stays well under AI_TIMEOUT_MS, unlike the heavier 70b (which
 * times out). The previous default (`@cf/meta/llama-3.1-8b-instruct`) was
 * deprecated by Workers AI on 2026-05-30. Bumping the model is a deploy-free
 * secret rotation via AI_MODEL_BUG / AI_MODEL_DESIGN.
 */
export const DEFAULT_AI_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';

/**
 * Workers AI call for the design mode. Returns `DesignDraft` matching
 * `DESIGN_SCHEMA`. Throws on schema violation — caller (worker.ts)
 * surfaces a 502 + the popup falls back to manual entry.
 */
export const generateDesignDraft = async (
  ai: Ai,
  opts: GenerateDesignDraftOptions,
): Promise<DesignDraft> => {
  const safeElements = sanitizeForAI(opts.elements) as DesignElementInput[];
  const safeMeta = sanitizeForAI(opts.meta ?? {}) as Record<string, unknown>;
  const summary = summarizeDesignInput(safeElements, safeMeta);

  const messages = [
    { role: 'system', content: DESIGN_SYSTEM_PROMPT },
    { role: 'user', content: buildDesignUserPrompt(redactJwt(opts.userInput), summary) },
  ];

  const result = (await withTimeout(
    ai.run(opts.model ?? DEFAULT_AI_MODEL, {
      messages,
      response_format: {
        type: 'json_schema',
        json_schema: DESIGN_SCHEMA,
      },
      // Design draft is more verbose (one block per element). Bump the
      // ceiling so an 8-element pick doesn't get truncated.
      max_tokens: 1536,
    } as Parameters<Ai['run']>[1]),
    AI_TIMEOUT_MS,
    'Workers AI (design)',
  )) as { response?: unknown } | string;

  const raw =
    typeof result === 'string' ? result : ((result as { response?: unknown }).response ?? result);

  let parsed: unknown = extractJsonFromAiResponse(raw);

  if (!isDesignDraft(parsed)) {
    throw new Error('AI response did not match DESIGN_SCHEMA');
  }

  // The model is told to echo selectors verbatim, but Workers AI sometimes
  // shortens or rewords. If we got a count match, restore each item's
  // selector from the original input so the ADF builder can find the
  // source element for "자세히 보기 →".
  if (parsed.items.length === opts.elements.length) {
    parsed = {
      ...parsed,
      items: parsed.items.map((item, idx) => {
        const src = opts.elements[idx];
        if (!src) return item;
        return { ...item, selector: src.selector };
      }),
    } as DesignDraft;
  }

  return parsed as DesignDraft;
};

// ────────────────────────────────────────────────────────────────────────
// Bug mode draft (original Phase 1)
// ────────────────────────────────────────────────────────────────────────

export const generateBugDraft = async (
  ai: Ai,
  opts: GenerateBugDraftOptions,
): Promise<BugDraft> => {
  // Sanitize the entire artifact bag before we touch it for prompt building
  // — `summarizeForPrompt` reads from already-redacted copies.
  const safe = sanitizeForAI(opts.artifacts) as DraftInputArtifacts;
  const summary = summarizeForPrompt(safe);
  const sniffed = sniffAttachments(safe);

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserPrompt(redactJwt(opts.userInput), summary) },
  ];

  const result = (await withTimeout(
    ai.run(opts.model ?? DEFAULT_AI_MODEL, {
      messages,
      response_format: {
        type: 'json_schema',
        json_schema: BUG_SCHEMA,
      },
      // Workers AI sometimes ignores the schema if max_tokens is too low —
      // budget enough for ~500 output tokens of Korean.
      max_tokens: 768,
    } as Parameters<Ai['run']>[1]),
    AI_TIMEOUT_MS,
    'Workers AI (bug)',
  )) as { response?: unknown } | string;

  // Workers AI returns { response: ... } for chat; the response can already
  // be a parsed object when json_schema is honored, or a JSON string with
  // assorted decorations (code fences, prose prefix). `extractJsonFromAiResponse`
  // handles all the common shapes.
  const raw =
    typeof result === 'string' ? result : ((result as { response?: unknown }).response ?? result);

  const parsed: unknown = extractJsonFromAiResponse(raw);

  if (!isBugDraft(parsed)) {
    throw new Error('AI response did not match BUG_SCHEMA');
  }

  // If the model returned null for attachments but we sniffed something
  // useful from the raw artifacts, prefer the sniffed value — the model
  // sometimes drops these even when present in the prompt.
  return {
    ...parsed,
    attachments: {
      consoleError: parsed.attachments.consoleError ?? sniffed.consoleError,
      failedRequest: parsed.attachments.failedRequest ?? sniffed.failedRequest,
    },
  };
};
