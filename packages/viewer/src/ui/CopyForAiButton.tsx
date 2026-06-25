// B2 — a reusable per-item "Copy for AI" button. Own copy state so each row's
// feedback is independent; announces success via an aria-live status region.
// `getText` is lazy so the (curated, redacted) context is built only on click.

import { useCopy } from './useCopy';

export function CopyForAiButton({
  getText,
  label = 'Copy for AI',
}: {
  getText: () => string;
  label?: string;
}) {
  const { copied, copy } = useCopy();
  return (
    <>
      <button
        type="button"
        className="bugzarv-dz-copy"
        onClick={() => copy(getText())}
        aria-label={label}
      >
        {copied ? 'Copied ✓' : label}
      </button>
      <output className="bugzarv-sr">{copied ? 'Copied to clipboard' : ''}</output>
    </>
  );
}
