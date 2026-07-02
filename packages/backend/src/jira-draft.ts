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

import {
  type ActionTarget,
  extractReproActions,
  type ReproAction,
  type RrwebEvent,
} from '@bugzar/shared';
import type { BugDraft, DesignDraft } from './adf';
import { DEFAULT_AI_MODEL, runDraftModel } from './ai-driver';
import { redactJwt, sanitizeForAI } from './sanitize';

// extractJsonFromAiResponse moved to ai-driver.ts; re-exported for the unit
// test that imports it from './jira-draft'.
export { extractJsonFromAiResponse } from './ai-driver';

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

// Symptom-list caps (failed requests / console errors shown in [증상]).
const MAX_ITEMS = 5;
const MAX_STR = 400;
// Repro-path window: how many user actions to keep LEADING UP TO the first
// failure. We don't slice from the start (the tail — where the bug fires —
// is what matters), we window around the failure. See `buildReproPath`.
const MAX_REPRO_STEPS = 6;
// Error-hint extracted from a failed request's response body. Kept short on
// purpose — the goal is the error code / message, not the whole payload.
const ERROR_HINT_MAX = 120;

// ── rrweb action labelling ──────────────────────────────────────────
//
// The INTERPRETATION of raw rrweb events into normalized user actions —
// snapshot indexing, radio/checkbox + synthesized-click de-dup, ancestry
// collapse — is shared with the viewer in `@bugzar/shared`
// (`extractReproActions`) so the two surfaces can't drift. Here we only turn
// those normalized actions into the Korean, LLM-facing repro path.
//
// Stable, semantic identity only. `ActionTarget` carries the raw attrs; we build
// a `data-testid` / `aria-label` / `role` hint and DROP class soup — it burns
// tokens and misleads the model.
const buildHint = (target: ActionTarget): string => {
  if (target.testId) return `data-testid="${target.testId}"`;
  if (target.ariaLabel) return `aria-label="${target.ariaLabel.slice(0, 30)}"`;
  if (target.role) return `role="${target.role}"`;
  return '';
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
const describeTarget = (target: ActionTarget | null): string => {
  if (!target) return '(알 수 없는 요소)';
  const text = target.text ? ` "${target.text}"` : '';
  const hint = buildHint(target);
  return `[${target.tag}${text}${hint ? ` — ${hint}` : ''}]`;
};

/** A click target is worth keeping in the repro path only if we can name it. */
const hasIdentity = (target: ActionTarget | null): boolean =>
  !!(target && (target.text || buildHint(target)));

// ── error-signal extraction (the high-value, low-noise part) ────────
//
// A failed request's response body usually CONTAINS the real error
// ("OUT_OF_STOCK", "validation failed: email"). We pull the meaningful
// field out instead of dumping the whole payload (noise + tokens).
export const extractErrorHint = (body: unknown): string | null => {
  if (typeof body !== 'string' || !body.trim()) return null;
  const trimmed = body.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      // Prefer human-readable fields over bare codes.
      for (const key of ['message', 'error_description', 'detail', 'error', 'title', 'code']) {
        const v = obj[key];
        if (typeof v === 'string' && v.trim()) return v.trim().slice(0, ERROR_HINT_MAX);
        if (v && typeof v === 'object') {
          const nested = (v as Record<string, unknown>).message;
          if (typeof nested === 'string' && nested.trim()) {
            return nested.trim().slice(0, ERROR_HINT_MAX);
          }
        }
      }
    }
  } catch {
    // not JSON — fall through to a plain truncated slice
  }
  return trimmed.replace(/\s+/g, ' ').slice(0, ERROR_HINT_MAX);
};

// First *frame* of a stack trace (not the message), e.g.
// "Cart.tsx:42:10" — enough to point at the code without the full dump.
export const topStackFrame = (stack: unknown): string | null => {
  if (typeof stack !== 'string' || !stack.trim()) return null;
  const lines = stack
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const frame = lines.find(
    (l) => /^at\s/.test(l) || /\.(t|j)sx?:\d+/.test(l) || /:\d+:\d+\)?$/.test(l),
  );
  return frame ? frame.replace(/^at\s+/, '').slice(0, 100) : null;
};

/** Shorten a URL/href to path+query, dropping the origin (noise). */
const shortPath = (href: string): string => {
  try {
    const u = new URL(href);
    return `${u.pathname}${u.search}` || href;
  } catch {
    return href;
  }
};

// ── repro path (user actions) ───────────────────────────────────────

interface PathStep {
  t: number;
  text: string;
  isFailure: boolean;
}

/** Format one shared normalized action as a Korean repro-path step (or drop it). */
const actionToStep = (a: ReproAction): PathStep | null => {
  if (a.kind === 'navigate') {
    return { t: a.t, text: `${shortPath(a.href)} 로 이동`, isFailure: false };
  }
  if (a.kind === 'type') {
    const valuePart = a.masked
      ? ' 에 (입력값 마스킹됨) 입력'
      : a.value
        ? ` 에 "${a.value}" 입력`
        : ' 입력';
    return { t: a.t, text: `${describeTarget(a.target)}${valuePart}`, isFailure: false };
  }
  // Click — drop anonymous containers we can't name (noise without identity).
  if (!hasIdentity(a.target)) return null;
  return { t: a.t, text: `${describeTarget(a.target)} 클릭`, isFailure: false };
};

/** Extract identifiable user actions (nav / click / input) as readable steps. */
const buildActionTimeline = (events: unknown[], sessionStart: number): PathStep[] =>
  extractReproActions(events as RrwebEvent[], sessionStart)
    .map(actionToStep)
    .filter((s): s is PathStep => s !== null);

// ── failure signals (symptoms) ──────────────────────────────────────

interface FailureSignal {
  t: number;
  /** Detailed line for the [증상] block. */
  symptom: string;
  /** Compact marker for the repro path tail. */
  marker: string;
}

const extractFailures = (netArr: unknown[], consoleArr: unknown[]): FailureSignal[] => {
  const out: FailureSignal[] = [];
  for (const ev of netArr) {
    const e = ev as {
      tFromStart?: number;
      method?: string;
      url?: string;
      status?: number | null;
      error?: string | null;
      responseBody?: string | null;
    } | null;
    if (!e || typeof e.tFromStart !== 'number') continue;
    const isFail = (typeof e.status === 'number' && e.status >= 400) || !!e.error;
    if (!isFail) continue;
    const method = e.method ?? 'GET';
    const url = e.url ?? '?';
    const status = e.status ?? 'ERR';
    const hint = extractErrorHint(e.responseBody) ?? (e.error ? String(e.error) : null);
    out.push({
      t: e.tFromStart,
      symptom: `실패 요청: ${method} ${url} → ${status}${hint ? ` | ${hint}` : ''}`.slice(
        0,
        MAX_STR,
      ),
      marker: `✗ ${method} ${url} 요청이 ${status} 으로 실패`,
    });
  }
  for (const ev of consoleArr) {
    const e = ev as {
      tFromStart?: number;
      level?: string;
      args?: unknown[];
      stack?: string;
    } | null;
    if (!e || typeof e.tFromStart !== 'number' || e.level !== 'error') continue;
    const msg = (e.args ?? [])
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ')
      .slice(0, MAX_STR);
    const frame = topStackFrame(e.stack);
    out.push({
      t: e.tFromStart,
      symptom: `콘솔 에러: ${msg}${frame ? ` @ ${frame}` : ''}`,
      marker: `✗ 콘솔 에러: ${msg.slice(0, 80)}`,
    });
  }
  return out;
};

/**
 * Merge user actions + failure markers, then KEEP THE WINDOW AROUND THE
 * FIRST FAILURE (the tail is where the bug fires). No failure → first N.
 * Consecutive duplicates within 500ms are collapsed (mousedown/up noise).
 */
const buildReproPath = (actions: PathStep[], failures: FailureSignal[]): PathStep[] => {
  const failSteps: PathStep[] = failures.map((f) => ({ t: f.t, text: f.marker, isFailure: true }));
  const all = [...actions, ...failSteps].sort((a, b) => a.t - b.t);
  const deduped: PathStep[] = [];
  for (const step of all) {
    const last = deduped[deduped.length - 1];
    if (last && last.text === step.text && step.t - last.t < 500) continue;
    deduped.push(step);
  }
  const firstFail = deduped.findIndex((s) => s.isFailure);
  if (firstFail === -1) return deduped.slice(0, MAX_REPRO_STEPS);
  const start = Math.max(0, firstFail - (MAX_REPRO_STEPS - 1));
  return deduped.slice(start, firstFail + 1);
};

/** Numbered Korean repro steps — shared by the prompt and the deterministic stub. */
export const timelineToReproSteps = (steps: PathStep[]): string[] =>
  steps.map((s, i) => `${i + 1}. ${s.text}`);

/** Pull just the URL + start time from meta (env block — no UA/viewport noise). */
const envFromMeta = (meta: Record<string, unknown>): { url: string; startedAt: string } => ({
  url: typeof meta.url === 'string' ? meta.url : '(unknown)',
  startedAt: typeof meta.startedAt === 'number' ? new Date(meta.startedAt).toISOString() : '(?)',
});

/**
 * Curated, symptom-first summary fed to the model. Three blocks:
 *   [증상]      — failed requests (with response-body error hint) + console errors (with top frame)
 *   [재현 경로]  — identifiable user actions windowed around the first failure
 *   [환경]      — URL + start time only
 * Everything else (class selectors, UA, viewport, success requests, non-error
 * console, full stacks) is dropped — noise that burns tokens and misleads.
 */
export const summarizeForPrompt = (input: DraftInputArtifacts): string => {
  const meta = (input.meta ?? {}) as Record<string, unknown>;
  const sessionStart = typeof meta.startedAt === 'number' ? (meta.startedAt as number) : 0;
  const consoleArr = Array.isArray(input.console) ? (input.console as unknown[]) : [];
  const netArr = Array.isArray(input.network) ? (input.network as unknown[]) : [];
  const eventsArr = Array.isArray(input.events) ? (input.events as unknown[]) : [];

  const failures = extractFailures(netArr, consoleArr);
  const actions = buildActionTimeline(eventsArr, sessionStart);
  const reproSteps = timelineToReproSteps(buildReproPath(actions, failures));

  const symptomBlock = failures.length
    ? failures
        .slice(0, MAX_ITEMS)
        .map((f) => `- ${f.symptom}`)
        .join('\n')
    : '(명시적 실패 신호 없음)';
  const reproBlock = reproSteps.length
    ? reproSteps.map((s) => `  ${s}`).join('\n')
    : '(상호작용 없음)';
  const env = envFromMeta(meta);

  const out = [
    '[증상]',
    symptomBlock,
    '',
    '[재현 경로]',
    reproBlock,
    '',
    '[환경]',
    `- URL: ${env.url}`,
    `- 발생 시각: ${env.startedAt}`,
  ].join('\n');

  return redactJwt(out);
};

const SYSTEM_PROMPT = `당신은 한국어로 QA 버그 리포트를 작성하는 어시스턴트입니다.
목표: 개발자가 추가 질문 없이 바로 재현·수정에 착수할 수 있는 리포트.
입력은 (1) 사용자 한 줄 설명 (2) 큐레이션된 [증상]/[재현 경로]/[환경] 요약입니다. JSON schema 에 맞춘 응답만 생성하세요.

판단 순서 (먼저 할 것):
1) [증상]에 실패 요청·콘솔 에러가 있으면 그것이 버그의 핵심입니다. title·overview 를 이 증상 중심으로 쓰고, 단순 클릭 나열로 채우지 말 것.
2) [증상]이 "(명시적 실패 신호 없음)"이면 실패를 지어내지 말 것:
   - 사용자 입력에 명확한 문제 진술(예: "저장이 안 됨", "화면이 깨짐")이 있으면 그것을 증상으로 삼되, 캡처된 근거가 없다는 점을 밝힐 것.
   - 사용자 입력에도 문제 진술이 없으면 이것은 "버그"가 아니라 "관측 기록"입니다. overview 는 사용자가 실제로 한 행동만 사실대로 기술하고, 끝에 "캡처된 세션에서 명시적 에러/실패 신호는 없음"을 명시할 것. "에러/실패가 발생함" 같은 단정은 절대 쓰지 말 것.

각 필드 작성 규칙:
- title: 한 줄, 50자 이내, 끝에 마침표 금지, "버그:" 같은 접두어 금지. "어디서 / 무엇이 / 어떻게" 핵심. 실패 신호가 없으면 버그로 단정하지 말고 관측된 동작을 제목으로 쓸 것.
- overview: 1-3 문장.
  · 실패 신호가 있을 때: "사용자가 X 화면에서 Y 했을 때 Z 가 발생/실패함" 구조. 가능하면 '기대 vs 실제'를 대비 — 단, 기대 동작을 입력에서 추론할 수 없으면 쓰지 말 것(추측 금지).
  · 실패 신호가 없을 때: "사용자가 X 화면에서 Y 함" 처럼 행동만 기술하고 실패를 단정하지 말 것. 끝에 "명시적 에러/실패 신호 없음"을 명시.
- reproSteps: 한 단계 한 문자열, 3-7 단계. **[재현 경로]의 단계를 그대로 옮겨 적을 것.** 관측된 실패/이상 결과가 있으면 마지막 단계를 그것으로 끝내고, 실패가 관측되지 않았으면 마지막에 기록된 실제 액션으로 끝낼 것 — 이상 결과를 지어내지 말 것. 자리표시자("절차 모르겠음" 등) 금지.
  요소는 [tag "text"] 대괄호 표기로 주어집니다 — 그대로 옮기세요. **꺾쇠 < > 로 바꾸지 말 것** (Jira 가 HTML 태그로 오해해 첫 글자가 잘림).
- envBullets: URL, 발생 시각만. (Viewport / Browser / User-Agent 는 넣지 말 것.)
- attachments.consoleError: 첫 콘솔 에러 message 그대로(없으면 null).
- attachments.failedRequest: "<METHOD> <URL> → <status>" 형식(없으면 null).

문체: 간결한 평서형('~함 / ~됨')으로 통일.

원칙 (Anti-hallucination — 어기면 부정확한 리포트가 발행됨):
- **실패 지어내기 금지**: [증상]과 사용자 입력 어디에도 실패 근거가 없으면 "에러/실패가 발생했다/났다"고 쓰지 말 것. 성공한 요청(2xx)이나 정상 액션을 실패로 서술 금지. 저장 성공을 "저장 실패"로 뒤집지 말 것.
- **숫자 추정 금지**: 정확한 횟수/길이/순번을 단정하지 말 것. [재현 경로]에 실제로 등장한 것만 세어 표기. 모호하면 "여러 번" 등 정성 표현.
- **입력값 추정 금지**: 입력값은 [재현 경로]의 따옴표 안 값만 사용. "(입력값 마스킹됨)"은 자릿수/내용/타입 추정 금지.
- **overview 와 reproSteps 정합**: overview 의 횟수/이벤트는 reproSteps 와 일치.
- **입력 type 추정 금지**: 명시 없으면 "비밀번호/이메일 입력" 단정 금지.
- 캡처되지 않아 추측한 내용은 "(추정)" 접미사로 표시.
- 콘솔 에러 raw 텍스트를 reproSteps 에 그대로 복사하지 말 것 — 의미를 풀어 적기.

예시 (형식·톤 참고용 — 값을 그대로 베끼지 말 것):
[증상]
- 실패 요청: POST /graphql → 500 | PRODUCT_FETCH_FAILED
- 콘솔 에러: Failed to fetch products @ ProductList.tsx:88
[재현 경로]
  1. [button "필터 열기" — data-testid="filter-toggle"] 클릭
  2. [span "판매중"] 클릭
  3. ✗ POST /graphql 요청이 500 으로 실패
[이상적 출력]
{"title":"판매중 필터 적용 시 /graphql 500 으로 상품 목록 빔","overview":"사용자가 목록 화면에서 필터를 열고 '판매중'을 선택했을 때 POST /graphql 이 500(PRODUCT_FETCH_FAILED)으로 실패하며 상품이 표시되지 않음. 기대: 판매중 상품 노출, 실제: 빈 목록.","reproSteps":["1. [button \\"필터 열기\\" — data-testid=\\"filter-toggle\\"] 클릭","2. [span \\"판매중\\"] 클릭","3. POST /graphql 이 500 으로 실패하고 상품 목록이 비어 있음"],"envBullets":["URL: https://example.com/products","발생 시각: 2026-06-23T04:12:00Z"],"attachments":{"consoleError":"Failed to fetch products","failedRequest":"POST /graphql → 500"}}

예시2 (실패 신호가 없는 관측 기록 — 실패를 지어내지 말 것):
[증상]
(명시적 실패 신호 없음)
[재현 경로]
  1. [textarea] 에 (입력값 마스킹됨) 입력
  2. [button "수정 저장"] 클릭
[이상적 출력]
{"title":"상품 정보 수정 후 저장 동작 기록","overview":"사용자가 상품 수정 화면에서 여러 항목을 입력하고 '수정 저장'을 클릭함. 캡처된 세션에서 명시적 에러/실패 신호는 없음.","reproSteps":["1. 상품 정보 입력란에 값 입력","2. '수정 저장' 클릭"],"envBullets":["URL: https://example.com/edit","발생 시각: 2026-07-02T01:09:33Z"],"attachments":{"consoleError":null,"failedRequest":null}}`;

const buildUserPrompt = (userInput: string, summary: string): string =>
  `[사용자 입력]\n"${userInput || '(없음)'}"\n\n${summary}`;

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

/**
 * Deterministic draft used when AI is unavailable (no binding / free-tier
 * exhausted / schema violation). Builds REAL repro steps from the same curated
 * timeline the prompt uses, so the no-AI path is still publishable — not a
 * "(AI 실패)" placeholder. On the Free plan this is what reviewers see once the
 * daily neuron allocation is spent.
 */
export const buildBugStub = (artifacts: DraftInputArtifacts, userInput: string): BugDraft => {
  const safe = sanitizeForAI(artifacts) as DraftInputArtifacts;
  const meta = (safe.meta && typeof safe.meta === 'object' ? safe.meta : {}) as Record<
    string,
    unknown
  >;
  const sessionStart = typeof meta.startedAt === 'number' ? (meta.startedAt as number) : 0;
  const consoleArr = Array.isArray(safe.console) ? (safe.console as unknown[]) : [];
  const netArr = Array.isArray(safe.network) ? (safe.network as unknown[]) : [];
  const eventsArr = Array.isArray(safe.events) ? (safe.events as unknown[]) : [];

  const failures = extractFailures(netArr, consoleArr);
  const actions = buildActionTimeline(eventsArr, sessionStart);
  const reproSteps = timelineToReproSteps(buildReproPath(actions, failures)).map((s) =>
    redactJwt(s),
  );
  const sniff = sniffAttachments(safe);
  const env = envFromMeta(meta);
  const trimmedInput = userInput.trim();
  const firstSymptom = failures[0]?.symptom ?? null;

  const title = redactJwt(
    trimmedInput.slice(0, 50) ||
      (sniff.failedRequest ? `요청 실패: ${sniff.failedRequest}` : '') ||
      (firstSymptom ? firstSymptom.slice(0, 50) : '') ||
      'Bugzar 버그 리포트',
  );
  const overview = redactJwt(
    trimmedInput ||
      (firstSymptom
        ? `세션 중 ${firstSymptom} 발생 (자동 합성된 기본 초안 — Replay 영상으로 확인 필요).`
        : '사용자 한 줄 설명이 없어 캡처된 동작만으로 합성한 기본 초안입니다. Replay 영상으로 재현 절차를 확인하세요.'),
  );

  return {
    title,
    overview,
    reproSteps: reproSteps.length
      ? reproSteps
      : ['기록된 상호작용이 없어 재현 절차를 확정하지 못함 — Replay 영상 참고'],
    envBullets: [`URL: ${env.url}`, `발생 시각: ${env.startedAt}`],
    attachments: sniff,
  };
};

/** Deterministic design draft used when AI is unavailable. Memo-first. */
export const buildDesignStub = (
  elements: DesignElementInput[],
  userInput: string,
  meta: Record<string, unknown>,
): DesignDraft => {
  const env = envFromMeta(meta);
  return {
    title: `[디자인] ${userInput.trim().slice(0, 50) || '디자인 피드백'}`,
    overview: redactJwt(
      userInput.trim() ||
        '사용자 전체 코멘트가 없어 각 요소의 메모를 기반으로 정리한 기본 초안입니다.',
    ),
    items: elements.map((el) => ({
      selector: el.selector,
      location: el.componentName || (el.textContent ?? '').trim().slice(0, 40) || el.selector,
      issue: redactJwt((el.userNote ?? '').trim() || '(메모 없음 — 요소 기준 검토 필요)'),
      suggestion: '(검토 필요)',
      severityHint: 'minor' as const,
    })),
    envBullets: [`URL: ${env.url}`, `발생 시각: ${env.startedAt}`],
  };
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
 * One compact line per selected element — IDENTITY + the user's memo (the
 * key signal). We drop the raw css selector and rect/size: the selector is
 * restored by index on output, and size is noise. Identity = component name
 * when known, else tag, plus the visible text.
 */
const summarizeDesignElement = (el: DesignElementInput, idx: number): string => {
  const ident = el.componentName
    ? `<${el.componentName}>`
    : (el.tagName ?? 'element').toLowerCase();
  const text = truncate((el.textContent ?? '').trim(), 60);
  const textPart = text ? ` "${text}"` : '';
  const note = truncate(redactJwt((el.userNote ?? '').trim()), 200);
  return `${idx + 1}. ${ident}${textPart} — 메모: ${note || '(없음)'}`;
};

const summarizeDesignInput = (
  elements: DesignElementInput[],
  meta: Record<string, unknown> | undefined,
): string => {
  const env = envFromMeta((meta ?? {}) as Record<string, unknown>);
  const items = elements.map((el, idx) => summarizeDesignElement(el, idx)).join('\n');
  return `[선택한 요소]\n${items || '(선택 없음)'}\n\n[환경]\n- URL: ${env.url}\n- 발생 시각: ${env.startedAt}`;
};

const DESIGN_SYSTEM_PROMPT = `당신은 한국어로 디자인 피드백 리포트를 작성하는 어시스턴트입니다.
입력은 (1) 사용자 전체 코멘트 (2) [선택한 요소] 목록(요소별 식별자 + 사용자 메모) + [환경]. JSON schema 에 맞춘 응답만 생성하세요.

각 필드 작성 규칙:
- title: "[디자인]"으로 시작, 60자 이내.
- overview: 1~2 문장으로 피드백의 전체 의도.
- items: 입력의 각 요소마다 하나, 입력 순서 그대로.
  · selector: 해당 요소의 번호 문자열(예: "1"). 임의 변형 금지.
  · location: 사용자에게 보일 위치 ("헤더의 검색 버튼" 등) — 식별자/텍스트로 추론.
  · issue: 사용자 메모를 자연스러운 한 문장으로 다듬기. 메모가 "(없음)"이면 요소 정보로 합리적 추정하되 "(추정)" 표시.
  · suggestion: 구체적 개선 방향을 한 문장으로.
  · severityHint: minor|major|critical. 판단 근거 — 가독성/접근성 저해는 major 이상, 정렬·여백 등 미관 이슈는 minor.
- envBullets: ["URL: ...", "발생 시각: ..."]. (Viewport / Browser / User-Agent 는 넣지 말 것.)
문체: 간결한 평서형, 모든 필드 한국어.

예시 (형식 참고 — 값을 그대로 베끼지 말 것):
[선택한 요소]
1. <BuyButton> "구매하기" — 메모: 버튼이 작고 색이 흐림
[이상적 출력]
{"title":"[디자인] 구매 버튼 가시성 개선 필요","overview":"주요 행동 유도 버튼의 크기와 대비가 부족해 눈에 잘 띄지 않음.","items":[{"selector":"1","location":"구매 버튼","issue":"구매 버튼이 작고 색 대비가 낮아 가독성이 떨어짐.","suggestion":"버튼 크기를 키우고 배경과의 대비를 높여 주요 액션으로 강조.","severityHint":"major"}],"envBullets":["URL: https://example.com/cart","발생 시각: 2026-06-23T04:12:00Z"]}`;

const buildDesignUserPrompt = (userInput: string, summary: string): string =>
  `[전체 코멘트]\n"${userInput || '(없음)'}"\n\n${summary}`;

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

  // Design draft is more verbose (one block per element) — bump the ceiling.
  let parsed: DesignDraft = await runDraftModel(ai, {
    model: opts.model ?? DEFAULT_AI_MODEL,
    messages,
    schema: DESIGN_SCHEMA,
    maxTokens: 1536,
    label: 'Workers AI (design)',
    validate: isDesignDraft,
  });

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
    };
  }

  return parsed;
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

  const parsed = await runDraftModel(ai, {
    model: opts.model ?? DEFAULT_AI_MODEL,
    messages,
    schema: BUG_SCHEMA,
    maxTokens: 1024,
    label: 'Workers AI (bug)',
    validate: isBugDraft,
  });

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
