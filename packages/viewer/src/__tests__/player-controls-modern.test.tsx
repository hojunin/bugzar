import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ErrorMarker } from '../panels/markers';
import { Controls } from '../player/Controls';

// Contract tests for the modern player controls (goal target). These are RED
// until the speed control, clickable error ticks, and fullscreen toggle land.
// The new Controls props are OPTIONAL, so the existing Controls.test.tsx (which
// renders without them) must stay green.

afterEach(cleanup);

const markers: ErrorMarker[] = [
  { t: 200, kind: 'console' },
  { t: 600, kind: 'network' },
];

const base = {
  playing: false,
  currentTime: 0,
  totalTime: 1000,
  markers,
  events: [],
  viewport: { width: 1280, height: 720 },
  onPlayPause: vi.fn(),
  onSeek: vi.fn(),
};

describe('Controls — playback speed', () => {
  it('shows the current multiplier on the trigger', () => {
    render(<Controls {...base} speed={1} onSetSpeed={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: /playback speed/i });
    expect(trigger.textContent).toMatch(/1\s*[x×]/i);
  });

  it('reflects a non-default active speed', () => {
    render(<Controls {...base} speed={2} onSetSpeed={vi.fn()} />);
    expect(screen.getByRole('button', { name: /playback speed/i }).textContent).toMatch(
      /2\s*[x×]/i,
    );
  });

  it('selecting a speed option calls onSetSpeed with that multiplier', () => {
    const onSetSpeed = vi.fn();
    render(<Controls {...base} speed={1} onSetSpeed={onSetSpeed} />);
    fireEvent.click(screen.getByRole('button', { name: /playback speed/i }));
    fireEvent.click(screen.getByRole('button', { name: /2(\.0)?\s*[x×]\s*speed/i }));
    expect(onSetSpeed).toHaveBeenCalledWith(2);
  });
});

describe('Controls — clickable error ticks', () => {
  it('keeps one tick per error marker (data-testid preserved)', () => {
    render(<Controls {...base} />);
    expect(screen.getAllByTestId('bugzarv-marker')).toHaveLength(2);
  });

  it('clicking a tick seeks to exactly that marker time, once', () => {
    const onSeek = vi.fn();
    render(<Controls {...base} onSeek={onSeek} />);
    const ticks = screen.getAllByTestId('bugzarv-marker');
    fireEvent.click(ticks[0] as HTMLElement); // console @ 200ms
    expect(onSeek).toHaveBeenCalledTimes(1);
    expect(onSeek).toHaveBeenCalledWith(200);
  });

  it('each tick seeks to its own marker', () => {
    const onSeek = vi.fn();
    render(<Controls {...base} onSeek={onSeek} />);
    const ticks = screen.getAllByTestId('bugzarv-marker');
    fireEvent.click(ticks[1] as HTMLElement); // network @ 600ms
    expect(onSeek).toHaveBeenCalledWith(600);
  });

  it('ticks are focusable controls (role button)', () => {
    render(<Controls {...base} />);
    for (const tick of screen.getAllByTestId('bugzarv-marker')) {
      expect(tick.tagName === 'BUTTON' || tick.getAttribute('role') === 'button').toBe(true);
    }
  });
});

describe('Controls — fullscreen', () => {
  it('renders a fullscreen toggle that calls onToggleFullscreen', () => {
    const onToggleFullscreen = vi.fn();
    render(<Controls {...base} onToggleFullscreen={onToggleFullscreen} />);
    fireEvent.click(screen.getByRole('button', { name: /^fullscreen$/i }));
    expect(onToggleFullscreen).toHaveBeenCalledTimes(1);
  });

  it('shows an exit affordance when already fullscreen', () => {
    render(<Controls {...base} onToggleFullscreen={vi.fn()} isFullscreen />);
    expect(screen.getByRole('button', { name: /exit fullscreen/i })).toBeTruthy();
  });
});

describe('Controls — backward compatibility', () => {
  it('still renders and play/pause works without the new optional props', () => {
    const onPlayPause = vi.fn();
    render(<Controls {...base} onPlayPause={onPlayPause} />);
    fireEvent.click(screen.getByRole('button', { name: /play/i }));
    expect(onPlayPause).toHaveBeenCalled();
  });
});
