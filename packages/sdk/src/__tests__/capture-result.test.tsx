import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Issue #22: when there is no Jira sink (jiraOff), the capture result must never
// be silently discarded. Routing branches on the RESOLVED onExport value:
//   url string  → link chip (Open + Copy)
//   void/empty  → nothing (host self-handled, e.g. downloadReplay)
//   reject      → download floor + onError + "downloaded" chip
//   no onExport → download floor + "downloaded" chip
//   build throw → onError, no floor, no chip
// jiraOn (endpoint+creds) keeps opening the review drawer (unchanged).
//
// RED until the #22 delivery rewrite lands in Bugzar/index.tsx + the result chip
// in Toolbar; then GREEN. happy-dom: assert via dispatched events + DOM contract.

const bundle = {
  events: [{ type: 2 }],
  console: [],
  network: [],
  storage: [],
  resources: [],
  state: [],
  vitals: {},
  system: null,
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
    captureSnapshot: () => [],
    collectSystemInfo: () => null,
  };
});

// Lazy-imported offline HTML builder — stub so no real viewer loads. Hoisted so a
// test can force a build rejection (the build-throw row).
const { exportReportHtml, exportDesignHtml } = vi.hoisted(() => ({
  exportReportHtml: vi.fn(async () => new Blob(['<!doctype html>'], { type: 'text/html' })),
  exportDesignHtml: vi.fn(async () => new Blob(['<!doctype html>'], { type: 'text/html' })),
}));
vi.mock('@bugzar/sdk/export', () => ({ exportReportHtml, exportDesignHtml }));

// Spy the internal download floor (#22 adds `import { downloadReplay } from '../download'`).
const { downloadReplay } = vi.hoisted(() => ({ downloadReplay: vi.fn() }));
vi.mock('../download', () => ({ downloadReplay }));

// Stub the review drawer so the jiraOn path is observable without auth/network.
vi.mock('../ReviewDrawer', () => ({
  ReviewDrawer: (p: { mode: string; url?: string }) => (
    <div className="bugzar-drawer" data-mode={p.mode} data-url={p.url ?? ''} />
  ),
}));

// Picker mock: capture onComplete so a design pick can be finished deterministically.
const { pickerRef } = vi.hoisted(() => ({
  pickerRef: {} as { onComplete?: (a: unknown[]) => void; onCancel?: () => void },
}));
vi.mock('../picker/picker', () => ({
  startDesignPick: (opts: { onComplete: (a: unknown[]) => void; onCancel: () => void }) => {
    pickerRef.onComplete = opts.onComplete;
    pickerRef.onCancel = opts.onCancel;
    return { stop: () => {}, isActive: () => false };
  },
}));

import { Bugzar } from '../Bugzar';
import { __resetRecorder } from '../Bugzar/useRecorder';

const chip = () => document.querySelector('.bugzar-chip');
const DESIGN_FAB = 'Leave design feedback on elements';
const ANN = [
  {
    id: 'a1',
    selector: '.x',
    tagName: 'DIV',
    textContent: '',
    cssClasses: [],
    rect: {},
    note: 'n',
  },
];

const recordThenStop = () => {
  fireEvent.click(screen.getByLabelText(/start recording/i));
  fireEvent.click(screen.getByLabelText(/stop recording/i));
};

afterEach(() => {
  cleanup();
  __resetRecorder();
  downloadReplay.mockClear();
  exportReportHtml.mockClear();
  exportDesignHtml.mockClear();
  document.querySelector('.bugzar-pick-root')?.remove();
});

describe('issue #22 — capture result is never discarded (jira off)', () => {
  it('onExport returns a URL → link chip with Open + Copy, no drawer, no download', async () => {
    const onExport = vi.fn(async () => 'https://cdn.example.com/r/1.html');
    render(<Bugzar onExport={onExport} />);
    recordThenStop();

    await waitFor(() => expect(chip()).toBeTruthy());
    const link = chip()?.querySelector('.bugzar-uploaded-link') as HTMLAnchorElement | null;
    expect(link?.getAttribute('href')).toBe('https://cdn.example.com/r/1.html');
    expect(chip()?.querySelector('.bugzar-chip-copy')).toBeTruthy();
    expect(downloadReplay).not.toHaveBeenCalled();
    expect(document.querySelector('.bugzar-drawer')).toBeFalsy();
  });

  it('onExport returns void → nothing shown, nothing downloaded (host self-handled)', async () => {
    const onExport = vi.fn(async () => undefined);
    render(<Bugzar onExport={onExport} />);
    recordThenStop();

    // Wait until delivery settles (idle Record button returns).
    await waitFor(() => expect(screen.queryByLabelText(/start recording/i)).toBeTruthy());
    expect(chip()).toBeFalsy();
    expect(downloadReplay).not.toHaveBeenCalled();
  });

  it('no onExport → downloads the HTML (floor) and shows a "downloaded" chip', async () => {
    render(<Bugzar />);
    recordThenStop();

    await waitFor(() => expect(downloadReplay).toHaveBeenCalledTimes(1));
    const [blob, meta] = downloadReplay.mock.calls[0] as [Blob, { mode: string }];
    expect(blob).toBeInstanceOf(Blob);
    expect(meta.mode).toBe('session');
    await waitFor(() => expect(chip()?.textContent ?? '').toMatch(/downloaded/i));
    expect(chip()?.querySelector('.bugzar-uploaded-link')).toBeFalsy(); // no Open on download chip
  });

  it('onExport rejects → downloads floor + fires onError + downloaded chip', async () => {
    const onError = vi.fn();
    const onExport = vi.fn(async () => {
      throw new Error('upload failed');
    });
    render(<Bugzar onExport={onExport} onError={onError} />);
    recordThenStop();

    await waitFor(() => expect(downloadReplay).toHaveBeenCalledTimes(1));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    await waitFor(() => expect(chip()?.textContent ?? '').toMatch(/downloaded/i));
  });

  it('build throws → fires onError, no download floor, no chip', async () => {
    const onError = vi.fn();
    exportReportHtml.mockRejectedValueOnce(new Error('build boom'));
    render(<Bugzar onExport={vi.fn(async () => 'https://x/1.html')} onError={onError} />);
    recordThenStop();

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(downloadReplay).not.toHaveBeenCalled();
    expect(chip()).toBeFalsy();
  });

  it('jira on → opens the review drawer (unchanged), no chip', async () => {
    const onExport = vi.fn(async () => 'https://cdn.example.com/r/1.html');
    render(
      <Bugzar onExport={onExport} endpoint="https://w.example.dev" jira={{ enabled: true }} />,
    );
    recordThenStop();

    await waitFor(() => expect(document.querySelector('.bugzar-drawer')).toBeTruthy());
    expect(chip()).toBeFalsy();
    expect(downloadReplay).not.toHaveBeenCalled();
  });

  it('autoHide: a result chip keeps the toolbar from collapsing (inUse includes result)', async () => {
    render(<Bugzar autoHide onExport={vi.fn(async () => 'https://x/1.html')} />);
    recordThenStop();
    await waitFor(() => expect(chip()).toBeTruthy());
    const root = document.querySelector('.bugzar-root') as HTMLElement;
    expect(root.hasAttribute('inert')).toBe(false);
    expect(root.getAttribute('aria-hidden')).not.toBe('true');
  });

  it('copy button writes the URL to the clipboard and swaps to a "copied" state', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const url = 'https://cdn.example.com/r/1.html';
    render(<Bugzar onExport={vi.fn(async () => url)} />);
    recordThenStop();

    await waitFor(() => expect(chip()?.querySelector('.bugzar-chip-copy')).toBeTruthy());
    fireEvent.click(chip()?.querySelector('.bugzar-chip-copy') as HTMLElement);
    expect(writeText).toHaveBeenCalledWith(url);
    await waitFor(() => expect(chip()?.textContent ?? '').toMatch(/copied/i));
  });

  it('dismiss (×) removes the chip and restores the idle Record/Design buttons', async () => {
    render(<Bugzar onExport={vi.fn(async () => 'https://x/1.html')} />);
    recordThenStop();
    await waitFor(() => expect(chip()).toBeTruthy());

    fireEvent.click(chip()?.querySelector('.bugzar-chip-dismiss') as HTMLElement);
    expect(chip()).toBeFalsy();
    expect(screen.getByLabelText(/start recording/i)).toBeTruthy();
  });

  it('chip controls avoid .bugzar-fab/.bugzar-pill so the #21 guard never blocks them', async () => {
    render(<Bugzar onExport={vi.fn(async () => 'https://x/1.html')} />);
    recordThenStop();
    await waitFor(() => expect(chip()).toBeTruthy());

    for (const c of chip()?.querySelectorAll('a, button') ?? []) {
      expect(c.closest('.bugzar-fab, .bugzar-pill')).toBeNull();
      const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      c.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false); // #21 guard only acts on fab/pill targets
    }
  });

  it('design pick + onExport URL → chip reads as a design report (viewReport)', async () => {
    const onExport = vi.fn(async () => 'https://x/design.html');
    render(<Bugzar onExport={onExport} design />);
    fireEvent.click(screen.getByLabelText(DESIGN_FAB));
    pickerRef.onComplete?.(ANN);

    await waitFor(() => expect(chip()).toBeTruthy());
    expect(chip()?.querySelector('.bugzar-uploaded-link')?.textContent ?? '').toMatch(/report/i);
  });
});
