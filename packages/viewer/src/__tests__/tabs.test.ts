import { describe, expect, it } from 'vitest';
import { visibleTabs } from '../panels/tabs';
import type { ReportData } from '../report/types';

const base: ReportData = {
  meta: null,
  events: [],
  console: [{ level: 'error', tFromStart: 1, args: ['x'] }],
  network: [],
  storage: [],
  resources: [],
  state: [],
  vitals: {},
  system: null,
  design: [],
};

describe('visibleTabs', () => {
  it('always shows the core + resources tabs, never an empty State tab', () => {
    const keys = visibleTabs(base).map((t) => t.key);
    expect(keys).toEqual(expect.arrayContaining(['console', 'network', 'resources']));
    expect(keys).not.toContain('state');
    // Storage tab is hidden per request (commented out in visibleTabs).
    expect(keys).not.toContain('storage');
  });

  it('shows the State tab only when state data exists', () => {
    const withState: ReportData = { ...base, state: [{ tFromStart: 5, data: {} }] };
    expect(visibleTabs(withState).map((t) => t.key)).toContain('state');
  });

  it('counts reflect the data', () => {
    expect(visibleTabs(base).find((t) => t.key === 'console')?.count).toBe(1);
  });
});
