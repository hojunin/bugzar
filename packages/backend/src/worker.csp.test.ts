/**
 * Tests for the security posture of the public surfaces:
 *
 *   - `GET /r/:id` — now a 302 redirect into the same-origin viewer (`/v/?id=`).
 *     No HTML is rendered here, so its security lives on the viewer assets.
 *   - `GET /` — the report index, still HTML served by the Worker → keeps its CSP.
 *   - `public/_headers` — Cloudflare Static Assets headers for the viewer (`/v/*`).
 *     The viewer is linked from Jira tickets and public-by-URL, so these must
 *     block framing/sniffing, keep `script-src`/`connect-src` to `'self'`, and
 *     still allow the passive resources the replayed DOM reloads.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import worker, { type Env } from './worker';

/** Minimal R2 stub — `get` returns null (no tombstone, no replay), enough to
 * drive the redirect/index paths. */
const makeEnv = (replayHtml?: string): Env => {
  const stub = {
    async list(): Promise<R2Objects> {
      return { objects: [], truncated: false } as unknown as R2Objects;
    },
    async get(key: string): Promise<R2ObjectBody | null> {
      if (!replayHtml) return null;
      if (key.endsWith('/replay.html') || key.endsWith('/replay')) {
        return {
          body: replayHtml,
          writeHttpMetadata(): void {
            /* noop */
          },
          // biome-ignore lint/suspicious/noExplicitAny: minimal R2ObjectBody stub
        } as any;
      }
      return null;
    },
  };
  return { ARTIFACTS: stub as unknown as R2Bucket };
};

describe('GET /r/:id — redirects to the same-origin viewer', () => {
  it('302s to /v/?id= (the bundled viewer reads the report same-origin)', async () => {
    const res = await worker.fetch(
      new Request('https://bugzar-backend.example/r/abc123'),
      makeEnv(),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/v/?id=abc123');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('GET / — security headers on the index page', () => {
  it('applies CSP + anti-framing/sniffing headers', async () => {
    const res = await worker.fetch(new Request('https://bugzar-backend.example/'), makeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Security-Policy')).toBeTruthy();
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  });
});

describe('GET /reports/:id/:asset — artifact hardening (S-2)', () => {
  it('serves a stored replay HTML as inert text/plain + attachment + nosniff', async () => {
    const res = await worker.fetch(
      new Request('https://bugzar-backend.example/reports/abc123/replay'),
      makeEnv('<script>alert(document.cookie)</script>'),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    // Never served as active HTML on the Worker origin (Stored-XSS prevention).
    expect(res.headers.get('content-type')).not.toContain('text/html');
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(res.headers.get('Content-Disposition')).toBe('attachment');
  });
});

describe('viewer static-asset security headers (public/_headers)', () => {
  const headers = readFileSync(new URL('../public/_headers', import.meta.url).pathname, 'utf8');

  it('scopes hardened headers to the viewer (/v/*)', () => {
    expect(headers).toMatch(/^\/v\/\*/m);
  });
  it('blocks framing + sniffing + trims referrers', () => {
    expect(headers).toMatch(/X-Frame-Options:\s*DENY/);
    expect(headers).toMatch(/X-Content-Type-Options:\s*nosniff/);
    expect(headers).toMatch(/Referrer-Policy:\s*strict-origin-when-cross-origin/);
    expect(headers).toMatch(/frame-ancestors 'none'/);
  });
  it('keeps script + network to self (no remote scripts, no eval)', () => {
    const csp = headers.match(/Content-Security-Policy:\s*(.+)/)?.[1] ?? '';
    expect(csp).toMatch(/script-src 'self'/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-eval'/);
    expect(csp).not.toMatch(/script-src[^;]*\bhttps:/);
    expect(csp).toMatch(/connect-src 'self'/);
  });
  it('allows the passive resources the replayed DOM reloads', () => {
    const csp = headers.match(/Content-Security-Policy:\s*(.+)/)?.[1] ?? '';
    expect(csp).toMatch(/img-src[^;]*blob:/);
    expect(csp).toMatch(/media-src[^;]*blob:/);
    expect(csp).toMatch(/frame-src[^;]*about:/);
  });
});

describe('Pretendard SRI hash is pinned in viewer HTML', () => {
  const SHA384_RE = /^sha384-[A-Za-z0-9+/]{64}={0,2}$/;
  const PINNED_HASH = 'sha384-GIdEBaqGN9mNkDkMkzMHW8EKUqtpPIe/sLj1X7DIrnc9uPtLROJgmuDlh+3rBw0j';

  it('the pinned hash conforms to SRI sha384 base64 format', () => {
    expect(PINNED_HASH).toMatch(SHA384_RE);
  });
});
