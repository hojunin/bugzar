// A2 — reproduction steps panel. A numbered, human-readable list of the user
// actions leading to the observed failure; clicking a step seeks the player.

import type { ReproStep } from '../report/repro-steps';

export function ReproPanel({ steps, onSeek }: { steps: ReproStep[]; onSeek: (t: number) => void }) {
  if (steps.length === 0) {
    return <div className="bugzarv-empty">No reproduction steps</div>;
  }
  return (
    <ol className="bugzarv-repro">
      {steps.map((s, i) => (
        <li key={`${i}-${s.t}`} className="bugzarv-repro-step">
          <button type="button" className="bugzarv-repro-btn" onClick={() => onSeek(s.t)}>
            <span className="bugzarv-repro-num" aria-hidden="true">
              {i + 1}
            </span>
            <span className="bugzarv-repro-text">{s.text}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}
