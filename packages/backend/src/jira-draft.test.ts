import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildBugStub,
  buildDesignStub,
  type DraftInputArtifacts,
  extractErrorHint,
  extractJsonFromAiResponse,
  generateBugDraft,
  generateDesignDraft,
  summarizeForPrompt,
  timelineToReproSteps,
  topStackFrame,
} from './jira-draft';

/**
 * Workers AI's Llama 3.1 8B routinely violates `response_format: json_schema`
 * by wrapping output in markdown fences, prefacing with prose, or trailing
 * with chatter. These tests pin down the parser's tolerance — anything that
 * regresses here surfaces as the dreaded "AI returned non-JSON response"
 * 502 the user hits in the popup.
 */
describe('extractJsonFromAiResponse', () => {
  it('passes through an already-parsed object', () => {
    const obj = { title: 'x', reproSteps: ['a'] };
    expect(extractJsonFromAiResponse(obj)).toEqual(obj);
  });

  it('parses a clean JSON string', () => {
    const s = '{"title":"hello","n":42}';
    expect(extractJsonFromAiResponse(s)).toEqual({ title: 'hello', n: 42 });
  });

  it('strips ```json fences', () => {
    const s = '```json\n{"title":"hello"}\n```';
    expect(extractJsonFromAiResponse(s)).toEqual({ title: 'hello' });
  });

  it('strips plain ``` fences (no language tag)', () => {
    const s = '```\n{"title":"hello"}\n```';
    expect(extractJsonFromAiResponse(s)).toEqual({ title: 'hello' });
  });

  it('handles leading prose before the JSON object', () => {
    const s = 'Here is the JSON:\n{"title":"hello","n":1}';
    expect(extractJsonFromAiResponse(s)).toEqual({ title: 'hello', n: 1 });
  });

  it('handles trailing prose after the JSON object', () => {
    const s = '{"title":"hello"}\n\nLet me know if you need anything else.';
    expect(extractJsonFromAiResponse(s)).toEqual({ title: 'hello' });
  });

  it('handles both leading prose AND trailing prose', () => {
    const s = 'Sure! Here you go:\n{"title":"hello","reproSteps":["a","b"]}\nHope this helps.';
    expect(extractJsonFromAiResponse(s)).toEqual({
      title: 'hello',
      reproSteps: ['a', 'b'],
    });
  });

  it('handles braces inside string literals (do not break depth count)', () => {
    const s = '{"title":"contains {curly} braces","n":1}';
    expect(extractJsonFromAiResponse(s)).toEqual({
      title: 'contains {curly} braces',
      n: 1,
    });
  });

  it('handles escaped quotes inside strings', () => {
    const s = '{"title":"she said \\"hi\\""}';
    expect(extractJsonFromAiResponse(s)).toEqual({ title: 'she said "hi"' });
  });

  it('strips leading whitespace + BOM', () => {
    const s = '﻿\n  \n{"title":"hello"}';
    expect(extractJsonFromAiResponse(s)).toEqual({ title: 'hello' });
  });

  it('throws when the input has no JSON object at all', () => {
    expect(() => extractJsonFromAiResponse('I cannot help with that request.')).toThrow(/non-JSON/);
  });

  it('throws when the input has a "{" but the slice does not parse', () => {
    // "{" appears but content is broken — depth scan finds a slice that
    // still isn't valid JSON.
    expect(() => extractJsonFromAiResponse('result: { not, json: at: all }')).toThrow(/non-JSON/);
  });

  it('throws for null / undefined / number inputs', () => {
    expect(() => extractJsonFromAiResponse(null)).toThrow(/non-JSON/);
    expect(() => extractJsonFromAiResponse(undefined)).toThrow(/non-JSON/);
    expect(() => extractJsonFromAiResponse(42)).toThrow(/non-JSON/);
  });
});

/**
 * `summarizeForPrompt` is what feeds the AI. The first published Jira ticket
 * (CBPFE-4164) showed the cost of getting this wrong — the AI parroted the
 * user's one-line description because it had nothing else to go on. These
 * tests pin down the enriched timeline format: clicks resolve to element
 * tag+text, URL changes show up as NAVIGATE rows, env metadata makes it
 * through, and the model gets enough signal to generate real repro steps.
 */
describe('summarizeForPrompt', () => {
  const sessionStart = 1_700_000_000_000;

  // FullSnapshot: a button (data-testid + noise class), an input (aria-label),
  // and a class-only div (no stable identity → its class must be dropped).
  const sampleFullSnapshot = {
    type: 2,
    timestamp: sessionStart,
    data: {
      node: {
        type: 1, // Document
        childNodes: [
          {
            type: 2, // Element
            id: 1,
            tagName: 'BODY',
            childNodes: [
              {
                type: 2,
                id: 42,
                tagName: 'BUTTON',
                attributes: { 'data-testid': 'filter-toggle', class: 'btn primary css-1a2b3c' },
                childNodes: [{ type: 3, textContent: '필터 열기' }],
              },
              {
                type: 2,
                id: 43,
                tagName: 'INPUT',
                attributes: { 'aria-label': '검색어', type: 'text' },
              },
              {
                type: 2,
                id: 44,
                tagName: 'DIV',
                attributes: { class: 'sidebar-link' },
                childNodes: [{ type: 3, textContent: '더보기' }],
              },
            ],
          },
        ],
      },
    },
  };

  it('renders a click as a Korean repro step with tag + text + stable selector (no class)', () => {
    const artifacts: DraftInputArtifacts = {
      meta: { url: 'https://shop.example/list', startedAt: sessionStart },
      events: [
        sampleFullSnapshot,
        { type: 3, timestamp: sessionStart + 1500, data: { source: 2, type: 2, id: 42 } },
      ],
    };
    const summary = summarizeForPrompt(artifacts);
    expect(summary).toContain('[재현 경로]');
    // Square-bracket element notation (Jira-safe), Korean action verb.
    expect(summary).toContain('[button "필터 열기"');
    expect(summary).toContain('data-testid="filter-toggle"');
    expect(summary).toContain('클릭');
    // Class soup must be dropped — it's noise.
    expect(summary).not.toContain('btn primary');
    expect(summary).not.toContain('css-1a2b3c');
  });

  it('reports input events with the typed value', () => {
    const artifacts: DraftInputArtifacts = {
      meta: { url: 'https://shop.example/list', startedAt: sessionStart },
      events: [
        sampleFullSnapshot,
        { type: 3, timestamp: sessionStart + 2000, data: { source: 5, id: 43, text: '결제 모듈' } },
      ],
    };
    const summary = summarizeForPrompt(artifacts);
    expect(summary).toContain('aria-label="검색어"');
    expect(summary).toContain('"결제 모듈" 입력');
  });

  it('masks asterisk-only input values', () => {
    const artifacts: DraftInputArtifacts = {
      meta: { url: 'https://shop.example/list', startedAt: sessionStart },
      events: [
        sampleFullSnapshot,
        { type: 3, timestamp: sessionStart + 2000, data: { source: 5, id: 43, text: '*****' } },
      ],
    };
    const summary = summarizeForPrompt(artifacts);
    expect(summary).toContain('(입력값 마스킹됨)');
    expect(summary).not.toContain('*****');
  });

  it('drops clicks on elements with no stable identity (anonymous container)', () => {
    // The class-only div has text but no testid/aria/role — it keeps its text
    // but never its class. A truly anonymous node would be dropped entirely.
    const artifacts: DraftInputArtifacts = {
      meta: { url: 'https://shop.example/list', startedAt: sessionStart },
      events: [
        sampleFullSnapshot,
        { type: 3, timestamp: sessionStart + 1000, data: { source: 2, type: 2, id: 44 } },
      ],
    };
    const summary = summarizeForPrompt(artifacts);
    expect(summary).toContain('[div "더보기"]');
    expect(summary).not.toContain('sidebar-link');
  });

  it('renders URL changes as 이동 steps (path only)', () => {
    const artifacts: DraftInputArtifacts = {
      meta: { url: 'https://shop.example/list', startedAt: sessionStart },
      events: [
        sampleFullSnapshot,
        { type: 4, timestamp: sessionStart, data: { href: 'https://shop.example/list' } },
        {
          type: 4,
          timestamp: sessionStart + 3000,
          data: { href: 'https://shop.example/list?status=sale' },
        },
      ],
    };
    const summary = summarizeForPrompt(artifacts);
    expect(summary).toContain('/list?status=sale 로 이동');
    // Origin is dropped — only the path is repro-relevant.
    expect(summary).not.toContain('https://shop.example/list?status=sale 로 이동');
  });

  it('puts failed requests (with response-body error hint) + console errors in [증상]', () => {
    const artifacts: DraftInputArtifacts = {
      meta: { url: 'https://shop.example/list', startedAt: sessionStart },
      events: [sampleFullSnapshot],
      network: [
        {
          tFromStart: 1200,
          method: 'POST',
          url: '/graphql',
          status: 500,
          responseBody: '{"error":"PRODUCT_FETCH_FAILED"}',
        },
        { tFromStart: 800, method: 'GET', url: '/healthz', status: 200 }, // success — noise
      ],
      console: [
        {
          tFromStart: 1300,
          level: 'error',
          args: ['Failed to fetch products'],
          stack: 'Error: x\n    at ProductList.tsx:88:10',
        },
        { tFromStart: 400, level: 'log', args: ['app boot'] }, // non-error — noise
      ],
    };
    const summary = summarizeForPrompt(artifacts);
    expect(summary).toContain('[증상]');
    // Response-body error code is extracted — this is the high-value signal.
    expect(summary).toContain('실패 요청: POST /graphql → 500 | PRODUCT_FETCH_FAILED');
    // Console error message + top stack frame (not the full stack).
    expect(summary).toContain('콘솔 에러: Failed to fetch products @ ProductList.tsx:88:10');
    // Failed request listed before console error.
    expect(summary.indexOf('실패 요청')).toBeLessThan(summary.indexOf('콘솔 에러'));
    // Noise stays out.
    expect(summary).not.toContain('/healthz');
    expect(summary).not.toContain('app boot');
  });

  it('aggressively strips UA / viewport noise from the env block', () => {
    const summary = summarizeForPrompt({
      meta: {
        url: 'https://shop.example/list',
        startedAt: sessionStart,
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X) ChromeBuild',
        viewport: { w: 1440, h: 900, dpr: 2 },
      },
      events: [],
    });
    expect(summary).toContain('[환경]');
    expect(summary).toContain('- URL: https://shop.example/list');
    expect(summary).not.toContain('Viewport');
    expect(summary).not.toContain('User-Agent');
    expect(summary).not.toContain('Mozilla');
  });

  it('gracefully degrades when events is empty', () => {
    const summary = summarizeForPrompt({
      meta: { url: 'https://shop.example/list', startedAt: sessionStart },
      events: [],
    });
    expect(summary).toContain('[재현 경로]');
    expect(summary).toContain('(상호작용 없음)');
    expect(summary).toContain('(명시적 실패 신호 없음)');
  });

  it('collapses consecutive duplicate clicks inside 500ms (mousedown/up noise)', () => {
    const artifacts: DraftInputArtifacts = {
      meta: { url: 'https://shop.example/list', startedAt: sessionStart },
      events: [
        sampleFullSnapshot,
        { type: 3, timestamp: sessionStart + 500, data: { source: 2, type: 2, id: 42 } },
        { type: 3, timestamp: sessionStart + 520, data: { source: 2, type: 2, id: 42 } },
        { type: 3, timestamp: sessionStart + 540, data: { source: 2, type: 2, id: 42 } },
      ],
    };
    const summary = summarizeForPrompt(artifacts);
    const matches = summary.match(/\[button "필터 열기"/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('windows the repro path around the FIRST failure (keeps the tail, drops early noise)', () => {
    // 8 distinct clicks then a failure. Only the ~6-step window ending at the
    // failure should survive — early clicks (버튼1..) are dropped, the failure
    // is the last step.
    const buttons = Array.from({ length: 8 }, (_, i) => ({
      type: 2,
      id: 100 + i,
      tagName: 'BUTTON',
      attributes: { 'data-testid': `btn-${i + 1}` },
      childNodes: [{ type: 3, textContent: `버튼${i + 1}` }],
    }));
    const snapshot = {
      type: 2,
      timestamp: sessionStart,
      data: {
        node: { type: 1, childNodes: [{ type: 2, id: 1, tagName: 'BODY', childNodes: buttons }] },
      },
    };
    const clicks = buttons.map((b, i) => ({
      type: 3,
      timestamp: sessionStart + (i + 1) * 1000,
      data: { source: 2, type: 2, id: b.id },
    }));
    const artifacts: DraftInputArtifacts = {
      meta: { url: 'https://shop.example/list', startedAt: sessionStart },
      events: [snapshot, ...clicks],
      network: [{ tFromStart: 9000, method: 'POST', url: '/checkout', status: 500 }],
    };
    const summary = summarizeForPrompt(artifacts);
    expect(summary).toContain('버튼8');
    expect(summary).toContain('✗ POST /checkout 요청이 500 으로 실패');
    // Early clicks fall outside the window.
    expect(summary).not.toContain('버튼1]');
    expect(summary).not.toContain('버튼2]');
  });
});

describe('extractErrorHint', () => {
  it('pulls the error field out of a JSON body', () => {
    expect(extractErrorHint('{"error":"OUT_OF_STOCK"}')).toBe('OUT_OF_STOCK');
    expect(extractErrorHint('{"message":"validation failed: email"}')).toBe(
      'validation failed: email',
    );
    expect(extractErrorHint('{"detail":"nope","code":"E1"}')).toBe('nope');
  });

  it('reads a nested error.message', () => {
    expect(extractErrorHint('{"error":{"message":"boom"}}')).toBe('boom');
  });

  it('falls back to a truncated single line for non-JSON bodies', () => {
    expect(extractErrorHint('Internal Server Error\n at server')).toBe(
      'Internal Server Error at server',
    );
    expect(extractErrorHint('x'.repeat(500))?.length).toBe(120);
  });

  it('returns null for empty / non-string', () => {
    expect(extractErrorHint('')).toBeNull();
    expect(extractErrorHint(null)).toBeNull();
    expect(extractErrorHint(undefined)).toBeNull();
  });
});

describe('topStackFrame', () => {
  it('returns the first frame, stripped of "at "', () => {
    expect(topStackFrame('Error: boom\n    at Cart.tsx:42:10\n    at App.tsx:1:1')).toBe(
      'Cart.tsx:42:10',
    );
  });
  it('returns null when there is no frame', () => {
    expect(topStackFrame('just a message')).toBeNull();
    expect(topStackFrame(undefined)).toBeNull();
  });
});

describe('timelineToReproSteps', () => {
  it('numbers the steps from 1', () => {
    expect(
      timelineToReproSteps([
        { t: 1, text: '[button "A"] 클릭', isFailure: false },
        { t: 2, text: '✗ POST /x 요청이 500 으로 실패', isFailure: true },
      ]),
    ).toEqual(['1. [button "A"] 클릭', '2. ✗ POST /x 요청이 500 으로 실패']);
  });
});

describe('buildBugStub (deterministic, no AI)', () => {
  const sessionStart = 1_700_000_000_000;
  const snapshot = {
    type: 2,
    timestamp: sessionStart,
    data: {
      node: {
        type: 1,
        childNodes: [
          {
            type: 2,
            id: 1,
            tagName: 'BODY',
            childNodes: [
              {
                type: 2,
                id: 42,
                tagName: 'BUTTON',
                attributes: { 'data-testid': 'buy' },
                childNodes: [{ type: 3, textContent: '구매' }],
              },
            ],
          },
        ],
      },
    },
  };

  it('builds real repro steps from the timeline (no placeholder)', () => {
    const stub = buildBugStub(
      {
        meta: { url: 'https://shop.example/cart', startedAt: sessionStart },
        events: [
          snapshot,
          { type: 3, timestamp: sessionStart + 1000, data: { source: 2, type: 2, id: 42 } },
        ],
        network: [
          {
            tFromStart: 1500,
            method: 'POST',
            url: '/api/order',
            status: 500,
            responseBody: '{"error":"OUT_OF_STOCK"}',
          },
        ],
      },
      '',
    );
    expect(stub.reproSteps.some((s) => s.includes('구매'))).toBe(true);
    expect(stub.reproSteps.some((s) => s.includes('✗ POST /api/order 요청이 500'))).toBe(true);
    expect(stub.reproSteps.join(' ')).not.toContain('AI 자동 생성 실패');
    expect(stub.attachments.failedRequest).toBe('POST /api/order → 500');
    expect(stub.envBullets).toContain('URL: https://shop.example/cart');
  });

  it('uses the user input for the title when present', () => {
    const stub = buildBugStub({ meta: {}, events: [] }, '결제 버튼이 안 눌림');
    expect(stub.title).toBe('결제 버튼이 안 눌림');
    expect(stub.reproSteps.length).toBeGreaterThan(0);
  });
});

describe('buildDesignStub (deterministic, no AI)', () => {
  it('maps each element with memo-first issue text', () => {
    const stub = buildDesignStub(
      [
        { id: 'a', selector: 'button.buy', componentName: 'BuyButton', userNote: '버튼이 작음' },
        { id: 'b', selector: 'header .search', textContent: '검색' },
      ],
      '',
      { url: 'https://shop.example', startedAt: 1_700_000_000_000 },
    );
    expect(stub.items).toHaveLength(2);
    expect(stub.items[0]).toMatchObject({
      selector: 'button.buy',
      location: 'BuyButton',
      issue: '버튼이 작음',
    });
    expect(stub.items[1].issue).toContain('메모 없음');
    expect(stub.title).toContain('[디자인]');
  });
});

/**
 * Workers AI hung-response guard. The `ai.run()` call is wrapped in
 * `withTimeout(_, 30_000, ...)`. When the underlying call never resolves
 * (cold start, network stall, model gateway error), the wrapper rejects
 * with "Workers AI (bug|design) timed out after 30000ms" so the worker
 * handler can surface a 502 → SW AiFallbackView, instead of leaving the
 * popup spinning forever.
 *
 * We drive the timer with `vi.useFakeTimers()` and confirm:
 *   1. Without `advanceTimersByTime(30_000)` the promise stays pending.
 *   2. After advancing past the threshold it rejects with the expected msg.
 *   3. Both bug + design modes share the same behavior (different label).
 */
describe('schema-violation retry (runDraftModel)', () => {
  const artifacts: DraftInputArtifacts = {
    meta: { url: 'https://x.test', startedAt: 1 },
    events: [],
  };
  const validDraft = {
    title: 't',
    overview: 'o',
    reproSteps: ['1. a'],
    envBullets: ['URL: x'],
    attachments: { consoleError: null, failedRequest: null },
  };

  it('retries once and succeeds when the first response is non-JSON', async () => {
    let calls = 0;
    const ai = {
      run: async () => {
        calls += 1;
        return calls === 1 ? 'not json at all' : { response: JSON.stringify(validDraft) };
      },
    } as unknown as Parameters<typeof generateBugDraft>[0];
    const draft = await generateBugDraft(ai, { artifacts, userInput: 'x' });
    expect(calls).toBe(2);
    expect(draft.title).toBe('t');
  });

  it('throws after a second schema violation (caller falls back to stub)', async () => {
    let calls = 0;
    const ai = {
      run: async () => {
        calls += 1;
        return 'still not json';
      },
    } as unknown as Parameters<typeof generateBugDraft>[0];
    await expect(generateBugDraft(ai, { artifacts, userInput: 'x' })).rejects.toThrow();
    expect(calls).toBe(2);
  });
});

describe('Workers AI timeout guard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A fake Ai binding whose `.run()` returns a promise that never resolves. */
  const makeHungAi = (): { run: () => Promise<unknown> } => ({
    run: () => new Promise(() => {}),
  });

  it('rejects bug draft generation when ai.run() hangs past 30s', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal Ai binding stub
    const ai = makeHungAi() as any;
    const artifacts: DraftInputArtifacts = {
      meta: { url: 'https://example.test', startedAt: Date.now() },
      events: [],
    };
    const promise = generateBugDraft(ai, { artifacts, userInput: 'boom' });
    // Surface rejection synchronously so the test doesn't hang on its own
    // bug — `.catch` registers the handler before the timer fires.
    let caught: Error | null = null;
    promise.catch((e: Error) => {
      caught = e;
    });
    await vi.advanceTimersByTimeAsync(30_001);
    expect(caught).not.toBeNull();
    expect((caught as unknown as Error).message).toMatch(/Workers AI \(bug\) timed out/);
  });

  it('rejects design draft generation when ai.run() hangs past 30s', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal Ai binding stub
    const ai = makeHungAi() as any;
    const promise = generateDesignDraft(ai, {
      elements: [],
      userInput: 'boom',
      meta: { url: 'https://example.test' },
    });
    let caught: Error | null = null;
    promise.catch((e: Error) => {
      caught = e;
    });
    await vi.advanceTimersByTimeAsync(30_001);
    expect(caught).not.toBeNull();
    expect((caught as unknown as Error).message).toMatch(/Workers AI \(design\) timed out/);
  });

  it('does NOT reject before 30s elapse', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal Ai binding stub
    const ai = makeHungAi() as any;
    const artifacts: DraftInputArtifacts = {
      meta: { url: 'https://example.test', startedAt: Date.now() },
      events: [],
    };
    const promise = generateBugDraft(ai, { artifacts, userInput: 'still waiting' });
    let settled = false;
    promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    // 29.5s — still under the limit
    await vi.advanceTimersByTimeAsync(29_500);
    expect(settled).toBe(false);
  });
});
