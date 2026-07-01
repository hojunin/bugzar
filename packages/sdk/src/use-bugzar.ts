'use client';

import type { Recorder } from '@bugzar/capture-core';
import { createRecorder } from '@bugzar/capture-core';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExportMeta, ReportBundle } from './public-types';

// Lazy-load the heavy export module only when an offline HTML is built (onExport),
// so the ~478 KB inlined viewer never enters the core bundle.
const buildReplayBlob = async (bundle: ReportBundle): Promise<Blob> =>
  (
    await (import('@bugzar/sdk/export' as string) as Promise<typeof import('./export')>)
  ).exportReportHtml(bundle);

/** The capture/output subset of `BugzarProps` the headless engine needs. */
export interface UseBugzarOptions {
  mask?: boolean;
  onStart?: () => void;
  /** Receive the built self-contained replay HTML to upload to your own storage. */
  onExport?: (blob: Blob, meta: ExportMeta) => Promise<string | undefined>;
  onError?: (error: Error) => void;
  captureState?: () => unknown;
  redactState?: (state: unknown) => unknown;
}

export interface BugzarControls {
  recording: boolean;
  elapsed: number;
  start: () => void;
  stop: () => void;
}

/**
 * Headless recording engine — the same start/stop logic the `<Bugzar />`
 * FAB drives, exposed so a host can wire its OWN "Report a bug" button.
 *
 *   const { recording, start, stop } = useBugzar({ onExport });
 */
export function useBugzar(opts: UseBugzarOptions = {}): BugzarControls {
  const { mask = true, onStart, onExport, onError, captureState, redactState } = opts;

  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const recorderRef = useRef<Recorder | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(
    () => () => {
      if (tickRef.current) clearInterval(tickRef.current);
      recorderRef.current?.stop();
    },
    [],
  );

  const start = useCallback(() => {
    if (recorderRef.current?.isActive()) return;
    const rec = createRecorder({
      maskAllInputs: mask,
      inlineAssets: !!onExport,
      ...(captureState ? { captureState } : {}),
      ...(redactState ? { redactState } : {}),
    });
    recorderRef.current = rec;
    rec.start();
    setRecording(true);
    setElapsed(0);
    const startedAt = Date.now();
    tickRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 500);
    onStart?.();
  }, [mask, onExport, captureState, redactState, onStart]);

  const stop = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec) return;
    const bundle = rec.stop();
    recorderRef.current = null;
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    setRecording(false);

    if (onExport) {
      buildReplayBlob(bundle)
        .then((blob) => onExport(blob, { ...bundle.meta, mode: 'session' }))
        .catch((err) => onError?.(err instanceof Error ? err : new Error(String(err))));
    }
  }, [onExport, onError]);

  return { recording, elapsed, start, stop };
}
