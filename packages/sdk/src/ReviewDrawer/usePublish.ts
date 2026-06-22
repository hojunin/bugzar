import { useCallback, useState } from 'react';
import { publishIssue } from '../oauth/atlassian';
import type { AuthState } from '../oauth/use-atlassian-auth';
import type { PublishResult } from '../public-types';
import { saveLastEpic } from './last-epic';

const JSON_HEADERS = { 'content-type': 'application/json' };

type Mode = 'bug' | 'design';

interface UsePublishArgs {
  oauth: boolean;
  base: string;
  headers: Record<string, string>;
  mode: Mode;
  authState: AuthState;
  getToken: () => Promise<string | null>;
  title: string;
  description: string;
  epicKey: string;
  epicQuery: string;
  getDescAdf: (description: string) => unknown;
  onPublished: ((result: PublishResult) => void) | undefined;
}

export interface Publish {
  phase: 'edit' | 'publishing' | 'done';
  published: PublishResult | null;
  error: boolean;
  publish: () => Promise<void>;
}

/** The publish state machine: OAuth (file as the user) or service-account route. */
export function usePublish({
  oauth,
  base,
  headers,
  mode,
  authState,
  getToken,
  title,
  description,
  epicKey,
  epicQuery,
  getDescAdf,
  onPublished,
}: UsePublishArgs): Publish {
  const [phase, setPhase] = useState<'edit' | 'publishing' | 'done'>('edit');
  const [published, setPublished] = useState<PublishResult | null>(null);
  const [error, setError] = useState(false);

  const publish = useCallback(async () => {
    setError(false);
    setPhase('publishing');
    // Project is derived from the chosen epic (`BUGZAR-123` → `BUGZAR`).
    const effectiveProjectKey = epicKey.split('-')[0] ?? '';
    const descAdf = getDescAdf(description);
    try {
      if (oauth) {
        if (authState.kind !== 'authenticated') throw new Error('not connected');
        const token = await getToken();
        if (!token) throw new Error('no token');
        const { site } = authState.session;
        const r = await publishIssue({ base, headers }, token, {
          cloudId: site.id,
          siteUrl: site.url,
          projectKey: effectiveProjectKey,
          title: title.trim(),
          issueType: mode === 'design' ? 'Task' : 'Bug',
          ...(description.trim() ? { description } : {}),
          ...(descAdf ? { descriptionAdf: descAdf } : {}),
          ...(epicKey ? { epicKey } : {}),
        });
        const result: PublishResult = {
          issueKey: r.issueKey,
          issueUrl: r.issueUrl,
          stubbed: false,
        };
        setPublished(result);
        setPhase('done');
        if (epicKey) saveLastEpic(epicKey, epicQuery);
        onPublished?.(result);
        return;
      }

      const body: Record<string, unknown> = {
        title: title.trim(),
        projectKey: effectiveProjectKey,
      };
      if (epicKey) body.epicKey = epicKey;
      if (description.trim()) body.description = description;
      if (descAdf) body.descriptionAdf = descAdf;
      const res = await fetch(`${base}/jira/publish`, {
        method: 'POST',
        headers: { ...JSON_HEADERS, ...headers },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`publish ${res.status}`);
      const data = (await res.json()) as PublishResult;
      const result: PublishResult = {
        issueKey: data.issueKey,
        issueUrl: data.issueUrl,
        stubbed: Boolean(data.stubbed),
      };
      setPublished(result);
      setPhase('done');
      if (epicKey && !result.stubbed) saveLastEpic(epicKey, epicQuery);
      onPublished?.(result);
    } catch {
      setError(true);
      setPhase('edit');
    }
  }, [
    base,
    headers,
    epicKey,
    epicQuery,
    title,
    description,
    onPublished,
    oauth,
    mode,
    authState,
    getToken,
    getDescAdf,
  ]);

  return { phase, published, error, publish };
}
