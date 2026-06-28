import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetRecorder } from '../Bugzar/useRecorder';

// Regression: a client-side route change that unmounts the subtree <Bugzar/>
// lives in must NOT tear down an in-progress recording. The recorder is mocked
// (the real capture engine has its own suite); `stop` is a spy so we can assert
// the recording is NOT stopped on unmount, only on an explicit Stop click.
const bundle = {
  events: [{ type: 2 }],
  console: [],
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

const stopSpy = vi.fn();

vi.mock('@bugzar/capture-core', () => {
  let active = false;
  return {
    createRecorder: () => ({
      start: () => {
        active = true;
      },
      stop: () => {
        active = false;
        stopSpy();
        return bundle;
      },
      isActive: () => active,
    }),
  };
});

import { Bugzar } from '../Bugzar';

// <Bugzar/> nested under a routed page: changing `route` flips the key so React
// fully unmounts the old page and mounts a new one — exactly what React Router
// does to a <Route> element's subtree on link navigation.
function RoutedApp({ route }: { route: string }) {
  return (
    <div key={route} data-route={route}>
      <Bugzar />
    </div>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  stopSpy.mockClear();
});

afterEach(() => {
  cleanup();
  __resetRecorder();
  vi.useRealTimers();
});

describe('recording survives client-side navigation', () => {
  it('keeps recording across an unmount→remount and does not stop on unmount', () => {
    const { rerender } = render(<RoutedApp route="/a" />);

    fireEvent.click(screen.getByLabelText('Start recording'));
    expect(screen.getByLabelText('Stop recording')).toBeTruthy();

    // Navigate: the page holding <Bugzar/> unmounts, a fresh one mounts.
    rerender(<RoutedApp route="/b" />);

    // The recording must still be live on the remounted toolbar...
    expect(screen.getByLabelText('Stop recording')).toBeTruthy();
    // ...and the recorder must NOT have been stopped by the unmount.
    expect(stopSpy).not.toHaveBeenCalled();

    // An explicit Stop still works and is the only thing that stops it.
    fireEvent.click(screen.getByLabelText('Stop recording'));
    expect(stopSpy).toHaveBeenCalledOnce();
    expect(screen.getByLabelText('Start recording')).toBeTruthy();
  });

  it('resumes the elapsed timer after the remount (no reset to 0:00)', () => {
    const { rerender } = render(<RoutedApp route="/a" />);
    fireEvent.click(screen.getByLabelText('Start recording'));

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByText('0:03')).toBeTruthy();

    rerender(<RoutedApp route="/b" />);

    // Still recording after the remount, and elapsed is derived from the
    // persisted start time so it carries over instead of resetting to 0:00.
    expect(screen.getByLabelText('Stop recording')).toBeTruthy();
    expect(screen.getByText('0:03')).toBeTruthy();
  });
});
