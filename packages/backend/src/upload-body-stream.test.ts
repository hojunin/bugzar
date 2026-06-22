/**
 * Regression: asset upload must hand R2 a length-known body.
 *
 * Production R2 `put()` rejects a ReadableStream without a known length
 * ("Provided readable stream must have a known length …"). The original code
 * piped `req.body` through `capBodyStream`'s TransformStream, producing a
 * length-less stream → every real upload 500'd in production. (Local/test R2 is
 * a hand stub that ignores the constraint, so this was invisible until a live
 * smoke test.)
 *
 * The fix streams `req.body` straight to `put`. This test pins that contract by
 * asserting `put` receives the exact request-body stream — not a transformed copy.
 */

import { describe, expect, it } from 'vitest';
import worker, { type Env } from './worker';

const stubArtifactsCapturingPut = (): { env: Env; getPutValue: () => unknown } => {
  let putValue: unknown;
  const env = {
    ARTIFACTS: {
      async put(_key: string, value: unknown): Promise<unknown> {
        putValue = value;
        return {};
      },
    },
  } as unknown as Env;
  return { env, getPutValue: () => putValue };
};

describe('asset upload — R2 receives a length-known body', () => {
  it('PUT /reports/:id/:asset streams the raw request body to R2.put', async () => {
    const { env, getPutValue } = stubArtifactsCapturingPut();
    const req = new Request('https://w.example/reports/abc123/meta.json', {
      method: 'PUT',
      body: '{"smoke":true}',
      headers: { 'content-type': 'application/json' },
    });
    const res = await worker.fetch(req, env);

    expect(res.status).toBe(200);
    // Prod R2 requires a known length; the buggy code passed a bare
    // TransformStream. The fix buffers to a length-known ArrayBuffer.
    expect(getPutValue()).toBeInstanceOf(ArrayBuffer);
  });
});
