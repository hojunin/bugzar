import type {
  ConsoleEntry,
  NetworkEntryPayload,
  ResourceTimingEntry,
  StateSnapshot,
  StorageSnapshotPayload,
} from '@bugzar/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConsolePanel } from '../panels/ConsolePanel';
import { NetworkPanel } from '../panels/NetworkPanel';
import { ResourcesPanel } from '../panels/ResourcesPanel';
import { StatePanel } from '../panels/StatePanel';
import { StoragePanel } from '../panels/StoragePanel';

afterEach(cleanup);

describe('ConsolePanel', () => {
  const entries: ConsoleEntry[] = [
    { level: 'error', tFromStart: 1, args: ['Boom failed'] },
    { level: 'log', tFromStart: 2, args: ['fine'] },
  ];
  it('renders rows and filters by query', () => {
    const { rerender } = render(
      <ConsolePanel entries={entries} query="" currentTime={0} onSeek={vi.fn()} />,
    );
    expect(screen.getByText(/Boom failed/)).toBeTruthy();
    expect(screen.getByText(/fine/)).toBeTruthy();
    rerender(<ConsolePanel entries={entries} query="boom" currentTime={0} onSeek={vi.fn()} />);
    expect(screen.queryByText(/fine/)).toBeNull();
  });

  it('clicking a row seeks the player to that entry (VM9)', () => {
    const onSeek = vi.fn();
    render(<ConsolePanel entries={entries} query="" currentTime={0} onSeek={onSeek} />);
    fireEvent.click(screen.getByText(/Boom failed/));
    expect(onSeek).toHaveBeenCalledWith(1);
  });
});

describe('NetworkPanel', () => {
  const entries: NetworkEntryPayload[] = [
    {
      tFromStart: 1,
      method: 'POST',
      url: '/api/pay',
      status: 500,
      durationMs: 10,
      requestHeaders: {},
      requestBody: null,
      responseHeaders: {},
      responseBody: null,
      error: null,
      initiator: 'fetch',
    },
  ];
  it('renders the request row with url + status', () => {
    render(<NetworkPanel entries={entries} query="" currentTime={0} onSeek={vi.fn()} />);
    expect(screen.getByText(/\/api\/pay/)).toBeTruthy();
    expect(screen.getByText(/500/)).toBeTruthy();
  });
});

describe('StoragePanel', () => {
  const snaps: StorageSnapshotPayload[] = [
    { tFromStart: 0, localStorage: { token: 'abc' }, sessionStorage: {}, cookies: '' },
  ];
  it('renders the active snapshot key/value', () => {
    render(<StoragePanel snapshots={snaps} currentTime={5} />);
    expect(screen.getByText(/token/)).toBeTruthy();
    expect(screen.getByText(/abc/)).toBeTruthy();
  });
});

describe('ResourcesPanel', () => {
  const entries: ResourceTimingEntry[] = [
    {
      name: 'https://cdn/app.js',
      initiatorType: 'script',
      startTime: 0,
      duration: 50,
      transferSize: 1234,
      encodedBodySize: 1000,
      decodedBodySize: 2000,
      nextHopProtocol: 'h2',
    },
  ];
  it('renders a resource row', () => {
    render(<ResourcesPanel entries={entries} />);
    expect(screen.getByText(/app\.js/)).toBeTruthy();
  });
});

describe('StatePanel', () => {
  const snaps: StateSnapshot[] = [{ tFromStart: 0, data: { queries: [{ key: 'user' }] } }];
  it('renders the snapshot data', () => {
    render(<StatePanel snapshots={snaps} currentTime={5} />);
    expect(screen.getByText(/user/)).toBeTruthy();
  });
});
