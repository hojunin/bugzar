import { type ConsoleEntry, redactFreeText } from '@bugzar/shared';

type Level = ConsoleEntry['level'];
/**
 * 5 standard log levels + 3 grouping markers. We patch grouping the same
 * way as logs so the viewer can reconstruct nested folds when the page
 * uses `console.group(...)`. groupEnd carries no payload — `args` is
 * empty for it. Pages that never call the grouping APIs see no change.
 */
const LEVELS: readonly Level[] = [
  'log',
  'info',
  'warn',
  'error',
  'debug',
  'group',
  'groupCollapsed',
  'groupEnd',
] as const;

type Options = {
  sessionStart: number;
  onEntry: (entry: ConsoleEntry) => void;
};

// Each captured arg is free-text-scrubbed (Bearer/JWT/sensitive XML) — apps
// commonly log auth responses, and console entries land in the public replay.
const stringifyArg = (arg: unknown): string => {
  if (typeof arg === 'string') return redactFreeText(arg);
  if (arg instanceof Error) return redactFreeText(arg.message);
  let s: string;
  try {
    s = JSON.stringify(arg);
  } catch {
    s = String(arg);
  }
  return redactFreeText(s ?? String(arg));
};

const extractStack = (args: unknown[]): string | undefined => {
  for (const a of args) {
    if (a instanceof Error && a.stack) return a.stack;
  }
  return undefined;
};

// R2b — cap frames so a deep stack/cause chain can't bloat the report.
const FRAME_CAP = 4;
const capStack = (stack: string): string => stack.split('\n').slice(0, FRAME_CAP).join('\n');

/** Flatten an `error.cause` chain → redacted "Caused by: …" lines (depth-capped). */
const flattenCause = (err: unknown, depth = 3): string | undefined => {
  const parts: string[] = [];
  let cur: unknown = err instanceof Error ? err.cause : undefined;
  for (let d = 0; cur != null && d < depth; d++) {
    if (cur instanceof Error) {
      parts.push(`Caused by: ${cur.stack ? capStack(cur.stack) : cur.message}`);
      cur = cur.cause;
    } else {
      parts.push(`Caused by: ${stringifyArg(cur)}`);
      cur = undefined;
    }
  }
  return parts.length ? redactFreeText(parts.join('\n')) : undefined;
};

type Originals = {
  console: Partial<Record<Level, (...args: unknown[]) => void>>;
};

let originals: Originals | null = null;
let errorListener: ((e: ErrorEvent) => void) | null = null;
let rejectionListener: ((e: PromiseRejectionEvent) => void) | null = null;
let cspListener: ((e: SecurityPolicyViolationEvent) => void) | null = null;

export const installConsolePatch = ({ sessionStart, onEntry }: Options): void => {
  if (originals) return;

  originals = { console: {} };

  for (const level of LEVELS) {
    const original = console[level].bind(console);
    originals.console[level] = original;
    console[level] = ((...args: unknown[]) => {
      const stack = extractStack(args);
      onEntry({
        level,
        tFromStart: Date.now() - sessionStart,
        args: args.map(stringifyArg),
        // Conditional spread keeps `stack` absent rather than present-undefined
        // (exactOptionalPropertyTypes); identical once JSON-serialized.
        ...(stack !== undefined ? { stack } : {}),
      });
      original(...args);
    }) as (typeof console)[Level];
  }

  errorListener = (e: ErrorEvent) => {
    const stack = e.error instanceof Error ? e.error.stack : undefined;
    const cause = flattenCause(e.error);
    // ErrorEvent.filename is a script URL (not a credentialed request) — origin
    // file:line:col. Bundle coords in prod; the viewer cites but never promotes.
    const hasSource = typeof e.filename === 'string' && e.filename !== '';
    onEntry({
      level: 'error',
      kind: 'error',
      tFromStart: Date.now() - sessionStart,
      args: [redactFreeText(e.message)],
      ...(stack !== undefined ? { stack } : {}),
      ...(cause ? { cause } : {}),
      ...(hasSource
        ? { source: { file: e.filename, line: e.lineno ?? 0, col: e.colno ?? 0 } }
        : {}),
    });
  };
  window.addEventListener('error', errorListener);

  rejectionListener = (e: PromiseRejectionEvent) => {
    const reason = e.reason;
    const stack = reason instanceof Error ? reason.stack : undefined;
    const cause = flattenCause(reason);
    onEntry({
      level: 'error',
      kind: 'unhandledrejection',
      tFromStart: Date.now() - sessionStart,
      args: [reason instanceof Error ? redactFreeText(reason.message) : stringifyArg(reason)],
      ...(stack !== undefined ? { stack } : {}),
      ...(cause ? { cause } : {}),
    });
  };
  window.addEventListener('unhandledrejection', rejectionListener);

  // R2c — CSP violations as a distinct console entry (kind='csp') so the viewer
  // can badge them; no new asset channel.
  cspListener = (e: SecurityPolicyViolationEvent) => {
    onEntry({
      level: 'error',
      kind: 'csp',
      tFromStart: Date.now() - sessionStart,
      args: [redactFreeText(`CSP: ${e.violatedDirective} blocked ${e.blockedURI || '(inline)'}`)],
    });
  };
  window.addEventListener('securitypolicyviolation', cspListener);
};

export const uninstallConsolePatch = (): void => {
  if (!originals) return;
  for (const level of LEVELS) {
    const orig = originals.console[level];
    if (orig) console[level] = orig as (typeof console)[Level];
  }
  if (errorListener) window.removeEventListener('error', errorListener);
  if (rejectionListener) window.removeEventListener('unhandledrejection', rejectionListener);
  if (cspListener) window.removeEventListener('securitypolicyviolation', cspListener);
  errorListener = null;
  rejectionListener = null;
  cspListener = null;
  originals = null;
};
