import type { RrwebEvent } from '@bugzar/shared';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { ErrorMarker } from '../panels/markers';
import { previewTimeAt, ScrubberPreview } from './ScrubberPreview';

export interface ControlsProps {
  playing: boolean;
  currentTime: number;
  totalTime: number;
  markers: ErrorMarker[];
  /** rrweb events — drive the hover-preview thumbnail. */
  events: RrwebEvent[];
  /** Recording viewport, for scaling the preview thumbnail. */
  viewport: { width: number; height: number };
  onPlayPause: () => void;
  onSeek: (ms: number) => void;
}

interface Pt {
  x: number;
  t: number;
}

const fmtClock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function Controls({
  playing,
  currentTime,
  totalTime,
  markers,
  events,
  viewport,
  onPlayPause,
  onSeek,
}: ControlsProps) {
  const [hover, setHover] = useState<Pt | null>(null);
  const [drag, setDrag] = useState<Pt | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragTRef = useRef(0);

  const ptAt = useCallback(
    (clientX: number): Pt | null => {
      const el = trackRef.current;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const x = Math.min(Math.max(clientX - rect.left, 0), rect.width);
      return { x, t: previewTimeAt(x, rect.width, totalTime) };
    },
    [totalTime],
  );

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = ptAt(e.clientX);
    if (!p) return;
    dragTRef.current = p.t;
    setDrag(p);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag) return; // drag is tracked on the window (see effect)
    const p = ptAt(e.clientX);
    if (p) setHover(p);
  };

  // While dragging, follow the pointer anywhere and commit the seek on release.
  // Seeking the heavy main replayer on every move is janky, so only the preview
  // updates live; the actual seek lands once, on pointerup.
  const isDragging = drag != null;
  useEffect(() => {
    if (!isDragging) return;
    const move = (e: PointerEvent) => {
      const p = ptAt(e.clientX);
      if (p) {
        dragTRef.current = p.t;
        setDrag(p);
      }
    };
    const up = () => {
      onSeek(dragTRef.current);
      setDrag(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [isDragging, ptAt, onSeek]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (totalTime <= 0) return;
    const step = Math.max(totalTime * 0.02, 250);
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      onSeek(Math.min(currentTime + step, totalTime));
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      onSeek(Math.max(currentTime - step, 0));
    } else if (e.key === 'Home') {
      e.preventDefault();
      onSeek(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      onSeek(totalTime);
    }
  };

  const active = drag ?? hover;
  const headT = drag ? drag.t : currentTime;
  const pct = totalTime > 0 ? (headT / totalTime) * 100 : 0;
  const trackW = trackRef.current?.getBoundingClientRect().width ?? 0;

  return (
    <div className="bugzarv-controls">
      <button
        type="button"
        className="bugzarv-play"
        aria-label={playing ? 'Pause' : 'Play'}
        onClick={onPlayPause}
      >
        {playing ? '⏸' : '▶'}
      </button>
      <div
        className={`bugzarv-scrubber${isDragging ? ' bugzarv-scrubber-drag' : ''}`}
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(totalTime)}
        aria-valuenow={Math.round(headT)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKeyDown}
      >
        <div className="bugzarv-track">
          <div className="bugzarv-track-fill" style={{ width: `${pct}%` }} />
          {markers.map((m, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: kind+t can collide for coincident events; the index is a uniqueness tiebreaker and the list never reorders.
              key={`${m.kind}-${m.t}-${i}`}
              data-testid="bugzarv-marker"
              className={`bugzarv-marker bugzarv-marker-${m.kind}`}
              style={{ left: `${totalTime > 0 ? (m.t / totalTime) * 100 : 0}%` }}
            />
          ))}
          {active ? <div className="bugzarv-hoverline" style={{ left: `${active.x}px` }} /> : null}
          <div className="bugzarv-thumb" style={{ left: `${pct}%` }} />
        </div>
        <ScrubberPreview
          events={events}
          viewport={viewport}
          visible={active != null}
          t={active?.t ?? headT}
          x={active?.x ?? (pct / 100) * trackW}
          trackWidth={trackW}
        />
      </div>
      <div className="bugzarv-clock">
        {fmtClock(headT)} <span className="bugzarv-clock-sep">/</span> {fmtClock(totalTime)}
      </div>
    </div>
  );
}
