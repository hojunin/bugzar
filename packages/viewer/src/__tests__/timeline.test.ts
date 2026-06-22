import { describe, expect, it } from 'vitest';
import { activeIndex, barGeometry, isFuture, snapshotAt } from '../panels/timeline';

const entries = [{ tFromStart: 0 }, { tFromStart: 100 }, { tFromStart: 200 }];

describe('activeIndex', () => {
  it('returns the last entry at/before t', () => {
    expect(activeIndex(entries, 0)).toBe(0);
    expect(activeIndex(entries, 150)).toBe(1);
    expect(activeIndex(entries, 999)).toBe(2);
  });
  it('returns -1 before the first entry', () => {
    expect(activeIndex([{ tFromStart: 50 }], 10)).toBe(-1);
  });
});

describe('isFuture', () => {
  it('is true only when the entry is strictly after t', () => {
    expect(isFuture({ tFromStart: 100 }, 50)).toBe(true);
    expect(isFuture({ tFromStart: 100 }, 100)).toBe(false);
    expect(isFuture({ tFromStart: 100 }, 150)).toBe(false);
  });
});

describe('snapshotAt', () => {
  const snaps = [
    { tFromStart: 0, v: 'a' },
    { tFromStart: 100, v: 'b' },
  ];
  it('picks the snapshot at/just-before t', () => {
    expect(snapshotAt(snaps, 150)?.v).toBe('b');
    expect(snapshotAt(snaps, 0)?.v).toBe('a');
  });
  it('returns null before the first snapshot', () => {
    expect(snapshotAt([{ tFromStart: 50, v: 'x' }], 10)).toBeNull();
  });
});

describe('barGeometry', () => {
  it('scales startTime/duration into the panel width (px)', () => {
    // window [0..1000] → 500px; entry start 250, dur 250 → x=125, width=125
    expect(
      barGeometry({ startTime: 250, duration: 250 }, { min: 0, max: 1000, width: 500 }),
    ).toEqual({
      x: 125,
      width: 125,
    });
  });
});
