import { getStrings } from '../i18n';
import type { PublishResult } from '../public-types';

/** Post-publish screen — the real issue link, or the stub "not-real" note. */
export function PublishedView({
  published,
  onClose,
}: {
  published: PublishResult;
  onClose: () => void;
}) {
  const t = getStrings();
  return (
    <div className="bugzar-published">
      <div className="bugzar-published-title">
        {published.stubbed ? t.draftCreated : t.jiraIssueCreated}
      </div>
      {published.stubbed ? (
        <>
          <code className="bugzar-issue-key">{published.issueKey}</code>
          <p className="bugzar-published-note">{t.draftNotFiledNote}</p>
        </>
      ) : (
        <a className="bugzar-issue-link" href={published.issueUrl} target="_blank" rel="noreferrer">
          {published.issueKey}
        </a>
      )}
      <div className="bugzar-drawer-actions">
        <button type="button" className="bugzar-btn" onClick={onClose}>
          {t.close}
        </button>
      </div>
    </div>
  );
}
