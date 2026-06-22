/**
 * PR-18 — retention cleanup driven by a daily Cron Trigger.
 *
 * Three policies, applied in order:
 *
 *  - **orphaned**: report id has artifacts under `reports/<id>/` but no
 *    `replay.html`. Capture started, upload chain crashed mid-flight. 24h
 *    grace period before deletion so the user can still recover.
 *  - **expired**: any report whose oldest object is older than 6 months.
 *    Long-term storage is not part of the Bugzar product surface.
 *  - **evicted**: if the surviving bucket size still exceeds
 *    `SIZE_LIMIT_BYTES` (9.5 GB safety margin under the 10 GB R2 free tier),
 *    drop reports oldest-first until back under the threshold.
 *
 * All passes also clear the `.deleted` tombstone introduced by PR-16 once
 * the report is gone — otherwise the bucket would grow tombstones forever.
 */

import type { Env } from './worker';

const ORPHAN_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const EXPIRE_TTL_MS = 6 * 30 * 24 * 60 * 60 * 1000; // 6 months (180d)
const SIZE_LIMIT_BYTES = 9_500_000_000; // 9.5 GB, safety margin under R2 free tier (10 GB).

export interface RetentionResult {
  scanned: number;
  reportsScanned: number;
  reportsDeleted: number;
  objectsDeleted: number;
  orphanedDeleted: number;
  expiredDeleted: number;
  evictedDeleted: number;
  bytesScanned: number;
  bytesDeleted: number;
}

/**
 * Extract the report id from a key like `reports/<id>/replay.html`. Returns
 * null for keys that don't fit the `reports/<id>/...` shape (legacy
 * uploads under `/artifacts/...`, top-level junk).
 */
const reportIdFromKey = (key: string): string | null => {
  const parts = key.split('/');
  if (parts.length < 2 || parts[0] !== 'reports') return null;
  const id = parts[1];
  return id && /^[a-z0-9]{1,40}$/i.test(id) ? id : null;
};

export const runRetentionCleanup = async (
  env: Env,
  nowMs: number = Date.now(),
): Promise<RetentionResult> => {
  const result: RetentionResult = {
    scanned: 0,
    reportsScanned: 0,
    reportsDeleted: 0,
    objectsDeleted: 0,
    orphanedDeleted: 0,
    expiredDeleted: 0,
    evictedDeleted: 0,
    bytesScanned: 0,
    bytesDeleted: 0,
  };

  // Group every R2 object by reportId in one pass — that way the decision
  // for each report (orphaned / expired / keep) considers the full set,
  // not just the keys that happened to land in the same list() page.
  const byReport = new Map<
    string,
    { keys: string[]; oldestUploaded: number; hasReplay: boolean; totalBytes: number }
  >();

  let cursor: string | undefined;
  // R2 list() returns 1000 keys per page. We page through everything once;
  // the daily cron has plenty of CPU budget compared to a request-path call.
  while (true) {
    const page = await env.ARTIFACTS.list({
      prefix: 'reports/',
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const obj of page.objects) {
      result.scanned += 1;
      result.bytesScanned += obj.size;
      const id = reportIdFromKey(obj.key);
      if (!id) continue;
      const uploadedMs = obj.uploaded.getTime();
      const bucket = byReport.get(id);
      if (bucket) {
        bucket.keys.push(obj.key);
        bucket.totalBytes += obj.size;
        if (uploadedMs < bucket.oldestUploaded) bucket.oldestUploaded = uploadedMs;
        if (obj.key.endsWith('/replay.html')) bucket.hasReplay = true;
      } else {
        byReport.set(id, {
          keys: [obj.key],
          totalBytes: obj.size,
          oldestUploaded: uploadedMs,
          hasReplay: obj.key.endsWith('/replay.html'),
        });
      }
    }
    if (!page.truncated) break;
    cursor = (page as { cursor?: string }).cursor;
    if (!cursor) break;
  }

  result.reportsScanned = byReport.size;

  // Surviving reports after the age-based pass — feed into size-based eviction.
  const survivors: { id: string; oldestUploaded: number; totalBytes: number; keys: string[] }[] =
    [];

  for (const [id, info] of byReport) {
    const ageMs = nowMs - info.oldestUploaded;
    const isExpired = ageMs > EXPIRE_TTL_MS;
    // Tombstone-only ".deleted" objects count as "no replay" — skip the
    // orphan rule for those so PR-16 deletes don't reappear as orphans.
    const onlyTombstone = info.keys.length === 1 && info.keys[0]?.endsWith('/.deleted') === true;
    const isOrphaned = !isExpired && !info.hasReplay && !onlyTombstone && ageMs > ORPHAN_TTL_MS;

    if (!isExpired && !isOrphaned) {
      survivors.push({
        id,
        oldestUploaded: info.oldestUploaded,
        totalBytes: info.totalBytes,
        keys: info.keys,
      });
      continue;
    }

    await Promise.allSettled(info.keys.map((k) => env.ARTIFACTS.delete(k)));
    result.reportsDeleted += 1;
    result.objectsDeleted += info.keys.length;
    result.bytesDeleted += info.totalBytes;
    if (isExpired) result.expiredDeleted += 1;
    else if (isOrphaned) result.orphanedDeleted += 1;
    console.log(
      `[retention] deleted reportId=${id} keys=${info.keys.length} reason=${
        isExpired ? 'expired' : 'orphaned'
      }`,
    );
  }

  // Size-based eviction: if survivors still exceed the 9.5 GB threshold,
  // drop reports oldest-first (FIFO) until the bucket is back under the cap.
  let remainingBytes = survivors.reduce((sum, r) => sum + r.totalBytes, 0);
  if (remainingBytes > SIZE_LIMIT_BYTES) {
    survivors.sort((a, b) => a.oldestUploaded - b.oldestUploaded);
    for (const r of survivors) {
      if (remainingBytes <= SIZE_LIMIT_BYTES) break;
      await Promise.allSettled(r.keys.map((k) => env.ARTIFACTS.delete(k)));
      result.reportsDeleted += 1;
      result.objectsDeleted += r.keys.length;
      result.bytesDeleted += r.totalBytes;
      result.evictedDeleted += 1;
      remainingBytes -= r.totalBytes;
      console.log(
        `[retention] deleted reportId=${r.id} keys=${r.keys.length} reason=evicted bytes=${r.totalBytes}`,
      );
    }
  }

  if (env.BUGZAR_ANALYTICS) {
    try {
      env.BUGZAR_ANALYTICS.writeDataPoint({
        indexes: ['retention_cleanup'],
        blobs: [String(result.reportsScanned), String(result.reportsDeleted)],
        doubles: [
          result.objectsDeleted,
          result.orphanedDeleted,
          result.expiredDeleted,
          result.evictedDeleted,
          result.bytesScanned,
          result.bytesDeleted,
        ],
      });
    } catch (err) {
      console.warn('[retention] telemetry writeDataPoint failed', (err as Error).message);
    }
  }

  return result;
};
