// Clipboard copy with transient "copied" feedback. Mirrors the design view's
// 1.5s pattern; the feedback should be announced via an aria-live/role=status
// region by the caller. Works under the export CSP (clipboard needs no
// connect-src, only a user gesture).

import { useCallback, useState } from 'react';

export function useCopy(resetMs = 1500): { copied: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(
    (text: string) => {
      void navigator.clipboard?.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), resetMs);
    },
    [resetMs],
  );
  return { copied, copy };
}
