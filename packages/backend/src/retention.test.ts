/**
 * PR-18 — retention cleanup tests.
 *
 * The R2 stub tracks `uploaded` timestamps explicitly so we can drive the
 * orphan / expire thresholds without touching real time. Pagination is
 * exercised by splitting the same data across two stub pages.
 */

import { describe, expect, it } from 'vitest';
import { runRetentionCleanup } from './retention';
import type { Env } from './worker';

interface StubObject {
  key: string;
  uploaded: Date;
  size: number;
}

const makeBucket = (initial: StubObject[]) => {
  const store = [...initial];
  return {
    getStore: () => store,
    bucket: {
      async list(
        opts?: R2ListOptions,
      ): Promise<R2Objects & { truncated: boolean; cursor?: string }> {
        const prefix = opts?.prefix ?? '';
        const limit = opts?.limit ?? 1000;
        const cursor = (opts as { cursor?: string } | undefined)?.cursor ?? '';
        const all = store.filter((o) => o.key.startsWith(prefix));
        const startIdx = cursor ? Number(cursor) : 0;
        const slice = all.slice(startIdx, startIdx + limit);
        const truncated = startIdx + limit < all.length;
        return {
          objects: slice.map((o) => ({
            key: o.key,
            uploaded: o.uploaded,
            size: o.size,
            etag: 'etag',
            httpEtag: 'etag',
            version: 'v1',
          })) as unknown as R2Object[],
          truncated,
          ...(truncated ? { cursor: String(startIdx + limit) } : {}),
          // biome-ignore lint/suspicious/noExplicitAny: typed as R2Objects
        } as any;
      },
      async delete(key: string): Promise<void> {
        const idx = store.findIndex((o) => o.key === key);
        if (idx >= 0) store.splice(idx, 1);
      },
    },
  };
};

const NOW = new Date('2026-06-01T00:00:00Z').getTime();

const objAt = (key: string, ageMs: number, size: number = 0): StubObject => ({
  key,
  uploaded: new Date(NOW - ageMs),
  size,
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('runRetentionCleanup', () => {
  it('preserves orphans younger than 24h', async () => {
    const { bucket, getStore } = makeBucket([
      // No replay.html — orphaned, but only 2 hours old
      objAt('reports/young123/meta.json', 2 * HOUR),
      objAt('reports/young123/events.json', 2 * HOUR),
    ]);
    const env = { ARTIFACTS: bucket } as unknown as Env;
    const result = await runRetentionCleanup(env, NOW);
    expect(result.reportsDeleted).toBe(0);
    expect(getStore().length).toBe(2);
  });

  it('deletes orphans older than 24h', async () => {
    const { bucket, getStore } = makeBucket([
      objAt('reports/orphan456/meta.json', 26 * HOUR),
      objAt('reports/orphan456/events.json', 26 * HOUR),
    ]);
    const env = { ARTIFACTS: bucket } as unknown as Env;
    const result = await runRetentionCleanup(env, NOW);
    expect(result.orphanedDeleted).toBe(1);
    expect(result.reportsDeleted).toBe(1);
    expect(result.objectsDeleted).toBe(2);
    expect(getStore().length).toBe(0);
  });

  it('preserves complete reports younger than 6 months', async () => {
    const { bucket, getStore } = makeBucket([
      objAt('reports/keep789/replay.html', 30 * DAY),
      objAt('reports/keep789/meta.json', 30 * DAY),
    ]);
    const env = { ARTIFACTS: bucket } as unknown as Env;
    const result = await runRetentionCleanup(env, NOW);
    expect(result.reportsDeleted).toBe(0);
    expect(getStore().length).toBe(2);
  });

  it('deletes reports older than 6 months even when replay.html exists', async () => {
    const { bucket, getStore } = makeBucket([
      objAt('reports/expired1/replay.html', 200 * DAY),
      objAt('reports/expired1/meta.json', 200 * DAY),
      objAt('reports/expired1/events.json', 200 * DAY),
    ]);
    const env = { ARTIFACTS: bucket } as unknown as Env;
    const result = await runRetentionCleanup(env, NOW);
    expect(result.expiredDeleted).toBe(1);
    expect(result.objectsDeleted).toBe(3);
    expect(getStore().length).toBe(0);
  });

  it('groups objects of one report across paginated list() pages', async () => {
    // 1500 objects across the same prefix forces two list() pages at limit=1000.
    const objects: StubObject[] = [];
    for (let i = 0; i < 1500; i++) {
      objects.push(objAt(`reports/many/part-${i}.json`, 200 * DAY));
    }
    const { bucket, getStore } = makeBucket(objects);
    const env = { ARTIFACTS: bucket } as unknown as Env;
    const result = await runRetentionCleanup(env, NOW);
    expect(result.reportsScanned).toBe(1);
    expect(result.reportsDeleted).toBe(1);
    expect(result.objectsDeleted).toBe(1500);
    expect(getStore().length).toBe(0);
  });

  it('leaves the .deleted tombstone alone (does not re-classify as orphan)', async () => {
    const { bucket, getStore } = makeBucket([objAt('reports/tomb999/.deleted', 30 * DAY)]);
    const env = { ARTIFACTS: bucket } as unknown as Env;
    const result = await runRetentionCleanup(env, NOW);
    expect(result.orphanedDeleted).toBe(0);
    expect(getStore().length).toBe(1);
  });

  it('writes a retention_cleanup telemetry data point when TELEMETRY is bound', async () => {
    const { bucket } = makeBucket([objAt('reports/exp/meta.json', 200 * DAY)]);
    const calls: { indexes: string[]; doubles: number[] }[] = [];
    const env = {
      ARTIFACTS: bucket,
      BUGZAR_ANALYTICS: {
        writeDataPoint: (p: { indexes: string[]; doubles: number[] }) => calls.push(p),
      },
    } as unknown as Env;
    await runRetentionCleanup(env, NOW);
    expect(calls[0]?.indexes).toEqual(['retention_cleanup']);
    expect(calls[0]?.doubles?.[0]).toBe(1); // objectsDeleted
  });

  it('does not evict when total bucket size is under 9.5 GB', async () => {
    const GB = 1_000_000_000;
    const { bucket, getStore } = makeBucket([
      objAt('reports/small1/replay.html', 10 * DAY, 4 * GB),
      objAt('reports/small2/replay.html', 5 * DAY, 4 * GB),
    ]);
    const env = { ARTIFACTS: bucket } as unknown as Env;
    const result = await runRetentionCleanup(env, NOW);
    expect(result.evictedDeleted).toBe(0);
    expect(getStore().length).toBe(2);
  });

  it('evicts oldest reports first when bucket exceeds 9.5 GB', async () => {
    const GB = 1_000_000_000;
    // 4 × 3.5 GB = 14 GB. Need to drop ≥ 4.5 GB to clear the 9.5 GB cap.
    // One eviction (3.5 GB) leaves 10.5 GB — still over. Two leaves 7 GB.
    const { bucket, getStore } = makeBucket([
      objAt('reports/old1/replay.html', 100 * DAY, 3.5 * GB),
      objAt('reports/old2/replay.html', 80 * DAY, 3.5 * GB),
      objAt('reports/mid/replay.html', 50 * DAY, 3.5 * GB),
      objAt('reports/new/replay.html', 10 * DAY, 3.5 * GB),
    ]);
    const env = { ARTIFACTS: bucket } as unknown as Env;
    const result = await runRetentionCleanup(env, NOW);
    expect(result.evictedDeleted).toBe(2);
    expect(result.objectsDeleted).toBe(2);
    expect(result.bytesDeleted).toBe(7 * GB);
    const remainingKeys = getStore().map((o) => o.key);
    expect(remainingKeys).toContain('reports/mid/replay.html');
    expect(remainingKeys).toContain('reports/new/replay.html');
    expect(remainingKeys).not.toContain('reports/old1/replay.html');
    expect(remainingKeys).not.toContain('reports/old2/replay.html');
  });

  it('stops evicting as soon as bucket drops back under 9.5 GB', async () => {
    const GB = 1_000_000_000;
    // 12 GB total — one 3 GB eviction is enough (12 → 9 ≤ 9.5).
    const { bucket, getStore } = makeBucket([
      objAt('reports/old/replay.html', 100 * DAY, 3 * GB),
      objAt('reports/mid/replay.html', 50 * DAY, 3 * GB),
      objAt('reports/newish/replay.html', 30 * DAY, 3 * GB),
      objAt('reports/new/replay.html', 10 * DAY, 3 * GB),
    ]);
    const env = { ARTIFACTS: bucket } as unknown as Env;
    const result = await runRetentionCleanup(env, NOW);
    expect(result.evictedDeleted).toBe(1);
    expect(getStore().length).toBe(3);
    expect(getStore().map((o) => o.key)).not.toContain('reports/old/replay.html');
  });

  it('counts expired deletions toward the size budget before considering eviction', async () => {
    const GB = 1_000_000_000;
    // 4 GB expired + 7 GB survivors = 11 GB scanned. After expired pass survivors
    // are only 7 GB which is under 9.5 GB — no eviction should run.
    const { bucket, getStore } = makeBucket([
      objAt('reports/expired/replay.html', 200 * DAY, 4 * GB),
      objAt('reports/keep1/replay.html', 30 * DAY, 4 * GB),
      objAt('reports/keep2/replay.html', 10 * DAY, 3 * GB),
    ]);
    const env = { ARTIFACTS: bucket } as unknown as Env;
    const result = await runRetentionCleanup(env, NOW);
    expect(result.expiredDeleted).toBe(1);
    expect(result.evictedDeleted).toBe(0);
    expect(getStore().length).toBe(2);
  });
});
