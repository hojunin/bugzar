import { type RefObject, useEffect, useRef, useState } from 'react';

type Position = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

interface UseAutoHideArgs {
  autoHide: boolean;
  mounted: boolean;
  position: Position;
  /** Pinned open while in use (recording / uploading / picking / drawer). */
  inUse: boolean;
  rootRef: RefObject<HTMLDivElement | null>;
  /** Hover-to-reveal zone size (px); a missing axis keeps its default (300×30). */
  hoverZone?: { width?: number; height?: number };
}

/** The autoHide reveal machine: geometric hover + a 2s post-use grace hold. */
export function useAutoHide({
  autoHide,
  mounted,
  position,
  inUse,
  rootRef,
  hoverZone,
}: UseAutoHideArgs): {
  revealed: boolean;
  collapsed: boolean;
} {
  const hotW = hoverZone?.width ?? 300;
  const hotH = hoverZone?.height ?? 30;
  // autoHide reveal state: cursor in the hotspot/toolbar, and the 2s post-use hold.
  const [hovering, setHovering] = useState(false);
  const [grace, setGrace] = useState(false);
  const graceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevInUse = useRef(false);

  // Geometric hover detection (autoHide only): a passive window `pointermove`
  // decides `hovering` from coordinates, so the collapsed corner never blocks
  // page clicks (the dock is pointer-events:none). The hot-zone is the union of
  // a hotW×hotH corner hotspot (computed from innerWidth/innerHeight — always
  // reliable) and the live toolbar rect (keep-alive while revealed).
  // biome-ignore lint/correctness/useExhaustiveDependencies: rootRef is a stable ref read lazily at pointermove time; its identity never changes, so it is intentionally excluded from deps.
  useEffect(() => {
    if (!autoHide || !mounted) return;
    const inZone = (x: number, y: number): boolean => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const left = position.endsWith('left');
      const top = position.startsWith('top');
      const inCornerX = left ? x >= 0 && x <= hotW : x >= vw - hotW && x <= vw;
      const inCornerY = top ? y >= 0 && y <= hotH : y >= vh - hotH && y <= vh;
      if (inCornerX && inCornerY) return true;
      const r = rootRef.current?.getBoundingClientRect();
      return (
        !!r &&
        r.width > 0 &&
        x >= r.left - 4 &&
        x <= r.right + 4 &&
        y >= r.top - 4 &&
        y <= r.bottom + 4
      );
    };
    const onMove = (e: PointerEvent) => setHovering(inZone(e.clientX, e.clientY));
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, [autoHide, mounted, position, hotW, hotH]);

  // 2s grace after a use ends (inUse true→false): hold the idle toolbar open,
  // then let hover decide again. Re-entering use cancels the pending hide.
  useEffect(() => {
    if (!autoHide) return;
    if (prevInUse.current && !inUse) {
      setGrace(true);
      if (graceTimer.current) clearTimeout(graceTimer.current);
      graceTimer.current = setTimeout(() => setGrace(false), 2000);
    } else if (inUse && graceTimer.current) {
      clearTimeout(graceTimer.current);
      graceTimer.current = null;
      setGrace(false);
    }
    prevInUse.current = inUse;
  }, [autoHide, inUse]);

  // Clear any pending grace timer on unmount.
  useEffect(
    () => () => {
      if (graceTimer.current) clearTimeout(graceTimer.current);
    },
    [],
  );

  const revealed = hovering || inUse || grace;
  // Collapsed & idle → remove the off-screen toolbar from a11y tree + tab order.
  const collapsed = autoHide && !revealed && !inUse;
  return { revealed, collapsed };
}
