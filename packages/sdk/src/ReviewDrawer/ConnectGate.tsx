import { getStrings } from '../i18n';
import { isSafeUrl } from '../safe-url';

/** OAuth "connect Atlassian" gate shown before the form (clientId mode only). */
export function ConnectGate({
  reportUrl,
  authError,
  connecting,
  authLoading,
  connect,
  onClose,
}: {
  reportUrl: string | undefined;
  authError: string | null;
  connecting: boolean;
  authLoading: boolean;
  connect: () => Promise<void>;
  onClose: () => void;
}) {
  const t = getStrings();
  // "Skip" doubles as "open the report": file nothing in Jira, just pop the
  // uploaded report in a new tab (when the host returned a URL), then close.
  const skip = (): void => {
    // Only pop http(s) URLs — a javascript:/data: reportUrl would run in this page.
    if (isSafeUrl(reportUrl)) window.open(reportUrl, '_blank', 'noopener,noreferrer');
    onClose();
  };
  return (
    <div className="bugzar-connect">
      <div className="bugzar-connect-head">
        <span className="bugzar-connect-check" aria-hidden="true">
          ✓
        </span>
        {t.jiraReportUploaded}
      </div>
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
      <button type="button" className="bugzar-btn bugzar-btn-ghost" onClick={skip}>
        {t.jiraSkip}
      </button>
    </div>
  );
}
