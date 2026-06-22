import { describe, expect, it } from 'vitest';
import { REDACTED, redactJwt, sanitizeForAI, sanitizeHeaders } from './sanitize';

describe('sanitizeHeaders', () => {
  it('redacts Authorization regardless of case', () => {
    const out = sanitizeHeaders({ Authorization: 'Bearer secret-token-xyz' });
    expect(out.Authorization).toBe(REDACTED);
  });

  it('redacts Cookie and Set-Cookie', () => {
    const out = sanitizeHeaders({
      Cookie: 'sid=abc123',
      'Set-Cookie': 'sid=abc123; HttpOnly',
    });
    expect(out.Cookie).toBe(REDACTED);
    expect(out['Set-Cookie']).toBe(REDACTED);
  });

  it('redacts custom auth-style headers not on the allowlist', () => {
    const out = sanitizeHeaders({
      'X-Auth-Token': 'aaa',
      'X-Api-Key': 'bbb',
      'X-Csrf-Token': 'ccc',
    });
    expect(out['X-Auth-Token']).toBe(REDACTED);
    expect(out['X-Api-Key']).toBe(REDACTED);
    expect(out['X-Csrf-Token']).toBe(REDACTED);
  });

  it('passes through safe content / cache headers verbatim', () => {
    const out = sanitizeHeaders({
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ETag: 'W/"abc"',
    });
    expect(out['Content-Type']).toBe('application/json');
    expect(out['Cache-Control']).toBe('no-store');
    expect(out.ETag).toBe('W/"abc"');
  });

  it('strips JWTs that leak into allowed headers (e.g. Referer)', () => {
    const out = sanitizeHeaders({
      Referer: 'https://app.example.com/?token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF123',
    });
    expect(out.Referer).toContain('https://app.example.com');
    expect(out.Referer).toContain(REDACTED);
    expect(out.Referer).not.toContain('eyJ');
  });

  it('handles null / undefined input safely', () => {
    expect(sanitizeHeaders(null)).toEqual({});
    expect(sanitizeHeaders(undefined)).toEqual({});
  });
});

describe('redactJwt', () => {
  it('redacts a canonical 3-segment JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV';
    expect(redactJwt(jwt)).toBe(REDACTED);
  });

  it('redacts JWTs embedded in larger strings', () => {
    const text = 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF123 in body';
    const out = redactJwt(text);
    expect(out).toContain('Bearer');
    expect(out).toContain('in body');
    expect(out).not.toContain('eyJ');
    expect(out).toContain(REDACTED);
  });

  it('redacts multiple JWTs in one string', () => {
    const a = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.aaaBBBccc';
    const b = 'eyJ0eXAiOiJKV1QifQ.eyJyb2xlIjoiYWRtaW4ifQ.dddEEEfff';
    const out = redactJwt(`${a} and ${b}`);
    expect(out).toBe(`${REDACTED} and ${REDACTED}`);
  });

  it('passes regular text through unchanged', () => {
    expect(redactJwt('hello world')).toBe('hello world');
    expect(redactJwt('eyJ-but-not-a-jwt')).toBe('eyJ-but-not-a-jwt');
  });
});

describe('sanitizeForAI', () => {
  it('redacts Authorization in deeply nested header bags', () => {
    const input = {
      entries: [
        {
          url: 'https://api.example.com/me',
          requestHeaders: { Authorization: 'Bearer abc', 'Content-Type': 'application/json' },
          responseHeaders: { 'Set-Cookie': 'sid=1', 'Cache-Control': 'no-store' },
        },
      ],
    };
    const out = sanitizeForAI(input) as typeof input;
    expect(out.entries[0]?.requestHeaders.Authorization).toBe(REDACTED);
    expect(out.entries[0]?.requestHeaders['Content-Type']).toBe('application/json');
    expect(out.entries[0]?.responseHeaders['Set-Cookie']).toBe(REDACTED);
    expect(out.entries[0]?.responseHeaders['Cache-Control']).toBe('no-store');
  });

  it('redacts cookies field in storage snapshot', () => {
    const input = {
      snapshots: [
        {
          tFromStart: 0,
          localStorage: { theme: 'dark' },
          sessionStorage: {},
          cookies: 'sessionId=abc123; csrf=xyz',
        },
      ],
    };
    const out = sanitizeForAI(input) as typeof input;
    expect(out.snapshots[0]?.cookies).toBe(REDACTED);
    expect(out.snapshots[0]?.localStorage.theme).toBe('dark');
  });

  it('sweeps JWTs out of request/response bodies', () => {
    const input = {
      requestBody: '{"token":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.aaaBBBccc"}',
      responseBody: 'set Bearer eyJ0eXAiOiJKV1QifQ.eyJyb2xlIjoiYWRtaW4ifQ.dddEEEfff in storage',
    };
    const out = sanitizeForAI(input) as typeof input;
    expect(out.requestBody).not.toContain('eyJ');
    expect(out.requestBody).toContain(REDACTED);
    expect(out.responseBody).not.toContain('eyJ');
    expect(out.responseBody).toContain('Bearer');
  });

  it('redacts top-level Authorization property regardless of nesting', () => {
    const input = { meta: { Authorization: 'Bearer xxx' } };
    const out = sanitizeForAI(input) as { meta: { Authorization: string } };
    expect(out.meta.Authorization).toBe(REDACTED);
  });

  it('does not mutate the input', () => {
    const input = {
      requestHeaders: { Authorization: 'Bearer abc' },
      body: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.aaaBBBccc',
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    sanitizeForAI(input);
    expect(input).toEqual(snapshot);
  });

  it('passes primitives through unchanged', () => {
    expect(sanitizeForAI(42)).toBe(42);
    expect(sanitizeForAI(true)).toBe(true);
    expect(sanitizeForAI(null)).toBe(null);
    expect(sanitizeForAI(undefined)).toBe(undefined);
  });

  it('preserves arrays and recurses into them', () => {
    const input = {
      entries: [
        { level: 'log', args: ['hello', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.aaaBBBccc'] },
        { level: 'warn', args: ['plain text'] },
      ],
    };
    const out = sanitizeForAI(input) as typeof input;
    expect(out.entries[0]?.args[0]).toBe('hello');
    expect(out.entries[0]?.args[1]).toBe(REDACTED);
    expect(out.entries[1]?.args[0]).toBe('plain text');
  });
});
