// VM3 — rrweb `Replayer` lifecycle + a rAF clock. Mounts the replay into the
// given root element, drives `onTime`, and exposes imperative play/seek controls.

import type { RrwebEvent } from '@bugzar/shared';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { Replayer } from 'rrweb';

export interface ReplayerHandle {
  play: (ms?: number) => void;
  pause: (ms?: number) => void;
  seek: (ms: number) => void;
  setSpeed: (n: number) => void;
  getCurrentTime: () => number;
  totalTime: number;
}

export function useReplayer(
  rootRef: RefObject<HTMLDivElement | null>,
  events: RrwebEvent[],
  onTime?: (ms: number) => void,
  onFinish?: () => void,
): ReplayerHandle {
  const replayerRef = useRef<Replayer | null>(null);
  const rafRef = useRef<number | null>(null);
  const totalTimeRef = useRef(0);
  const [totalTime, setTotalTime] = useState(0);

  // Keep the latest callbacks without re-running the construction effect.
  const onTimeRef = useRef(onTime);
  onTimeRef.current = onTime;
  const onFinishRef = useRef(onFinish);
  onFinishRef.current = onFinish;

  const stopClock = useCallback(() => {
    if (rafRef.current != null && typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(rafRef.current);
    }
    rafRef.current = null;
  }, []);

  const startClock = useCallback(() => {
    if (typeof requestAnimationFrame === 'undefined') return;
    stopClock();
    const loop = () => {
      const r = replayerRef.current;
      if (!r) {
        rafRef.current = null;
        return;
      }
      const t = r.getCurrentTime();
      onTimeRef.current?.(t);
      // Playback finished — stop the clock so the tab doesn't spin a core at
      // 60fps forever, and let the Player reset its play/pause state.
      if (totalTimeRef.current > 0 && t >= totalTimeRef.current) {
        rafRef.current = null;
        onFinishRef.current?.();
        return;
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  }, [stopClock]);

  useEffect(() => {
    // rrweb's Replayer throws for <2 events — the Player guards this, but the
    // hook stays safe on its own.
    if (!rootRef.current || events.length < 2) return;
    const replayer = new Replayer(events as ConstructorParameters<typeof Replayer>[0], {
      root: rootRef.current,
      skipInactive: false,
      mouseTail: false,
    });
    replayerRef.current = replayer;
    const meta = replayer.getMetaData?.();
    if (meta) {
      totalTimeRef.current = meta.totalTime;
      setTotalTime(meta.totalTime);
    }
    return () => {
      stopClock();
      replayer.destroy?.();
      replayerRef.current = null;
    };
  }, [events, rootRef, stopClock]);

  const play = useCallback(
    (ms?: number) => {
      replayerRef.current?.play(ms);
      startClock();
    },
    [startClock],
  );

  const pause = useCallback(
    (ms?: number) => {
      replayerRef.current?.pause(ms);
      stopClock();
      const r = replayerRef.current;
      if (r) onTimeRef.current?.(r.getCurrentTime());
    },
    [stopClock],
  );

  // Seek = pause-at-offset; emit the new time so panels stay in sync.
  const seek = useCallback(
    (ms: number) => {
      replayerRef.current?.pause(ms);
      stopClock();
      onTimeRef.current?.(ms);
    },
    [stopClock],
  );

  const setSpeed = useCallback((n: number) => {
    replayerRef.current?.setConfig({ speed: n });
  }, []);

  const getCurrentTime = useCallback(() => replayerRef.current?.getCurrentTime() ?? 0, []);

  return { play, pause, seek, setSpeed, getCurrentTime, totalTime };
}
