import { NETWORK_ASSET_CAP_BYTES } from '@bugzar/shared';
import { describe, expect, it } from 'vitest';
import { assetCap } from './worker';

// #20: the `network` asset gets a surgical higher ceiling; every other JSON asset
// stays at the 10MB default. RED until worker.ts adds the `network` entry + exports
// `assetCap`.

describe('network asset cap', () => {
  it('caps the network asset at 25MB (surgical, from the shared limit)', () => {
    expect(assetCap('network')).toBe(NETWORK_ASSET_CAP_BYTES);
    expect(assetCap('network')).toBe(25 * 1024 * 1024);
  });

  it('leaves other JSON assets at the 10MB default', () => {
    expect(assetCap('events')).toBe(10 * 1024 * 1024);
    expect(assetCap('console')).toBe(10 * 1024 * 1024);
    expect(assetCap('storage')).toBe(10 * 1024 * 1024);
    expect(assetCap(undefined)).toBe(10 * 1024 * 1024);
  });

  it('keeps the dedicated video/screenshot caps untouched', () => {
    expect(assetCap('video')).toBe(100 * 1024 * 1024);
    expect(assetCap('screenshot')).toBe(5 * 1024 * 1024);
  });
});
