/**
 * PR-16: DELETE /reports/:id + 410 Gone behavior.
 *
 * The R2 stub here is richer than the index test's — we need head/list/get/
 * put/delete to all behave in concert because the delete handler reads the
 * bucket, mutates it, then a follow-up GET must observe the tombstone.
 */

import { describe, expect, it } from 'vitest';
import worker, { type Env } from './worker';

interface StubObject {
  key: string;
  body?: string;
}

const makeStubBucket = (
  initial: StubObject[],
): { ARTIFACTS: R2Bucket; getStore: () => StubObject[] } => {
  const store = [...initial];
  const find = (key: string): StubObject | undefined => store.find((o) => o.key === key);
  return {
    getStore: () => store,
    ARTIFACTS: {
      async head(key: string): Promise<R2Object | null> {
        const o = find(key);
        if (!o) return null;
        // biome-ignore lint/suspicious/noExplicitAny: minimal R2Object stub
        return { key, size: o.body?.length ?? 0 } as any;
      },
      async get(key: string): Promise<R2ObjectBody | null> {
        const o = find(key);
        if (!o) return null;
        return {
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(o.body ?? ''));
              controller.close();
            },
          }),
          async text() {
            return o.body ?? '';
          },
          writeHttpMetadata() {
            /* noop */
          },
          // biome-ignore lint/suspicious/noExplicitAny: minimal R2ObjectBody stub
        } as any;
      },
      async list(opts?: R2ListOptions): Promise<R2Objects> {
        const prefix = opts?.prefix ?? '';
        const matched = store.filter((o) => o.key.startsWith(prefix));
        return {
          objects: matched.map((o) => ({
            key: o.key,
            uploaded: new Date(),
            size: o.body?.length ?? 0,
            etag: 'etag',
            httpEtag: 'etag',
            version: 'v1',
            // biome-ignore lint/suspicious/noExplicitAny: minimal R2Object stub
          })) as any,
          truncated: false,
          // biome-ignore lint/suspicious/noExplicitAny: typed as R2Objects
        } as any;
      },
      async put(key: string, value: string | ArrayBuffer | ReadableStream): Promise<R2Object> {
        const idx = store.findIndex((o) => o.key === key);
        const body = typeof value === 'string' ? value : '';
        if (idx >= 0) store[idx] = { key, body };
        else store.push({ key, body });
        // biome-ignore lint/suspicious/noExplicitAny: minimal R2Object stub
        return { key, size: body.length } as any;
      },
      async delete(key: string): Promise<void> {
        const idx = store.findIndex((o) => o.key === key);
        if (idx >= 0) store.splice(idx, 1);
      },
      // biome-ignore lint/suspicious/noExplicitAny: only the surface above is used
    } as any,
  };
};

const sampleObjects = (reportId: string): StubObject[] => [
  { key: `reports/${reportId}/replay.html`, body: '<html>hi</html>' },
  { key: `reports/${reportId}/meta.json`, body: '{}' },
  { key: `reports/${reportId}/events.json`, body: '[]' },
];

const makeDeleteReq = (reportId: string, token?: string): Request =>
  new Request(`https://example.com/reports/${reportId}`, {
    method: 'DELETE',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

describe('DELETE /reports/:id', () => {
  it('returns 501 when ADMIN_SECRET is not configured', async () => {
    const stub = makeStubBucket(sampleObjects('abc123'));
    const env = stub as unknown as Env;
    const res = await worker.fetch(makeDeleteReq('abc123', 'whatever'), env);
    expect(res.status).toBe(501);
  });

  it('returns 401 when the bearer token does not match ADMIN_SECRET', async () => {
    const stub = makeStubBucket(sampleObjects('abc123'));
    const env = { ...stub, ADMIN_SECRET: 'correct' } as unknown as Env;
    const res = await worker.fetch(makeDeleteReq('abc123', 'wrong'), env);
    expect(res.status).toBe(401);
  });

  it('returns 401 when no Authorization header is provided', async () => {
    const stub = makeStubBucket(sampleObjects('abc123'));
    const env = { ...stub, ADMIN_SECRET: 'correct' } as unknown as Env;
    const res = await worker.fetch(makeDeleteReq('abc123'), env);
    expect(res.status).toBe(401);
  });

  it('returns 404 when no report objects exist under the prefix', async () => {
    const stub = makeStubBucket([]);
    const env = { ...stub, ADMIN_SECRET: 'correct' } as unknown as Env;
    const res = await worker.fetch(makeDeleteReq('nonexistent', 'correct'), env);
    expect(res.status).toBe(404);
  });

  it('deletes every asset under the prefix and writes a tombstone', async () => {
    const stub = makeStubBucket(sampleObjects('abc123'));
    const env = { ...stub, ADMIN_SECRET: 'correct' } as unknown as Env;
    const res = await worker.fetch(makeDeleteReq('abc123', 'correct'), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; deletedKeys: number };
    expect(body.deletedKeys).toBe(3);
    // Bucket now contains only the tombstone.
    const remaining = stub.getStore().map((o) => o.key);
    expect(remaining).toEqual(['reports/abc123/.deleted']);
  });

  it('subsequent GET /r/:id returns 410 Gone after deletion', async () => {
    const stub = makeStubBucket(sampleObjects('abc123'));
    const env = { ...stub, ADMIN_SECRET: 'correct' } as unknown as Env;
    await worker.fetch(makeDeleteReq('abc123', 'correct'), env);
    const getRes = await worker.fetch(new Request('https://example.com/r/abc123'), env);
    expect(getRes.status).toBe(410);
    const html = await getRes.text();
    expect(html).toContain('삭제된 리포트');
    expect(html).toContain('abc123');
  });

  it('asset GETs also return 410 Gone after deletion', async () => {
    const stub = makeStubBucket(sampleObjects('abc123'));
    const env = { ...stub, ADMIN_SECRET: 'correct' } as unknown as Env;
    await worker.fetch(makeDeleteReq('abc123', 'correct'), env);
    const assetRes = await worker.fetch(
      new Request('https://example.com/reports/abc123/meta.json'),
      env,
    );
    expect(assetRes.status).toBe(410);
  });

  it('emits a `report_deleted` telemetry event when TELEMETRY is bound', async () => {
    const stub = makeStubBucket(sampleObjects('abc123'));
    const writeDataPoint = (() => {
      const calls: unknown[] = [];
      const fn = (point: unknown) => calls.push(point);
      (fn as unknown as { calls: unknown[] }).calls = calls;
      return fn as unknown as (point: unknown) => void;
    })();
    const env = {
      ...stub,
      ADMIN_SECRET: 'correct',
      BUGZAR_ANALYTICS: { writeDataPoint },
    } as unknown as Env;
    await worker.fetch(makeDeleteReq('abc123', 'correct'), env);
    const calls = (writeDataPoint as unknown as { calls: { indexes: string[] }[] }).calls;
    expect(calls.length).toBe(1);
    expect(calls[0]?.indexes).toEqual(['report_deleted']);
  });
});
