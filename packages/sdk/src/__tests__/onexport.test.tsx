import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
    captureSnapshot: () => [{ type: 2 }],
  };
});

// The offline HTML builder is lazy-imported; stub it so no real viewer loads.
const htmlBlob = new Blob(['<!doctype html>'], { type: 'text/html' });
vi.mock('@bugzar/sdk/export', () => ({
  exportReportHtml: vi.fn(async () => htmlBlob),
  exportDesignHtml: vi.fn(async () => htmlBlob),
}));

// Picker mock: capture onComplete so a pick can be "finished" deterministically.
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

afterEach(cleanup);

describe('onExport — session', () => {
  it('builds the HTML and calls onExport with mode "session" on stop', async () => {
    const onExport = vi.fn(async () => 'https://cdn.example.com/r/1.html');
    render(<Bugzar onExport={onExport} />);

    fireEvent.click(screen.getByLabelText(/start recording/i));
    fireEvent.click(screen.getByLabelText(/stop recording/i));

    await waitFor(() => expect(onExport).toHaveBeenCalledTimes(1));
    const [blob, meta] = onExport.mock.calls[0] as unknown as [Blob, { mode: string; url: string }];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('text/html');
    expect(meta.mode).toBe('session');
    expect(meta.url).toBe('https://example.com');
  });
});

describe('onExport — design', () => {
  it('calls onExport with mode "design" when a pick finishes', async () => {
    const onExport = vi.fn(async () => undefined);
    render(<Bugzar onExport={onExport} design />);

    fireEvent.click(screen.getByLabelText('Leave design feedback on elements'));
    pickerRef.onComplete?.([
      {
        id: 'a1',
        selector: '.x',
        tagName: 'DIV',
        textContent: '',
        cssClasses: [],
        rect: {},
        note: 'n',
      },
    ]);

    await waitFor(() => expect(onExport).toHaveBeenCalledTimes(1));
    expect(onExport).toHaveBeenCalledWith(
      expect.any(Blob),
      expect.objectContaining({ mode: 'design' }),
    );
  });
});

describe('onExport — errors', () => {
  it('calls onError when onExport rejects', async () => {
    const onError = vi.fn();
    const onExport = vi.fn(async () => {
      throw new Error('upload failed');
    });
    render(<Bugzar onExport={onExport} onError={onError} />);

    fireEvent.click(screen.getByLabelText(/start recording/i));
    fireEvent.click(screen.getByLabelText(/stop recording/i));

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });
});
