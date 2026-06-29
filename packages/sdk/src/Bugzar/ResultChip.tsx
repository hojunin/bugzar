import { useState } from 'react';
import { getStrings } from '../i18n';
import { UploadedLink } from '../ReviewDrawer/UploadedLink';

/** Post-capture chip shown when there's no Jira drawer: a shareable link the host
 *  returned (Open + Copy), or a confirmation the HTML was downloaded locally (#22). */
export type ResultState =
  | { kind: 'link'; mode: 'bug' | 'design'; url: string }
  | { kind: 'downloaded'; mode: 'bug' | 'design' };

/**
 * The terminal result chip — sits in the toolbar slot until dismissed. Reuses the
 * drawer's `UploadedLink` for the Open affordance; Copy/dismiss use neutral classes
 * (never `.bugzar-fab`/`.bugzar-pill`) so the #21 press guard leaves them alone.
 */
export function ResultChip({ result, onDismiss }: { result: ResultState; onDismiss: () => void }) {
  const t = getStrings();
  const [copied, setCopied] = useState(false);

  const heading =
    result.kind === 'downloaded'
      ? t.downloaded
      : result.mode === 'design'
        ? t.designReady
        : t.replayReady;

  const copy = () => {
    if (result.kind !== 'link') return;
    // Secure-context guard; copy the already-resolved URL synchronously so the
    // click's user activation covers the clipboard write.
    navigator.clipboard?.writeText(result.url).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };

  return (
    // <output> has an implicit role="status" + aria-live="polite" — the result is
    // announced when it replaces the uploading state, without stealing focus.
    <output className="bugzar-chip">
      <span className="bugzar-chip-label">{heading}</span>
      {result.kind === 'link' && (
        <>
          <UploadedLink url={result.url} mode={result.mode} />
          <button type="button" className="bugzar-chip-copy" onClick={copy}>
            {copied ? t.copied : t.share}
          </button>
        </>
      )}
      <button
        type="button"
        className="bugzar-chip-dismiss"
        aria-label={t.dismiss}
        onClick={onDismiss}
      >
        ×
      </button>
    </output>
  );
}
