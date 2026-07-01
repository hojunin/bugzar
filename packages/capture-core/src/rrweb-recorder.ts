import type { eventWithTime } from '@rrweb/types';
import { record } from 'rrweb';

type Options = {
  onBatch: (events: eventWithTime[]) => void;
  batchIntervalMs: number;
  /**
   * Inline images (and keep stylesheets inlined) into the rrweb snapshot at
   * capture time. Needed for an OFFLINE replay (e.g. the SDK's self-contained
   * HTML export) where the original asset URLs are unreachable. Costs capture
   * size, so it's opt-in — the hosted replay can reload assets over the network.
   */
  inlineImages?: boolean;
  /**
   * Semantics changed: now means "mask sensitive inputs only" (password +
   * a few other risky types). Every other input keeps its visible value
   * — reviewers can see what was actually typed, which is essential for
   * reproducing form-driven bugs. When the user explicitly opts into
   * "mask everything", flip this to true.
   *
   * - false / undefined (default): rrweb's maskAllInputs OFF, but
   *   maskInputOptions still mask password / hidden / credit-card-like
   *   fields. Most QA cases.
   * - true: rrweb's maskAllInputs ON — every text input is masked.
   *   Use when recording in front of customers / sensitive demos.
   */
  maskAllInputs?: boolean;
};

/**
 * Per-type masking floor used only on the opt-out path (`maskAllInputs: false`).
 * Just `password` — rrweb always masks it — so opting out of full masking still
 * never leaks a password field. With `maskAllInputs` on (the default), rrweb
 * masks every input type and this object is unused.
 */
const SENSITIVE_INPUT_OPTIONS = {
  password: true,
} as const;

let stopFn: (() => void) | null = null;
let buffer: eventWithTime[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let lastOnBatch: ((events: eventWithTime[]) => void) | null = null;

/**
 * Post-capture sanitize: `<input name="tagName">` 같이 form 의 native property
 * 를 가리는 named children 의 name/id attr 를 삭제한다.
 *
 * 왜 필요한가:
 *   - rrweb 의 record 옵션 `blockSelector` 가 입력 input 을 매치하면 attrs 가
 *     비워져야 하는데, 같은 selector 가 record 의 다른 코드 경로 (mutation
 *     observer 의 add 처리) 에서는 호출되지 않거나 element matching 이 안
 *     되는 케이스가 있어 events 에 input 의 name=tagName 이 그대로 남는다.
 *   - replay 시 rrweb-player 가 form 을 재구성하면 그 안에 input(name=tagName)
 *     이 들어가고 `form.tagName` 이 HTMLFormElement 의 named property access
 *     로 input 노드 반환 → `.toUpperCase()` throw → mutation batch abort →
 *     이후 모든 mutation 이 "Node with id X not found" 로 누적.
 *
 * Selenium #14229 / Playwright #30616 와 같은 함정. rrweb 자체의 fix 가 아직
 * 없어 우리 측에서 사후 검열한다.
 *
 * 검열 방식: input 노드 자체는 events 에 남기되 (UI 의 빈 박스로 보임), 충돌
 * 유발 attr (`name="tagName"` / `id="tagName"`) 만 attrs 에서 삭제. form 의
 * named children 매핑이 끊겨 form.tagName 이 정상 string 반환.
 */
const COLLIDING_VALUES = new Set(['tagName']);

const sanitizeSerializedNode = (node: unknown): void => {
  if (!node || typeof node !== 'object') return;
  const n = node as {
    type?: number;
    attributes?: Record<string, string>;
    childNodes?: unknown[];
  };
  if (n.type === 2 /* Element */ && n.attributes && typeof n.attributes === 'object') {
    // name / id 가 native form property 와 충돌하는 값이면 그 attr 만 삭제.
    if (typeof n.attributes.name === 'string' && COLLIDING_VALUES.has(n.attributes.name)) {
      delete n.attributes.name;
    }
    if (typeof n.attributes.id === 'string' && COLLIDING_VALUES.has(n.attributes.id)) {
      delete n.attributes.id;
    }
  }
  if (Array.isArray(n.childNodes)) {
    for (const c of n.childNodes) sanitizeSerializedNode(c);
  }
};

const sanitizeEvents = (events: eventWithTime[]): void => {
  for (const e of events) {
    // FullSnapshot — 전체 트리를 walk.
    if (e.type === 2) {
      const data = e.data as { node?: unknown } | undefined;
      if (data?.node) sanitizeSerializedNode(data.node);
      continue;
    }
    // IncrementalSnapshot Mutation — adds 의 노드 트리 + attributes mutation 검열.
    if (e.type === 3) {
      const d = e.data as
        | {
            source?: number;
            adds?: Array<{ node?: unknown }>;
            attributes?: Array<{ attributes?: Record<string, string | null> }>;
          }
        | undefined;
      if (!d || d.source !== 0) continue;
      if (Array.isArray(d.adds)) {
        for (const add of d.adds) {
          if (add?.node) sanitizeSerializedNode(add.node);
        }
      }
      if (Array.isArray(d.attributes)) {
        for (const am of d.attributes) {
          const attrs = am?.attributes;
          if (!attrs || typeof attrs !== 'object') continue;
          if (typeof attrs.name === 'string' && COLLIDING_VALUES.has(attrs.name)) {
            // 충돌 유발 값을 빈 문자열로 (null 은 removeAttribute 인데 None 으로
            // 인식될 수 있어서 보수적으로 empty string).
            attrs.name = '';
          }
          if (typeof attrs.id === 'string' && COLLIDING_VALUES.has(attrs.id)) {
            attrs.id = '';
          }
        }
      }
    }
  }
};

export const startRecording = ({
  onBatch,
  batchIntervalMs,
  maskAllInputs = true,
  inlineImages = false,
}: Options): void => {
  if (stopFn) return; // idempotent
  buffer = [];
  lastOnBatch = onBatch;

  stopFn =
    record({
      emit: (e: eventWithTime) => {
        // 단일 event 도 트리 검열. 큰 비용 아님 (Element 노드 + childNodes 만).
        sanitizeEvents([e]);
        buffer.push(e);
      },
      // Fail-safe default: rrweb masks every input. A caller must explicitly
      // pass maskAllInputs:false to preserve visible input values for
      // reproduction, in which case only SENSITIVE_INPUT_OPTIONS (password)
      // stays masked.
      maskAllInputs,
      // Spread instead of an explicit `undefined`: exactOptionalPropertyTypes
      // rejects passing undefined to an optional prop, and omitting the key when
      // maskAllInputs is on is identical to rrweb (default = no per-type mask).
      ...(maskAllInputs ? {} : { maskInputOptions: SENSITIVE_INPUT_OPTIONS }),
      // Offline export: inline images + stylesheets so the replay needs no network.
      ...(inlineImages ? { inlineImages: true, inlineStylesheet: true } : {}),
      sampling: { mousemove: 50, scroll: 150 },
      slimDOMOptions: { script: true, comment: true },
      // 30초마다 새 FullSnapshot 강제. ag-grid 같은 가상 스크롤 컴포넌트에서
      // rrweb 의 MutationObserver 가 add↔remove 순서를 일부 놓치면 누적
      // node-id 어긋남이 생기고 replay 가 "Node with id 'X' not found" 로
      // 멈춰 보인다. 주기적 checkpoint 가 그 누적을 reset — 사용량이 늘긴
      // 하지만 캡처 자체가 무용지물이 되는 것보다 낫다.
      checkoutEveryNms: 30_000,
      // ────────────────────────────────────────────────────────────────
      // HTMLFormElement.tagName 충돌 회피.
      //
      // 페이지에 `<form>` 안에 `<input name="tagName">` 또는 `<input id="tagName">`
      // 가 있으면, JavaScript 표준 "form 의 named child 가 form 의 property 로
      // 노출" 동작 때문에 `form.tagName` 이 string "FORM" 대신 그 input 노드
      // 자체를 반환한다 (HTMLFormElement 의 named property access).
      //
      // rrweb-player 가 replay 도중 그 form 의 tagName 을 호출하면 input 노드가
      // 돌아오고, `.toUpperCase()` 에서 throw → 그 mutation batch 전체 abort →
      // 같은 batch 의 다른 adds 가 트리에 안 들어감 → 이후 모든 mutation 이
      // "Node with id X not found" 로 누적되어 replay 가 멈춘 것처럼 보임.
      //
      // 무신사 admin 의 카탈로그 페이지처럼 "태그명" 입력 필드가 흔한 폼이
      // 정확히 이 함정에 빠진다. Selenium #14229 / Playwright #30616 에서
      // 같은 케이스가 보고됐다 — rrweb 측 fix 는 아직 없음.
      //
      // 우회: 그 input 만 capture 에서 제외 → form 의 children 에 안 들어감 →
      // form.tagName 이 정상 string "FORM" → throw 없음. 그 input 한 개의
      // 사용자 입력은 캡처되지 않지만 전체 replay 가 부서지는 것보다 작은 손실.
      blockSelector: 'input[name="tagName"], input[id="tagName"]',
    }) ?? null;

  flushTimer = setInterval(() => {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    onBatch(batch);
  }, batchIntervalMs);
};

/**
 * One-shot DOM snapshot of the current page — a Meta + FullSnapshot pair the
 * viewer's `Replayer` can render as a static screen. Used by the design-pick flow
 * so a design report can show the actual page with the annotations pinned on it.
 *
 * rrweb emits the full snapshot synchronously during `record()`, so we start and
 * immediately stop. `blockSelector` excludes our own in-page UI (the FAB / picker
 * overlay) from the captured screen.
 *
 * Masking mirrors `startRecording`: `maskAllInputs` defaults on, so every field
 * is masked unless the caller opts out — without this the design-pick snapshot
 * would capture on-page credentials in cleartext into a report uploaded to R2 / Jira.
 */
export const captureSnapshot = (
  blockSelector?: string,
  inlineImages?: boolean,
  maskAllInputs = true,
): eventWithTime[] => {
  const events: eventWithTime[] = [];
  const stop = record({
    emit: (e: eventWithTime) => {
      sanitizeEvents([e]);
      events.push(e);
    },
    slimDOMOptions: { script: true, comment: true },
    maskAllInputs,
    ...(maskAllInputs ? {} : { maskInputOptions: SENSITIVE_INPUT_OPTIONS }),
    ...(blockSelector ? { blockSelector } : {}),
    // Offline design export: inline the page's images + styles into the snapshot.
    ...(inlineImages ? { inlineImages: true, inlineStylesheet: true } : {}),
  });
  stop?.();
  return events;
};

export const stopRecording = (): void => {
  if (stopFn) {
    stopFn();
    stopFn = null;
  }
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  // Final flush — earlier versions dropped the trailing buffer, which lost
  // every event between the last interval tick and stop (and the entire
  // initial FullSnapshot when the user stopped under one batch interval).
  if (buffer.length > 0 && lastOnBatch) {
    const batch = buffer;
    buffer = [];
    try {
      lastOnBatch(batch);
    } catch (err) {
      console.warn('[bugzar host] final rrweb flush failed', err);
    }
  }
  buffer = [];
  lastOnBatch = null;
};
