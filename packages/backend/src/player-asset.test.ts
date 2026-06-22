/**
 * The SDK's slim replay viewer (/r/:id) loads rrweb-player from these
 * same-origin routes because the replay CSP is `script-src 'self'` (no CDNs).
 * If these 404 or drift off `application/javascript`, every SDK-uploaded replay
 * silently fails to render.
 */

import { describe, expect, it } from 'vitest';
import worker, { type Env } from './worker';

const call = (path: string): Promise<Response> =>
  worker.fetch(new Request(`https://example.com${path}`), {} as Env);

describe('GET /assets/rrweb-player.*', () => {
  it('serves the player JS same-origin with a script content-type', async () => {
    const res = await call('/assets/rrweb-player.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(res.headers.get('cache-control')).toContain('immutable');
    const body = await res.text();
    expect(body.length).toBeGreaterThan(10_000);
    expect(body).toContain('rrwebPlayer');
  });

  it('serves the player CSS', async () => {
    const res = await call('/assets/rrweb-player.css');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/css');
    expect((await res.text()).length).toBeGreaterThan(100);
  });
});
