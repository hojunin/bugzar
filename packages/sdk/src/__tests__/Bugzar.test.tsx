import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Drive the component without real rrweb capture — the capture engine is
// covered by @bugzar/capture-core's own suite. Here we pin the SDK wiring:
// FAB → start → REC pill → stop → callbacks fire with the bundle.
const bundle = {
  events: [{ type: 2 }],
  console: [{ level: 'log' as const, tFromStart: 0, args: ['hi'] }],
  network: [],
  storage: [],
  vitals: {},
  meta: {
    url: 'https://example.com',
    userAgent: 'test',
    viewport: { width: 800, height: 600 },
    startedAt: 1000,
    endedAt: 2000,
    durationMs: 1000,
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

// Stop now builds + delivers a self-contained HTML even with no sink (#22), so the
// lazy export module and the download floor must be stubbed so it stays fast/deterministic.
vi.mock('@bugzar/sdk/export', () => ({
  exportReportHtml: vi.fn(async () => new Blob(['<!doctype html>'], { type: 'text/html' })),
  exportDesignHtml: vi.fn(async () => new Blob(['<!doctype html>'], { type: 'text/html' })),
}));
vi.mock('../download', () => ({ downloadReplay: vi.fn() }));

import { Bugzar } from '../Bugzar';
import { __resetRecorder } from '../Bugzar/useRecorder';
import { downloadReplay } from '../download';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  // The recording now survives unmount (it outlives client-side navigation), so
  // a test that leaves it running would leak into the next one — reset it.
  __resetRecorder();
  vi.mocked(downloadReplay).mockClear();
  vi.useRealTimers();
});

describe('Bugzar', () => {
  it('mounts the FAB into document.body via portal', () => {
    render(<Bugzar />);
    expect(screen.getByLabelText('Start recording')).toBeTruthy();
  });

  it('start shows the REC pill and fires onStart', () => {
    const onStart = vi.fn();
    render(<Bugzar onStart={onStart} />);

    fireEvent.click(screen.getByLabelText('Start recording'));

    expect(onStart).toHaveBeenCalledOnce();
    expect(screen.getByLabelText('Stop recording')).toBeTruthy();
  });

  it('stop with no sink downloads the capture instead of discarding it (#22)', async () => {
    render(<Bugzar />);

    fireEvent.click(screen.getByLabelText('Start recording'));
    fireEvent.click(screen.getByLabelText('Stop recording'));
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(vi.mocked(downloadReplay)).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.bugzar-chip')?.textContent ?? '').toMatch(/downloaded/i);
  });
});

describe('Bugzar autoHide', () => {
  const widget = () => document.querySelector('.bugzar-root');
  const revealed = () => widget()?.getAttribute('data-bugzar-revealed');
  // Geometric hover is decided from clientX/Y vs innerWidth/Height, so a raw
  // pointermove on window drives the component (no layout needed in happy-dom).
  const move = (clientX: number, clientY: number) =>
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX, clientY }));
    });
  const cornerX = () => window.innerWidth - 10;
  const cornerY = () => window.innerHeight - 5;
  const centerX = () => Math.floor(window.innerWidth / 2);
  const centerY = () => Math.floor(window.innerHeight / 2);

  it('off (default): toolbar has no data-bugzar-revealed, FAB renders as today', () => {
    render(<Bugzar />);
    expect(widget()).toBeTruthy();
    expect(widget()?.hasAttribute('data-bugzar-revealed')).toBe(false);
    expect(screen.getByLabelText('Start recording')).toBeTruthy();
  });

  it('on: mounts collapsed (revealed=false), toolbar inert + aria-hidden', () => {
    render(<Bugzar autoHide />);
    expect(revealed()).toBe('false');
    expect(widget()?.getAttribute('aria-hidden')).toBe('true');
    expect(widget()?.hasAttribute('inert')).toBe(true);
  });

  it('pointermove into the corner hotspot reveals it', () => {
    render(<Bugzar autoHide />);
    move(cornerX(), cornerY());
    expect(revealed()).toBe('true');
    // revealed → no longer hidden from a11y tree
    expect(widget()?.hasAttribute('inert')).toBe(false);
  });

  it('pointermove away from the corner collapses it again', () => {
    render(<Bugzar autoHide />);
    move(cornerX(), cornerY());
    expect(revealed()).toBe('true');
    move(centerX(), centerY());
    expect(revealed()).toBe('false');
  });

  it('stays pinned (revealed) while recording, even with the cursor away', () => {
    render(<Bugzar autoHide />);
    move(cornerX(), cornerY());
    fireEvent.click(screen.getByLabelText('Start recording'));
    move(0, 0); // cursor off the hotspot — in-use must keep it open
    expect(revealed()).toBe('true');
  });

  it('after a use ends (no result chip), holds the idle toolbar for 2s then collapses', async () => {
    // onExport returns void → host self-handled → no result chip, so inUse drops
    // and only the grace window can hold the toolbar open.
    render(<Bugzar autoHide onExport={async () => undefined} />);
    move(cornerX(), cornerY());
    fireEvent.click(screen.getByLabelText('Start recording'));
    move(0, 0); // away, so only in-use/grace can keep it open
    fireEvent.click(screen.getByLabelText('Stop recording'));
    // Settle the async delivery WITHOUT advancing the grace timer (microtasks only).
    await act(async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });
    expect(revealed()).toBe('true'); // 2s grace holds it
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(revealed()).toBe('false');
  });

  it('re-entering the hotspot during grace keeps it open past 2s', () => {
    render(<Bugzar autoHide />);
    move(cornerX(), cornerY());
    fireEvent.click(screen.getByLabelText('Start recording'));
    fireEvent.click(screen.getByLabelText('Stop recording'));
    // cursor is still in the corner → after grace expires hover keeps it open
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(revealed()).toBe('true');
  });

  it('hoverZone shrinks the reveal zone', () => {
    render(<Bugzar autoHide hoverZone={{ width: 6, height: 6 }} />);
    // Inside the default 300×30 corner but outside the custom 6×6 → stays hidden.
    move(window.innerWidth - 10, window.innerHeight - 5);
    expect(revealed()).toBe('false');
    // Inside the shrunk hotspot → reveals.
    move(window.innerWidth - 3, window.innerHeight - 3);
    expect(revealed()).toBe('true');
  });
});

describe('Bugzar offset', () => {
  const widget = () => document.querySelector('.bugzar-root') as HTMLElement | null;

  it('unset → no inline CSS vars (stylesheet 20px default stands)', () => {
    render(<Bugzar />);
    expect(widget()?.style.getPropertyValue('--bugzar-offset-x')).toBe('');
    expect(widget()?.style.getPropertyValue('--bugzar-offset-y')).toBe('');
  });

  it('a number sets both axes', () => {
    render(<Bugzar offset={40} />);
    expect(widget()?.style.getPropertyValue('--bugzar-offset-x')).toBe('40px');
    expect(widget()?.style.getPropertyValue('--bugzar-offset-y')).toBe('40px');
  });

  it('{ x, y } sets each axis independently; a missing axis falls back to 20', () => {
    render(<Bugzar offset={{ x: 8 }} />);
    expect(widget()?.style.getPropertyValue('--bugzar-offset-x')).toBe('8px');
    expect(widget()?.style.getPropertyValue('--bugzar-offset-y')).toBe('20px');
  });
});
