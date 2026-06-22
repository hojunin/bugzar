// @bugzar/sdk/export — build a self-contained, OFFLINE replay HTML from a captured
// bundle OR a design-pick report (Phase D). Double-click the file at file:// and
// the full @bugzar/viewer (replay + console/network/storage panels, or the design
// annotation view) runs with no backend and no network.
//
// Heavy assets (the ~478 KB inlined viewer IIFE) live in THIS module, so the
// core `@bugzar/sdk` bundle never pays for them — consumers reach this only via the
// `@bugzar/sdk/export` subpath (or Bugzar's lazy import on `download:'html'`).

import { SCHEMA_VERSION } from '@bugzar/shared';
import type { DesignAnnotation, ReportBundle, RrwebEvent, SystemInfo } from './public-types';
import { VIEWER_JS } from './viewer-asset.generated';

// Mirrors the Worker's REPLAY_CSP, minus the directives a <meta> CSP can't carry
// (frame-ancestors). Contains the replayed (attacker-influenced) DOM: no remote
// scripts, inline-only. img/font load read-only over https (like REPLAY_CSP) so
// captured pages with self-hosted/CDN webfonts (e.g. Pretendard) actually render
// instead of falling back to a system font; connect-src stays data:/blob: (no exfil).
const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob: https:',
  'media-src data: blob:',
  'font-src https: data:',
  "frame-src 'self' about: blob: data:",
  "child-src 'self' about: blob: data:",
  'connect-src blob: data:',
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const bytesToB64 = (bytes: Uint8Array): string => {
  let bin = '';
  const chunk = 0x8000; // chunk so the spread never overflows the call stack
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
};

const gzip = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  void writer.write(bytes);
  void writer.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
};

// Prevent an embedded `</script>` (in the minified viewer) from closing the tag.
const escapeScript = (s: string): string => s.replace(/<\/(script)/gi, '<\\/$1');

/** Encode a viewer ReportData into the self-contained offline HTML Blob. */
const buildHtml = async (reportData: unknown): Promise<Blob> => {
  const raw = new TextEncoder().encode(JSON.stringify(reportData));
  const hasCompression = typeof CompressionStream !== 'undefined';
  const payload = hasCompression ? await gzip(raw) : raw;
  const b64 = bytesToB64(payload);
  const encoding = hasCompression ? 'gzip' : 'identity';

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="${CSP}" />
<title>QA Replay</title>
<style>html,body{margin:0;height:100%;background:#09090b}#root{min-height:100vh}</style>
</head>
<body>
<div id="root"></div>
<script type="application/json" id="bugzar-data" data-encoding="${encoding}">${b64}</script>
<script>${escapeScript(VIEWER_JS)}</script>
<script>
(function(){
  var el = document.getElementById('bugzar-data');
  var bin = atob(el.textContent || '');
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  var decode = function(text){
    try {
      var data = JSON.parse(text);
      if (window.__BUGZAR_MOUNT__) window.__BUGZAR_MOUNT__(data);
      else window.__BUGZAR_REPORT__ = data;
    } catch (e) {
      document.getElementById('root').textContent = 'Failed to load report: ' + e;
    }
  };
  if (el.getAttribute('data-encoding') === 'gzip' && typeof DecompressionStream !== 'undefined') {
    var ds = new DecompressionStream('gzip');
    var w = ds.writable.getWriter(); w.write(bytes); w.close();
    new Response(ds.readable).arrayBuffer().then(function(buf){ decode(new TextDecoder().decode(buf)); });
  } else if (el.getAttribute('data-encoding') === 'gzip') {
    document.getElementById('root').textContent = 'This browser cannot decompress the report (needs DecompressionStream).';
  } else {
    decode(new TextDecoder().decode(bytes));
  }
})();
</script>
</body>
</html>`;

  return new Blob([html], { type: 'text/html;charset=utf-8' });
};

/**
 * Build a self-contained offline replay HTML for a recorded session bundle.
 * Returns a `text/html` Blob. Record with `inlineAssets` so images/styles are
 * embedded and the replay works fully offline.
 */
export async function exportReportHtml(bundle: ReportBundle): Promise<Blob> {
  return buildHtml({
    meta: { ...bundle.meta, mode: 'session', source: 'sdk', schemaVersion: SCHEMA_VERSION },
    events: bundle.events,
    console: bundle.console,
    network: bundle.network,
    storage: bundle.storage,
    resources: bundle.resources,
    state: bundle.state,
    vitals: bundle.vitals,
    system: bundle.system,
    design: [],
  });
}

/**
 * Build a self-contained offline HTML for a design-pick report — the page
 * snapshot with the picked elements pinned + their notes (the viewer's design
 * view). The backend-less counterpart of `uploadDesign`. Pass the one-shot DOM
 * `events` snapshot (captured with `inlineAssets` for an offline-faithful page).
 */
export async function exportDesignHtml(
  annotations: DesignAnnotation[],
  events: RrwebEvent[] = [],
  system: SystemInfo | null = null,
): Promise<Blob> {
  // Map `note` → `userNote` (the field the viewer's design view reads), matching
  // `uploadDesign`'s remap so notes survive.
  const design = annotations.map((a) => ({
    selector: a.selector,
    tagName: a.tagName,
    textContent: a.textContent,
    cssClasses: a.cssClasses,
    rect: a.rect,
    ...(a.componentName ? { componentName: a.componentName } : {}),
    ...(a.attributes ? { attributes: a.attributes } : {}),
    ...(a.figmaUrl ? { figmaUrl: a.figmaUrl } : {}),
    userNote: a.note,
  }));
  const now = Date.now();
  return buildHtml({
    meta: {
      url: typeof location !== 'undefined' ? location.href : '',
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      viewport: {
        width: typeof window !== 'undefined' ? window.innerWidth : 0,
        height: typeof window !== 'undefined' ? window.innerHeight : 0,
      },
      startedAt: now,
      endedAt: now,
      durationMs: 0,
      mode: 'design',
      source: 'sdk',
      schemaVersion: SCHEMA_VERSION,
    },
    events,
    console: [],
    network: [],
    storage: [],
    resources: [],
    state: [],
    vitals: {},
    system,
    design,
  });
}
