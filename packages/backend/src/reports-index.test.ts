/**
 * Tests for the GET / index handler — lists every report in the bucket.
 *
 * We stub the R2 binding minimally: `.list()` returns a fixed set of object
 * keys (with `uploaded` Dates), `.get()` returns the matching meta.json
 * body. Anything the worker pulls outside this surface should fail loudly.
 */

import { describe, expect, it } from 'vitest';
import worker, { type Env } from './worker';

interface StubR2Object {
  key: string;
  uploaded: Date;
  body?: string;
}

const makeStubR2 = (objects: StubR2Object[]): { ARTIFACTS: R2Bucket } => {
  const byKey = new Map(objects.map((o) => [o.key, o]));
  return {
    ARTIFACTS: {
      async list(opts?: R2ListOptions): Promise<R2Objects> {
        const prefix = opts?.prefix ?? '';
        const matched = objects.filter((o) => o.key.startsWith(prefix));
        return {
          objects: matched.map((o) => ({
            key: o.key,
            uploaded: o.uploaded,
            // The handler only reads .key + .uploaded — fill the rest with
            // shape-compatible placeholders.
            size: 0,
            etag: 'etag',
            httpEtag: 'etag',
            version: 'v1',
            // biome-ignore lint/suspicious/noExplicitAny: minimal R2Object stub
          })) as any,
          truncated: false,
          // biome-ignore lint/suspicious/noExplicitAny: typed as R2Objects
        } as any;
      },
      async get(key: string): Promise<R2ObjectBody | null> {
        const o = byKey.get(key);
        if (!o || o.body === undefined) return null;
        return {
          async text() {
            return o.body ?? '';
          },
          // biome-ignore lint/suspicious/noExplicitAny: minimal R2ObjectBody stub
        } as any;
      },
      // biome-ignore lint/suspicious/noExplicitAny: not used in the index path
    } as any,
  };
};

const fetchIndex = async (env: Partial<Env>): Promise<{ status: number; html: string }> => {
  const res = await worker.fetch(new Request('https://bugzar-backend.example/'), env as Env);
  return { status: res.status, html: await res.text() };
};

describe('GET / — reports index', () => {
  it('renders the empty-state message when no reports exist', async () => {
    const env = makeStubR2([]);
    const { status, html } = await fetchIndex(env);
    expect(status).toBe(200);
    expect(html).toContain('아직 발행된 QA report 가 없습니다');
  });

  it('lists video + design reports with their meta info and link to /r/<id>', async () => {
    const now = Date.now();
    const env = makeStubR2([
      {
        key: 'reports/aaa111/meta.json',
        uploaded: new Date(now - 60_000),
        body: JSON.stringify({
          url: 'https://shop.example.com/checkout',
          startedAt: now - 120_000,
          durationMs: 45_000,
        }),
      },
      // The mere presence of design.json toggles the chip to 디자인.
      {
        key: 'reports/bbb222/meta.json',
        uploaded: new Date(now - 5_000),
        body: JSON.stringify({
          url: 'https://admin.dev.one.musinsa.com/catalog/list',
          startedAt: now - 30_000,
        }),
      },
      {
        key: 'reports/bbb222/design.json',
        uploaded: new Date(now - 5_000),
        body: '[]',
      },
    ]);
    const { status, html } = await fetchIndex(env);
    expect(status).toBe(200);
    // Both reports show.
    expect(html).toContain('/r/aaa111');
    expect(html).toContain('/r/bbb222');
    expect(html).toContain('shop.example.com');
    expect(html).toContain('admin.dev.one.musinsa.com');
    // Mode chips reflect asset presence.
    expect(html).toContain('chip-design');
    expect(html).toContain('chip-video');
    // Newest first — bbb222 (designed 5s ago) should appear before aaa111.
    const idxA = html.indexOf('/r/aaa111');
    const idxB = html.indexOf('/r/bbb222');
    expect(idxB).toBeGreaterThan(0);
    expect(idxA).toBeGreaterThan(idxB);
  });

  it('skips reports without a meta.json (partial / abandoned uploads)', async () => {
    const env = makeStubR2([
      {
        key: 'reports/ccc333/events.json',
        uploaded: new Date(),
        body: '[]',
      },
      // No meta.json — handler should drop the row instead of showing an
      // empty card with `(host 없음)`.
    ]);
    const { status, html } = await fetchIndex(env);
    expect(status).toBe(200);
    expect(html).not.toContain('/r/ccc333');
    expect(html).toContain('아직 발행된 QA report 가 없습니다');
  });

  it('escapes HTML in captured URLs (XSS hardening)', async () => {
    // Real-world threat: meta.json is uploaded via PUT, which we trust comes
    // from the extension. But if a malformed value bypasses URL parsing, the
    // hostOf/pathOf helpers fall back to the raw string — escaping must
    // still catch that path. Use a non-URL value to trigger the catch branch.
    const env = makeStubR2([
      {
        key: 'reports/xss111/meta.json',
        uploaded: new Date(),
        body: JSON.stringify({
          url: '<script>alert(1)</script>',
          startedAt: Date.now(),
        }),
      },
    ]);
    const { html } = await fetchIndex(env);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('GET /reports is an alias for the index (REST-style URL)', async () => {
    const env = makeStubR2([]);
    const res = await worker.fetch(
      new Request('https://bugzar-backend.example/reports'),
      env as Env,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Bugzar Reports');
  });

  it('renders author displayName + avatar img when meta.author is present', async () => {
    const env = makeStubR2([
      {
        key: 'reports/aaa111/meta.json',
        uploaded: new Date(),
        body: JSON.stringify({
          url: 'https://shop.example/checkout',
          startedAt: Date.now(),
          author: {
            accountId: 'acct-1',
            displayName: '홍길동',
            avatar: 'https://avatar.atlassian.com/acct-1.png',
          },
        }),
      },
    ]);
    const { html } = await fetchIndex(env);
    expect(html).toContain('홍길동');
    expect(html).toContain('https://avatar.atlassian.com/acct-1.png');
    // avatar 는 img 요소로 — 워커 응답의 img-src https: CSP 통과 전제.
    expect(html).toMatch(/<img class="avatar"[^>]*src="https:\/\/avatar.atlassian.com/);
  });

  it('falls back to initial chip when meta.author has no avatar', async () => {
    const env = makeStubR2([
      {
        key: 'reports/aaa111/meta.json',
        uploaded: new Date(),
        body: JSON.stringify({
          url: 'https://shop.example',
          startedAt: Date.now(),
          author: { accountId: 'acct-1', displayName: '홍길동' },
        }),
      },
    ]);
    const { html } = await fetchIndex(env);
    // <img> 가 아닌 텍스트 이니셜 span 이 들어가야 한다.
    expect(html).toContain('avatar-fallback');
    expect(html).not.toMatch(/<img class="avatar"/);
    // 한글 이니셜은 toUpperCase 가 noop 이라 글자 그대로 들어감.
    expect(html).toContain('>홍<');
  });

  it('renders an em dash placeholder when meta.author is absent (legacy reports)', async () => {
    const env = makeStubR2([
      {
        key: 'reports/aaa111/meta.json',
        uploaded: new Date(),
        body: JSON.stringify({
          url: 'https://shop.example',
          startedAt: Date.now(),
          // no author field — older meta.json from before this feature
        }),
      },
    ]);
    const { html } = await fetchIndex(env);
    expect(html).toContain('cell author empty');
    expect(html).toContain('—');
  });

  it('escapes author displayName + rejects javascript: avatar — prevents stored XSS via meta.json', async () => {
    const env = makeStubR2([
      {
        key: 'reports/xss222/meta.json',
        uploaded: new Date(),
        body: JSON.stringify({
          url: 'https://safe.example',
          startedAt: Date.now(),
          author: {
            accountId: 'acct-x',
            displayName: '<script>alert(1)</script>',
            avatar: 'javascript:alert(1)',
          },
        }),
      },
    ]);
    const { html } = await fetchIndex(env);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    // http(s) 가 아닌 src 는 renderer 가 거부 → <img> 자체가 등장하지 않고
    // 이니셜 fallback 으로 떨어진다. defense-in-depth (CSP img-src https: 외에
    // 코드 레벨에서 한 번 더 거름).
    expect(html).not.toMatch(/<img class="avatar"[^>]*src="javascript:/);
    expect(html).toContain('avatar-fallback');
  });

  it('drops author silently when meta.author has wrong shape (no displayName)', async () => {
    const env = makeStubR2([
      {
        key: 'reports/aaa111/meta.json',
        uploaded: new Date(),
        body: JSON.stringify({
          url: 'https://shop.example',
          startedAt: Date.now(),
          author: { accountId: 'acct-1' }, // missing displayName — should not crash
        }),
      },
    ]);
    const { html, status } = await fetchIndex(env);
    expect(status).toBe(200);
    expect(html).toContain('/r/aaa111');
    expect(html).toContain('cell author empty');
  });
});
