import { SCHEMA_VERSION } from '@bugzar/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadReport } from '../report/load-report';

const META = {
  url: 'https://app/x',
  userAgent: 'ua',
  viewport: { width: 1, height: 1 },
  startedAt: 0,
  endedAt: 10,
  durationMs: 10,
  schemaVersion: SCHEMA_VERSION,
};
const ASSETS: Record<string, unknown> = {
  meta: META,
  events: [{ type: 2, timestamp: 1, data: {} }],
  console: [{ level: 'error', tFromStart: 1, args: ['x'] }],
  network: [],
  storage: [],
  resources: [],
  state: [],
  vitals: { lcp: 100 },
  design: [],
};

const assetName = (url: string): string => {
  const parts = url.split('/');
  return (parts[parts.length - 1] ?? '').replace('.json', '');
};
const jsonRes = (o: unknown, status = 200): Response => new Response(JSON.stringify(o), { status });

afterEach(() => vi.restoreAllMocks());

describe('loadReport', () => {
  it('loads every asset and reports version ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => jsonRes(ASSETS[assetName(String(url))] ?? {})),
    );
    const r = await loadReport({ endpoint: 'https://w.dev', id: 'abc' });
    expect(r.failed).toEqual([]);
    expect(r.version).toBe('ok');
    expect(r.data.console).toHaveLength(1);
    expect(r.data.events).toHaveLength(1);
    expect(r.data.vitals.lcp).toBe(100);
  });

  it('tolerates a single failed asset (404 → empty slot, listed in failed)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const name = assetName(String(url));
        return name === 'network' ? jsonRes('nf', 404) : jsonRes(ASSETS[name] ?? {});
      }),
    );
    const r = await loadReport({ endpoint: 'https://w.dev', id: 'abc' });
    expect(r.failed).toContain('network');
    expect(r.data.network).toEqual([]);
    expect(r.data.console).toHaveLength(1);
  });

  it('surfaces a newer-schema report as a version mismatch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const name = assetName(String(url));
        return jsonRes(
          name === 'meta' ? { ...META, schemaVersion: SCHEMA_VERSION + 1 } : (ASSETS[name] ?? {}),
        );
      }),
    );
    const r = await loadReport({ endpoint: 'https://w.dev', id: 'abc' });
    expect(r.version).toBe('newer');
  });
});
