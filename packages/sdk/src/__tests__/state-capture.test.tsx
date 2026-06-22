/**
 * M6 — Bugzar forwards the app-state options to the recorder.
 *
 * The actual sampling/serialization is capture-core's job (and is shelled). Here
 * we pin only the SDK wiring: `captureState` / `redactState` reach
 * `createRecorder`, and are omitted when not provided. This is plumbing, so it is
 * GREEN.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createRecorderMock } = vi.hoisted(() => ({ createRecorderMock: vi.fn() }));
vi.mock('@bugzar/capture-core', () => ({ createRecorder: createRecorderMock }));

import { Bugzar } from '../Bugzar';

const recorder = { start: vi.fn(), stop: vi.fn(), isActive: () => false };

beforeEach(() => {
  vi.useFakeTimers();
  createRecorderMock.mockReset();
  createRecorderMock.mockReturnValue(recorder);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Bugzar — app-state capture wiring (M6)', () => {
  it('forwards captureState + redactState to createRecorder', () => {
    const captureState = () => ({ n: 1 });
    const redactState = (s: unknown) => s;
    render(<Bugzar captureState={captureState} redactState={redactState} />);
    fireEvent.click(screen.getByLabelText('Start recording'));
    expect(createRecorderMock).toHaveBeenCalledWith(
      expect.objectContaining({ captureState, redactState }),
    );
  });

  it('omits captureState when not provided (no empty app-state plumbing)', () => {
    render(<Bugzar />);
    fireEvent.click(screen.getByLabelText('Start recording'));
    const opts = (createRecorderMock.mock.calls[0]?.[0] ?? {}) as Record<string, unknown>;
    expect('captureState' in opts).toBe(false);
  });

  // v1: offline HTML is built only when `onExport` is set, so inlining is gated on it.
  it('does not inline assets with no output sink (bare Bugzar)', () => {
    render(<Bugzar />);
    fireEvent.click(screen.getByLabelText('Start recording'));
    expect(createRecorderMock).toHaveBeenCalledWith(
      expect.objectContaining({ inlineAssets: false }),
    );
  });

  it('does not inline assets when an endpoint is set (hosted replay reloads assets)', () => {
    render(<Bugzar endpoint="https://w.dev" />);
    fireEvent.click(screen.getByLabelText('Start recording'));
    expect(createRecorderMock).toHaveBeenCalledWith(
      expect.objectContaining({ inlineAssets: false }),
    );
  });

  it('inlines assets when onExport is set', () => {
    render(<Bugzar onExport={async () => undefined} />);
    fireEvent.click(screen.getByLabelText('Start recording'));
    expect(createRecorderMock).toHaveBeenCalledWith(
      expect.objectContaining({ inlineAssets: true }),
    );
  });
});
