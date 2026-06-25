// Injected viewer stylesheet. The viewer owns its whole page, but we still scope
// every rule under the `bugzarv-` prefix (dark theme: #18181b / #e4e4e7) so nothing
// is ambiguous and the markup stays self-documenting.

const CSS = `
:root { color-scheme: dark; }
body { margin: 0; }
.bugzarv-app, .bugzarv-state {
  font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif;
  color: #e4e4e7;
  background: #18181b;
  min-height: 100vh;
}
.bugzarv-app { display: flex; flex-direction: column; height: 100vh; }
.bugzarv-state { padding: 48px; max-width: 640px; }
.bugzarv-state h1 { font-size: 18px; margin: 0 0 12px; }
.bugzarv-state code {
  background: #27272a; padding: 2px 6px; border-radius: 4px;
  font-family: ui-monospace, monospace; word-break: break-all;
}

/* min-width:0 is load-bearing: without it this intermediate flex column adopts
   its content's intrinsic min-width, so a wide rrweb replay overflows and the
   player mis-measures its width (page renders too wide → cropped on the right). */
/* Slim URL-only header for design reports (no diagnostic bar there). */
.bugzarv-urlbar {
  flex: 0 0 auto; padding: 8px 16px; border-bottom: 1px solid #27272a; background: #1f1f23;
  font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.bugzarv-session-col { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; min-width: 0; }
.bugzarv-session { display: flex; flex: 1 1 auto; min-height: 0; min-width: 0; }

/* A1/B1 — diagnostic bar: compact, sticky, bounded (never a full screen) */
.bugzarv-sr {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
.bugzarv-diag {
  flex: 0 0 auto; position: sticky; top: 0; z-index: 3;
  display: flex; align-items: center; gap: 10px 16px; flex-wrap: wrap;
  padding: 10px 16px; border-bottom: 1px solid #27272a; background: #1f1f23;
  border-left: 3px solid #52525b; box-shadow: 0 1px 0 rgba(0, 0, 0, 0.35);
}
.bugzarv-diag-error { border-left-color: #f87171; }
.bugzarv-diag-warn { border-left-color: #fbbf24; }
.bugzarv-diag-ok { border-left-color: #34d399; }
.bugzarv-diag-main { display: flex; align-items: center; gap: 10px; flex: 1 1 320px; min-width: 0; }
.bugzarv-diag-dot { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%; background: #52525b; }
.bugzarv-diag-error .bugzarv-diag-dot { background: #f87171; }
.bugzarv-diag-warn .bugzarv-diag-dot { background: #fbbf24; }
.bugzarv-diag-ok .bugzarv-diag-dot { background: #34d399; }
.bugzarv-diag-headline {
  margin: 0; min-width: 0; font-size: 16px; font-weight: 600; line-height: 1.3;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.bugzarv-diag-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; min-width: 0; }
.bugzarv-diag-chip {
  flex: 0 0 auto; border: 1px solid #3f3f46; background: #27272a; color: #d4d4d8;
  border-radius: 999px; padding: 2px 10px; font-size: 12px; font-weight: 600; cursor: pointer;
}
.bugzarv-diag-chip:hover { background: #3f3f46; }
.bugzarv-diag-chip-error { color: #fca5a5; border-color: rgba(248, 113, 113, 0.4); }
.bugzarv-diag-chip-failed { color: #fdba74; border-color: rgba(251, 146, 60, 0.4); }
.bugzarv-diag-copy { display: flex; align-items: center; gap: 8px; margin-left: auto; flex: 0 0 auto; }
.bugzarv-diag-infowrap { position: relative; flex: 0 0 auto; display: inline-flex; }
.bugzarv-diag-info {
  width: 20px; height: 20px; padding: 0; border-radius: 50%;
  border: 1px solid #3f3f46; background: transparent; color: #a1a1aa;
  font-size: 12px; line-height: 1; cursor: pointer;
}
.bugzarv-diag-info:hover { color: #e4e4e7; border-color: #52525b; }
.bugzarv-diag-tip {
  position: absolute; right: 0; top: calc(100% + 6px); z-index: 20; width: 230px;
  padding: 8px 10px; border-radius: 6px; background: #0f0f11; border: 1px solid #3f3f46;
  color: #d4d4d8; font-size: 11px; line-height: 1.4; font-weight: 400;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
}
.bugzarv-left {
  flex: 1 1 60%; min-width: 0; display: flex; flex-direction: column;
  border-right: 1px solid #27272a; padding: 12px; gap: 8px;
}
.bugzarv-sidebar { flex: 1 1 40%; min-width: 0; display: flex; flex-direction: column; }
@media (max-width: 860px) { .bugzarv-session { flex-direction: column; } }

.bugzarv-replay-outer {
  flex: 1 1 auto; min-height: 0; position: relative;
  background: #fff; border-radius: 4px; overflow: hidden;
}
.bugzarv-replay-scroll { width: 100%; height: 100%; overflow: auto; }
.bugzarv-replay { overflow: hidden; }
.bugzarv-replay iframe { border: 0; }
.bugzarv-zoom { position: absolute; bottom: 8px; right: 8px; display: flex; gap: 4px; z-index: 5; }
.bugzarv-zoom-btn {
  width: 28px; height: 28px; border-radius: 6px; border: 1px solid #d4d4d8;
  background: rgba(255, 255, 255, 0.92); color: #27272a; cursor: pointer;
  font-size: 16px; line-height: 1; display: flex; align-items: center; justify-content: center;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
}
.bugzarv-zoom-btn:hover { background: #fff; }
.bugzarv-zoom-btn:active { transform: scale(0.94); }
.bugzarv-empty { display: grid; place-items: center; flex: 1 1 auto; color: #71717a; }

.bugzarv-controls { display: flex; align-items: center; gap: 12px; flex: 0 0 auto; padding: 2px 2px 0; }
.bugzarv-play {
  flex: 0 0 auto; width: 32px; height: 32px; border-radius: 999px; border: 0; cursor: pointer;
  display: grid; place-items: center; background: #e4e4e7; color: #18181b; font-size: 12px; line-height: 1;
  transition: background 0.12s, transform 0.08s;
}
.bugzarv-play:hover { background: #fff; }
.bugzarv-play:active { transform: scale(0.94); }

/* Modern scrubber: tall stable hover zone, thin rounded track, round thumb */
.bugzarv-scrubber {
  position: relative; flex: 1 1 auto; min-width: 0; height: 22px;
  display: flex; align-items: center; cursor: pointer; touch-action: none; outline: none;
}
.bugzarv-track { position: relative; flex: 1 1 auto; height: 5px; border-radius: 999px; background: #3f3f46; }
.bugzarv-scrubber:focus-visible .bugzarv-track { box-shadow: 0 0 0 2px rgba(96, 165, 250, 0.5); }
.bugzarv-track-fill {
  position: absolute; left: 0; top: 0; height: 100%; border-radius: 999px;
  background: #60a5fa; pointer-events: none;
}
.bugzarv-thumb {
  position: absolute; top: 50%; width: 13px; height: 13px; border-radius: 50%; background: #fff;
  transform: translate(-50%, -50%); box-shadow: 0 1px 4px rgba(0, 0, 0, 0.55);
  pointer-events: none; transition: width 0.1s, height 0.1s;
}
.bugzarv-scrubber:hover .bugzarv-thumb, .bugzarv-scrubber-drag .bugzarv-thumb { width: 16px; height: 16px; }
.bugzarv-hoverline {
  position: absolute; top: -4px; bottom: -4px; width: 2px; transform: translateX(-50%);
  background: rgba(228, 228, 231, 0.45); pointer-events: none;
}
.bugzarv-marker {
  position: absolute; top: -3px; width: 2px; height: 11px; border-radius: 1px;
  transform: translateX(-1px); pointer-events: none;
}
/* Non-color cue: console errors are a full tall tick, network failures a shorter
   tick with a square head — distinguishable without relying on hue (a11y, §C3). */
.bugzarv-marker-console { background: #f87171; height: 13px; top: -4px; }
.bugzarv-marker-network { background: #fb923c; height: 7px; top: 0; border-radius: 0; }

.bugzarv-clock {
  flex: 0 0 auto; font-family: ui-monospace, monospace; font-size: 12px; color: #a1a1aa;
  white-space: nowrap; font-variant-numeric: tabular-nums;
}
.bugzarv-clock-sep { color: #52525b; margin: 0 1px; }

/* Track hover-scrub thumbnail */
.bugzarv-preview {
  position: absolute; bottom: calc(100% + 10px); transform: translateX(-50%);
  background: #0f0f11; border: 1px solid #3f3f46; border-radius: 6px; padding: 4px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.55); pointer-events: none; z-index: 20;
}
.bugzarv-preview-frame { overflow: hidden; border-radius: 3px; background: #fff; position: relative; }
.bugzarv-preview-stage { transform-origin: top left; pointer-events: none; }
.bugzarv-preview-note {
  position: absolute; inset: 0; display: grid; place-items: center;
  font-family: ui-sans-serif, system-ui, sans-serif; font-size: 11px; color: #71717a;
}
.bugzarv-preview-stage iframe { border: 0; }
.bugzarv-preview-cap {
  text-align: center; font-family: ui-monospace, monospace; font-size: 11px;
  color: #a1a1aa; padding-top: 3px;
}
.bugzarv-btn {
  background: #27272a; color: #e4e4e7; border: 1px solid #3f3f46;
  border-radius: 4px; padding: 4px 8px; cursor: pointer; font: inherit;
}
.bugzarv-btn:hover { background: #3f3f46; }

.bugzarv-tabs { display: flex; gap: 2px; border-bottom: 1px solid #27272a; flex: 0 0 auto; }
.bugzarv-tab {
  background: transparent; color: #a1a1aa; border: 0; border-bottom: 2px solid transparent;
  padding: 8px 12px; cursor: pointer; font: inherit; display: flex; gap: 6px; align-items: center;
}
.bugzarv-tab-active { color: #e4e4e7; border-bottom-color: #60a5fa; }
.bugzarv-tab-count {
  background: #3f3f46; color: #e4e4e7; border-radius: 999px;
  padding: 0 6px; font-size: 11px; min-width: 16px; text-align: center;
}
.bugzarv-toolbar { display: flex; align-items: center; gap: 8px; padding: 8px; flex: 0 0 auto; }
.bugzarv-search {
  flex: 1 1 auto; min-width: 0; padding: 6px 8px; background: #27272a; color: #e4e4e7;
  border: 1px solid #3f3f46; border-radius: 4px; font: inherit;
}
.bugzarv-toggle {
  display: flex; align-items: center; gap: 4px; flex: 0 0 auto;
  color: #a1a1aa; font-size: 12px; white-space: nowrap; cursor: pointer; user-select: none;
}
.bugzarv-toggle input { cursor: pointer; }
.bugzarv-panel { flex: 1 1 auto; overflow: auto; }

.bugzarv-row {
  display: flex; gap: 8px; align-items: baseline; padding: 4px 12px;
  border-bottom: 1px solid #27272a; cursor: pointer; font-family: ui-monospace, monospace;
}
.bugzarv-row:hover { background: #27272a; }
.bugzarv-row-error { background: rgba(248, 113, 113, 0.12); }
.bugzarv-row-future { opacity: 0.45; }
.bugzarv-row-active { background: #27272a; box-shadow: inset 2px 0 #60a5fa; }
.bugzarv-badge { color: #a1a1aa; flex: 0 0 auto; }
.bugzarv-badge-error { color: #f87171; }
.bugzarv-badge-group { color: #818cf8; }
.bugzarv-row-grouphdr { color: #c7c7cc; }
.bugzarv-time { color: #71717a; flex: 0 0 auto; width: 56px; }
.bugzarv-msg { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bugzarv-status-bad { color: #f87171; }

/* Network — modern row + status tags + sectioned detail */
.bugzarv-net-row { gap: 10px; align-items: center; }
.bugzarv-method {
  flex: 0 0 auto; width: 44px; font-weight: 700; font-size: 11px; letter-spacing: 0.02em;
}
.bugzarv-method-get { color: #60a5fa; }
.bugzarv-method-post { color: #34d399; }
.bugzarv-method-put, .bugzarv-method-patch { color: #fbbf24; }
.bugzarv-method-delete { color: #f87171; }
.bugzarv-tag {
  flex: 0 0 auto; display: inline-block; padding: 1px 8px; border-radius: 999px;
  font-size: 11px; font-weight: 600; line-height: 1.6; font-family: ui-sans-serif, system-ui, sans-serif;
}
.bugzarv-tag-2xx { background: rgba(52, 211, 153, 0.15); color: #34d399; }
.bugzarv-tag-3xx { background: rgba(96, 165, 250, 0.15); color: #60a5fa; }
.bugzarv-tag-4xx { background: rgba(251, 191, 36, 0.16); color: #fbbf24; }
.bugzarv-tag-5xx { background: rgba(248, 113, 113, 0.18); color: #f87171; }
.bugzarv-tag-err { background: rgba(248, 113, 113, 0.22); color: #fca5a5; }
.bugzarv-tag-pending, .bugzarv-tag-info { background: #3f3f46; color: #d4d4d8; }

.bugzarv-net-section { margin: 0 0 14px; }
.bugzarv-net-section-title {
  margin: 0 0 6px; padding-bottom: 4px; border-bottom: 1px solid #27272a;
  font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #e4e4e7;
}
.bugzarv-net-sub { margin: 8px 0 4px; font-size: 11px; font-weight: 500; color: #a1a1aa; }
.bugzarv-net-empty { color: #71717a; font-size: 12px; padding: 2px 0; }

/* Resources — type filter chips + type tags */
.bugzarv-respanel { display: flex; flex-direction: column; height: 100%; min-height: 0; }
/* Only the rows scroll; the filter chips stay pinned under the search bar. */
.bugzarv-respanel .bugzarv-rows { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
.bugzarv-rfilter {
  display: flex; flex-wrap: wrap; gap: 6px; padding: 8px; flex: 0 0 auto;
  border-bottom: 1px solid #27272a; background: #1f1f23;
}
.bugzarv-rfilter-chip {
  background: #27272a; color: #a1a1aa; border: 1px solid #3f3f46; border-radius: 999px;
  padding: 2px 10px; font: inherit; font-size: 11px; cursor: pointer;
}
.bugzarv-rfilter-chip:hover { background: #3f3f46; }
.bugzarv-rfilter-on { background: rgba(96, 165, 250, 0.16); color: #93c5fd; border-color: #3b82f6; }
.bugzarv-rfilter-count { opacity: 0.7; }
.bugzarv-rtag-js { background: rgba(251, 191, 36, 0.16); color: #fbbf24; }
.bugzarv-rtag-css { background: rgba(96, 165, 250, 0.16); color: #60a5fa; }
.bugzarv-rtag-img { background: rgba(192, 132, 252, 0.16); color: #c084fc; }
.bugzarv-rtag-font { background: rgba(244, 114, 182, 0.16); color: #f472b6; }
.bugzarv-rtag-fetch { background: rgba(45, 212, 191, 0.16); color: #2dd4bf; }
.bugzarv-rtag-doc { background: rgba(161, 161, 170, 0.16); color: #d4d4d8; }
.bugzarv-rtag-other { background: #3f3f46; color: #a1a1aa; }
.bugzarv-tree { margin: 0; padding: 12px; white-space: pre-wrap; word-break: break-all; }

.bugzarv-row-group { border-bottom: 1px solid #27272a; }
.bugzarv-row-group .bugzarv-row { border-bottom: 0; width: 100%; text-align: left; background: transparent; }
.bugzarv-disclosure { color: #71717a; flex: 0 0 auto; width: 12px; }
.bugzarv-detail { padding: 8px 12px 12px 32px; background: #161618; }
.bugzarv-detail-copy { display: flex; justify-content: flex-end; margin-bottom: 8px; }
/* R2 — text badges (kind/CORS); always a text token, never color-only */
.bugzarv-kind {
  flex: 0 0 auto; font-size: 10px; font-weight: 700; letter-spacing: 0.02em; text-transform: uppercase;
  padding: 1px 6px; border-radius: 4px; background: rgba(251, 146, 60, 0.16); color: #fdba74;
}
.bugzarv-detail-meta { font-family: ui-monospace, monospace; font-size: 12px; color: #a1a1aa; margin: 6px 0; word-break: break-all; }

/* A2 — reproduction steps */
.bugzarv-repro { list-style: none; margin: 0; padding: 8px 4px; counter-reset: none; }
.bugzarv-repro-step { border-bottom: 1px solid #1f1f23; }
.bugzarv-repro-btn {
  display: flex; gap: 10px; align-items: flex-start; width: 100%; box-sizing: border-box;
  padding: 8px 12px; border: 0; background: transparent; color: #e4e4e7; cursor: pointer;
  font: inherit; text-align: left;
}
.bugzarv-repro-btn:hover { background: #27272a; }
.bugzarv-repro-num {
  flex: 0 0 auto; min-width: 20px; height: 20px; border-radius: 10px; background: #3f3f46;
  color: #e4e4e7; font-size: 11px; font-weight: 700; line-height: 20px; text-align: center;
}
.bugzarv-repro-text { min-width: 0; line-height: 1.5; word-break: break-word; }
.bugzarv-repro-step:last-child .bugzarv-repro-num { background: #f87171; color: #18181b; }
.bugzarv-detail-section { margin-bottom: 12px; }
.bugzarv-detail-section:last-child { margin-bottom: 0; }
.bugzarv-detail-title {
  margin: 0 0 4px; font-size: 11px; text-transform: uppercase;
  letter-spacing: 0.04em; color: #a1a1aa;
}
.bugzarv-kv { border-collapse: collapse; width: 100%; font-family: ui-monospace, monospace; font-size: 12px; }
.bugzarv-kv-k { color: #a1a1aa; padding: 2px 12px 2px 0; vertical-align: top; white-space: nowrap; }
.bugzarv-kv-v { color: #e4e4e7; padding: 2px 0; word-break: break-all; }
.bugzarv-detail-body {
  margin: 0; padding: 8px; background: #0f0f11; border-radius: 4px;
  font-size: 12px; white-space: pre-wrap; word-break: break-all; color: #d4d4d8;
}

.bugzarv-json { font-family: ui-monospace, monospace; font-size: 12px; background: #0f0f11; border-radius: 4px; padding: 6px 8px; }
.bugzarv-json-row { line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
.bugzarv-json-toggle {
  display: block; width: 100%; text-align: left; background: none; border: 0;
  color: inherit; font: inherit; cursor: pointer;
}
.bugzarv-json-toggle:hover { background: #1f1f23; }
.bugzarv-json-disc { color: #71717a; display: inline-block; width: 12px; }
.bugzarv-json-key { color: #93c5fd; }
.bugzarv-json-str { color: #86efac; }
.bugzarv-json-num { color: #fca5a5; }
.bugzarv-json-bool { color: #c4b5fd; }
.bugzarv-json-null { color: #71717a; }
.bugzarv-json-sum { color: #a1a1aa; }
.bugzarv-json-more { color: #71717a; }
.bugzarv-json-arg { font-family: ui-monospace, monospace; padding: 2px 8px; color: #d4d4d8; }

/* Storage — localStorage / sessionStorage / cookies, always all three */
.bugzarv-storage { padding: 12px 16px; }
.bugzarv-storage-section { margin-bottom: 16px; }
.bugzarv-storage-count {
  display: inline-block; margin-left: 4px; padding: 0 6px; border-radius: 999px;
  background: #3f3f46; color: #d4d4d8; font-size: 11px; font-weight: 600;
}
.bugzarv-storage-empty { color: #71717a; font-size: 12px; padding: 4px 0; }

/* System Info */
.bugzarv-sysinfo { padding: 12px 16px; }
.bugzarv-sysinfo .bugzarv-net-section { margin-bottom: 16px; }
.bugzarv-sysinfo-note {
  margin-bottom: 14px; padding: 8px 10px; border-radius: 4px;
  background: rgba(251, 191, 36, 0.1); color: #fbbf24; font-size: 12px;
}
.bugzarv-sysinfo-ua { word-break: break-all; color: #d4d4d8; }

.bugzarv-bar-track { position: relative; height: 10px; background: #27272a; border-radius: 2px; flex: 1 1 auto; }
.bugzarv-bar { position: absolute; top: 0; height: 100%; background: #60a5fa; border-radius: 2px; }

.bugzarv-design { padding: 16px; display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); }
.bugzarv-card { border: 1px solid #27272a; border-radius: 6px; padding: 12px; background: #1f1f23; }
.bugzarv-card-selector { font-family: ui-monospace, monospace; color: #60a5fa; word-break: break-all; }
.bugzarv-card-tag { color: #a1a1aa; font-size: 11px; text-transform: uppercase; }
.bugzarv-card-component { color: #34d399; font-size: 12px; }
.bugzarv-card-note { margin-top: 8px; }

/* Design review — page snapshot (left) + pinned annotations + message list (right) */
.bugzarv-dz { display: flex; flex: 1 1 auto; min-height: 0; }
.bugzarv-dz-canvas {
  flex: 1 1 auto; min-width: 0; overflow: auto; position: relative;
  background:
    linear-gradient(45deg, #131316 25%, transparent 25%) -8px 0/16px 16px,
    linear-gradient(-45deg, #131316 25%, transparent 25%) -8px 0/16px 16px,
    #0c0c0e;
}
.bugzarv-dz-zoom { position: relative; margin: 16px auto; }
.bugzarv-dz-inner { position: relative; transform-origin: top left; }
.bugzarv-dz-stage { position: absolute; inset: 0; }
.bugzarv-dz-stage .replayer-wrapper { position: absolute; inset: 0; }
.bugzarv-dz-stage iframe { border: 0; background: #fff; }
.bugzarv-dz-pins { position: absolute; inset: 0; pointer-events: none; }
.bugzarv-dz-pin {
  position: absolute; box-sizing: border-box; padding: 0; margin: 0; cursor: pointer;
  border: 2px solid #3b82f6; background: rgba(59, 130, 246, 0.1); border-radius: 2px;
  pointer-events: auto;
}
.bugzarv-dz-pin:hover { background: rgba(59, 130, 246, 0.18); }
.bugzarv-dz-pin-on { border-color: #f59e0b; background: rgba(245, 158, 11, 0.16); z-index: 6; }
.bugzarv-dz-pin-num {
  position: absolute; top: -10px; left: -10px; min-width: 18px; height: 18px; padding: 0 4px;
  display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box;
  border-radius: 9px; background: #3b82f6; color: #fff; font-size: 11px; font-weight: 700; line-height: 1;
}
.bugzarv-dz-pin-on .bugzarv-dz-pin-num { background: #f59e0b; }
.bugzarv-dz-pin-note {
  position: absolute; top: calc(100% + 6px); left: 0; z-index: 7; max-width: 260px; width: max-content;
  padding: 6px 9px; border-radius: 6px; background: #f59e0b; color: #18181b;
  font-size: 12px; font-weight: 600; line-height: 1.35; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5);
  white-space: normal;
}
.bugzarv-dz-loading {
  position: absolute; top: 24px; left: 50%; transform: translateX(-50%);
  color: #71717a; font-size: 13px;
}
.bugzarv-dz-list {
  flex: 0 0 300px; overflow-y: auto; border-left: 1px solid #27272a; background: #161618;
  display: flex; flex-direction: column;
}
.bugzarv-dz-tabs {
  display: flex; gap: 4px; padding: 8px 10px; border-bottom: 1px solid #27272a;
  position: sticky; top: 0; background: #161618; z-index: 2;
}
.bugzarv-dz-tab {
  border: 1px solid transparent; background: transparent; color: #a1a1aa;
  border-radius: 6px; padding: 4px 10px; font-size: 12px; font-weight: 600; cursor: pointer;
}
.bugzarv-dz-tab:hover { color: #d4d4d8; }
.bugzarv-dz-tab-on { background: #27272a; color: #fff; }
.bugzarv-dz-list-head {
  display: flex; align-items: center; justify-content: flex-end; gap: 8px;
  padding: 8px 14px; border-bottom: 1px solid #27272a; background: #161618;
}
.bugzarv-dz-copyall, .bugzarv-dz-copy {
  border: 1px solid #3f3f46; background: #27272a; color: #d4d4d8; border-radius: 6px;
  padding: 3px 8px; font-size: 11px; font-weight: 600; cursor: pointer; text-transform: none; letter-spacing: 0;
}
.bugzarv-dz-copyall:hover, .bugzarv-dz-copy:hover { background: #3f3f46; color: #fff; }
.bugzarv-dz-item { border-bottom: 1px solid #27272a; }
.bugzarv-dz-item-on { background: rgba(245, 158, 11, 0.1); box-shadow: inset 2px 0 #f59e0b; }
.bugzarv-dz-itemmain {
  display: flex; gap: 10px; align-items: flex-start; text-align: left; width: 100%; box-sizing: border-box;
  padding: 10px 14px 6px; border: 0; background: transparent; color: #e4e4e7; cursor: pointer; font: inherit;
}
.bugzarv-dz-itemmain:hover { background: #1f1f23; }
.bugzarv-dz-itemactions { display: flex; align-items: center; gap: 12px; padding: 0 14px 10px 42px; }
.bugzarv-dz-itembadge {
  flex: 0 0 auto; min-width: 18px; height: 18px; border-radius: 9px; background: #3b82f6;
  color: #fff; font-size: 11px; font-weight: 700; line-height: 18px; text-align: center;
}
.bugzarv-dz-item-on .bugzarv-dz-itembadge { background: #f59e0b; }
.bugzarv-dz-itembody { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.bugzarv-dz-itemsel {
  font-family: ui-monospace, monospace; font-size: 11px; color: #60a5fa;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.bugzarv-dz-itemtag { font-size: 10px; text-transform: uppercase; color: #71717a; letter-spacing: 0.03em; }
.bugzarv-dz-itemtext {
  font-size: 11px; color: #a1a1aa; font-style: italic;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.bugzarv-dz-attrs { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 2px; }
.bugzarv-dz-attr {
  font-family: ui-monospace, monospace; font-size: 10px; color: #d4d4d8;
  background: #27272a; border-radius: 3px; padding: 1px 5px;
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.bugzarv-dz-attr-k { color: #c084fc; }
.bugzarv-dz-itemnote { font-size: 13px; color: #e4e4e7; margin-top: 4px; white-space: pre-wrap; word-break: break-word; }
.bugzarv-dz-figma { font-size: 12px; color: #60a5fa; text-decoration: none; white-space: nowrap; }
.bugzarv-dz-figma:hover { text-decoration: underline; }
@media (max-width: 860px) { .bugzarv-dz { flex-direction: column; } .bugzarv-dz-list { flex-basis: 200px; border-left: 0; border-top: 1px solid #27272a; } }
`;

let injected = false;

/** Inject the viewer stylesheet once (idempotent). */
export function injectStyles(): void {
  if (injected || typeof document === 'undefined') return;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  injected = true;
}
