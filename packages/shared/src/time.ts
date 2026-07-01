import { v7 as uuidv7 } from 'uuid';

/**
 * Returns a UUID v7 — time-ordered, 122 bits of randomness.
 * Used for session IDs so listing by prefix sorts chronologically
 * and so URLs aren't guessable (replay viewer relies on this).
 */
export const newSessionId = (): string => uuidv7();

/**
 * Returns the millisecond offset of `timestamp` relative to `sessionStart`.
 * Both inputs are epoch ms. Throws if timestamp is before start — clock
 * skew or a malformed event we don't want to silently accept (would
 * break replay scrubbing).
 */
export const tFromStart = (timestamp: number, sessionStart: number): number => {
  if (timestamp < sessionStart) {
    throw new Error(`Event timestamp ${timestamp} is before session start ${sessionStart}`);
  }
  return timestamp - sessionStart;
};
