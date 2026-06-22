import type { ExportMeta } from './public-types';

/**
 * Drop-in `onExport` that saves the built replay HTML to the user's machine
 * instead of uploading it — the no-`endpoint`, no-sharing path:
 *
 *   import { Bugzar, downloadReplay } from '@bugzar/sdk';
 *   <Bugzar onExport={downloadReplay} />
 *
 * The file is named `bugzar-<mode>-<startedAt>.html`. Returns nothing (the object
 * URL is local and revoked immediately) — wrap it if you want a custom filename
 * or a shareable URL.
 */
export async function downloadReplay(blob: Blob, meta: ExportMeta): Promise<void> {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `bugzar-${meta.mode}-${meta.startedAt}.html`;
  a.click();
  URL.revokeObjectURL(url);
}
