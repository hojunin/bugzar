/**
 * Pilot replay upload route — PUT /pilot/r2/:key stores a self-contained replay
 * HTML and returns a GET-able URL; GET /pilot/r2/:key serves it back. Used by
 * the catalog pilot's `onExport`. Kept separate from /reports/:id/:asset (which
 * is the per-report asset set) — this is a single-object trial upload.
 */

import { describe, expect, it } from 'vitest';
import worker, { type Env } from './worker';

const stubR2 = (): { env: Env; store: Map<string, ArrayBuffer> } => {
  const store = new Map<string, ArrayBuffer>();
  const env = {
    ARTIFACTS: {
      async put(key: string, value: ArrayBuffer): Promise<unknown> {
        store.set(key, value);
        return {};
      },
      async get(key: string): Promise<unknown> {
        if (!store.has(key)) return null;
        const buf = store.get(key) as ArrayBuffer;
        return {
          body: buf,
          writeHttpMetadata(): void {
            /* noop */
          },
        };
      },
    },
  } as unknown as Env;
  return { env, store };
};

describe('PUT/GET /pilot/r2/:key', () => {
  it('PUT stores the HTML and returns a GET url for the same key', async () => {
    const { env, store } = stubR2();
    const res = await worker.fetch(
      new Request('https://w.example/pilot/r2/session-1730000000000.html', {
        method: 'PUT',
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: '<html>replay</html>',
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    expect(body.url).toContain('/pilot/r2/session-1730000000000.html');
    expect(store.size).toBe(1);
  });

  it('GET serves the stored HTML back', async () => {
    const { env } = stubR2();
    await worker.fetch(
      new Request('https://w.example/pilot/r2/x.html', {
        method: 'PUT',
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: '<html>hello-replay</html>',
      }),
      env,
    );
    const res = await worker.fetch(new Request('https://w.example/pilot/r2/x.html'), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('hello-replay');
  });

  it('GET renders the report inline (not a download) under the viewer CSP', async () => {
    const { env } = stubR2();
    await worker.fetch(
      new Request('https://w.example/pilot/r2/x.html', {
        method: 'PUT',
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: '<html><script>alert(1)</script>replay</html>',
      }),
      env,
    );
    const res = await worker.fetch(new Request('https://w.example/pilot/r2/x.html'), env);
    // Inline HTML so the browser opens it directly — no forced download.
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('Content-Disposition')).toBe('inline');
    expect(res.headers.get('Content-Disposition')).not.toBe('attachment');
    // Under the same hardening the viewer uses at /r/:id: CSP + nosniff + no framing.
    const csp = res.headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  });
});
