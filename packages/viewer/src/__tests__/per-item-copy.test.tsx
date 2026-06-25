import type { ConsoleEntry, NetworkEntryPayload } from '@bugzar/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConsolePanel } from '../panels/ConsolePanel';
import { NetworkPanel } from '../panels/NetworkPanel';
import type { ReportData } from '../report/types';

const report: ReportData = {
  meta: {
    url: 'https://app.example',
    userAgent: 'UA',
    viewport: { width: 1440, height: 900 },
    startedAt: 0,
    endedAt: 3000,
    durationMs: 3000,
  },
  events: [],
  console: [
    {
      level: 'error',
      tFromStart: 1000,
      args: ['TypeError: boom'],
      stack: 'TypeError: boom\n  at f (a.js:1)',
    } as ConsoleEntry,
  ],
  network: [
    {
      tFromStart: 1100,
      method: 'POST',
      url: 'https://app.example/api/order',
      status: 500,
      durationMs: 80,
      requestHeaders: {},
      requestBody: null,
      responseHeaders: {},
      responseBody: '{"error":"OUT_OF_STOCK"}',
      error: null,
      initiator: 'fetch',
    } as NetworkEntryPayload,
  ],
  storage: [],
  resources: [],
  state: [],
  vitals: {},
  system: null,
  design: [],
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('per-item Copy for AI (B2)', () => {
  it('console error detail exposes a Copy-for-AI that copies the error + correlation', () => {
    const writeText = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render(
      <ConsolePanel
        entries={report.console}
        query=""
        currentTime={0}
        onSeek={() => {}}
        report={report}
      />,
    );
    // expand the error row
    fireEvent.click(screen.getByRole('button', { name: /TypeError: boom/ }));
    fireEvent.click(screen.getByRole('button', { name: /copy for ai/i }));
    const out = writeText.mock.calls[0]?.[0] as string;
    expect(out).toContain('# Console error');
    expect(out).toContain('TypeError: boom');
    expect(out).toContain('POST /api/order → 500'); // correlated failure
  });

  it('failed request detail exposes a Copy-for-AI; a 2xx request does not', () => {
    const writeText = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const twoxx: NetworkEntryPayload = {
      ...(report.network[0] as NetworkEntryPayload),
      status: 200,
      url: 'https://app.example/api/ok',
    };
    render(
      <NetworkPanel
        entries={[report.network[0] as NetworkEntryPayload, twoxx]}
        query=""
        currentTime={0}
        onSeek={() => {}}
        report={report}
      />,
    );
    const rows = screen.getAllByRole('button', { name: /api/ });
    fireEvent.click(rows[0] as HTMLElement); // expand the 500
    expect(screen.getByRole('button', { name: /copy for ai/i })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /copy for ai/i }));
    expect(writeText.mock.calls[0]?.[0] as string).toContain('# Failed request');

    // expand the 2xx — still only one Copy-for-AI button (the failed one)
    fireEvent.click(rows[1] as HTMLElement);
    expect(screen.getAllByRole('button', { name: /copy for ai/i })).toHaveLength(1);
  });
});
