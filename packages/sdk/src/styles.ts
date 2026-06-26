// Build-time-free style injection: append a single <style> to <head> on first
// mount. Mirrors agentation's effect (styles live in the document, component is
// a portal) without the SCSS/PostCSS toolchain. All selectors are prefixed
// `bugzar-` and scoped under `.bugzar-root` to avoid colliding with the host app.
// When the M4 rich UI lands we can move to compiled CSS modules like agentation.

const STYLE_ID = 'bugzar-styles';

const CSS = `
.bugzar-root {
  position: fixed;
  z-index: 2147483646;
  display: flex;
  gap: 8px;
  align-items: center;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --bugzar-bg: #ffffff;
  --bugzar-fg: #18181b;
  --bugzar-border: rgba(0, 0, 0, 0.12);
  --bugzar-primary: #3b82f6; --bugzar-success: #16a34a; --bugzar-error: #e5484d;
  --bugzar-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
}
.bugzar-theme-dark {
  --bugzar-bg: #1c1c1f;
  --bugzar-fg: #f4f4f5;
  --bugzar-border: rgba(255, 255, 255, 0.14);
  --bugzar-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
}
@media (prefers-color-scheme: dark) {
  .bugzar-theme-auto {
    --bugzar-bg: #1c1c1f;
    --bugzar-fg: #f4f4f5;
    --bugzar-border: rgba(255, 255, 255, 0.14);
    --bugzar-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
  }
}
.bugzar-bottom-right { right: var(--bugzar-offset-x, 20px); bottom: var(--bugzar-offset-y, 20px); }
.bugzar-bottom-left  { left: var(--bugzar-offset-x, 20px);  bottom: var(--bugzar-offset-y, 20px); }
.bugzar-top-right    { right: var(--bugzar-offset-x, 20px); top: var(--bugzar-offset-y, 20px); }
.bugzar-top-left     { left: var(--bugzar-offset-x, 20px);  top: var(--bugzar-offset-y, 20px); }

.bugzar-fab, .bugzar-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--bugzar-border);
  background: var(--bugzar-bg);
  color: var(--bugzar-fg);
  box-shadow: var(--bugzar-shadow);
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
  padding: 0 14px;
  height: 40px;
  border-radius: 20px;
  transition: transform 0.12s ease, box-shadow 0.12s ease;
  -webkit-font-smoothing: antialiased;
}
.bugzar-fab:hover, .bugzar-pill:hover { transform: translateY(-1px); }
.bugzar-fab:active, .bugzar-pill:active { transform: translateY(0); }

.bugzar-fab-dot {
  width: 10px; height: 10px;
  border-radius: 50%;
  /* recording indicator — red */
  background: var(--bugzar-error);
}
.bugzar-fab-label { letter-spacing: 0.02em; }
.bugzar-fab-icon { display: block; flex: 0 0 auto; }
.bugzar-fab-secondary { font-weight: 500; opacity: 0.92; }
.bugzar-fab-secondary:hover { opacity: 1; }

.bugzar-pill { border-color: var(--bugzar-error); }
.bugzar-dot {
  width: 9px; height: 9px;
  border-radius: 50%;
  background: var(--bugzar-error);
  animation: bugzar-pulse 1.2s ease-in-out infinite;
}
.bugzar-time { font-variant-numeric: tabular-nums; min-width: 34px; }
.bugzar-stop-label { color: var(--bugzar-error); }

@keyframes bugzar-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
/* ── review drawer (M4 / F4.3) ── */
.bugzar-drawer {
  width: 360px;
  max-width: calc(100vw - 40px);
  max-height: calc(100vh - 40px);
  box-sizing: border-box;
  display: flex; flex-direction: column; gap: 12px;
  padding: 16px;
  border: 1px solid var(--bugzar-border);
  border-radius: 14px;
  background: var(--bugzar-bg); color: var(--bugzar-fg);
  box-shadow: var(--bugzar-shadow);
  overflow-y: auto;
  font-size: 13px;
  animation: bugzar-drawer-in 0.2s ease both;
}
@keyframes bugzar-drawer-in {
  from { opacity: 0; transform: translateY(10px) scale(0.98); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
.bugzar-drawer-header {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  font-weight: 700; font-size: 16px;
}
.bugzar-drawer-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bugzar-field { display: flex; flex-direction: column; gap: 4px; position: relative; }
.bugzar-field-label {
  font-size: 11px; font-weight: 600; opacity: 0.65;
  text-transform: uppercase; letter-spacing: 0.04em;
}
.bugzar-input, .bugzar-textarea {
  width: 100%; box-sizing: border-box; padding: 8px 10px;
  border: 1px solid var(--bugzar-border); border-radius: 8px;
  background: transparent; color: var(--bugzar-fg);
  font: inherit; font-size: 13px;
}
.bugzar-textarea { resize: vertical; min-height: 72px; }
.bugzar-input:focus, .bugzar-textarea:focus {
  outline: 2px solid var(--bugzar-primary); outline-offset: 0; border-color: transparent;
}
.bugzar-input:disabled, .bugzar-textarea:disabled { opacity: 0.5; cursor: not-allowed; }
.bugzar-epic-field { z-index: 1; }
.bugzar-epic-list {
  list-style: none; margin: 4px 0 0; padding: 4px;
  position: absolute; top: 100%; left: 0; right: 0; z-index: 2;
  max-height: 168px; overflow-y: auto;
  border: 1px solid var(--bugzar-border); border-radius: 8px;
  background: var(--bugzar-bg); box-shadow: var(--bugzar-shadow);
  animation: bugzar-fade-in 0.14s ease both;
}
.bugzar-epic-option {
  display: flex; align-items: baseline; gap: 8px;
  width: 100%; text-align: left; padding: 6px 8px;
  border: none; background: transparent; color: var(--bugzar-fg);
  cursor: pointer; border-radius: 6px; font-size: 13px;
}
.bugzar-epic-option:hover { background: rgba(127,127,127,0.12); }
.bugzar-epic-key {
  flex: 0 0 auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px; font-weight: 700; color: var(--bugzar-primary);
}
.bugzar-epic-summary {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.bugzar-design-cards {
  display: flex; flex-direction: column; gap: 6px;
  max-height: 184px; overflow-y: auto;
}
.bugzar-design-card {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 8px; border: 1px solid var(--bugzar-border); border-radius: 8px;
}
.bugzar-card-index {
  flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;
  min-width: 18px; height: 18px; border-radius: 9px;
  background: var(--bugzar-primary); color: #fff; font-size: 11px; font-weight: 700; line-height: 1;
}
.bugzar-card-note { flex: 1; min-width: 0; font-size: 13px; }
.bugzar-ai-error { font-size: 12px; color: var(--bugzar-error); }
.bugzar-ai-note { font-size: 12px; opacity: 0.75; }
.bugzar-drawer-actions { display: flex; align-items: center; gap: 8px; }
.bugzar-spacer { flex: 1; }
.bugzar-btn {
  padding: 7px 14px; border-radius: 8px; font-size: 13px; font-weight: 600;
  cursor: pointer; border: 1px solid var(--bugzar-border);
  background: transparent; color: var(--bugzar-fg);
  transition: transform 0.12s ease, opacity 0.12s ease, background 0.12s ease;
}
.bugzar-btn:hover { transform: translateY(-1px); }
.bugzar-btn-primary { background: var(--bugzar-primary); border-color: var(--bugzar-primary); color: #fff; }
.bugzar-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
.bugzar-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
.bugzar-btn-ghost:hover { border-color: var(--bugzar-fg); }
.bugzar-published {
  display: flex; flex-direction: column; gap: 10px; align-items: flex-start;
  animation: bugzar-fade-in 0.2s ease both;
}
.bugzar-published-title { font-weight: 700; font-size: 14px; }
.bugzar-issue-key {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 14px;
  padding: 4px 8px; border-radius: 6px; background: rgba(127,127,127,0.12);
}
.bugzar-issue-link { font-weight: 700; color: var(--bugzar-primary); text-decoration: none; font-size: 15px; }
.bugzar-issue-link:hover { text-decoration: underline; }
.bugzar-published-note { font-size: 12px; opacity: 0.7; margin: 0; }

/* ── OAuth connect step + connected-account chip ── */
.bugzar-connect { display: flex; flex-direction: column; gap: 10px; }
.bugzar-connect-head { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 14px; }
.bugzar-connect-check {
  display: inline-flex; width: 18px; height: 18px; align-items: center; justify-content: center;
  border-radius: 50%; background: var(--bugzar-success); color: #fff; font-size: 12px;
}
.bugzar-connect-hint { margin: 0; font-size: 12px; opacity: 0.75; line-height: 1.5; }
/* connected-account avatar (in the header row) + hover/focus popover */
.bugzar-acct { position: relative; flex: 0 0 auto; }
.bugzar-acct-av {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border-radius: 50%; border: none; padding: 0;
  background: rgba(59, 130, 246, 0.16); color: var(--bugzar-primary);
  font: inherit; font-size: 11px; font-weight: 700; cursor: pointer;
}
.bugzar-acct-av:hover { background: rgba(59, 130, 246, 0.28); }
.bugzar-acct-img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; display: block; }
.bugzar-acct-pop {
  position: absolute; top: calc(100% + 8px); right: 0; z-index: 4;
  min-width: 200px; max-width: 280px; box-sizing: border-box;
  display: flex; flex-direction: column; gap: 8px; padding: 12px;
  border: 1px solid var(--bugzar-border); border-radius: 10px;
  background: var(--bugzar-bg); box-shadow: var(--bugzar-shadow);
  opacity: 0; transform: translateY(-4px); pointer-events: none;
  transition: opacity 0.12s ease, transform 0.12s ease;
}
/* transparent bridge over the gap so hover survives moving into the popover */
.bugzar-acct-pop::before { content: ''; position: absolute; top: -8px; left: 0; right: 0; height: 8px; }
.bugzar-acct:hover .bugzar-acct-pop,
.bugzar-acct:focus-within .bugzar-acct-pop { opacity: 1; transform: translateY(0); pointer-events: auto; }
.bugzar-acct-pop-name { font-size: 13px; font-weight: 600; word-break: break-word; }
.bugzar-acct-pop-note { font-size: 11px; opacity: 0.6; line-height: 1.4; }
.bugzar-acct-disc {
  align-self: flex-start; border: 1px solid var(--bugzar-border); background: transparent; color: var(--bugzar-fg);
  border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer;
}
.bugzar-acct-disc:hover { border-color: var(--bugzar-fg); }
/* link to the uploaded replay / design report (review drawer) */
.bugzar-uploaded-link {
  display: inline-flex; align-items: center; gap: 6px; align-self: flex-start;
  padding: 6px 10px; border: 1px solid var(--bugzar-border); border-radius: 8px;
  color: var(--bugzar-primary); font-size: 12px; font-weight: 600; text-decoration: none;
}
.bugzar-uploaded-link:hover { border-color: var(--bugzar-primary); }

/* ── widget terminal states (③) ── */
.bugzar-terminal {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 0 10px 0 12px; height: 40px; border-radius: 20px;
  border: 1px solid var(--bugzar-border); background: var(--bugzar-bg); color: var(--bugzar-fg);
  box-shadow: var(--bugzar-shadow); font-size: 13px; font-weight: 600;
  animation: bugzar-fade-in 0.18s ease both;
}
.bugzar-terminal-sent, .bugzar-terminal-exported { border-color: var(--bugzar-success); }
.bugzar-terminal-action {
  border: none; background: transparent; color: var(--bugzar-primary);
  cursor: pointer; font: inherit; font-weight: 600; padding: 0;
}
.bugzar-terminal-action:hover { text-decoration: underline; }
.bugzar-terminal-check {
  display: inline-flex; width: 18px; height: 18px;
  align-items: center; justify-content: center; border-radius: 50%;
  background: var(--bugzar-success); color: #fff; font-size: 12px;
  animation: bugzar-pop 0.24s ease both;
}
.bugzar-terminal-failed { border-color: var(--bugzar-error); animation: bugzar-shake 0.32s ease both; }
.bugzar-terminal-link { color: var(--bugzar-primary); text-decoration: none; }
.bugzar-terminal-link:hover { text-decoration: underline; }
.bugzar-terminal-dismiss {
  border: none; background: transparent; color: var(--bugzar-fg); opacity: 0.5;
  cursor: pointer; font-size: 16px; line-height: 1; padding: 0 2px;
}
.bugzar-terminal-dismiss:hover { opacity: 1; }

@keyframes bugzar-fade-in {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes bugzar-pop {
  0% { transform: scale(0); } 60% { transform: scale(1.2); } 100% { transform: scale(1); }
}
@keyframes bugzar-shake {
  0%, 100% { transform: translateX(0); }
  20% { transform: translateX(-4px); } 40% { transform: translateX(4px); }
  60% { transform: translateX(-3px); } 80% { transform: translateX(3px); }
}

@media (prefers-reduced-motion: reduce) {
  .bugzar-dot { animation: none; }
  .bugzar-fab, .bugzar-pill, .bugzar-btn, .bugzar-acct-pop, .bugzar-pick-badge { transition: none; }
  .bugzar-drawer, .bugzar-published, .bugzar-epic-list,
  .bugzar-terminal, .bugzar-terminal-check, .bugzar-terminal-failed { animation: none; }
}

/* ── autoHide slide (opt-in) ──
   With autoHide on, the toolbar carries data-bugzar-revealed and slides off its
   anchored edge while collapsed. It keeps its normal fixed position + natural
   width (no wrapping); collapsed it sits fully off-viewport — fixed elements
   don't add scroll, so the corner stays free and never blocks page clicks.
   Hover is detected in JS by geometry, not by this element. */
.bugzar-root[data-bugzar-revealed] { transition: transform 0.24s ease; }
.bugzar-root[data-bugzar-revealed="false"] { transform: translateY(calc(100% + var(--bugzar-offset-y, 20px))); }
.bugzar-root.bugzar-top-right[data-bugzar-revealed="false"],
.bugzar-root.bugzar-top-left[data-bugzar-revealed="false"] { transform: translateY(calc(-100% - var(--bugzar-offset-y, 20px))); }
.bugzar-root[data-bugzar-revealed="true"] { transform: translateY(0); }

@media (prefers-reduced-motion: reduce) {
  .bugzar-root[data-bugzar-revealed] { transition: none; }
}

/* ── design picker ── */
.bugzar-pick-root {
  position: fixed; inset: 0; z-index: 2147483645; pointer-events: none;
  --bugzar-bg: #ffffff; --bugzar-fg: #18181b; --bugzar-border: rgba(0,0,0,0.12);
  --bugzar-primary: #3b82f6; --bugzar-success: #16a34a; --bugzar-error: #e5484d; --bugzar-shadow: 0 6px 20px rgba(0,0,0,0.18);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
@media (prefers-color-scheme: dark) {
  .bugzar-pick-root {
    --bugzar-bg: #1c1c1f; --bugzar-fg: #f4f4f5; --bugzar-border: rgba(255,255,255,0.14);
    --bugzar-shadow: 0 6px 20px rgba(0,0,0,0.45);
  }
}
.bugzar-pick-hover, .bugzar-pick-selected {
  position: fixed; top: 0; left: 0; pointer-events: none; box-sizing: border-box;
  border-radius: 2px;
}
.bugzar-pick-hover { border: 2px solid var(--bugzar-primary); background: rgba(59,130,246,0.08); }
.bugzar-pick-selected { border: 2px solid var(--bugzar-primary); background: rgba(59,130,246,0.08); }
.bugzar-pick-badge {
  position: absolute; top: -9px; left: -9px;
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 18px; height: 18px; border-radius: 9px;
  background: var(--bugzar-primary); color: #fff; font-size: 11px; font-weight: 700; line-height: 1;
  /* the box itself is click-through; the badge alone is the edit handle */
  pointer-events: auto; cursor: pointer; transition: transform 0.1s ease;
}
.bugzar-pick-badge:hover { transform: scale(1.15); }
/* per-element note popover (anchored to the clicked element) */
.bugzar-pick-popover {
  position: fixed; top: 0; left: 0; width: 260px; box-sizing: border-box;
  display: flex; flex-direction: column; gap: 8px; padding: 10px;
  border: 1px solid var(--bugzar-border); border-radius: 12px;
  background: var(--bugzar-bg); color: var(--bugzar-fg); box-shadow: var(--bugzar-shadow);
  pointer-events: auto; font-size: 13px; animation: bugzar-fade-in 0.12s ease both;
}
.bugzar-pick-pop-head {
  display: flex; flex-direction: column; gap: 2px; padding-bottom: 2px;
  border-bottom: 1px solid var(--bugzar-border);
}
.bugzar-pick-pop-tag { font-size: 12px; font-weight: 700; }
.bugzar-pick-pop-sel {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--bugzar-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.bugzar-pick-pop-eltext {
  font-size: 11px; opacity: 0.65; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.bugzar-pick-pop-note {
  width: 100%; box-sizing: border-box; resize: vertical; min-height: 56px;
  padding: 7px 9px; border: 1px solid var(--bugzar-border); border-radius: 8px;
  background: transparent; color: var(--bugzar-fg); font: inherit; font-size: 13px;
}
.bugzar-pick-pop-figma {
  width: 100%; box-sizing: border-box; padding: 6px 9px; border: 1px solid var(--bugzar-border);
  border-radius: 8px; background: transparent; color: var(--bugzar-fg); font: inherit; font-size: 12px;
}
.bugzar-pick-pop-note:focus, .bugzar-pick-pop-figma:focus {
  outline: 2px solid var(--bugzar-primary); outline-offset: 0; border-color: transparent;
}
.bugzar-pick-pop-actions { display: flex; justify-content: flex-end; gap: 6px; }

/* floating collection bar (selected elements + Done) */
.bugzar-pick-bar {
  position: fixed; right: 20px; bottom: 20px; width: 320px; max-height: 60vh; box-sizing: border-box;
  display: flex; flex-direction: column; gap: 8px; padding: 12px;
  border: 1px solid var(--bugzar-border); border-radius: 12px;
  background: var(--bugzar-bg); color: var(--bugzar-fg); box-shadow: var(--bugzar-shadow);
  pointer-events: auto; font-size: 13px;
}
.bugzar-pick-bar-head { font-weight: 600; }
.bugzar-pick-bar-list { display: flex; flex-direction: column; gap: 6px; overflow-y: auto; }
.bugzar-pick-chip { display: flex; align-items: center; gap: 8px; }
.bugzar-pick-chip-main {
  flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px;
  padding: 4px; margin: -4px; border: none; border-radius: 6px;
  background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.bugzar-pick-chip-main:hover { background: rgba(127,127,127,0.12); }
.bugzar-pick-chip-text {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 12px; opacity: 0.9;
}
.bugzar-pick-itembadge {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 18px; height: 18px; border-radius: 9px;
  background: var(--bugzar-primary); color: #fff; font-size: 11px; font-weight: 700; line-height: 1; flex: 0 0 auto;
}
.bugzar-pick-del {
  border: none; background: transparent; color: var(--bugzar-fg); opacity: 0.5;
  cursor: pointer; font-size: 16px; line-height: 1; padding: 0 4px; flex: 0 0 auto;
}
.bugzar-pick-del:hover { opacity: 1; }
.bugzar-pick-bar-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 2px; }
.bugzar-pick-btn {
  padding: 6px 14px; border-radius: 8px; font-size: 13px; font-weight: 600;
  cursor: pointer; border: 1px solid var(--bugzar-border); background: transparent; color: var(--bugzar-fg);
}
.bugzar-pick-btn-primary { background: var(--bugzar-primary); border-color: var(--bugzar-primary); color: #fff; }
.bugzar-pick-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.bugzar-pick-btn-ghost:hover { border-color: var(--bugzar-fg); }
`;

export function injectStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}
