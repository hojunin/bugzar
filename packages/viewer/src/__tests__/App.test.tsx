import { SCHEMA_VERSION } from '@bugzar/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// App renders <Player> for session reports; mock rrweb so these tests are
// deterministic and never touch the real Replayer (which throws for <2 events).
vi.mock('rrweb', () => ({
  Replayer: vi.fn().mockImplementation(() => ({
    play: vi.fn(),
    pause: vi.fn(),
    getCurrentTime: () => 0,
    getMetaData: () => ({ startTime: 0, endTime: 1000, totalTime: 1000 }),
    on: vi.fn(),
    setConfig: vi.fn(),
    destroy: vi.fn(),
  })),
}));

import { App } from '../App';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const assetName = (url: string): string => {
  const parts = url.split('/');
  return (parts[parts.length - 1] ?? '').replace('.json', '');
};
const metaFor = (schemaVersion: number) => ({
  url: 'https://app/x',
  userAgent: 'ua',
  viewport: { width: 1, height: 1 },
  startedAt: 0,
  endedAt: 10,
  durationMs: 10,
  schemaVersion,
});
// A replayable session needs ≥2 rrweb events (Meta + FullSnapshot).
const TWO_EVENTS = [
  { type: 4, timestamp: 0, data: {} },
  { type: 2, timestamp: 1, data: {} },
];
const json = (o: unknown, status = 200): Response => new Response(JSON.stringify(o), { status });

describe('App state machine', () => {
  it('shows NeedParams when endpoint/id are absent', () => {
    render(<App search="" />);
    expect(screen.getByText(/endpoint/i)).toBeTruthy();
  });

  it('renders the main view (Console tab) for a valid session report', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const name = assetName(String(url));
        const map: Record<string, unknown> = {
          meta: metaFor(SCHEMA_VERSION),
          events: TWO_EVENTS,
          console: [{ level: 'error', tFromStart: 1, args: ['boom'] }],
        };
        return json(map[name] ?? []);
      }),
    );
    render(<App search="?endpoint=https://w.dev&id=abc" />);
    expect(await screen.findByText('Console')).toBeTruthy();
  });

  it('still renders the sidebar when events.json is missing (degraded session)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const name = assetName(String(url));
        if (name === 'events') return json('not found', 404);
        const map: Record<string, unknown> = {
          meta: metaFor(SCHEMA_VERSION),
          console: [{ level: 'error', tFromStart: 1, args: ['boom'] }],
        };
        return json(map[name] ?? []);
      }),
    );
    render(<App search="?endpoint=https://w.dev&id=abc" />);
    expect(await screen.findByText('Console')).toBeTruthy();
  });

  it('shows a version-mismatch state for a newer report', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const name = assetName(String(url));
        return json(name === 'meta' ? metaFor(SCHEMA_VERSION + 1) : []);
      }),
    );
    render(<App search="?endpoint=https://w.dev&id=abc" />);
    expect(await screen.findByText(/version/i)).toBeTruthy();
  });

  it('renders the design view (annotation cards) for a design report', async () => {
    // A design report's meta carries mode:'design' + the stamped version + url
    // (uploadDesign stamps SCHEMA_VERSION too — see VM1).
    const designMeta = { ...metaFor(SCHEMA_VERSION), mode: 'design', source: 'sdk' };
    const element = {
      selector: '.btn-buy',
      tagName: 'BUTTON',
      textContent: 'Buy',
      cssClasses: 'btn-buy',
      rect: { x: 0, y: 0, width: 1, height: 1 },
      userNote: 'wrong color',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const name = assetName(String(url));
        if (name === 'meta') return json(designMeta);
        if (name === 'design') return json([element]);
        return json([]);
      }),
    );
    render(<App search="?endpoint=https://w.dev&id=des" />);
    expect(await screen.findByText(/wrong color/)).toBeTruthy();
  });
});
