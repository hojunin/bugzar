/**
 * Phase B — write-path authorization & enumeration hardening.
 *
 *  - S-3: an asset PUT is bound to the report's HMAC `uploadToken` (when
 *    `UPLOAD_SECRET` is set), and oversized writes are rejected (413).
 *  - S-6: the `GET /` enumeration index is hidden on a public deploy unless
 *    explicitly opted in.
 *  - Writes are origin-gated; a public deploy with no allowlist denies them.
 */

import { describe, expect, it } from 'vitest';
import worker, { type Env } from './worker';

const stubArtifacts = (): R2Bucket => {
  const store = new Map<string, string>();
  return {
    async put(key: string, body: unknown): Promise<unknown> {
      store.set(key, String(body));
      return {};
    },
    async get(): Promise<null> {
      return null;
    },
    async head(): Promise<null> {
      return null;
    },
    async list(): Promise<R2Objects> {
      return { objects: [], truncated: false } as unknown as R2Objects;
    },
    async delete(): Promise<void> {
      /* noop */
    },
  } as unknown as R2Bucket;
};

const env = (extra: Partial<Env> = {}): Env => ({ ARTIFACTS: stubArtifacts(), ...extra }) as Env;

const postReports = (e: Env, headers?: Record<string, string>) =>
  worker.fetch(new Request('https://w.example/reports', { method: 'POST', headers }), e);

describe('Phase B — upload token (S-3)', () => {
  it('issues an uploadToken when UPLOAD_SECRET is set', async () => {
    const res = await postReports(env({ UPLOAD_SECRET: 's3cret' }));
    const body = (await res.json()) as { uploadToken?: string };
    expect(body.uploadToken).toBeTruthy();
  });

  it('omits uploadToken when UPLOAD_SECRET is unset (back-compat)', async () => {
    const body = (await (await postReports(env())).json()) as { uploadToken?: string };
    expect(body.uploadToken).toBeUndefined();
  });

  it('binds asset PUTs to a matching token', async () => {
    const e = env({ UPLOAD_SECRET: 's3cret' });
    const created = (await (await postReports(e)).json()) as {
      reportId: string;
      uploadToken: string;
    };
    const put = (headers: Record<string, string>) =>
      worker.fetch(
        new Request(`https://w.example/reports/${created.reportId}/meta`, {
          method: 'PUT',
          headers,
          body: '{}',
        }),
        e,
      );
    expect((await put({ 'content-type': 'application/json' })).status).toBe(401); // none
    expect(
      (await put({ 'content-type': 'application/json', 'X-Upload-Token': 'nope' })).status,
    ).toBe(401); // wrong
    expect(
      (await put({ 'content-type': 'application/json', 'X-Upload-Token': created.uploadToken }))
        .status,
    ).toBe(200); // valid
  });

  it('rejects oversized writes with 413 (declared content-length over the cap)', async () => {
    const res = await worker.fetch(
      new Request('https://w.example/reports/abc/network', {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'content-length': String(26 * 1024 * 1024), // > 25 MB network cap (#20)
        },
        body: '{}',
      }),
      env(),
    );
    expect(res.status).toBe(413);
  });

  it('rejects an oversized chunked write with no Content-Length (counts streamed bytes)', async () => {
    // R2 stub that actually DRAINS the body — so the capping TransformStream runs.
    const draining = (): R2Bucket =>
      ({
        async put(_key: string, body: ReadableStream<Uint8Array>): Promise<unknown> {
          await new Response(body).arrayBuffer();
          return {};
        },
        async get(): Promise<null> {
          return null;
        },
        async head(): Promise<null> {
          return null;
        },
        async list(): Promise<R2Objects> {
          return { objects: [], truncated: false } as unknown as R2Objects;
        },
        async delete(): Promise<void> {},
      }) as unknown as R2Bucket;

    // 26 MB streamed in 1 MB chunks, with NO content-length header — the header
    // check (overSizeLimit) sees nothing; the byte counter must catch it at the
    // 25 MB network cap (#20).
    const oneMB = new Uint8Array(1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 26; i++) controller.enqueue(oneMB);
        controller.close();
      },
    });
    const res = await worker.fetch(
      new Request('https://w.example/reports/abc/network', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }),
      env({ ARTIFACTS: draining() }),
    );
    expect(res.status).toBe(413);
  });
});

describe('Phase B — public index gating (S-6)', () => {
  const getIndex = (e: Env) => worker.fetch(new Request('https://w.example/'), e);

  it('serves the index in local dev (no PUBLIC_DEPLOY)', async () => {
    expect((await getIndex(env())).status).toBe(200);
  });
  it('hides the index on a public deploy by default', async () => {
    expect((await getIndex(env({ PUBLIC_DEPLOY: '1' }))).status).toBe(404);
  });
  it('exposes the index when PUBLIC_INDEX=1', async () => {
    expect((await getIndex(env({ PUBLIC_DEPLOY: '1', PUBLIC_INDEX: '1' }))).status).toBe(200);
  });

  // Footgun guard: a hardened deploy that set ALLOWED_ORIGINS / UPLOAD_SECRET but
  // forgot PUBLIC_DEPLOY must still hide the enumeration index.
  it('hides the index when ALLOWED_ORIGINS is set even without PUBLIC_DEPLOY', async () => {
    expect((await getIndex(env({ ALLOWED_ORIGINS: 'https://app.ok' }))).status).toBe(404);
  });
  it('hides the index when UPLOAD_SECRET is set even without PUBLIC_DEPLOY', async () => {
    expect((await getIndex(env({ UPLOAD_SECRET: 's3cret' }))).status).toBe(404);
  });
});

describe('Phase B — write origin gating', () => {
  it('denies writes on a public deploy with no allowlist', async () => {
    expect((await postReports(env({ PUBLIC_DEPLOY: '1' }))).status).toBe(403);
  });
  it('allows writes from an allowlisted Origin', async () => {
    const res = await postReports(env({ PUBLIC_DEPLOY: '1', ALLOWED_ORIGINS: 'https://app.ok' }), {
      Origin: 'https://app.ok',
    });
    expect(res.status).toBe(200);
  });
});
