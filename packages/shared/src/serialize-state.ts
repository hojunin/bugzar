/**
 * M6 — serialize + redact a host app-state snapshot into a JSON-safe value.
 *
 * Structured-clone-style coercion (Date → ISO, Map → entries, Set → values,
 * Error → { name, message }, functions/Promises dropped), a WeakSet circular
 * guard ('[Circular]'), redaction (sensitive keys + JWT-looking strings →
 * `[REDACTED]`, reusing sanitize-network-body's patterns) applied during the
 * walk, then the host `redact` override, then a size-cap that replaces an
 * oversized result with an explicit truncation marker. Redaction and truncation
 * leave IN-BAND markers so a viewer never confuses masked/truncated with missing.
 */

import { isSensitiveKey, looksLikeJwt, REDACTED } from './sanitize-network-body';

export interface SerializeStateOptions {
  /** Host redaction hook, applied AFTER the built-in key/JWT masking. */
  redact?: (state: unknown) => unknown;
  /** Max serialized size in bytes before truncation. Default 256 KB. */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 256 * 1024;

export const serializeState = (value: unknown, opts: SerializeStateOptions = {}): unknown => {
  const seen = new WeakSet<object>();

  const walk = (v: unknown): unknown => {
    if (v === null) return null;
    const t = typeof v;
    if (t === 'string') return looksLikeJwt(v as string) ? REDACTED : v;
    if (t === 'number' || t === 'boolean') return v;
    if (t === 'bigint') return (v as bigint).toString();
    // functions / symbols / undefined are not serializable — dropped.
    if (t !== 'object') return undefined;

    if (v instanceof Date) return v.toISOString();
    if (v instanceof Error) return { name: v.name, message: v.message };
    if (typeof Promise !== 'undefined' && v instanceof Promise) return undefined; // dropped

    if (seen.has(v as object)) return '[Circular]';
    seen.add(v as object);

    if (v instanceof Map) return [...v.entries()].map(([k, val]) => [walk(k), walk(val)]);
    if (v instanceof Set) return [...v.values()].map((x) => walk(x));
    if (Array.isArray(v)) return v.map((x) => walk(x));

    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (isSensitiveKey(k)) {
        out[k] = REDACTED;
        continue;
      }
      const w = walk(val);
      if (w !== undefined) out[k] = w; // drop function/Promise/undefined values
    }
    return out;
  };

  let result = walk(value);
  if (opts.redact) result = opts.redact(result);

  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  let json: string | undefined;
  try {
    json = JSON.stringify(result);
  } catch {
    json = undefined;
  }
  if (typeof json === 'string' && json.length > maxBytes) {
    return { __truncated: true, bytes: json.length, note: `state exceeded ${maxBytes} bytes` };
  }
  return result;
};
