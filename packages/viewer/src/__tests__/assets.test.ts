import { describe, expect, it } from 'vitest';
import { ASSET_NAMES } from '../report/load-report';

describe('asset contract (drift guard)', () => {
  it('covers exactly the captured data slots the SDK uploads (replay excluded)', () => {
    expect([...ASSET_NAMES].sort()).toEqual([
      'console',
      'design',
      'events',
      'meta',
      'network',
      'resources',
      'state',
      'storage',
      'system',
      'vitals',
    ]);
  });
});
