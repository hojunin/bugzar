/** Worker base URL, optionally with host-supplied auth headers. */
export type Endpoint = string | { url: string; headers?: Record<string, string> };

/** Normalize an endpoint into a trailing-slash-free base URL + its auth headers. */
export function resolveEndpoint(endpoint: Endpoint): {
  base: string;
  headers: Record<string, string>;
} {
  const base = (typeof endpoint === 'string' ? endpoint : endpoint.url).replace(/\/+$/, '');
  const headers = typeof endpoint === 'string' ? {} : (endpoint.headers ?? {});
  return { base, headers };
}
