import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ErrorMarker } from '../panels/markers';
import { Controls } from '../player/Controls';
import { previewTimeAt, ScrubberPreview } from '../player/ScrubberPreview';

afterEach(cleanup);

const markers: ErrorMarker[] = [
  { t: 200, kind: 'console' },
  { t: 600, kind: 'network' },
];
const baseProps = {
  playing: false,
  currentTime: 0,
  totalTime: 1000,
  markers,
  events: [],
  viewport: { width: 1280, height: 720 },
  onPlayPause: vi.fn(),
  onSeek: vi.fn(),
};

describe('Controls', () => {
  it('the play/pause button fires onPlayPause', () => {
    const onPlayPause = vi.fn();
    render(<Controls {...baseProps} onPlayPause={onPlayPause} />);
    fireEvent.click(screen.getByRole('button', { name: /play/i }));
    expect(onPlayPause).toHaveBeenCalled();
  });

  it('renders one scrubber tick per error marker', () => {
    render(<Controls {...baseProps} />);
    expect(screen.getAllByTestId('bugzarv-marker')).toHaveLength(2);
  });

  // The prev/next-error skip buttons were removed (the scrubber keeps the error
  // ticks); navigation is now via the scrubber + hover preview.
});

describe('previewTimeAt', () => {
  it('maps an x-offset to a clamped timestamp', () => {
    expect(previewTimeAt(50, 100, 1000)).toBe(500);
    expect(previewTimeAt(0, 100, 1000)).toBe(0);
    expect(previewTimeAt(100, 100, 1000)).toBe(1000);
    expect(previewTimeAt(150, 100, 1000)).toBe(1000); // clamped past the end
  });

  it('is zero for a degenerate track/duration', () => {
    expect(previewTimeAt(50, 0, 1000)).toBe(0);
    expect(previewTimeAt(50, 100, 0)).toBe(0);
  });
});

describe('ScrubberPreview', () => {
  const props = {
    events: [],
    viewport: { width: 1280, height: 720 },
    t: 0,
    x: 0,
    trackWidth: 100,
  };

  // Regression: the rrweb stage must stay mounted even when hidden. If the
  // component unmounted it on !visible, the replayer would paint into a detached
  // node and every re-hover would show a blank frame.
  it('keeps the stage mounted (CSS-hidden) when not visible', () => {
    const { container } = render(<ScrubberPreview {...props} visible={false} />);
    const root = container.querySelector('.bugzarv-preview') as HTMLElement;
    expect(root).toBeTruthy();
    expect(root.style.display).toBe('none');
    expect(container.querySelector('.bugzarv-preview-stage')).toBeTruthy();
  });

  it('shows the timestamp caption when visible', () => {
    render(<ScrubberPreview {...props} visible={true} t={3000} />);
    expect(screen.getByText('0:03')).toBeTruthy();
  });
});
