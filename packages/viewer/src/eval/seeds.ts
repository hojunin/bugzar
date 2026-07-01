// Eval seed bugs (R0). Each is a realistic captured report + its bug class +
// the expected fix location/answer, so the eval harness can measure the
// one-paste-fix rate on two axes (localization vs fix). The golden snapshot of
// each seed's Copy-for-AI output (see eval-golden.test.ts) is the deterministic
// baseline; the live-AI scorer (scripts/eval-ai.mjs) is opt-in.

import type { ConsoleEntry, NetworkEntryPayload, RrwebEvent } from '@bugzar/shared';
import type { ReportData } from '../report/types';

export type BugClass = 'network' | 'runtime' | 'state' | 'cors' | 'async';

export interface Seed {
  name: string;
  /** Coarse class — feeds R0's "what dominates?" distribution check. */
  bugClass: BugClass;
  report: ReportData;
  /** Ground truth for the live scorer (not used by the deterministic snapshot). */
  expected: { area: string; fix: string };
}

const meta = (url: string, durationMs = 4000) => ({
  url,
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120',
  viewport: { width: 1440, height: 900 },
  startedAt: 0,
  endedAt: durationMs,
  durationMs,
});

const con = (o: Partial<ConsoleEntry>): ConsoleEntry => ({
  level: 'error',
  tFromStart: 1000,
  args: ['error'],
  ...o,
});
const net = (o: Partial<NetworkEntryPayload>): NetworkEntryPayload => ({
  tFromStart: 1000,
  method: 'GET',
  url: 'https://app.example/api/x',
  status: 200,
  durationMs: 50,
  requestHeaders: {},
  requestBody: null,
  responseHeaders: {},
  responseBody: null,
  error: null,
  initiator: 'fetch',
  ...o,
});

// Minimal rrweb stream: FullSnapshot (button #5) + a click, so repro steps form.
const withClick = (t: number): RrwebEvent[] =>
  [
    {
      type: 4,
      timestamp: 0,
      data: { href: 'https://app.example/checkout', width: 1440, height: 900 },
    },
    {
      type: 2,
      timestamp: 0,
      data: {
        node: {
          type: 1,
          id: 1,
          childNodes: [
            {
              type: 2,
              id: 2,
              tagName: 'BODY',
              attributes: {},
              childNodes: [
                {
                  type: 2,
                  id: 5,
                  tagName: 'BUTTON',
                  attributes: { 'data-testid': 'place-order' },
                  childNodes: [{ type: 3, id: 6, textContent: 'Place order' }],
                },
              ],
            },
          ],
        },
      },
    },
    { type: 3, timestamp: t, data: { source: 2, type: 2, id: 5 } },
  ] as unknown as RrwebEvent[];

const empty = (over: Partial<ReportData>): ReportData => ({
  meta: meta('https://app.example/checkout'),
  events: [],
  console: [],
  network: [],
  storage: [],
  resources: [],
  state: [],
  vitals: {},
  system: null,
  design: [],
  ...over,
});

export const SEEDS: Seed[] = [
  {
    name: 'network-5xx-order',
    bugClass: 'network',
    report: empty({
      events: withClick(1200),
      network: [
        net({ tFromStart: 600, url: 'https://app.example/api/cart', status: 200 }),
        net({
          tFromStart: 1300,
          method: 'POST',
          url: 'https://app.example/api/order',
          status: 500,
          requestBody: '{"sku":"WIDGET-1","qty":3,"coupon":"SAVE10"}',
          responseBody:
            '{"error":"OUT_OF_STOCK","detail":"sku WIDGET-1 has 0 available","traceId":"abc123"}',
        }),
      ],
    }),
    expected: {
      area: 'order API handler / stock check',
      fix: 'handle OUT_OF_STOCK: surface a user-facing message instead of a 500; validate stock before charging',
    },
  },
  {
    name: 'runtime-null-deref',
    bugClass: 'runtime',
    report: empty({
      events: withClick(900),
      console: [
        con({
          tFromStart: 950,
          args: ["TypeError: Cannot read properties of undefined (reading 'name')"],
          stack:
            "TypeError: Cannot read properties of undefined (reading 'name')\n    at UserBadge (UserBadge.tsx:14:22)\n    at renderWithHooks (react-dom.js:1:55)",
        }),
      ],
    }),
    expected: {
      area: 'UserBadge.tsx:14 — user may be undefined',
      fix: 'guard user before reading user.name (optional chaining / loading state)',
    },
  },
  {
    name: 'state-dependent-filter',
    bugClass: 'state',
    report: empty({
      events: withClick(1500),
      console: [
        con({
          tFromStart: 1600,
          args: ['TypeError: filters.map is not a function'],
          stack:
            'TypeError: filters.map is not a function\n    at FilterList (FilterList.tsx:28:18)',
        }),
      ],
      state: [{ tFromStart: 1550, data: { filters: null, query: 'sale' } }],
    }),
    expected: {
      area: 'FilterList.tsx:28 — filters is null in state',
      fix: 'default filters to [] / handle null before .map; check why state.filters is null',
    },
  },
  {
    name: 'cors-blocked',
    bugClass: 'cors',
    report: empty({
      events: withClick(800),
      network: [
        net({
          tFromStart: 850,
          method: 'GET',
          url: 'https://api.thirdparty.com/v1/quote',
          status: null,
          error: 'Failed to fetch',
          corsLikely: true,
        }),
      ],
      console: [
        con({
          level: 'error',
          tFromStart: 860,
          args: [
            "Access to fetch at 'https://api.thirdparty.com/v1/quote' from origin 'https://app.example' has been blocked by CORS policy",
          ],
        }),
      ],
    }),
    expected: {
      area: 'CORS config on api.thirdparty.com / proxy the request',
      fix: 'add the origin to Access-Control-Allow-Origin server-side, or proxy via same-origin endpoint',
    },
  },
  {
    // The prod case R2b targets: a minified stack (single-letter fns,
    // app.4f3a.js:1:NNNN) where the un-symbolicated frame is the ONLY location
    // signal. R2's symbolic gate must NOT promote this to a "Where to look"
    // location (it's useless until R3a source maps); R2b just captures it.
    name: 'runtime-minified-stack',
    bugClass: 'runtime',
    report: empty({
      events: withClick(900),
      console: [
        con({
          tFromStart: 950,
          args: ["TypeError: Cannot read properties of null (reading 'total')"],
          stack:
            "TypeError: Cannot read properties of null (reading 'total')\n    at t (https://app.example/assets/app.4f3a.js:1:88421)\n    at o (https://app.example/assets/app.4f3a.js:1:90233)",
          // R2b captured the ErrorEvent origin — but it's a minified bundle coord,
          // so the symbolic gate must NOT promote it to a "location".
          source: { file: 'https://app.example/assets/app.4f3a.js', line: 1, col: 88421 },
        }),
      ],
    }),
    expected: {
      area: 'cart total component (minified as app.4f3a.js:1:88421 — needs source maps)',
      fix: 'guard the null cart before reading .total',
    },
  },
  {
    name: 'async-unhandled-rejection',
    bugClass: 'async',
    report: empty({
      console: [
        con({
          tFromStart: 2000,
          args: ['Unhandled promise rejection: Error: payment gateway timeout'],
          stack: 'Error: payment gateway timeout\n    at PayButton.onClick (PayButton.tsx:41:9)',
        }),
      ],
      network: [
        net({
          tFromStart: 1900,
          method: 'POST',
          url: 'https://app.example/api/pay',
          status: null,
          error: 'Network timeout',
          requestBody: '{"amount":4200,"token":"tok_visa"}',
        }),
      ],
    }),
    expected: {
      area: 'PayButton.tsx:41 — unawaited/uncaught pay() rejection on timeout',
      fix: 'await + try/catch the pay() call; show retry on timeout instead of leaving it unhandled',
    },
  },
];

/** Bug-class distribution — R0 uses this to decide R1-first vs pull R2a forward. */
export function classDistribution(seeds: Seed[] = SEEDS): Record<BugClass, number> {
  const d = { network: 0, runtime: 0, state: 0, cors: 0, async: 0 };
  for (const s of seeds) d[s.bugClass]++;
  return d;
}
