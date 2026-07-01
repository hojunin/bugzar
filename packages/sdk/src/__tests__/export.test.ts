/**
 * Phase D — the self-contained offline HTML export.
 *
 * Verifies the round-trip the exported file's bootstrap performs at file://:
 * the embedded (gzip + base64) report decodes back to the original bundle, and
 * the HTML carries the inert-by-default security shell (meta-CSP) + the inlined
 * viewer mount hook. The actual browser render is the manual D7 gate.
 */

import { describe, expect, it } from 'vitest';
import { exportDesignHtml, exportReportHtml } from '../export';
import type { DesignAnnotation, ReportBundle } from '../public-types';

const bundle: ReportBundle = {
  events: [{ type: 2, timestamp: 1, data: { node: {} } }] as ReportBundle['events'],
  console: [{ level: 'log', tFromStart: 0, args: ['hi'] }],
  network: [],
  storage: [],
  vitals: {},
  resources: [],
  state: [],
  system: { collectedAt: 1 } as ReportBundle['system'],
  meta: {
    url: 'https://app.example.com/x?y=1',
    userAgent: 'test',
    viewport: { width: 800, height: 600 },
    startedAt: 1717000000000,
    endedAt: 1717000005000,
    durationMs: 5000,
  },
};

const recoverEmbedded = async (html: string): Promise<unknown> => {
  const m = html.match(/id="bugzar-data" data-encoding="(\w+)">([^<]*)</);
  if (!m) throw new Error('no embedded data block');
  const [, encoding, b64] = m;
  const bytes = Uint8Array.from(atob(b64 ?? ''), (c) => c.charCodeAt(0));
  let json: string;
  if (encoding === 'gzip') {
    const ds = new DecompressionStream('gzip');
    const w = ds.writable.getWriter();
    void w.write(bytes);
    void w.close();
    json = new TextDecoder().decode(await new Response(ds.readable).arrayBuffer());
  } else {
    json = new TextDecoder().decode(bytes);
  }
  return JSON.parse(json);
};

describe('exportReportHtml', () => {
  it('returns a text/html Blob with the inert security shell', async () => {
    const blob = await exportReportHtml(bundle);
    expect(blob.type).toContain('text/html');
    const html = await blob.text();
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('id="bugzar-data"');
    expect(html).toContain('__BUGZAR_MOUNT__'); // bootstrap hands data to the inlined viewer
    expect(html).toContain('<div id="root">');
  });

  it('lets captured webfonts/images load over https (mirrors REPLAY_CSP)', async () => {
    // Captured pages reference self-hosted/CDN fonts (Pretendard) via @font-face
    // url(...); a data:-only font-src blocks every fetch and text falls back to a
    // system font. img-src must allow https for the same reason (CDN images).
    const html = await (await exportReportHtml(bundle)).text();
    expect(html).toMatch(/font-src[^;"]*\bhttps:/);
    expect(html).toMatch(/img-src[^;"]*\bhttps:/);
    // ...but the active threat model stays put: no remote scripts, no exfil channel.
    expect(html).toContain("script-src 'unsafe-inline'");
    expect(html).toContain('connect-src blob: data:');
  });

  it('embeds the report so the bootstrap recovers it byte-for-byte', async () => {
    const html = await (await exportReportHtml(bundle)).text();
    const data = (await recoverEmbedded(html)) as {
      events: unknown;
      meta: { url: string; schemaVersion?: number };
      design: unknown[];
    };
    expect(data.events).toEqual(bundle.events);
    expect(data.meta.url).toBe(bundle.meta.url);
    expect(typeof data.meta.schemaVersion).toBe('number'); // stamped like upload
    expect(data.design).toEqual([]);
  });

  it('compresses (gzip) when CompressionStream is available', async () => {
    const html = await (await exportReportHtml(bundle)).text();
    expect(html).toMatch(/data-encoding="gzip"/);
  });
});

describe('exportDesignHtml', () => {
  const annotations: DesignAnnotation[] = [
    {
      id: '1',
      selector: '.buy',
      tagName: 'BUTTON',
      textContent: 'Buy',
      cssClasses: 'btn primary',
      rect: { x: 0, y: 0, width: 80, height: 32 },
      note: 'wrong color',
    },
  ];

  it('produces a design-mode report with annotations recoverable', async () => {
    const html = await (await exportDesignHtml(annotations, bundle.events)).text();
    const data = (await recoverEmbedded(html)) as {
      meta: { mode?: string };
      design: Array<{ selector: string; userNote: string }>;
      events: unknown;
    };
    expect(data.meta.mode).toBe('design'); // viewer renders DesignView
    expect(data.design[0]?.selector).toBe('.buy');
    expect(data.design[0]?.userNote).toBe('wrong color'); // note → userNote remap
    expect(data.events).toEqual(bundle.events); // page snapshot carried through
  });
});
