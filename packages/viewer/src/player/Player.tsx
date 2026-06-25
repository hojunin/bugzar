import type { RrwebEvent } from '@bugzar/shared';
import type { RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { ErrorMarker } from '../panels/markers';
import { Controls } from './Controls';
import { useReplayer } from './use-replayer';

export interface PlayerProps {
  events: RrwebEvent[];
  onTime?: (ms: number) => void;
  /** Filled with a `seek(ms)` fn so panels/controls can drive the player. */
  seekRef?: RefObject<((ms: number) => void) | null>;
  /** Error/failed-request ticks for the scrubber (VM11). */
  markers?: ErrorMarker[];
  /** Recording viewport, for the track hover-preview thumbnail. */
  viewport?: { width: number; height: number };
}

export function Player({
  events,
  onTime,
  seekRef,
  markers = [],
  viewport = { width: 1280, height: 720 },
}: PlayerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  // Fit-to-width: 1 = the recorded viewport scaled to the container width; the
  // +/- buttons multiply on top of the fit (manual zoom).
  const [zoom, setZoom] = useState(1);

  // Hooks run unconditionally (the <2-events empty state is rendered AFTER).
  const handle = useReplayer(
    rootRef,
    events,
    (ms) => {
      setCurrentTime(ms);
      onTime?.(ms);
    },
    () => setPlaying(false), // playback finished → reset the play button
  );

  // Expose seek outward so panel rows can drive the playhead.
  useEffect(() => {
    if (!seekRef) return;
    seekRef.current = (ms: number) => {
      handle.seek(ms);
      setCurrentTime(ms);
      setPlaying(false);
    };
    return () => {
      seekRef.current = null;
    };
  }, [seekRef, handle.seek]);

  // Scale the rrweb replay to fit the container width (no horizontal scroll at
  // 1×); `zoom` multiplies on top. rrweb renders at the recorded viewport size,
  // so we transform its wrapper and size our mount box to the scaled result.
  useEffect(() => {
    const scroll = scrollRef.current;
    const root = rootRef.current;
    if (!scroll || !root || events.length < 2) return;
    const apply = () => {
      const wrapper = root.querySelector('.replayer-wrapper') as HTMLElement | null;
      if (!wrapper) return;
      // Scale from the RECORDED viewport (rrweb renders the iframe at this size),
      // NOT wrapper.offsetWidth: the wrapper can get constrained to our own mount
      // box, which yields scale=1 and clips a wider page on the right.
      const rw = viewport.width || wrapper.offsetWidth || 1280;
      const rh = viewport.height || wrapper.offsetHeight || 720;
      const scale = (scroll.clientWidth / rw) * zoom;
      wrapper.style.transformOrigin = 'top left';
      wrapper.style.transform = `scale(${scale})`;
      root.style.width = `${rw * scale}px`;
      root.style.height = `${rh * scale}px`;
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(scroll);
    // rrweb sizes its iframe a tick after construction — re-apply to catch it.
    const t1 = setTimeout(apply, 60);
    const t2 = setTimeout(apply, 300);
    return () => {
      ro.disconnect();
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [events, zoom, viewport.width, viewport.height]);

  // rrweb's Replayer throws for <2 events; short/aborted recordings + a missing
  // events.json degrade to an empty state (the sidebar panels still render).
  if (events.length < 2) {
    return <div className="bugzarv-empty">No DOM events recorded for this session.</div>;
  }

  const seekTo = (ms: number) => {
    handle.seek(ms);
    setCurrentTime(ms);
    setPlaying(false);
  };
  const onPlayPause = () => {
    if (playing) {
      handle.pause();
      setPlaying(false);
    } else {
      // Restart from the beginning if the playhead is parked at the end.
      const from = handle.totalTime > 0 && currentTime >= handle.totalTime ? 0 : currentTime;
      handle.play(from);
      setCurrentTime(from);
      setPlaying(true);
    }
  };
  return (
    <>
      <div className="bugzarv-replay-outer">
        <div ref={scrollRef} className="bugzarv-replay-scroll">
          <div ref={rootRef} className="bugzarv-replay" />
        </div>
        <div className="bugzarv-zoom">
          <button
            type="button"
            className="bugzarv-zoom-btn"
            aria-label="Zoom out"
            onClick={() => setZoom((z) => Math.max(0.25, Math.round((z - 0.25) * 100) / 100))}
          >
            −
          </button>
          <button
            type="button"
            className="bugzarv-zoom-btn"
            aria-label="Zoom in"
            onClick={() => setZoom((z) => Math.min(4, Math.round((z + 0.25) * 100) / 100))}
          >
            +
          </button>
        </div>
      </div>
      <Controls
        playing={playing}
        currentTime={currentTime}
        totalTime={handle.totalTime}
        markers={markers}
        events={events}
        viewport={viewport}
        onPlayPause={onPlayPause}
        onSeek={seekTo}
      />
    </>
  );
}
