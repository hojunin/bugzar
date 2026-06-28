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
  /** Playback speed multiplier (default 1). */
  speed?: number;
  /** Wire a speed selector; omit to hide it. */
  onSetSpeed?: (n: number) => void;
  /** Wire a fullscreen toggle; omit to hide it. */
  onToggleFullscreen?: () => void;
  /** Current fullscreen state — flips the toggle's affordance. */
  isFullscreen?: boolean;
}

interface Pt {
  x: number;
  t: number;
}

const SPEEDS = [0.5, 1, 1.5, 2, 4] as const;

const fmtClock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const fmtMarker = (kind: ErrorMarker['kind'], t: number) =>
  `${kind === 'network' ? 'Network' : 'Console'} issue at ${fmtClock(t)}`;

/** Speed selector: a trigger showing the current multiplier + a pop-up menu. */
function SpeedControl({ speed, onSetSpeed }: { speed: number; onSetSpeed: (n: number) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on an outside click while the menu is open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open]);

  return (
    <div className="bugzarv-speed" ref={ref}>
      <button
        type="button"
        className="bugzarv-speed-trigger"
        aria-label="Playback speed"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {speed}×
      </button>
      {open ? (
        <div className="bugzarv-speed-menu" role="menu">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              className={`bugzarv-speed-item${s === speed ? ' is-active' : ''}`}
              aria-label={`${s}× speed`}
              aria-pressed={s === speed}
              onClick={() => {
                onSetSpeed(s);
                setOpen(false);
              }}
            >
              {s}×
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Enter/exit fullscreen corner-bracket glyph. */
function FsIcon({ exit }: { exit: boolean }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {exit ? (
        <path d="M5.5 1.5v3h-3M8.5 1.5v3h3M8.5 12.5v-3h3M5.5 12.5v-3h-3" />
      ) : (
        <path d="M1.5 5.5v-4h4M12.5 5.5v-4h-4M12.5 8.5v4h-4M1.5 8.5v4h4" />
      )}
    </svg>
  );
}

export function Controls({
  playing,
  currentTime,
  totalTime,
  markers,
  events,
  viewport,
  onPlayPause,
  onSeek,
  speed = 1,
  onSetSpeed,
  onToggleFullscreen,
  isFullscreen = false,
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
      {onSetSpeed ? <SpeedControl speed={speed} onSetSpeed={onSetSpeed} /> : null}
      {onToggleFullscreen ? (
        <button
          type="button"
          className="bugzarv-fs"
          aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          onClick={onToggleFullscreen}
        >
          <FsIcon exit={isFullscreen} />
        </button>
      ) : null}
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
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: kind+t can collide for coincident events; the index is a uniqueness tiebreaker and the list never reorders.
              key={`${m.kind}-${m.t}-${i}`}
              type="button"
              data-testid="bugzarv-marker"
              className={`bugzarv-marker bugzarv-marker-${m.kind}`}
              style={{ left: `${totalTime > 0 ? (m.t / totalTime) * 100 : 0}%` }}
              aria-label={`Jump to ${fmtMarker(m.kind, m.t)}`}
              title={fmtMarker(m.kind, m.t)}
              // Don't let the tick start a track drag/seek — it has its own target.
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onSeek(m.t);
              }}
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
