/**
 * Bugzar backend — GET / report index page.
 *
 * Lists every published report in the R2 bucket and renders the human-facing
 * HTML dashboard. Extracted from worker.ts; the router calls handleListReports.
 */

import {
  applyReplaySecurityHeaders,
  buildOrigin,
  CORS_HEADERS,
  type Env,
  escapeHtmlAttr,
} from './runtime';

/**
 * GET /  — index page listing every report in the bucket.
 *
 * Strategy: list R2 with `prefix: 'reports/'`, filter to keys ending in
 * `/meta.json`, fetch each meta's body to read url/startedAt/durationMs,
 * infer mode from whether `design.json` exists alongside, then render an
 * HTML table sorted by recency.
 *
 * Costs: ~1 list + N gets per render. For small QA teams (< few hundred
 * reports) this is fine. If usage grows we'll:
 *   - cache the index in a Worker KV (refresh on each `handleCreateReport`)
 *   - store url/mode in meta.json's R2 customMetadata so list() alone is enough
 *
 * Cache-Control is short (60s) so a fresh report shows up within a minute
 * but repeated dashboard refreshes don't hammer R2.
 */
interface ReportIndexEntry {
  id: string;
  url: string;
  startedAt: number;
  durationMs: number | null;
  mode: 'video' | 'design' | 'session';
  /**
   * 리포트를 발행한 Atlassian 사용자 — 추출은 extension 의 submit-chain 이
   * meta.json 에 박는다. 구식 리포트엔 누락되어 있을 수 있어 옵셔널.
   * avatar 는 Atlassian CDN 의 HTTPS URL — replay CSP `img-src https:` 통과.
   */
  author?: {
    displayName: string;
    avatar?: string;
  };
}

const REPORT_LIST_LIMIT = 500;

export const handleListReports = async (env: Env, reqUrl: URL): Promise<Response> => {
  const origin = buildOrigin(env, reqUrl);

  // Step 1: list every object under reports/. We get up to 1000 keys per
  // page; loop until the cursor runs out or we hit our soft limit. For the
  // expected scale this rarely needs more than one page.
  const allObjects: { key: string; uploaded: Date }[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.ARTIFACTS.list({
      prefix: 'reports/',
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const o of page.objects) {
      allObjects.push({ key: o.key, uploaded: o.uploaded });
    }
    cursor = page.truncated ? page.cursor : undefined;
    // Hard cap so a runaway listing can't burn the whole CPU budget.
    if (allObjects.length >= REPORT_LIST_LIMIT * 10) break;
  } while (cursor);

  // Step 2: bucket keys by reportId, note which assets exist + the most
  // recent upload time per report.
  const byReport = new Map<
    string,
    { hasDesign: boolean; hasVideo: boolean; metaKey?: string; latestUpload: number }
  >();
  for (const obj of allObjects) {
    const m = /^reports\/([a-z0-9-]+)\/([^/]+)$/i.exec(obj.key);
    if (!m) continue;
    const id = m[1];
    const file = m[2];
    if (!id || !file) continue;
    const entry = byReport.get(id) ?? { hasDesign: false, hasVideo: false, latestUpload: 0 };
    if (file === 'design.json') entry.hasDesign = true;
    if (file.startsWith('video.')) entry.hasVideo = true;
    if (file === 'meta.json') entry.metaKey = obj.key;
    const upTime = obj.uploaded.getTime();
    if (upTime > entry.latestUpload) entry.latestUpload = upTime;
    byReport.set(id, entry);
  }

  // Step 3: fetch each report's meta.json body in parallel. Reports
  // without a meta.json (e.g. partial uploads) are dropped — listing them
  // would just confuse the reviewer.
  const candidates = [...byReport.entries()]
    .filter(([, v]) => v.metaKey)
    .sort((a, b) => b[1].latestUpload - a[1].latestUpload)
    .slice(0, REPORT_LIST_LIMIT);

  const entries: ReportIndexEntry[] = (
    await Promise.all(
      candidates.map(async ([id, info]): Promise<ReportIndexEntry | null> => {
        if (!info.metaKey) return null;
        try {
          const obj = await env.ARTIFACTS.get(info.metaKey);
          if (!obj) return null;
          const text = await obj.text();
          const meta = JSON.parse(text) as {
            url?: unknown;
            startedAt?: unknown;
            durationMs?: unknown;
            author?: unknown;
          };
          // author 는 extension submit-chain 이 박는 `{ accountId, displayName, avatar? }`.
          // worker UI 는 displayName + avatar 만 사용한다. 타입 가드를 좁게
          // 가져가서 meta.json 이 손상돼도 row 가 깨지지 않도록 한다.
          let author: ReportIndexEntry['author'];
          if (
            meta.author &&
            typeof meta.author === 'object' &&
            'displayName' in meta.author &&
            typeof (meta.author as { displayName: unknown }).displayName === 'string'
          ) {
            const a = meta.author as { displayName: string; avatar?: unknown };
            author = {
              displayName: a.displayName,
              ...(typeof a.avatar === 'string' && a.avatar ? { avatar: a.avatar } : {}),
            };
          }
          return {
            id,
            url: typeof meta.url === 'string' ? meta.url : '',
            startedAt: typeof meta.startedAt === 'number' ? meta.startedAt : info.latestUpload,
            durationMs: typeof meta.durationMs === 'number' ? meta.durationMs : null,
            mode: info.hasDesign ? 'design' : info.hasVideo ? 'video' : 'session',
            ...(author ? { author } : {}),
          };
        } catch (err) {
          console.warn('[reports:list] meta parse failed', id, err);
          return null;
        }
      }),
    )
  ).filter((e): e is ReportIndexEntry => e !== null);

  entries.sort((a, b) => b.startedAt - a.startedAt);

  const headers = new Headers(CORS_HEADERS);
  headers.set('content-type', 'text/html; charset=utf-8');
  // Short cache so repeat visits are fast but a new submit shows up within
  // a minute. The R2 list cost is what we're trading off.
  headers.set('cache-control', 'public, max-age=60');
  applyReplaySecurityHeaders(headers);
  return new Response(renderReportsIndexHtml(entries, origin), { headers });
};

const formatDuration = (ms: number | null): string => {
  if (ms === null) return '—';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
};

const formatTimestamp = (ms: number): string => {
  try {
    return new Date(ms).toLocaleString('ko-KR', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return new Date(ms).toISOString();
  }
};

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const pathOf = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return '';
  }
};

const renderAuthorCell = (author: ReportIndexEntry['author']): string => {
  if (!author) return '<div class="cell author empty">—</div>';
  // 아바타 src 는 Atlassian 의 https CDN — 응답 헤더 CSP 가 img-src https
  // 만 허용. 그래도 defense-in-depth 로 http(s) 가 아닌 스킴은 코드 레벨에서
  // 거부하고 이니셜 fallback 으로 떨어진다.
  const safeAvatar = author.avatar && /^https?:\/\//i.test(author.avatar) ? author.avatar : null;
  const initial = author.displayName.trim().charAt(0).toUpperCase() || '?';
  const avatarHtml = safeAvatar
    ? `<img class="avatar" src="${escapeHtmlAttr(safeAvatar)}" alt="" loading="lazy" width="20" height="20" />`
    : `<span class="avatar avatar-fallback" aria-hidden="true">${escapeHtmlAttr(initial)}</span>`;
  return `<div class="cell author">
          ${avatarHtml}
          <span class="name">${escapeHtmlAttr(author.displayName)}</span>
        </div>`;
};

const renderReportsIndexHtml = (entries: ReportIndexEntry[], origin: string): string => {
  const rows = entries
    .map(
      (e) => `
      <a class="row" href="${escapeHtmlAttr(`${origin}/r/${e.id}`)}" data-host="${escapeHtmlAttr(hostOf(e.url))}" data-mode="${escapeHtmlAttr(e.mode)}" data-author="${escapeHtmlAttr(e.author?.displayName ?? '')}">
        <div class="cell mode">
          <span class="chip chip-${escapeHtmlAttr(e.mode)}">${e.mode === 'design' ? '디자인' : e.mode === 'session' ? '세션' : '영상'}</span>
        </div>
        <div class="cell url">
          <div class="host">${escapeHtmlAttr(hostOf(e.url) || '(host 없음)')}</div>
          <div class="path mono">${escapeHtmlAttr(pathOf(e.url))}</div>
        </div>
        ${renderAuthorCell(e.author)}
        <div class="cell when">${escapeHtmlAttr(formatTimestamp(e.startedAt))}</div>
        <div class="cell dur mono">${escapeHtmlAttr(formatDuration(e.durationMs))}</div>
        <div class="cell id mono">${escapeHtmlAttr(e.id.slice(0, 8))}</div>
      </a>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <title>Bugzar Reports</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <!-- Pretendard via jsDelivr (dynamic subset). System fallback covers
       offline / pre-load paint. -->
  <link
    rel="stylesheet"
    href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css"
  />
  <style>
    :root {
      --background: #ffffff;
      --surface: #fafafa;
      --surface-elevated: #ffffff;
      --border: #e5e7eb;
      --foreground: #0f172a;
      --muted-foreground: #64748b;
      --primary: #2563eb;
      --primary-soft: #dbeafe;
      --design: #8b5cf6;
      --design-soft: #ede9fe;
      --video: #10b981;
      --video-soft: #d1fae5;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --background: #09090b;
        --surface: #18181b;
        --surface-elevated: #27272a;
        --border: #3f3f46;
        --foreground: #fafafa;
        --muted-foreground: #a1a1aa;
        --primary: #60a5fa;
        --primary-soft: #1e3a8a;
        --design-soft: #4c1d95;
        --video-soft: #064e3b;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: 'Pretendard Variable', Pretendard, -apple-system, BlinkMacSystemFont,
        'Inter', system-ui, 'Segoe UI', 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif;
      background: var(--background);
      color: var(--foreground);
      font-size: 14px;
      line-height: 1.55;
    }
    .mono { font-family: inherit; }
    header.top {
      padding: 20px 24px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
    }
    header.top h1 { margin: 0; font-size: 18px; font-weight: 700; }
    header.top .count { font-size: 12px; color: var(--muted-foreground); }
    .controls {
      padding: 12px 24px;
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
      border-bottom: 1px solid var(--border);
      background: var(--surface);
    }
    .controls input[type="search"] {
      flex: 1;
      min-width: 220px;
      padding: 8px 12px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--background);
      color: var(--foreground);
      font: inherit;
    }
    .controls input[type="search"]:focus {
      outline: 2px solid var(--primary);
      outline-offset: 1px;
    }
    .filter-group { display: flex; gap: 4px; }
    .filter-btn {
      padding: 6px 12px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--background);
      color: var(--muted-foreground);
      font: inherit;
      cursor: pointer;
    }
    .filter-btn[aria-pressed="true"] {
      background: var(--primary-soft);
      color: var(--primary);
      border-color: var(--primary);
    }
    .list {
      padding: 16px 24px 32px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .row {
      display: grid;
      grid-template-columns: 80px minmax(0, 1fr) 180px 160px 70px 100px;
      gap: 16px;
      align-items: center;
      padding: 12px 16px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      text-decoration: none;
      color: var(--foreground);
      transition: background 150ms, border-color 150ms;
    }
    @media (max-width: 720px) {
      .row {
        grid-template-columns: 60px 1fr 80px;
        grid-template-areas: 'mode url dur' 'mode author id' 'mode when id';
      }
      .cell.mode { grid-area: mode; }
      .cell.url { grid-area: url; }
      .cell.author { grid-area: author; font-size: 11px; }
      .cell.when { grid-area: when; font-size: 10px; color: var(--muted-foreground); }
      .cell.dur { grid-area: dur; text-align: right; }
      .cell.id { grid-area: id; text-align: right; color: var(--muted-foreground); }
    }
    .cell.author {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      font-size: 12px;
      color: var(--foreground);
    }
    .cell.author.empty {
      color: var(--muted-foreground);
      font-size: 12px;
    }
    .cell.author .avatar {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      flex: 0 0 20px;
      object-fit: cover;
      background: var(--surface-elevated);
    }
    .cell.author .avatar-fallback {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      font-weight: 600;
      color: var(--muted-foreground);
      border: 1px solid var(--border);
    }
    .cell.author .name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .row:hover {
      background: var(--surface-elevated);
      border-color: var(--primary);
    }
    .row:focus-visible {
      outline: 2px solid var(--primary);
      outline-offset: 2px;
    }
    .chip {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 9999px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.04em;
    }
    .chip-video { background: var(--video-soft); color: var(--video); }
    .chip-design { background: var(--design-soft); color: var(--design); }
    .cell.url { min-width: 0; }
    .cell.url .host {
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .cell.url .path {
      font-size: 11px;
      color: var(--muted-foreground);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .cell.when, .cell.dur, .cell.id {
      font-size: 12px;
      color: var(--muted-foreground);
    }
    .empty {
      padding: 48px 24px;
      text-align: center;
      color: var(--muted-foreground);
    }
    .row.hidden { display: none; }
  </style>
</head>
<body>
  <header class="top">
    <div>
      <h1>Bugzar Reports</h1>
      <div class="count">${entries.length}건 (최신순, 최대 ${REPORT_LIST_LIMIT}건)</div>
    </div>
  </header>
  ${
    entries.length === 0
      ? '<div class="empty">아직 발행된 QA report 가 없습니다.<br/>확장을 통해 첫 리포트를 만들어보세요.</div>'
      : `
      <div class="controls">
        <input type="search" id="search" placeholder="호스트 / 경로 / 리포트 id 검색…" />
        <div class="filter-group" role="group" aria-label="모드 필터">
          <button type="button" class="filter-btn" data-filter="all" aria-pressed="true">전체</button>
          <button type="button" class="filter-btn" data-filter="video" aria-pressed="false">영상</button>
          <button type="button" class="filter-btn" data-filter="design" aria-pressed="false">디자인</button>
        </div>
      </div>
      <main class="list">${rows}</main>
      <script>
        (function() {
          var rows = Array.prototype.slice.call(document.querySelectorAll('.row'));
          var search = document.getElementById('search');
          var filters = document.querySelectorAll('.filter-btn');
          var currentMode = 'all';
          var currentQuery = '';
          function apply() {
            var q = currentQuery.trim().toLowerCase();
            for (var i = 0; i < rows.length; i++) {
              var r = rows[i];
              var modeOk = currentMode === 'all' || r.dataset.mode === currentMode;
              var queryOk = !q ||
                r.textContent.toLowerCase().indexOf(q) >= 0 ||
                (r.dataset.host || '').toLowerCase().indexOf(q) >= 0;
              r.classList.toggle('hidden', !(modeOk && queryOk));
            }
          }
          search.addEventListener('input', function(e) {
            currentQuery = e.target.value || '';
            apply();
          });
          filters.forEach(function(btn) {
            btn.addEventListener('click', function() {
              filters.forEach(function(b) { b.setAttribute('aria-pressed', 'false'); });
              btn.setAttribute('aria-pressed', 'true');
              currentMode = btn.dataset.filter || 'all';
              apply();
            });
          });
        })();
      </script>`
  }
</body>
</html>`;
};

// ────────────────────────────────────────────────────────────────────────
// Handlers — legacy /upload + /artifacts (backward compat for old extension
// builds and the existing E2E test fixture). These can be deleted once
// every client is on the /reports/ flow.
// ────────────────────────────────────────────────────────────────────────
