/**
 * Worker `/jira/draft` no longer surfaces a 502 when Workers AI fails to
 * produce valid JSON — it now falls back to a stub built from the
 * artifacts (`stub: true`) so the chain keeps going and the Jira ticket
 * still gets published. Pin the contract here so a refactor can't
 * silently re-introduce the 502 path.
 */

import { describe, expect, it } from 'vitest';
import worker, { type Env } from './worker';

// Minimal R2 stub that returns "not found" for every key. The handler's
// JSON-asset fetcher tolerates nulls so the handler still runs.
const emptyArtifactBucket = {
  async get() {
    return null;
  },
  async list() {
    return { objects: [], truncated: false };
  },
} as unknown as R2Bucket;

const baseRequest = (mode: 'bug' | 'design' = 'bug') =>
  new Request('https://example.com/jira/draft', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      reportId: 'r1',
      userInput: '판매중 버튼 클릭 후 잘 안돼',
      mode,
    }),
  });

describe('POST /jira/draft — AI failure fallback', () => {
  it('returns 200 + stub:true when AI returns a non-JSON response', async () => {
    const env: Env = {
      ARTIFACTS: emptyArtifactBucket,
      AI: {
        // Pretend Workers AI gave us garbage that the parser can't recover.
        run: async () => 'this is not JSON at all',
      } as unknown as Ai,
    } as Env;
    const res = await worker.fetch(baseRequest('bug'), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      stub: boolean;
      title: string;
      description: unknown;
      mode: string;
    };
    expect(body.stub).toBe(true);
    expect(body.mode).toBe('bug');
    expect(body.title).toContain('판매중');
    expect(body.description).toBeTruthy();
  });

  it('returns 200 + stub:true when AI throws (e.g. timeout / 503)', async () => {
    const env: Env = {
      ARTIFACTS: emptyArtifactBucket,
      AI: {
        run: async () => {
          throw new Error('Workers AI 503 Service Unavailable');
        },
      } as unknown as Ai,
    } as Env;
    const res = await worker.fetch(baseRequest('bug'), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stub: boolean };
    expect(body.stub).toBe(true);
  });

  it('still returns 200 + stub:true for design mode AI failure', async () => {
    const env: Env = {
      ARTIFACTS: emptyArtifactBucket,
      AI: {
        run: async () => 'broken response',
      } as unknown as Ai,
    } as Env;
    const res = await worker.fetch(baseRequest('design'), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stub: boolean; mode: string };
    expect(body.stub).toBe(true);
    expect(body.mode).toBe('design');
  });

  it('still 200 + stub:true (NOT 200 without stub) when AI succeeds with valid draft', async () => {
    // Sanity: success path keeps stub omitted/false. Pinning this guards
    // against a regression where we accidentally mark every response stub.
    const env: Env = {
      ARTIFACTS: emptyArtifactBucket,
      AI: {
        run: async () => ({
          response: JSON.stringify({
            title: '판매중 버튼 무반응',
            overview: '사용자가 ...',
            reproSteps: ['1. 페이지 이동'],
            envBullets: ['URL: x'],
            attachments: { consoleError: null, failedRequest: null },
          }),
        }),
      } as unknown as Ai,
    } as Env;
    const res = await worker.fetch(baseRequest('bug'), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stub?: boolean };
    // The success path doesn't set stub at all — chain treats absence as false.
    expect(body.stub).toBeFalsy();
  });
});
