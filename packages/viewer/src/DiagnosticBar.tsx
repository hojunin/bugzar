// A1 + B1 — the diagnostic bar. A compact band (NOT a full screen) at the top of
// the session view that names the symptom, counts errors/failures, and offers a
// one-click "Copy for AI". Bounded height so the player below stays visible
// (§C1); collapses on scroll via sticky positioning.

import { useMemo, useState } from 'react';
import type { TabKey } from './panels/tabs';
import { formatSessionForAI } from './report/ai-context';
import { deriveDiagnostics, isFailedRequest } from './report/diagnostics';
import type { ReportData } from './report/types';
import { useCopy } from './ui/useCopy';

const COPY_INCLUDES =
  'Includes: failing request + body, errors + stack, reproduction, environment (redacted)';

export interface DiagnosticBarProps {
  data: ReportData;
  /** Jump the player + sidebar to a moment in a given tab. */
  onJump: (tab: TabKey, t: number) => void;
  /** Optional reproduction steps to fold into the AI copy (A2). */
  reproSteps?: string[];
}

export function DiagnosticBar({ data, onJump, reproSteps }: DiagnosticBarProps) {
  const d = useMemo(() => deriveDiagnostics(data), [data]);
  const copyText = useMemo(
    () => formatSessionForAI(data, reproSteps?.length ? { reproSteps } : {}),
    [data, reproSteps],
  );
  const { copied, copy } = useCopy();
  const [infoOpen, setInfoOpen] = useState(false);

  const firstError = data.console.find((c) => c.level === 'error');
  const firstFailed = data.network.find(isFailedRequest);

  // Headline = the captured URL — a definite, known fact (not a guessed "main"
  // error). The symptom still leads the Copy-for-AI; severity/counts convey it
  // here. Environment/system details live in the System Info tab, not the header.
  const url = d.url || data.meta?.url || '(report)';

  return (
    <section className={`bugzarv-diag bugzarv-diag-${d.severity}`} aria-label="Diagnostic summary">
      <div className="bugzarv-diag-main">
        <span className="bugzarv-diag-dot" aria-hidden="true" />
        <h2 className="bugzarv-diag-headline" title={url}>
          {url}
        </h2>
      </div>

      <div className="bugzarv-diag-meta">
        {firstError ? (
          <button
            type="button"
            className="bugzarv-diag-chip bugzarv-diag-chip-error"
            onClick={() => onJump('console', firstError.tFromStart)}
          >
            {d.errorCount} error{d.errorCount === 1 ? '' : 's'}
          </button>
        ) : null}
        {firstFailed ? (
          <button
            type="button"
            className="bugzarv-diag-chip bugzarv-diag-chip-failed"
            onClick={() => onJump('network', firstFailed.tFromStart)}
          >
            {d.failedCount} failed
          </button>
        ) : null}
      </div>

      <div className="bugzarv-diag-copy">
        <button
          type="button"
          className="bugzarv-dz-copyall"
          onClick={() => copy(copyText)}
          aria-label="Copy report for AI"
        >
          {copied ? 'Copied ✓' : 'Copy for AI'}
        </button>
        <span className="bugzarv-diag-infowrap">
          <button
            type="button"
            className="bugzarv-diag-info"
            aria-label="What the copy includes"
            aria-expanded={infoOpen}
            onClick={() => setInfoOpen((v) => !v)}
            onBlur={() => setInfoOpen(false)}
          >
            ⓘ
          </button>
          {infoOpen ? (
            <span className="bugzarv-diag-tip" role="tooltip">
              {COPY_INCLUDES}
            </span>
          ) : null}
        </span>
        <output className="bugzarv-sr">{copied ? 'Report copied to clipboard' : ''}</output>
      </div>
    </section>
  );
}
