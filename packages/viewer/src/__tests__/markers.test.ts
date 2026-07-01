import type { NetworkEntryPayload } from '@bugzar/shared';
import { describe, expect, it } from 'vitest';
import { errorMarkers, nextErrorTime, prevErrorTime } from '../panels/markers';
import type { ReportData } from '../report/types';

const netRow = (over: Partial<NetworkEntryPayload>): NetworkEntryPayload => ({
  tFromStart: 0,
  method: 'GET',
  url: '/',
  status: 200,
  durationMs: 1,
  requestHeaders: {},
  requestBody: null,
  responseHeaders: {},
  responseBody: null,
  error: null,
  initiator: 'fetch',
  ...over,
});

const report: ReportData = {
  meta: null,
  events: [],
  console: [
    { level: 'error', tFromStart: 50, args: ['boom'] },
    { level: 'log', tFromStart: 60, args: ['ok'] },
  ],
  network: [
    netRow({ tFromStart: 100, method: 'POST', url: '/pay', status: 500 }),
    netRow({ tFromStart: 110, url: '/ok', status: 200 }),
  ],
  storage: [],
  resources: [],
  state: [],
  vitals: {},
  system: null,
  design: [],
};

describe('errorMarkers', () => {
  it('collects console errors + failed requests, time-sorted', () => {
    const m = errorMarkers(report);
    expect(m.map((x) => x.t)).toEqual([50, 100]);
    expect(m.map((x) => x.kind)).toEqual(['console', 'network']);
  });
});

describe('nextErrorTime', () => {
  it('returns the first marker strictly after t; null past the last', () => {
    const m = errorMarkers(report);
    expect(nextErrorTime(m, 0)).toBe(50);
    expect(nextErrorTime(m, 50)).toBe(100);
    expect(nextErrorTime(m, 100)).toBeNull();
  });
});

describe('prevErrorTime', () => {
  it('returns the last marker strictly before t; null before the first', () => {
    const m = errorMarkers(report);
    expect(prevErrorTime(m, 200)).toBe(100);
    expect(prevErrorTime(m, 100)).toBe(50);
    expect(prevErrorTime(m, 50)).toBeNull();
  });
});
