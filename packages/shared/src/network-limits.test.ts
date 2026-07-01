import { describe, expect, it } from 'vitest';
import {
  NETWORK_ASSET_CAP_BYTES,
  NETWORK_BODY_MAX_BYTES,
  NETWORK_TOTAL_BUDGET_BYTES,
} from './network-limits';

// Single source of truth for the network capture limits (#20), consumed by both
// capture-core (per-body + session total) and the backend Worker (asset cap).
// RED until network-limits.ts lands.

describe('network limits', () => {
  it('per-body 1MB, session total 20MB, backend asset cap 25MB (bytes)', () => {
    expect(NETWORK_BODY_MAX_BYTES).toBe(1_000_000);
    expect(NETWORK_TOTAL_BUDGET_BYTES).toBe(20 * 1024 * 1024);
    expect(NETWORK_ASSET_CAP_BYTES).toBe(25 * 1024 * 1024);
  });

  it('lockstep invariant: the client can never send more than the backend accepts', () => {
    // The session budget plus one final full body must still fit under the asset
    // cap, so the network asset upload can never 413 on a budget-respecting client.
    expect(NETWORK_TOTAL_BUDGET_BYTES + NETWORK_BODY_MAX_BYTES).toBeLessThanOrEqual(
      NETWORK_ASSET_CAP_BYTES,
    );
  });
});
