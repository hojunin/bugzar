/**
 * M3.5 Foundation — the upload/asset/mode contract.
 *
 *  - POST /reports must allocate the extended asset set (resources/state/vitals
 *    slots) so M5/M6 streams have an upload target.
 *  - The index must label a video-less SDK report as `mode:'session'` (derived
 *    from asset presence), not the old "everything non-design is video".
 */

import { describe, expect, it } from 'vitest';
import worker, { type Env } from './worker';

const stubR2 = (
  objs: { key: string; uploaded: Date; body?: string }[],
): { ARTIFACTS: R2Bucket } => ({
  ARTIFACTS: {
    async list(opts?: R2ListOptions): Promise<R2Objects> {
      const prefix = opts?.prefix ?? '';
      const matched = objs.filter((o) => o.key.startsWith(prefix));
      return {
        objects: matched.map((o) => ({ key: o.key, uploaded: o.uploaded })),
        truncated: false,
      } as unknown as R2Objects;
    },
    async get(key: string): Promise<R2ObjectBody | null> {
      const o = objs.find((x) => x.key === key);
      if (!o?.body) return null;
      return {
        async text(): Promise<string> {
          return o.body as string;
        },
        writeHttpMetadata(): void {
          /* noop */
        },
      } as unknown as R2ObjectBody;
    },
  } as unknown as R2Bucket,
});

describe('POST /reports — extended asset set', () => {
  it('allocates resources/state/vitals slots alongside the existing assets', async () => {
    const res = await worker.fetch(
      new Request('https://w.example/reports', { method: 'POST' }),
      {} as Env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { assetUrls: Record<string, string> };
    for (const a of [
      'meta',
      'events',
      'console',
      'network',
      'storage',
      'replay',
      'vitals',
      'resources',
      'state',
    ]) {
      expect(body.assetUrls[a]).toContain(`/${a}`);
    }
  });
});

describe('GET / — session mode derivation', () => {
  it('labels a meta+events report (no video, no design) as mode=session', async () => {
    const now = Date.now();
    const env = stubR2([
      {
        key: 'reports/sess01/meta.json',
        uploaded: new Date(now),
        body: JSON.stringify({ url: 'https://app.example/x', startedAt: now }),
      },
      { key: 'reports/sess01/events.json', uploaded: new Date(now), body: '[]' },
    ]);
    const res = await worker.fetch(new Request('https://w.example/'), env as Env);
    const html = await res.text();
    expect(html).toContain('/r/sess01');
    expect(html).toContain('data-mode="session"');
    expect(html).toContain('세션');
  });
});
