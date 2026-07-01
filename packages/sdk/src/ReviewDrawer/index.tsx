'use client';

import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import { getStrings } from '../i18n';
import { useAtlassianAuth } from '../oauth/use-atlassian-auth';
import type { DesignAnnotation, PublishResult, ReportBundle } from '../public-types';
import { type Endpoint, resolveEndpoint } from '../upload';
import { ConnectGate } from './ConnectGate';
import { DrawerForm } from './DrawerForm';
import { PublishedView } from './PublishedView';
import { UploadedLink } from './UploadedLink';
import { useAiPolish } from './useAiPolish';
import { useEpicSearch } from './useEpicSearch';
import { usePublish } from './usePublish';

type Mode = 'bug' | 'design';

export interface ReviewDrawerProps {
  mode: Mode;
  endpoint: Endpoint;
  /** R2/S3 replay URL from `onExport` — linked in the filed issue (optional). */
  url?: string;
  /** When set, the drawer files as the connected user via OAuth (not the service account). */
  clientId?: string;
  defaultEpicKey?: string;
  /** Bug mode — drives the read-only capture summary. */
  bundle?: ReportBundle;
  /** Design mode — drives the imageless element cards. */
  annotations?: DesignAnnotation[];
  position: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  theme: 'light' | 'dark' | 'auto';
  /** Inline CSS-variable overrides for the corner inset (--bugzar-offset-*). */
  style?: CSSProperties;
  onPublished?: (result: PublishResult) => void;
  onClose: () => void;
}

/**
 * The review drawer — the M4/F4.3 publish surface. Opens after the bundle (bug)
 * or annotations (design) are uploaded, leads with a read-only capture summary,
 * lets the tester title/describe/pick-epic, AI-polish via the Worker, and file a
 * Jira issue.
 *
 * Two publish modes: with `clientId` it's per-user OAuth (the ticket is filed AS
 * the connected reviewer); otherwise the Worker's service account files it (and
 * an unconfigured Worker returns an explicit `stubbed:true`).
 *
 * This container owns the shared form state (title/description) and the auth
 * context, then routes to one of three screens — published / connect / edit.
 */
export function ReviewDrawer({
  mode,
  endpoint,
  url,
  clientId,
  defaultEpicKey,
  bundle,
  annotations,
  position,
  theme,
  style,
  onPublished,
  onClose,
}: ReviewDrawerProps) {
  const { base, headers } = useMemo(() => resolveEndpoint(endpoint), [endpoint]);
  const t = getStrings();
  const oauth = !!clientId;
  const {
    state: authState,
    connect,
    disconnect,
    connecting,
    error: authError,
    getToken,
  } = useAtlassianAuth(endpoint, clientId);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');

  const epic = useEpicSearch({ defaultEpicKey, base, headers, oauth, getToken, authState });
  const ai = useAiPolish({
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
  });
  const pub = usePublish({
    oauth,
    base,
    headers,
    mode,
    authState,
    getToken,
    title,
    description,
    epicKey: epic.key,
    epicQuery: epic.query,
    getDescAdf: ai.getDescAdf,
    onPublished,
  });

  // Escape closes (Cancel) from any screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const uploadedLink = <UploadedLink url={url} mode={mode} />;

  return (
    <div
      className={`bugzar-root bugzar-${position} bugzar-theme-${theme}`}
      {...(style ? { style } : {})}
      role="dialog"
      aria-modal="true"
      aria-label={mode === 'design' ? t.drawerTitleDesign : t.drawerTitleBug}
    >
      <div className="bugzar-drawer">
        {pub.phase === 'done' && pub.published ? (
          <PublishedView published={pub.published} onClose={onClose} />
        ) : oauth && authState.kind !== 'authenticated' ? (
          <ConnectGate
            reportUrl={url}
            authError={authError}
            connecting={connecting}
            authLoading={authState.kind === 'loading'}
            connect={connect}
            onClose={onClose}
          />
        ) : (
          <DrawerForm
            mode={mode}
            oauth={oauth}
            authState={authState}
            disconnect={disconnect}
            uploadedLink={uploadedLink}
            annotations={annotations}
            title={title}
            description={description}
            setTitle={setTitle}
            setDescription={setDescription}
            ai={ai}
            epic={epic}
            pub={pub}
            onClose={onClose}
          />
        )}
      </div>
    </div>
  );
}
