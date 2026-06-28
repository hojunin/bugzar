import type { Recorder } from '@bugzar/capture-core';
import { createRecorder } from '@bugzar/capture-core';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReportBundle } from '../public-types';

interface UseRecorderArgs {
  mask: boolean;
  /** Inline page assets into the capture (heavy) — only for the offline-HTML path. */
  inlineAssets: boolean;
  onStart?: (() => void) | undefined;
  captureState?: (() => unknown) | undefined;
  redactState?: ((state: unknown) => unknown) | undefined;
}

export interface RecorderControls {
  recording: boolean;
  elapsed: number;
  start: () => void;
  /** Stop capture and return the bundle (or null when not recording). */
  stop: () => ReportBundle | null;
}

// The recording lives OUTSIDE the React component lifecycle. rrweb is already a
// module singleton in capture-core; the recorder instance (which owns the
// in-memory event/console/network buffers) and the start time have to be too.
// Otherwise a client-side route change that unmounts the subtree <Bugzar/> sits
// in tears the recording down — the toolbar comes back on the next page showing
// nothing was captured. Keeping them at module scope lets a remounted <Bugzar/>
// rebind to the in-progress recording. The recorder is stopped only by an
// explicit stop() call, never by an unmount.
let activeRecorder: Recorder | null = null;
let activeStartedAt = 0;

/** Test-only: drop the module-level recording so each test starts from clean state. */
export function __resetRecorder(): void {
  activeRecorder = null;
  activeStartedAt = 0;
}

const elapsedFrom = (startedAt: number): number =>
  Math.max(0, Math.floor((Date.now() - startedAt) / 1000));

/** The recording engine: start/stop the recorder + the elapsed-seconds tick. */
export function useRecorder({
  mask,
  inlineAssets,
  onStart,
  captureState,
  redactState,
}: UseRecorderArgs): RecorderControls {
  // Seed from the module singleton so a remount onto an in-progress recording
  // shows the REC pill + correct elapsed immediately, not a stale 0:00.
  const [recording, setRecording] = useState(() => activeRecorder?.isActive() ?? false);
  const [elapsed, setElapsed] = useState(() =>
    activeRecorder?.isActive() ? elapsedFrom(activeStartedAt) : 0,
  );
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startTick = useCallback(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = setInterval(() => {
      setElapsed(elapsedFrom(activeStartedAt));
    }, 500);
  }, []);

  // On (re)mount, resume the elapsed tick if a recording is already running (the
  // navigation case). On unmount, clear ONLY the local tick — never stop the
  // recorder; that is exactly what used to lose the recording on a route change.
  useEffect(() => {
    if (activeRecorder?.isActive()) {
      setRecording(true);
      setElapsed(elapsedFrom(activeStartedAt));
      startTick();
    }
    return () => {
      if (tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
    };
  }, [startTick]);

  const start = useCallback(() => {
    if (activeRecorder?.isActive()) return;
    const rec = createRecorder({
      maskAllInputs: mask,
      inlineAssets,
      ...(captureState ? { captureState } : {}),
      ...(redactState ? { redactState } : {}),
    });
    activeRecorder = rec;
    rec.start();
    activeStartedAt = Date.now();
    setRecording(true);
    setElapsed(0);
    startTick();
    onStart?.();
  }, [mask, inlineAssets, captureState, redactState, onStart, startTick]);

  const stop = useCallback((): ReportBundle | null => {
    const rec = activeRecorder;
    if (!rec) return null;
    const bundle = rec.stop();
    activeRecorder = null;
    activeStartedAt = 0;
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    setRecording(false);
    return bundle;
  }, []);

  return { recording, elapsed, start, stop };
}
