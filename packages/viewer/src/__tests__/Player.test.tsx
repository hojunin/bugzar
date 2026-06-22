import type { RrwebEvent } from '@bugzar/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// `vi.hoisted` is required: `vi.mock` is hoisted above imports, so the mock var
// it references must be hoisted too — otherwise importing the real `rrweb` at
// module-eval hits a TDZ (`Cannot access 'ReplayerMock' before initialization`).
// Assertions are unchanged; only the mock's declaration form is corrected.
const { ReplayerMock } = vi.hoisted(() => ({
  ReplayerMock: vi.fn().mockImplementation(() => ({
    play: vi.fn(),
    pause: vi.fn(),
    getCurrentTime: () => 0,
    getMetaData: () => ({ startTime: 0, endTime: 1000, totalTime: 1000 }),
    on: vi.fn(),
    setConfig: vi.fn(),
    destroy: vi.fn(),
  })),
}));
vi.mock('rrweb', () => ({ Replayer: ReplayerMock }));

import { Player } from '../player/Player';

// rrweb's Replayer requires ≥2 events; a real session has at least a Meta (type 4)
// + FullSnapshot (type 2). Fewer than 2 is unreplayable → empty state.
const TWO_EVENTS: RrwebEvent[] = [
  { type: 4, timestamp: 0, data: {} },
  { type: 2, timestamp: 1, data: {} },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Player', () => {
  it('shows an empty state when there are no events', () => {
    render(<Player events={[]} />);
    expect(screen.getByText(/no dom events/i)).toBeTruthy();
    expect(ReplayerMock).not.toHaveBeenCalled();
  });

  it('shows an empty state for a too-short (<2 events) recording, without constructing the Replayer', () => {
    render(<Player events={[{ type: 2, timestamp: 1, data: {} }]} />);
    expect(screen.getByText(/no dom events/i)).toBeTruthy();
    expect(ReplayerMock).not.toHaveBeenCalled();
  });

  it('constructs the rrweb Replayer for a replayable session (≥2 events)', () => {
    render(<Player events={TWO_EVENTS} />);
    expect(ReplayerMock).toHaveBeenCalled();
  });
});
