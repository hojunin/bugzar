import { describe, expect, it } from 'vitest';
import { isParamsError, parseReportParams } from '../report/params';

const SELF = 'https://viewer.self';

describe('parseReportParams', () => {
  it('parses an explicit endpoint + id and strips the endpoint trailing slash', () => {
    const r = parseReportParams('?endpoint=https://w.dev/&id=abc', SELF);
    expect(isParamsError(r)).toBe(false);
    expect(r).toEqual({ endpoint: 'https://w.dev', id: 'abc' });
  });
  it('accepts a bare (no leading ?) query string', () => {
    expect(parseReportParams('endpoint=https://w.dev&id=x', SELF)).toEqual({
      endpoint: 'https://w.dev',
      id: 'x',
    });
  });
  it('defaults endpoint to the viewer origin when omitted (same-origin)', () => {
    expect(parseReportParams('?id=abc', SELF)).toEqual({ endpoint: SELF, id: 'abc' });
  });
  it('missing id → error', () => {
    expect(parseReportParams('?endpoint=https://w.dev', SELF)).toEqual({ error: 'missing-id' });
  });
});
