import type { ConsoleEntry, NetworkEntryPayload } from '@bugzar/shared';
import { describe, expect, it } from 'vitest';
import { matchesQuery, searchConsole, searchNetwork } from '../panels/filters';

const con: ConsoleEntry[] = [
  { level: 'error', tFromStart: 1, args: ['Boom failed'] },
  { level: 'log', tFromStart: 2, args: ['all good'] },
];

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
const net: NetworkEntryPayload[] = [
  netRow({ method: 'POST', url: '/api/pay', status: 500 }),
  netRow({ method: 'GET', url: '/api/ok', status: 200 }),
];

describe('matchesQuery', () => {
  it('is case-insensitive substring; empty query matches all', () => {
    expect(matchesQuery('Hello World', 'world')).toBe(true);
    expect(matchesQuery('Hello', 'xyz')).toBe(false);
    expect(matchesQuery('anything', '')).toBe(true);
  });
});

describe('searchConsole', () => {
  it('filters by joined args (case-insensitive); empty query keeps all', () => {
    expect(searchConsole(con, 'boom')).toHaveLength(1);
    expect(searchConsole(con, '')).toHaveLength(2);
  });
});

describe('searchNetwork', () => {
  it('matches method / url / status', () => {
    expect(searchNetwork(net, 'pay')).toHaveLength(1);
    expect(searchNetwork(net, 'get')).toHaveLength(1);
    expect(searchNetwork(net, '500')).toHaveLength(1);
  });
});
