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

/** The recording engine: start/stop the recorder + the elapsed-seconds tick. */
export function useRecorder({
  mask,
  inlineAssets,
  onStart,
  captureState,
  redactState,
}: UseRecorderArgs): RecorderControls {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const recorderRef = useRef<Recorder | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Restore page globals if unmounted mid-recording.
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
      inlineAssets,
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
  }, [mask, inlineAssets, captureState, redactState, onStart]);

  const stop = useCallback((): ReportBundle | null => {
    const rec = recorderRef.current;
    if (!rec) return null;
    const bundle = rec.stop();
    recorderRef.current = null;
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    setRecording(false);
    return bundle;
  }, []);

  return { recording, elapsed, start, stop };
}
