import { useEffect, useMemo, useState } from 'react';
import { searchEpics } from '../oauth/atlassian';
import type { AuthState } from '../oauth/use-atlassian-auth';
import { loadLastEpic } from './last-epic';

export interface Epic {
  key: string;
  summary: string;
}

interface UseEpicSearchArgs {
  defaultEpicKey: string | undefined;
  base: string;
  headers: Record<string, string>;
  oauth: boolean;
  getToken: () => Promise<string | null>;
  authState: AuthState;
}

export interface EpicSearch {
  query: string;
  key: string;
  results: Epic[];
  open: boolean;
  loading: boolean;
  onQueryChange: (value: string) => void;
  onFocus: () => void;
  select: (epic: Epic) => void;
}

/** The epic search combobox machine: prefill, debounced search, and selection. */
export function useEpicSearch({
  defaultEpicKey,
  base,
  headers,
  oauth,
  getToken,
  authState,
}: UseEpicSearchArgs): EpicSearch {
  // Prefill the epic: an explicit `defaultEpicKey` wins; otherwise reuse the epic
  // you last published to (so repeated reports to the same epic are one-click).
  const prefillEpic = useMemo(
    () => (defaultEpicKey ? { key: defaultEpicKey, summary: defaultEpicKey } : loadLastEpic()),
    [defaultEpicKey],
  );
  const [query, setQuery] = useState(prefillEpic?.summary ?? '');
  const [key, setKey] = useState(prefillEpic?.key ?? '');
  const [touched, setTouched] = useState(false);
  const [results, setResults] = useState<Epic[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  // Debounced, project-scoped epic search. OAuth mode searches via the user's
  // token through the Worker proxy; legacy mode uses the service-account route.
  useEffect(() => {
    if (!touched) return;
    const q = query.trim();
    if (!q) {
      setResults([]);
      setOpen(false);
      setLoading(false);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        if (oauth) {
          const token = await getToken();
          const cloudId = authState.kind === 'authenticated' ? authState.session.site.id : '';
          if (!token || !cloudId) {
            setResults([]);
            return;
          }
          setResults(await searchEpics({ base, headers }, token, cloudId, q));
        } else {
          const url = `${base}/jira/epics?q=${encodeURIComponent(q)}`;
          const res = await fetch(url, { headers });
          const data = (await res.json()) as { epics?: Epic[] };
          setResults(data.epics ?? []);
        }
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
        setOpen(true);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [query, touched, base, headers, oauth, getToken, authState]);

  const onQueryChange = (value: string): void => {
    setTouched(true);
    setQuery(value);
    setKey('');
    // Open the dropdown the instant there's input — show a loading state until
    // the debounced search resolves.
    if (value.trim()) {
      setOpen(true);
      setLoading(true);
    } else {
      setOpen(false);
      setLoading(false);
    }
  };

  const onFocus = (): void => {
    if (query.trim()) setOpen(true);
  };

  const select = (epic: Epic): void => {
    setQuery(epic.summary);
    setKey(epic.key);
    setOpen(false);
  };

  return { query, key, results, open, loading, onQueryChange, onFocus, select };
}
