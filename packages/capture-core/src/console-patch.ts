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

type Originals = {
  console: Partial<Record<Level, (...args: unknown[]) => void>>;
};

let originals: Originals | null = null;
let errorListener: ((e: ErrorEvent) => void) | null = null;
let rejectionListener: ((e: PromiseRejectionEvent) => void) | null = null;

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
    onEntry({
      level: 'error',
      tFromStart: Date.now() - sessionStart,
      args: [redactFreeText(e.message)],
      ...(stack !== undefined ? { stack } : {}),
    });
  };
  window.addEventListener('error', errorListener);

  rejectionListener = (e: PromiseRejectionEvent) => {
    const reason = e.reason;
    const stack = reason instanceof Error ? reason.stack : undefined;
    onEntry({
      level: 'error',
      tFromStart: Date.now() - sessionStart,
      args: [reason instanceof Error ? redactFreeText(reason.message) : stringifyArg(reason)],
      ...(stack !== undefined ? { stack } : {}),
    });
  };
  window.addEventListener('unhandledrejection', rejectionListener);
};

export const uninstallConsolePatch = (): void => {
  if (!originals) return;
  for (const level of LEVELS) {
    const orig = originals.console[level];
    if (orig) console[level] = orig as (typeof console)[Level];
  }
  if (errorListener) window.removeEventListener('error', errorListener);
  if (rejectionListener) window.removeEventListener('unhandledrejection', rejectionListener);
  errorListener = null;
  rejectionListener = null;
  originals = null;
};
