import { useState } from 'react';
import { getStrings } from '../i18n';
import type { AtlassianSession } from '../oauth/atlassian';
import type { AuthState } from '../oauth/use-atlassian-auth';
import { initials } from './utils';

/** The connected Atlassian account: avatar button + name/disconnect popover.
 *  Owns its own avatar-broke fallback — the avatar can 404 or be CSP-blocked. */
function AccountBadge({
  profile,
  disconnect,
}: {
  profile: AtlassianSession['profile'];
  disconnect: () => void;
}) {
  const t = getStrings();
  // The Atlassian avatar can 404 or be blocked by the host page's CSP — fall back
  // to initials when the <img> fails to load.
  const [avatarBroke, setAvatarBroke] = useState(false);
  return (
    <div className="bugzar-acct">
      <button type="button" className="bugzar-acct-av" aria-label={profile.displayName}>
        {profile.avatarUrl && !avatarBroke ? (
          <img
            className="bugzar-acct-img"
            src={profile.avatarUrl}
            alt=""
            onError={() => setAvatarBroke(true)}
          />
        ) : (
          initials(profile.displayName)
        )}
      </button>
      <div className="bugzar-acct-pop">
        <span className="bugzar-acct-pop-name">{profile.displayName}</span>
        <button type="button" className="bugzar-acct-disc" onClick={disconnect}>
          {t.jiraDisconnect}
        </button>
      </div>
    </div>
  );
}

/** Drawer title + (in OAuth mode, when connected) the account badge. */
export function DrawerHeader({
  title,
  oauth,
  authState,
  disconnect,
}: {
  title: string;
  oauth: boolean;
  authState: AuthState;
  disconnect: () => void;
}) {
  return (
    <div className="bugzar-drawer-header">
      <span className="bugzar-drawer-title">{title}</span>
      {oauth && authState.kind === 'authenticated' ? (
        <AccountBadge profile={authState.session.profile} disconnect={disconnect} />
      ) : null}
    </div>
  );
}
