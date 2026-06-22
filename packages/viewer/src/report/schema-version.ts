// VM1 — schema-version compatibility. Keyed off the single `SCHEMA_VERSION`
// the SDK stamps into `meta.schemaVersion`, so producer and renderer stay aligned.

import { SCHEMA_VERSION } from '@bugzar/shared';
import type { VersionStatus } from './types';

export { SCHEMA_VERSION };

/**
 * Compare a report's stamped schema version to the version this viewer renders.
 * `undefined` (pre-versioning report) → 'unknown'.
 */
export function checkSchemaVersion(reported: number | undefined): VersionStatus {
  if (reported == null) return 'unknown';
  if (reported === SCHEMA_VERSION) return 'ok';
  return reported < SCHEMA_VERSION ? 'older' : 'newer';
}
