/**
 * M4 DX — `useBugzar()` headless engine (④).
 *
 * Lets a host drive recording from its own button (no FAB). Contract: `start()`
 * begins recording, `stop()` ends it, surfaced via `recording`. SHELL today
 * (start/stop are no-ops), so this is RED until the implement-last pass.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const bundle = {
  events: [],
  console: [],
  network: [],
  storage: [],
  vitals: {},
  resources: [],
  state: [],
  meta: {
    url: '',
    userAgent: '',
    viewport: { width: 0, height: 0 },
    startedAt: 0,
    endedAt: 0,
    durationMs: 0,
  },
};

vi.mock('@bugzar/capture-core', () => {
  let active = false;
  return {
    createRecorder: () => ({
      start: () => {
        active = true;
      },
      stop: () => {
        active = false;
        return bundle;
      },
      isActive: () => active,
    }),
  };
});

vi.mock('@bugzar/sdk/export', () => ({
  exportReportHtml: vi.fn(async () => new Blob(['<!doctype html>'], { type: 'text/html' })),
  exportDesignHtml: vi.fn(async () => new Blob(['<!doctype html>'], { type: 'text/html' })),
}));

import { useBugzar } from '../use-bugzar';

function Harness() {
  const { recording, start, stop } = useBugzar();
  return (
    <div>
      <span data-testid="rec">{String(recording)}</span>
      <button type="button" onClick={start}>
        start
      </button>
      <button type="button" onClick={stop}>
        stop
      </button>
    </div>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useBugzar (④ headless engine)', () => {
  it('start() begins recording and stop() ends it — drives the engine with no FAB', () => {
    render(<Harness />);
    expect(screen.getByTestId('rec').textContent).toBe('false');
    fireEvent.click(screen.getByText('start'));
    expect(screen.getByTestId('rec').textContent).toBe('true');
    fireEvent.click(screen.getByText('stop'));
    expect(screen.getByTestId('rec').textContent).toBe('false');
  });

  it('calls onExport with the built HTML + session meta on stop', async () => {
    const onExport = vi.fn(async () => 'https://cdn/x.html');
    function H() {
      const { start, stop } = useBugzar({ onExport });
      return (
        <div>
          <button type="button" onClick={start}>
            start
          </button>
          <button type="button" onClick={stop}>
            stop
          </button>
        </div>
      );
    }
    render(<H />);
    fireEvent.click(screen.getByText('start'));
    fireEvent.click(screen.getByText('stop'));
    await waitFor(() => expect(onExport).toHaveBeenCalledTimes(1));
    expect(onExport).toHaveBeenCalledWith(
      expect.any(Blob),
      expect.objectContaining({ mode: 'session' }),
    );
  });
});
