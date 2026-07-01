// Hover-scrub thumbnail: a second rrweb Replayer that we seek to the hovered
// timestamp and render scaled-down in a popover above the track.
//
// The preview replayer is independent of the main player's clock — it only ever
// `pause(t)`s, never plays. Critical: the stage node stays MOUNTED for the life
// of the player (we toggle the popover with CSS, never unmount it). rrweb renders
// into the stage's DOM node; if we unmounted it on mouseleave, the replayer would
// keep painting into a detached node and every re-hover would show an empty frame.

import type { RrwebEvent } from '@bugzar/shared';
import { useEffect, useRef, useState } from 'react';

const PREVIEW_W = 248; // px — popover width budget
const PREVIEW_H = 160; // px — popover height budget
const fmt = (ms: number) => {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

/** Map a track x-offset to a timestamp, clamped to [0, totalTime]. Pure. */
export function previewTimeAt(x: number, width: number, totalTime: number): number {
  if (width <= 0 || totalTime <= 0) return 0;
  return Math.min(Math.max((x / width) * totalTime, 0), totalTime);
}

interface RrwebPreviewer {
  pause(ms?: number): void;
  destroy?(): void;
}

export interface ScrubberPreviewProps {
  events: RrwebEvent[];
  viewport: { width: number; height: number };
  visible: boolean;
  /** Hovered time (ms from start). */
  t: number;
  /** Cursor x within the track (px). */
  x: number;
  trackWidth: number;
}

export function ScrubberPreview({
  events,
  viewport,
  visible,
  t,
  x,
  trackWidth,
}: ScrubberPreviewProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const replayerRef = useRef<RrwebPreviewer | null>(null);
  const builtRef = useRef(false);
  // Latest requested time; an rAF coalesces rapid mousemove seeks into one.
  const wantRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const [ready, setReady] = useState(false);

  const canPreview = events.length >= 2;

  // Build the preview replayer once, shortly after mount (deferred so it doesn't
  // compete with the main player's first paint). The stage node is always in the
  // DOM, so the replayer's root stays attached for the player's whole lifetime.
  useEffect(() => {
    if (builtRef.current || !canPreview) return;
    builtRef.current = true;
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled || !stageRef.current) return;
      import('rrweb')
        .then(({ Replayer }) => {
          if (cancelled || !stageRef.current) return;
          try {
            const r = new Replayer(events as ConstructorParameters<typeof Replayer>[0], {
              root: stageRef.current,
              skipInactive: false,
              mouseTail: false,
              liveMode: false,
            }) as unknown as RrwebPreviewer;
            replayerRef.current = r;
            r.pause(wantRef.current);
            setReady(true);
          } catch {
            // happy-dom / unsupported env — the caption + a note still render.
            builtRef.current = false;
          }
        })
        .catch(() => {
          builtRef.current = false;
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [events, canPreview]);

  // Destroy on unmount.
  useEffect(
    () => () => {
      if (rafRef.current != null && typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(rafRef.current);
      }
      replayerRef.current?.destroy?.();
      replayerRef.current = null;
    },
    [],
  );

  // Seek the preview to the hovered time (rAF-coalesced) while hovering.
  useEffect(() => {
    wantRef.current = t;
    if (!visible || !ready || typeof requestAnimationFrame === 'undefined') return;
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      replayerRef.current?.pause(wantRef.current);
    });
  }, [t, visible, ready]);

  const scale = Math.min(PREVIEW_W / viewport.width, PREVIEW_H / viewport.height);
  const w = Math.round(viewport.width * scale);
  const h = Math.round(viewport.height * scale);
  // Clamp the popover so it stays within the track.
  const half = w / 2;
  const left = Math.min(Math.max(x, half), Math.max(trackWidth - half, half));

  return (
    <div
      className="bugzarv-preview"
      // The stage must stay in the DOM; hide with CSS instead of unmounting.
      style={{ left: `${left}px`, width: `${w}px`, display: visible ? 'block' : 'none' }}
    >
      <div className="bugzarv-preview-frame" style={{ width: `${w}px`, height: `${h}px` }}>
        <div
          ref={stageRef}
          className="bugzarv-preview-stage"
          style={{
            width: `${viewport.width}px`,
            height: `${viewport.height}px`,
            transform: `scale(${scale})`,
          }}
        />
        {!ready ? (
          <div className="bugzarv-preview-note">{canPreview ? 'loading…' : 'no preview'}</div>
        ) : null}
      </div>
      <div className="bugzarv-preview-cap">{fmt(t)}</div>
    </div>
  );
}
