import type { NetworkEntryPayload, RrwebEvent } from '@bugzar/shared';
import { describe, expect, it } from 'vitest';
import { extractReproSteps, reproStepText } from '../report/repro-steps';
import type { ReportData } from '../report/types';

// Minimal rrweb FullSnapshot: a document holding a button (#5) and an input (#7).
const fullSnapshot = (): RrwebEvent =>
  ({
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
                attributes: { 'data-testid': 'buy' },
                childNodes: [{ type: 3, id: 6, textContent: 'Buy now' }],
              },
              {
                type: 2,
                id: 7,
                tagName: 'INPUT',
                attributes: { 'aria-label': 'Email' },
                childNodes: [],
              },
            ],
          },
        ],
      },
    },
  }) as unknown as RrwebEvent;

const meta = (href: string, t = 0): RrwebEvent =>
  ({ type: 4, timestamp: t, data: { href, width: 1440, height: 900 } }) as unknown as RrwebEvent;
const click = (id: number, t: number): RrwebEvent =>
  ({ type: 3, timestamp: t, data: { source: 2, type: 2, id } }) as unknown as RrwebEvent;
const input = (id: number, text: string, t: number): RrwebEvent =>
  ({ type: 3, timestamp: t, data: { source: 5, id, text } }) as unknown as RrwebEvent;

// A design-system (mcds) radio/checkbox renders a styled control (button[role])
// next to a hidden native <input>. One user click fires: a click on the styled
// element + browser-synthesized click(s) on the native input + an input value-
// change. This mirrors the real session-1782488665772 export.
//   #10 radiogroup: #11 button[radio "일반택배"] + #12 input, #13 button[radio
//       "배송없음"] (text via #14 span) + #15 input
//   #20 div.flex (전체YN row): #21 button[checkbox "N"] (#22 span) + #23 input
//   #30 div.flex (toolbar): #31 > #32 button[submit "검색"]
const mcdsSnapshot = (): RrwebEvent =>
  ({
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
                id: 10,
                tagName: 'DIV',
                attributes: { role: 'radiogroup' },
                childNodes: [
                  {
                    type: 2,
                    id: 11,
                    tagName: 'BUTTON',
                    attributes: { role: 'radio' },
                    childNodes: [{ type: 3, id: 111, textContent: '일반택배' }],
                  },
                  {
                    type: 2,
                    id: 12,
                    tagName: 'INPUT',
                    attributes: { type: 'radio' },
                    childNodes: [],
                  },
                  {
                    type: 2,
                    id: 13,
                    tagName: 'BUTTON',
                    attributes: { role: 'radio' },
                    childNodes: [
                      {
                        type: 2,
                        id: 14,
                        tagName: 'SPAN',
                        attributes: { class: 'mcds:w-20' },
                        childNodes: [],
                      },
                      { type: 3, id: 131, textContent: '배송없음' },
                    ],
                  },
                  {
                    type: 2,
                    id: 15,
                    tagName: 'INPUT',
                    attributes: { type: 'radio' },
                    childNodes: [],
                  },
                ],
              },
              {
                type: 2,
                id: 20,
                tagName: 'DIV',
                attributes: { class: 'flex items-center' },
                childNodes: [
                  {
                    type: 2,
                    id: 21,
                    tagName: 'BUTTON',
                    attributes: { role: 'checkbox' },
                    childNodes: [
                      {
                        type: 2,
                        id: 22,
                        tagName: 'SPAN',
                        attributes: { class: 'mcds:w-20' },
                        childNodes: [],
                      },
                      { type: 3, id: 221, textContent: 'N' },
                    ],
                  },
                  {
                    type: 2,
                    id: 23,
                    tagName: 'INPUT',
                    attributes: { type: 'checkbox' },
                    childNodes: [],
                  },
                ],
              },
              {
                type: 2,
                id: 30,
                tagName: 'DIV',
                attributes: { class: 'flex' },
                childNodes: [
                  {
                    type: 2,
                    id: 31,
                    tagName: 'DIV',
                    attributes: { class: 'flex' },
                    childNodes: [
                      {
                        type: 2,
                        id: 32,
                        tagName: 'BUTTON',
                        attributes: { type: 'submit', class: 'mcds:inline-flex' },
                        childNodes: [{ type: 3, id: 321, textContent: '검색' }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  }) as unknown as RrwebEvent;

const net500: NetworkEntryPayload = {
  tFromStart: 2000,
  method: 'POST',
  url: 'https://app.example/api/order',
  status: 500,
  durationMs: 90,
  requestHeaders: {},
  requestBody: null,
  responseHeaders: {},
  responseBody: '{"error":"OUT_OF_STOCK"}',
  error: null,
  initiator: 'fetch',
};

const data = (events: RrwebEvent[], over: Partial<ReportData> = {}): ReportData => ({
  meta: {
    url: 'https://app.example/checkout',
    userAgent: 'UA',
    viewport: { width: 1440, height: 900 },
    startedAt: 0,
    endedAt: 3000,
    durationMs: 3000,
  },
  events,
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

describe('extractReproSteps', () => {
  it('resolves click/input targets to identifier-first labels and ends on the failure', () => {
    const steps = extractReproSteps(
      data(
        [
          meta('https://app.example/checkout'),
          fullSnapshot(),
          click(5, 1000),
          input(7, 'a@b.com', 1500),
        ],
        {
          network: [net500],
        },
      ),
    );
    const text = reproStepText(steps);
    expect(text[0]).toContain('Click [button "Buy now" — [data-testid="buy"]]');
    expect(text[1]).toContain('Type into [input — [aria-label="Email"]] "a@b.com"');
    // last step is the observed symptom
    expect(text.at(-1)).toBe('Observed: POST /api/order → 500');
  });

  it('keeps actions AFTER the failure and marks the failure in place', () => {
    // user clicks the error button, THEN keeps clicking — all clicks must show,
    // with "Observed" inserted at the failure moment (not truncated away).
    const steps = extractReproSteps(
      data(
        [
          meta('https://app.example/checkout'),
          fullSnapshot(),
          click(5, 1000), // before failure
          click(7, 2500), // AFTER failure (net500 @ 2000) — must NOT be dropped
        ],
        { network: [net500] },
      ),
    );
    const text = reproStepText(steps);
    expect(text.filter((t) => t.startsWith('Click'))).toHaveLength(2); // both clicks kept
    const obsIdx = text.findIndex((t) => t.startsWith('Observed:'));
    expect(obsIdx).toBe(1); // inserted between the 1000ms and 2500ms clicks
  });

  it('does not fabricate a masked input value', () => {
    const steps = extractReproSteps(
      data([meta('https://app.example/checkout'), fullSnapshot(), input(7, '*****', 800)], {
        network: [net500],
      }),
    );
    const typed = reproStepText(steps).find((t) => t.startsWith('Type into'));
    expect(typed).toContain('(value masked)');
    expect(typed).not.toContain('*****');
  });

  it('emits a Navigate step on URL change', () => {
    const steps = extractReproSteps(
      data([
        meta('https://app.example/list', 0),
        fullSnapshot(),
        meta('https://app.example/detail/9', 500),
        click(5, 1000),
      ]),
    );
    expect(reproStepText(steps)).toContain('Navigate to https://app.example/detail/9');
  });

  it('returns [] for a design-mode/no-interaction report (no actions)', () => {
    expect(extractReproSteps(data([meta('https://app.example'), fullSnapshot()]))).toEqual([]);
    expect(extractReproSteps(data([]))).toEqual([]);
  });

  it('collapses a run of identical clicks into one step counted as (×N)', () => {
    const steps = extractReproSteps(
      data([
        meta('https://app.example'),
        fullSnapshot(),
        click(5, 1000),
        click(5, 1100),
        click(5, 1150),
      ]),
    );
    const clicks = reproStepText(steps).filter((t) => t.startsWith('Click'));
    expect(clicks).toHaveLength(1); // one row…
    expect(clicks[0]).toContain('(×3)'); // …but it counts all 3 (not dropped)
  });

  it('skips clicks on Bugzar UI and on bare html/body background', () => {
    // a node whose class is `bugzar-fab` (recorder toolbar) + a body click
    const events = [
      meta('https://app.example'),
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
                    id: 9,
                    tagName: 'BUTTON',
                    attributes: { class: 'bugzar-fab', 'aria-label': '녹화 시작' },
                    childNodes: [{ type: 3, id: 10, textContent: '녹화' }],
                  },
                ],
              },
            ],
          },
        },
      },
      click(2, 800), // body background click → skip
      click(9, 1000), // Bugzar FAB click → skip
    ] as unknown as RrwebEvent[];
    expect(extractReproSteps(data(events))).toEqual([]);
  });

  it('collapses a custom radio/checkbox interaction into one Click (real mcds pattern)', () => {
    // Each interaction below is ONE user click that rrweb records as 2-4 events
    // (styled control + synthesized native-input clicks + value echo + a stray
    // container click). The viewer used to show all of them; now it shows one.
    const steps = extractReproSteps(
      data([
        meta('https://app.example/products'),
        mcdsSnapshot(),
        // 일반택배: styled button + synthesized native-input click + value echo
        click(11, 1000),
        click(12, 1002),
        input(12, '1', 1006),
        // 배송없음: click lands on the inner span → climbs to the role=radio button
        click(14, 1700),
        click(15, 1702),
        input(15, '5', 1706),
        // 전체YN checkbox: span click + native echoes + a later container-row click
        click(22, 4000),
        click(23, 4002),
        input(23, 'on', 4006),
        click(20, 4300),
        // 검색: an imprecise container click, then the real submit button
        click(30, 5000),
        click(32, 5470),
      ]),
    );
    expect(reproStepText(steps)).toEqual([
      'Click [button "일반택배" — [role="radio"]]',
      'Click [button "배송없음" — [role="radio"]]',
      'Click [button "N" — [role="checkbox"]]',
      'Click [button "검색" — button.mcds:inline-flex]',
    ]);
  });

  it('never renders a radio/checkbox value-change as "Type into"', () => {
    const text = reproStepText(
      extractReproSteps(
        data([
          meta('https://app.example/products'),
          mcdsSnapshot(),
          click(11, 1000),
          input(12, '1', 1006),
        ]),
      ),
    );
    expect(text.some((t) => t.startsWith('Type'))).toBe(false);
    expect(text).toEqual(['Click [button "일반택배" — [role="radio"]]']);
  });
});
