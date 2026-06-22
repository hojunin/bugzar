import type { RefObject } from 'react';
import { getStrings } from '../i18n';

type Position = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
type Theme = 'light' | 'dark' | 'auto';

const formatTime = (totalSeconds: number): string => {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
};

/** Pen/edit glyph for the Annotate button. */
function PenIcon() {
  return (
    <svg
      className="bugzar-fab-icon"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M4 20h4L18.5 9.5a2.12 2.12 0 0 0-3-3L5 17v3z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface ToolbarProps {
  position: Position;
  theme: Theme;
  recording: boolean;
  uploading: boolean;
  elapsed: number;
  design: boolean;
  autoHide: boolean;
  revealed: boolean;
  collapsed: boolean;
  rootRef: RefObject<HTMLDivElement | null>;
  onStart: () => void;
  onStop: () => void;
  onPick: () => void;
}

/** The floating toolbar: REC pill while recording, an uploading indicator, or the
 *  idle Record + (optional) Design buttons. Presentational — state lives above. */
export function Toolbar({
  position,
  theme,
  recording,
  uploading,
  elapsed,
  design,
  autoHide,
  revealed,
  collapsed,
  rootRef,
  onStart,
  onStop,
  onPick,
}: ToolbarProps) {
  const t = getStrings();
  return (
    <div
      ref={rootRef}
      className={`bugzar-root bugzar-${position} bugzar-theme-${theme}`}
      data-bugzar-recording={recording ? 'true' : 'false'}
      data-bugzar-revealed={autoHide ? (revealed ? 'true' : 'false') : undefined}
      inert={collapsed || undefined}
      aria-hidden={collapsed || undefined}
    >
      {recording ? (
        <button type="button" className="bugzar-pill" onClick={onStop} aria-label={t.stopRecording}>
          <span className="bugzar-dot" />
          <span className="bugzar-time">{formatTime(elapsed)}</span>
          <span className="bugzar-stop-label">{t.stop}</span>
        </button>
      ) : uploading ? (
        <output className="bugzar-fab" aria-label={t.uploading} aria-busy="true">
          <span className="bugzar-fab-dot" />
          <span className="bugzar-fab-label">{t.uploading}</span>
        </output>
      ) : (
        <>
          <button type="button" className="bugzar-fab" onClick={onStart} aria-label={t.startRecording}>
            <span className="bugzar-fab-dot" />
            <span className="bugzar-fab-label">{t.record}</span>
          </button>
          {design && (
            <button
              type="button"
              className="bugzar-fab bugzar-fab-secondary"
              onClick={onPick}
              aria-label={t.annotateAria}
            >
              <PenIcon />
              <span className="bugzar-fab-label">{t.annotate}</span>
            </button>
          )}
        </>
      )}
    </div>
  );
}
