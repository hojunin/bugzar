import type { ConsoleEntry, NetworkEntryPayload } from '@bugzar/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConsolePanel } from '../panels/ConsolePanel';
import { NetworkPanel } from '../panels/NetworkPanel';

afterEach(cleanup);

const c = (over: Partial<ConsoleEntry>): ConsoleEntry => ({
  level: 'log',
  tFromStart: 0,
  args: [],
  ...over,
});

const net = (url: string): NetworkEntryPayload => ({
  tFromStart: 0,
  method: 'POST',
  url,
  status: 200,
  durationMs: 1,
  requestHeaders: {},
  requestBody: null,
  responseHeaders: {},
  responseBody: null,
  error: null,
  initiator: 'fetch',
});

describe('ConsolePanel console.group tree', () => {
  it('nests entries under a group and toggles collapse', () => {
    const entries: ConsoleEntry[] = [
      c({ level: 'group', args: ['API call'] }),
      c({ args: ['inside group'] }),
      c({ level: 'groupEnd' }),
    ];
    render(<ConsolePanel entries={entries} query="" currentTime={0} onSeek={vi.fn()} />);
    expect(screen.getByText('API call')).toBeTruthy();
    expect(screen.getByText('inside group')).toBeTruthy();
    fireEvent.click(screen.getByText('API call'));
    expect(screen.queryByText('inside group')).toBeNull();
  });

  it('groupCollapsed starts collapsed', () => {
    const entries: ConsoleEntry[] = [
      c({ level: 'groupCollapsed', args: ['collapsed grp'] }),
      c({ args: ['hidden child'] }),
      c({ level: 'groupEnd' }),
    ];
    render(<ConsolePanel entries={entries} query="" currentTime={0} onSeek={vi.fn()} />);
    expect(screen.getByText('collapsed grp')).toBeTruthy();
    expect(screen.queryByText('hidden child')).toBeNull();
  });
});

describe('ConsolePanel expand + JSON tree', () => {
  it('expands a JSON log into a foldable JSON tree (keys as nodes)', () => {
    const entries: ConsoleEntry[] = [c({ args: ['response ::', '{"a":1,"b":2}'] })];
    render(<ConsolePanel entries={entries} query="" currentTime={0} onSeek={vi.fn()} />);
    expect(screen.queryByText('a:')).toBeNull(); // collapsed — no tree yet
    fireEvent.click(screen.getByText(/response ::/));
    expect(screen.getByText('a:')).toBeTruthy(); // JSON tree key node
    expect(screen.getByText('1')).toBeTruthy(); // its value
  });
});

describe('third-party filter (hidden by default)', () => {
  it('hides datadog console logs unless includeThirdParty', () => {
    const entries: ConsoleEntry[] = [c({ args: ['[Datadog] rum init'] }), c({ args: ['app log'] })];
    const { rerender } = render(
      <ConsolePanel entries={entries} query="" currentTime={0} onSeek={vi.fn()} />,
    );
    expect(screen.getByText(/app log/)).toBeTruthy();
    expect(screen.queryByText(/Datadog/)).toBeNull();
    rerender(
      <ConsolePanel
        entries={entries}
        query=""
        currentTime={0}
        onSeek={vi.fn()}
        includeThirdParty
      />,
    );
    expect(screen.getByText(/Datadog/)).toBeTruthy();
  });

  it('hides third-party network requests unless includeThirdParty', () => {
    const entries = [net('https://browser-intake-datadoghq.com/api/v2/rum'), net('/api/app')];
    const { rerender } = render(
      <NetworkPanel entries={entries} query="" currentTime={0} onSeek={vi.fn()} />,
    );
    expect(screen.getByText('/api/app')).toBeTruthy();
    expect(screen.queryByText(/datadoghq/)).toBeNull();
    rerender(
      <NetworkPanel
        entries={entries}
        query=""
        currentTime={0}
        onSeek={vi.fn()}
        includeThirdParty
      />,
    );
    expect(screen.getByText(/datadoghq/)).toBeTruthy();
  });
});
