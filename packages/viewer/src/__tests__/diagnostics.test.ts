import type { ConsoleEntry, NetworkEntryPayload } from '@bugzar/shared';
import { describe, expect, it } from 'vitest';
import { deriveDiagnostics } from '../report/diagnostics';
import type { ReportData } from '../report/types';

const base = (over: Partial<ReportData> = {}): ReportData => ({
  meta: {
    url: 'https://app.example/checkout',
    userAgent: 'UA',
    viewport: { width: 1440, height: 900 },
    startedAt: 0,
    endedAt: 5000,
    durationMs: 5000,
  },
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

const con = (over: Partial<ConsoleEntry>): ConsoleEntry => ({
  level: 'error',
  tFromStart: 1000,
  args: ['boom'],
  ...over,
});
const net = (over: Partial<NetworkEntryPayload>): NetworkEntryPayload => ({
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
  ...over,
});

describe('deriveDiagnostics — headline rules', () => {
  it('leads with the first 5xx as a METHOD path → status headline', () => {
    const d = deriveDiagnostics(
      base({
        network: [
          net({ tFromStart: 800, status: 200 }),
          net({
            tFromStart: 1200,
            method: 'POST',
            url: 'https://app.example/api/order',
            status: 500,
          }),
        ],
      }),
    );
    expect(d.severity).toBe('error');
    expect(d.headline).toBe('POST /api/order → 500');
    expect(d.jump).toEqual({ tab: 'network', t: 1200 });
  });

  it('leads with the first console error when it predates any 5xx', () => {
    const d = deriveDiagnostics(
      base({
        console: [con({ tFromStart: 500, args: ['TypeError: cannot read id of undefined'] })],
        network: [net({ tFromStart: 1500, status: 500 })],
      }),
    );
    expect(d.headline).toBe('TypeError: cannot read id of undefined');
    expect(d.jump).toEqual({ tab: 'console', t: 500 });
  });

  it('prefers a stacked console error over an earlier 5xx (root-cause score, R1b)', () => {
    const d = deriveDiagnostics(
      base({
        network: [net({ tFromStart: 500, status: 500, url: 'https://x/api/early' })],
        console: [
          con({
            tFromStart: 1500,
            args: ['TypeError: boom'],
            stack: 'TypeError: boom\n  at f (a.js:1)',
          }),
        ],
      }),
    );
    // stacked error (2+2) beats the earlier 5xx (2+correlation 1) despite being later
    expect(d.jump).toEqual({ tab: 'console', t: 1500 });
    expect(d.headline).toContain('TypeError: boom');
  });

  it('falls back to a client failure (4xx / transport) when no 5xx or error', () => {
    const d = deriveDiagnostics(
      base({
        network: [net({ tFromStart: 700, method: 'GET', url: 'https://x/api/me', status: 403 })],
      }),
    );
    expect(d.severity).toBe('warn');
    expect(d.headline).toBe('GET /api/me → 403');
  });

  it('reports "no signal" when nothing failed', () => {
    const d = deriveDiagnostics(
      base({ network: [net({ status: 200 })], console: [con({ level: 'log', args: ['ok'] })] }),
    );
    expect(d.severity).toBe('ok');
    expect(d.jump).toBeNull();
    expect(d.headline).toContain('진단 신호 없음');
  });
});

describe('deriveDiagnostics — counts + env', () => {
  it('counts console errors and failed requests', () => {
    const d = deriveDiagnostics(
      base({
        console: [
          con({ args: ['e1'] }),
          con({ level: 'warn', args: ['w'] }),
          con({ tFromStart: 2000, args: ['e2'] }),
        ],
        network: [
          net({ status: 200 }),
          net({ status: 404 }),
          net({ error: 'Network timeout', status: null }),
        ],
      }),
    );
    expect(d.errorCount).toBe(2);
    expect(d.failedCount).toBe(2);
  });

  it('derives env from meta viewport when no system info', () => {
    const d = deriveDiagnostics(base());
    expect(d.env).toContain('1440×900');
    expect(d.url).toBe('https://app.example/checkout');
  });
});
