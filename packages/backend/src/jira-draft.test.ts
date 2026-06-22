import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type DraftInputArtifacts,
  extractJsonFromAiResponse,
  generateBugDraft,
  generateDesignDraft,
  summarizeForPrompt,
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

  // Minimal rrweb FullSnapshot containing one button with a data-testid
  // and a span we click on. Mirrors what the real recorder emits, just
  // with the fields the summariser actually reads.
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
                attributes: { 'data-testid': 'filter-toggle', class: 'btn primary' },
                childNodes: [{ type: 3, textContent: '필터 열기' }],
              },
              {
                type: 2,
                id: 43,
                tagName: 'INPUT',
                attributes: { 'aria-label': '검색어', type: 'text' },
              },
            ],
          },
        ],
      },
    },
  };

  it('indexes rrweb snapshot and renders CLICK targets with tag + text + selector hint', () => {
    const artifacts: DraftInputArtifacts = {
      meta: { url: 'https://shop.example/list', startedAt: sessionStart },
      events: [
        sampleFullSnapshot,
        // Mouse interaction: source=2, type=2 means click.
        { type: 3, timestamp: sessionStart + 1500, data: { source: 2, type: 2, id: 42 } },
      ],
    };
    const summary = summarizeForPrompt(artifacts);
    expect(summary).toContain('[+1.5s]');
    expect(summary).toContain('CLICK');
    // describeTarget switched from angle brackets to square brackets so the
    // Llama model doesn't auto-strip leading chars on tags it sees as HTML
    // inline (e.g. <input>/<button>). Pin the new format.
    expect(summary).toContain('[button');
    expect(summary).toContain('필터 열기');
    expect(summary).toContain('data-testid="filter-toggle"');
  });

  it('reports INPUT events with the typed value', () => {
    const artifacts: DraftInputArtifacts = {
      meta: { url: 'https://shop.example/list', startedAt: sessionStart },
      events: [
        sampleFullSnapshot,
        // source=5 is input. data.text carries the (possibly masked) value.
        {
          type: 3,
          timestamp: sessionStart + 2000,
          data: { source: 5, id: 43, text: '결제 모듈' },
        },
      ],
    };
    const summary = summarizeForPrompt(artifacts);
    expect(summary).toContain('INPUT');
    expect(summary).toContain('value="결제 모듈"');
    expect(summary).toContain('aria-label="검색어"');
  });

  it('captures URL changes via rrweb meta events as NAVIGATE timeline rows', () => {
    const artifacts: DraftInputArtifacts = {
      meta: { url: 'https://shop.example/list', startedAt: sessionStart },
      events: [
        sampleFullSnapshot,
        { type: 4, timestamp: sessionStart, data: { href: 'https://shop.example/list' } },
        // SPA navigation that fires later — must show up as NAVIGATE.
        {
          type: 4,
          timestamp: sessionStart + 3000,
          data: { href: 'https://shop.example/list?status=sale' },
        },
      ],
    };
    const summary = summarizeForPrompt(artifacts);
    expect(summary).toContain('NAVIGATE');
    expect(summary).toContain('?status=sale');
  });

  it('interleaves failed network calls + console errors into the timeline', () => {
    const artifacts: DraftInputArtifacts = {
      meta: { url: 'https://shop.example/list', startedAt: sessionStart },
      events: [sampleFullSnapshot],
      network: [
        { tFromStart: 1200, method: 'POST', url: '/graphql', status: 500 },
        { tFromStart: 800, method: 'GET', url: '/healthz', status: 200 }, // success — should NOT show
      ],
      console: [
        { tFromStart: 1300, level: 'error', args: ['Failed to fetch products'] },
        { tFromStart: 400, level: 'log', args: ['app boot'] }, // non-error — should NOT show
      ],
    };
    const summary = summarizeForPrompt(artifacts);
    expect(summary).toContain('NETWORK POST /graphql → 500');
    expect(summary).toContain('CONSOLE.ERROR Failed to fetch products');
    // Sorted by tFromStart: 1.2s NETWORK should appear before 1.3s CONSOLE.
    expect(summary.indexOf('[+1.2s] NETWORK')).toBeLessThan(summary.indexOf('[+1.3s] CONSOLE'));
    // Healthy 200 calls and non-error console.log are noise — kept out.
    expect(summary).not.toContain('/healthz');
    expect(summary).not.toContain('app boot');
  });

  it('threads viewport + user-agent through to the env block', () => {
    const summary = summarizeForPrompt({
      meta: {
        url: 'https://shop.example/list',
        startedAt: sessionStart,
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X) ChromeBuild',
        viewport: { w: 1440, h: 900, dpr: 2 },
      },
      events: [],
    });
    expect(summary).toContain('Viewport: ');
    expect(summary).toContain('"w":1440');
    expect(summary).toContain('User-Agent: Mozilla/5.0');
  });

  it('gracefully degrades when events is empty (no snapshot to index)', () => {
    // Pre-fix this used to render `click@id=NNN` lines — useless to the AI.
    // Now an empty events array just yields "(상호작용 없음)" without crashing.
    const summary = summarizeForPrompt({
      meta: { url: 'https://shop.example/list', startedAt: sessionStart },
      events: [],
    });
    expect(summary).toContain('사용자 행동 타임라인');
    expect(summary).toContain('(상호작용 없음)');
  });

  it('collapses consecutive duplicate interactions inside 500ms (mousedown/up noise)', () => {
    // rrweb sometimes emits mousedown / mouseup / click on the same target
    // back-to-back. Without dedupe the timeline ends up with three
    // 'CLICK [button "필터"]' rows in a row.
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
    // Three identical events should produce ONE timeline row.
    const matches = summary.match(/CLICK \[button/g) ?? [];
    expect(matches.length).toBe(1);
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
