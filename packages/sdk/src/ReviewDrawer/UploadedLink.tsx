import { getStrings } from '../i18n';

type Mode = 'bug' | 'design';

/** Link to the just-uploaded replay (bug) / design report so the reviewer can
 *  open and eyeball it before filing. Renders nothing when the host returned no URL. */
export function UploadedLink({ url, mode }: { url: string | undefined; mode: Mode }) {
  if (!url) return null;
  const t = getStrings();
  return (
    <a className="bugzar-uploaded-link" href={url} target="_blank" rel="noreferrer">
      <span aria-hidden="true">↗</span>
      {mode === 'design' ? t.viewReport : t.viewReplay}
    </a>
  );
}
