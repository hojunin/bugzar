// Pure search/filter helpers for the data panels. Case-insensitive substring.

import type { ConsoleEntry, NetworkEntryPayload } from '@bugzar/shared';

/** Case-insensitive substring match; empty query matches everything. */
export function matchesQuery(haystack: string, query: string): boolean {
  if (!query) return true;
  return haystack.toLowerCase().includes(query.toLowerCase());
}

/** Filter console entries by their joined `args` (and level). */
export function searchConsole(entries: ConsoleEntry[], query: string): ConsoleEntry[] {
  if (!query) return entries;
  return entries.filter((e) => matchesQuery(`${e.level} ${e.args.join(' ')}`, query));
}

/** Filter network entries by method / url / status. */
export function searchNetwork(
  entries: NetworkEntryPayload[],
  query: string,
): NetworkEntryPayload[] {
  if (!query) return entries;
  return entries.filter((e) => matchesQuery(`${e.method} ${e.url} ${e.status ?? ''}`, query));
}
