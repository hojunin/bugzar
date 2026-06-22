import { useCallback, useRef, useState } from 'react';
import type { DesignAnnotation, ReportBundle } from '../public-types';
import { adfToText } from './utils';

const JSON_HEADERS = { 'content-type': 'application/json' };

type Mode = 'bug' | 'design';

interface UseAiPolishArgs {
  mode: Mode;
  url: string | undefined;
  base: string;
  headers: Record<string, string>;
  bundle: ReportBundle | undefined;
  annotations: DesignAnnotation[] | undefined;
  title: string;
  description: string;
  setTitle: (value: string) => void;
  setDescription: (value: string) => void;
}

export interface AiPolish {
  busy: boolean;
  error: boolean;
  polish: () => Promise<void>;
  /** The rich ADF the AI produced — but only while `description` is unedited. */
  getDescAdf: (description: string) => unknown;
}

/** AI-draft the title/description via the Worker, preserving the rich ADF. */
export function useAiPolish({
  mode,
  url,
  base,
  headers,
  bundle,
  annotations,
  title,
  description,
  setTitle,
  setDescription,
}: UseAiPolishArgs): AiPolish {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const adfRef = useRef<unknown>(null);
  const textRef = useRef('');

  const polish = useCallback(async () => {
    setError(false);
    setBusy(true);
    const userInput = [title, description]
      .map((s) => s.trim())
      .filter(Boolean)
      .join('\n\n');
    // Capture data is sent INLINE — the Worker no longer reads a hosted report.
    const draftBody =
      mode === 'design'
        ? {
            mode,
            userInput,
            url,
            elements: (annotations ?? []).map((a) => ({
              id: a.id,
              selector: a.selector,
              tagName: a.tagName,
              textContent: a.textContent,
              ...(a.componentName ? { componentName: a.componentName } : {}),
              rect: a.rect,
              userNote: a.note,
            })),
            meta: {
              url: typeof location !== 'undefined' ? location.href : '',
              mode: 'design',
            },
          }
        : {
            mode,
            userInput,
            url,
            artifacts: bundle
              ? {
                  meta: bundle.meta,
                  events: bundle.events,
                  console: bundle.console,
                  network: bundle.network,
                  storage: bundle.storage,
                }
              : {},
          };
    try {
      const res = await fetch(`${base}/jira/draft`, {
        method: 'POST',
        headers: { ...JSON_HEADERS, ...headers },
        body: JSON.stringify(draftBody),
      });
      if (!res.ok) throw new Error(`draft ${res.status}`);
      const data = (await res.json()) as {
        title?: string;
        description?: unknown;
      };
      const text = adfToText(data.description);
      if (data.title) setTitle(data.title);
      setDescription(text);
      adfRef.current = data.description ?? null;
      textRef.current = text;
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }, [base, headers, mode, url, title, description, bundle, annotations, setTitle, setDescription]);

  const getDescAdf = useCallback(
    (desc: string): unknown =>
      adfRef.current && desc === textRef.current ? adfRef.current : undefined,
    [],
  );

  return { busy, error, polish, getDescAdf };
}
