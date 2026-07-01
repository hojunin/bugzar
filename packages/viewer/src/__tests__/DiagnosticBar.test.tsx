import type { ConsoleEntry, NetworkEntryPayload } from '@bugzar/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiagnosticBar } from '../DiagnosticBar';
import type { ReportData } from '../report/types';

const data: ReportData = {
  meta: {
    url: 'https://app.example/checkout',
    userAgent: 'UA',
    viewport: { width: 1440, height: 900 },
    startedAt: 0,
    endedAt: 4000,
    durationMs: 4000,
  },
  events: [],
  console: [{ level: 'error', tFromStart: 1200, args: ['TypeError: x'] } as ConsoleEntry],
  network: [
    {
      tFromStart: 1100,
      method: 'POST',
      url: 'https://app.example/api/order',
      status: 500,
      durationMs: 90,
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

describe('DiagnosticBar', () => {
  it('headlines the captured URL (a definite fact, not a guessed error)', () => {
    render(<DiagnosticBar data={data} onJump={() => {}} />);
    const h = screen.getByRole('heading', { level: 2 });
    expect(h.textContent).toBe('https://app.example/checkout');
    expect(h.textContent).not.toContain('500'); // not the picked-error string
  });

  it('jumps to the failed request from the failed chip', () => {
    const onJump = vi.fn();
    render(<DiagnosticBar data={data} onJump={onJump} />);
    fireEvent.click(screen.getByRole('button', { name: /failed/i }));
    expect(onJump).toHaveBeenCalledWith('network', 1100);
  });

  it('jumps to the error from the errors chip', () => {
    const onJump = vi.fn();
    render(<DiagnosticBar data={data} onJump={onJump} />);
    fireEvent.click(screen.getByRole('button', { name: /^\d+ error/i }));
    expect(onJump).toHaveBeenCalledWith('console', 1200);
  });

  it('copies the AI context and announces it via role=status', () => {
    const writeText = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render(<DiagnosticBar data={data} onJump={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /copy report for ai/i }));
    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0]?.[0] as string;
    expect(copied).toContain('POST /api/order → 500');
    // feedback announced in a status region
    expect(screen.getByRole('status').textContent).toMatch(/copied/i);
  });

  it('shows the "what is included" tooltip on click (title attr would only show on hover)', () => {
    render(<DiagnosticBar data={data} onJump={() => {}} />);
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /what the copy includes/i }));
    expect(screen.getByRole('tooltip').textContent).toMatch(/Includes:/);
  });
});
