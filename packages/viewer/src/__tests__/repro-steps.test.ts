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
});
