// Parse the report locator from the page URL query string.
//   ?id=<reportId>[&endpoint=<worker base>]
// The viewer is served by the Worker itself, so `endpoint` defaults to the
// viewer's own origin — links are just `/r/:id` (→ `/v/?id=`). `endpoint` is an
// optional override for viewing a different Worker's report.

import type { ParamsError, ReportParams } from './types';

/**
 * Parse + normalize `?id=&endpoint=`. `endpoint` defaults to `defaultEndpoint`
 * (the viewer's own origin) and loses any trailing slash. Only `id` is required.
 */
export function parseReportParams(
  search: string,
  defaultEndpoint: string,
): ReportParams | ParamsError {
  const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const id = q.get('id');
  if (!id) return { error: 'missing-id' };
  const endpoint = (q.get('endpoint') ?? defaultEndpoint).replace(/\/+$/, '');
  return { endpoint, id };
}

/** Type guard: did parsing fail? */
export function isParamsError(v: ReportParams | ParamsError): v is ParamsError {
  return 'error' in v;
}
