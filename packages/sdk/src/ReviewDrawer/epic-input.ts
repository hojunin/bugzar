/** Project-key prefix of an issue/epic key, e.g. `"CBPFE-3991"` → `"CBPFE"`. */
export function epicProjectPrefix(key: string | undefined): string | undefined {
  const prefix = key?.match(/^([A-Za-z][A-Za-z0-9]*)-\d+$/)?.[1];
  return prefix ? prefix.toUpperCase() : undefined;
}

/**
 * Normalize a tester's epic input into a searchable term so they don't have to
 * type the exact `KEY-123`. The Worker epic search key-matches a key-shaped
 * result, so this only has to produce one:
 *
 *  - a full Jira browse URL (with any query/hash) → the embedded key
 *    `"https://jira.example.com/browse/CBPFE-3991?x=1"` → `"CBPFE-3991"`
 *  - a bare issue number + a known project prefix → the qualified key
 *    `"3991"` (prefix `"CBPFE"`) → `"CBPFE-3991"`
 *  - anything else (a partial title, an already-shaped key) → returned trimmed.
 *
 * `projectPrefix` is the project of the prefilled/last-used epic; when absent a
 * bare number is left as-is (falls back to a title match, unchanged behavior).
 */
export function normalizeEpicQuery(input: string, projectPrefix?: string): string {
  const q = input.trim();
  const urlKey = q.match(/\/browse\/([A-Za-z][A-Za-z0-9]*-\d+)/)?.[1];
  if (urlKey) return urlKey.toUpperCase();
  if (projectPrefix && /^\d+$/.test(q)) return `${projectPrefix}-${q}`;
  return q;
}
