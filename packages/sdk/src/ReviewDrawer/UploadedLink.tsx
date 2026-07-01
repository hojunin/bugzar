import { getStrings } from '../i18n';
import { isSafeUrl } from '../safe-url';

type Mode = 'bug' | 'design';

/** Link to the just-uploaded replay (bug) / design report so the reviewer can
 *  open and eyeball it before filing. Renders nothing when the host returned no
 *  URL, or a non-http(s) one (a `javascript:` href would run on click). */
export function UploadedLink({ url, mode }: { url: string | undefined; mode: Mode }) {
  if (!isSafeUrl(url)) return null;
  const t = getStrings();
  return (
    <a className="bugzar-uploaded-link" href={url} target="_blank" rel="noreferrer">
      <span aria-hidden="true">↗</span>
      {mode === 'design' ? t.viewReport : t.viewReplay}
    </a>
  );
}
