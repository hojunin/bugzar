import { describe, expect, it } from 'vitest';
import type { RrwebEvent } from './bundle';
import { extractReproActions } from './repro-actions';

// Mirrors the real session-1782488665772 (mcds design system): a styled
// button[role] control sits next to a hidden native <input>; one user click
// fires a click on the styled element + synthesized native-input click(s) + an
// input value-change, and a bubbled container click.
//   #10 radiogroup: #11 button[radio "택배"] + #12 input
//   #20 div (전체 row): #21 button[checkbox "N"] (#22 span) + #23 input
//   #30 div (toolbar): #31 > #32 button[submit "검색"]
//   #40 input[text aria=Email]  (a genuine text field)
const snapshot = (): RrwebEvent =>
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
                    childNodes: [{ type: 3, id: 111, textContent: '택배' }],
                  },
                  {
                    type: 2,
                    id: 12,
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
                attributes: { class: 'flex' },
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
                        attributes: { class: 'box' },
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
                        attributes: { type: 'submit' },
                        childNodes: [{ type: 3, id: 321, textContent: '검색' }],
                      },
                    ],
                  },
                ],
              },
              {
                type: 2,
                id: 40,
                tagName: 'INPUT',
                attributes: { 'aria-label': 'Email', type: 'text' },
                childNodes: [],
              },
            ],
          },
        ],
      },
    },
  }) as unknown as RrwebEvent;

const click = (id: number, t: number): RrwebEvent =>
  ({ type: 3, timestamp: t, data: { source: 2, type: 2, id } }) as unknown as RrwebEvent;
const input = (id: number, text: string, t: number): RrwebEvent =>
  ({ type: 3, timestamp: t, data: { source: 5, id, text } }) as unknown as RrwebEvent;

describe('extractReproActions', () => {
  it('collapses a custom radio interaction (styled + native click + value echo) into one click', () => {
    const actions = extractReproActions(
      [snapshot(), click(11, 1000), click(12, 1002), input(12, '1', 1006)],
      0,
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: 'click',
      target: { tag: 'button', role: 'radio', text: '택배' },
    });
  });

  it('drops a bubbled container click in favour of the inner control', () => {
    // checkbox via inner span (climbs to button[checkbox]) + the row container click
    const actions = extractReproActions(
      [snapshot(), click(22, 4000), click(23, 4002), input(23, 'on', 4006), click(20, 4300)],
      0,
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: 'click',
      target: { tag: 'button', role: 'checkbox' },
    });
  });

  it('merges an imprecise container click into the real submit button', () => {
    const actions = extractReproActions([snapshot(), click(30, 5000), click(32, 5470)], 0);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: 'click', target: { tag: 'button', text: '검색' } });
  });

  it('keeps genuine text input as a type action with its value', () => {
    const actions = extractReproActions([snapshot(), input(40, 'a@b.com', 800)], 0);
    expect(actions).toEqual([
      {
        kind: 'type',
        t: 800,
        target: expect.objectContaining({ tag: 'input', ariaLabel: 'Email' }),
        value: 'a@b.com',
        masked: false,
      },
    ]);
  });

  it('marks rrweb-masked values without inventing them', () => {
    const actions = extractReproActions([snapshot(), input(40, '*****', 800)], 0);
    expect(actions[0]).toMatchObject({ kind: 'type', masked: true, value: '' });
  });

  it('returns [] for a no-interaction (design-mode) snapshot', () => {
    expect(extractReproActions([snapshot()], 0)).toEqual([]);
  });
});
