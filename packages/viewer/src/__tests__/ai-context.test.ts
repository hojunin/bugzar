import type { ConsoleEntry, NetworkEntryPayload } from '@bugzar/shared';
import { describe, expect, it } from 'vitest';
import {
  extractErrorHint,
  formatConsoleErrorForAI,
  formatRequestForAI,
  formatSessionForAI,
} from '../report/ai-context';
import type { ReportData } from '../report/types';

// A real, decodable JWT (header {"alg":"HS256","typ":"JWT"}) — redactFreeText must mask it.
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

const base = (over: Partial<ReportData> = {}): ReportData => ({
  meta: {
    url: 'https://app.example/checkout',
    userAgent: 'Mozilla/5.0 UA',
    viewport: { width: 1440, height: 900 },
    startedAt: 0,
    endedAt: 4000,
    durationMs: 4000,
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

describe('extractErrorHint', () => {
  it('pulls a JSON message/error/code field', () => {
    expect(extractErrorHint('{"error":"OUT_OF_STOCK"}')).toBe('OUT_OF_STOCK');
    expect(extractErrorHint('{"message":"bad","code":42}')).toBe('bad');
    expect(extractErrorHint('{"code":500}')).toBe('500');
  });
  it('truncates non-JSON to a short prefix', () => {
    const long = 'x'.repeat(200);
    expect(extractErrorHint(long).length).toBeLessThanOrEqual(121);
  });
  it('returns empty for null/empty', () => {
    expect(extractErrorHint(null)).toBe('');
  });
});

describe('formatSessionForAI — curation', () => {
  const data = base({
    console: [
      con({
        tFromStart: 1200,
        args: ['TypeError: cannot read id'],
        stack: 'TypeError: cannot read id\n  at Cart (cart.tsx:42)\n  at run (x.js:1)',
      }),
      con({ level: 'log', args: ['just a log'] }),
    ],
    network: [
      net({ tFromStart: 800, status: 200, url: 'https://app.example/api/ok' }),
      net({
        tFromStart: 1100,
        method: 'POST',
        url: 'https://app.example/api/order',
        status: 500,
        responseBody: '{"error":"OUT_OF_STOCK"}',
      }),
    ],
  });

  it('leads with the symptom headline and includes the error + top stack frame', () => {
    const out = formatSessionForAI(data);
    expect(out.startsWith('# Bug report — ')).toBe(true);
    expect(out).toContain('TypeError: cannot read id');
    expect(out).toContain('at Cart (cart.tsx:42)');
  });

  it('includes the failing request WITH its response body, excludes 2xx + non-error console (noise)', () => {
    const out = formatSessionForAI(data);
    expect(out).toContain('POST /api/order → 500'); // full-body block header
    expect(out).toContain('OUT_OF_STOCK'); // response body surfaced (R1a)
    expect(out).not.toContain('/api/ok'); // 2xx excluded
    expect(out).not.toContain('just a log'); // non-error console excluded
  });

  it('folds in reproduction steps when provided', () => {
    const out = formatSessionForAI(data, {
      reproSteps: ['Click [button "Buy"]', 'POST /api/order → 500'],
    });
    expect(out).toContain('## Reproduction');
    expect(out).toContain('1. Click [button "Buy"]');
  });

  it('includes an Environment section', () => {
    expect(formatSessionForAI(data)).toContain('## Environment');
  });
});

describe('redaction-preservation (safety bar)', () => {
  it('does not leak a JWT embedded in a network error body', () => {
    const out = formatSessionForAI(
      base({
        network: [
          net({
            method: 'POST',
            url: 'https://x/api/login',
            status: 401,
            responseBody: `{"message":"invalid token ${JWT}"}`,
          }),
        ],
      }),
    );
    expect(out).not.toContain(JWT);
    expect(out).toContain('[REDACTED]');
  });

  it('does not leak a Bearer token in a console error message', () => {
    const out = formatSessionForAI(
      base({
        console: [con({ args: ['request failed', 'Authorization: Bearer sk_live_abc123def456'] })],
      }),
    );
    expect(out).not.toContain('sk_live_abc123def456');
    expect(out).toContain('Bearer [REDACTED]');
  });

  it('closes the benign-key PII gap — email is redacted (#3)', () => {
    // Previously PII under a benign key (email) was caught by neither capture nor
    // the copy redactFreeText pass. #3 wired redactPiiText into redactFreeText, so
    // the copy path now masks email/phone/card even under benign keys.
    const out = formatSessionForAI(
      base({
        network: [
          net({
            status: 500,
            method: 'POST',
            url: 'https://x/api/a',
            responseBody: `{"email":"user@acme.com","token":"${JWT}"}`,
          }),
        ],
      }),
    );
    expect(out).not.toContain(JWT); // JWT pattern IS caught
    expect(out).not.toContain('user@acme.com'); // #3: benign-key email now redacted
  });

  it('per-item copies are redacted too', () => {
    const data = base({
      console: [con({ args: [`boom Bearer sk_live_zzz999`] })],
      network: [net({ status: 500, responseBody: `{"error":"${JWT}"}` })],
    });
    expect(formatConsoleErrorForAI(data.console[0] as ConsoleEntry, data)).not.toContain(
      'sk_live_zzz999',
    );
    expect(formatRequestForAI(data.network[0] as NetworkEntryPayload, data)).not.toContain(JWT);
  });
});

describe('R1a — full bodies + selection + budget', () => {
  it('renders the headline 5xx with full request + response bodies (fenced)', () => {
    const out = formatSessionForAI(
      base({
        network: [
          net({
            tFromStart: 1000,
            method: 'POST',
            url: 'https://app.example/api/order',
            status: 500,
            requestBody: '{"sku":"X","qty":3}',
            responseBody: '{"error":"OUT_OF_STOCK"}',
          }),
        ],
      }),
    );
    expect(out).toContain('**POST /api/order → 500**');
    expect(out).toContain('Request:');
    expect(out).toContain('{"sku":"X","qty":3}');
    expect(out).toContain('Response:');
    expect(out).toContain('OUT_OF_STOCK');
  });

  it('keeps a non-headline 4xx as a one-liner (no body block)', () => {
    const out = formatSessionForAI(
      base({
        network: [
          net({
            tFromStart: 1000,
            method: 'POST',
            url: 'https://app.example/api/order',
            status: 500,
            responseBody: '{"error":"E"}',
          }),
          net({
            tFromStart: 1100,
            method: 'GET',
            url: 'https://app.example/api/me',
            status: 404,
            responseBody: '{"error":"NF"}',
          }),
        ],
      }),
    );
    expect(out).toContain('**POST /api/order → 500**'); // headline 5xx: full
    expect(out).toMatch(/- GET \/api\/me → 404/); // 4xx: one-liner
  });

  it('truncates an over-budget body with a marker, preserving signal', () => {
    const big = `{"padding":"${'x'.repeat(6000)}","error":"REAL_CAUSE"}`;
    const out = formatSessionForAI(
      base({
        network: [net({ status: 500, method: 'POST', url: 'https://x/api/a', responseBody: big })],
      }),
    );
    expect(out.length).toBeLessThan(6000); // budget bounded the copy
    // signal-preserving: error key surfaced OR an omission marker present
    expect(out.includes('REAL_CAUSE') || /omitted|more keys/.test(out)).toBe(true);
  });

  it('per-item formatRequestForAI emits the full body for its item', () => {
    const data = base({
      network: [
        net({
          status: 500,
          method: 'POST',
          url: 'https://x/api/a',
          requestBody: '{"a":1}',
          responseBody: '{"error":"BOOM"}',
        }),
      ],
    });
    const out = formatRequestForAI(data.network[0] as NetworkEntryPayload, data);
    expect(out).toContain('# Failed request');
    expect(out).toContain('{"a":1}'); // request body
    expect(out).toContain('BOOM'); // response body
  });
});

describe('R1c — structure + where-to-look (observed only)', () => {
  const data = base({
    console: [
      con({
        tFromStart: 1100,
        args: ['TypeError: x'],
        stack: 'TypeError: x\n  at Cart (Cart.tsx:9)',
      }),
    ],
    network: [
      net({
        tFromStart: 1000,
        method: 'POST',
        url: 'https://app.example/api/order',
        status: 500,
        responseBody: '{"error":"E"}',
      }),
    ],
  });

  it('orders failing request before errors, environment last', () => {
    const out = formatSessionForAI(data);
    expect(out.indexOf('## Failing request')).toBeLessThan(out.indexOf('## Errors'));
    expect(out.indexOf('## Environment')).toBeGreaterThan(out.indexOf('## Errors'));
    expect(out.indexOf('## Environment')).toBe(out.lastIndexOf('## ')); // env is the final section
  });

  it('where-to-look lists observed facts and never invents a file/component', () => {
    // network-lead (no stacked console error) → the failing-endpoint pointer fires
    const out = formatSessionForAI(
      base({
        network: [
          net({
            tFromStart: 1000,
            method: 'POST',
            url: 'https://app.example/api/order',
            status: 500,
            responseBody: '{"error":"E"}',
          }),
        ],
      }),
    );
    expect(out).toContain('## Where to look');
    expect(out).toContain('failing endpoint: POST /api/order → 500');
    // never a heuristic guess label
    expect(out).not.toMatch(/likely (area|file|component)/i);
  });
});

describe('R2 — location signals in copy', () => {
  it('includes source(file:line) and the cause chain in the error block', () => {
    const out = formatSessionForAI(
      base({
        console: [
          con({
            tFromStart: 1000,
            args: ['TypeError: x'],
            stack: 'TypeError: x\n  at Foo (Foo.tsx:3:1)',
            source: { file: 'https://app/assets/main.js', line: 12, col: 4 },
            cause: 'Caused by: Error: db down\n  at q (db.ts:9)',
          }),
        ],
      }),
    );
    expect(out).toContain('source: https://app/assets/main.js:12:4');
    expect(out).toContain('Caused by: Error: db down');
  });

  it('does NOT promote a minified bundle frame to a location (symbolic gate)', () => {
    const out = formatSessionForAI(
      base({
        console: [
          con({
            tFromStart: 1000,
            args: ['TypeError: null.total'],
            stack:
              'TypeError: null.total\n  at t (https://app/assets/app.4f3a.js:1:88421)\n  at o (https://app/assets/app.4f3a.js:1:90233)',
          }),
        ],
      }),
    );
    // the minified frame is still cited in Errors, but never under "Where to look"
    const where = out.slice(out.indexOf('## Where to look'));
    expect(where).not.toContain('app.4f3a.js');
    expect(where).not.toContain('error origin');
  });

  it('DOES promote a symbolic source frame to a location', () => {
    const out = formatSessionForAI(
      base({
        console: [
          con({
            tFromStart: 1000,
            args: ['TypeError: x'],
            stack: 'TypeError: x\n  at UserBadge (UserBadge.tsx:14:22)',
          }),
        ],
      }),
    );
    expect(out).toContain('error origin (observed): at UserBadge (UserBadge.tsx:14:22)');
  });

  it('labels likely-CORS with evidence, not as fact', () => {
    const out = formatSessionForAI(
      base({
        network: [
          net({
            status: null,
            method: 'GET',
            url: 'https://x/api/q',
            error: 'Failed to fetch',
            corsLikely: true,
          }),
        ],
      }),
    );
    expect(out).toContain('likely CORS');
    expect(out).toContain('opaque fetch failure'); // evidence
  });

  it('redacts a token-shaped value carried in cause', () => {
    const out = formatSessionForAI(
      base({ console: [con({ args: ['boom'], cause: `Caused by: token ${JWT}` })] }),
    );
    expect(out).not.toContain(JWT);
    expect(out).toContain('[REDACTED]');
  });
});

describe('per-item formatters — correlation', () => {
  it('a console error copy lists a failed request from the same moment', () => {
    const data = base({
      console: [con({ tFromStart: 1000, args: ['TypeError: x'] })],
      network: [net({ tFromStart: 1200, method: 'POST', url: 'https://x/api/order', status: 500 })],
    });
    const out = formatConsoleErrorForAI(data.console[0] as ConsoleEntry, data);
    expect(out).toContain('# Console error');
    expect(out).toContain('Around this moment');
    expect(out).toContain('POST /api/order → 500');
  });
});
