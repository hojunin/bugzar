import { describe, expect, it } from 'vitest';
import { reportMode } from '../report/mode';
import type { ReportData } from '../report/types';

const base: ReportData = {
  meta: null,
  events: [],
  console: [],
  network: [],
  storage: [],
  resources: [],
  state: [],
  vitals: {},
  system: null,
  design: [],
};

const meta = (mode?: string): ReportData['meta'] => ({
  url: 'u',
  userAgent: 'ua',
  viewport: { width: 1, height: 1 },
  startedAt: 0,
  endedAt: 1,
  durationMs: 1,
  ...(mode ? { mode } : {}),
});

const el = {
  selector: '.btn',
  tagName: 'BUTTON',
  textContent: 'Buy',
  cssClasses: 'btn',
  rect: { x: 0, y: 0, width: 1, height: 1 },
  userNote: 'wrong color',
};

describe('reportMode', () => {
  it('is design when meta.mode === "design"', () => {
    expect(reportMode({ ...base, meta: meta('design'), design: [el] })).toBe('design');
  });
  it('falls back to design when there are annotations but no events', () => {
    expect(reportMode({ ...base, meta: meta(), design: [el] })).toBe('design');
  });
  it('is session when rrweb events exist', () => {
    expect(
      reportMode({ ...base, meta: meta('session'), events: [{ type: 2, timestamp: 1, data: {} }] }),
    ).toBe('session');
  });
  it('defaults to session', () => {
    expect(reportMode(base)).toBe('session');
  });
});
