import type { ReactNode } from 'react';
import { getStrings } from '../i18n';

/** OAuth "connect Atlassian" gate shown before the form (clientId mode only). */
export function ConnectGate({
  uploadedLink,
  authError,
  connecting,
  authLoading,
  connect,
  onClose,
}: {
  uploadedLink: ReactNode;
  authError: string | null;
  connecting: boolean;
  authLoading: boolean;
  connect: () => Promise<void>;
  onClose: () => void;
}) {
  const t = getStrings();
  return (
    <div className="bugzar-connect">
      <div className="bugzar-connect-head">
        <span className="bugzar-connect-check" aria-hidden="true">
          ✓
        </span>
        {t.jiraReportUploaded}
      </div>
      {uploadedLink}
      <p className="bugzar-connect-hint">{t.jiraConnectHint}</p>
      {authError ? <output className="bugzar-ai-error">{t.jiraAuthFailed}</output> : null}
      <button
        type="button"
        className="bugzar-btn bugzar-btn-primary"
        onClick={() => void connect()}
        disabled={connecting || authLoading}
      >
        {connecting ? t.jiraConnecting : t.jiraConnect}
      </button>
      <button type="button" className="bugzar-btn bugzar-btn-ghost" onClick={onClose}>
        {t.jiraSkip}
      </button>
    </div>
  );
}
