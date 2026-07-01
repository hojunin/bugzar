# Viewer replay player polish — design & implementation plan

Goal-driven spec for the `@bugzar/viewer` replay player. The fit-to-width replay
leaves a letterbox gap below the page (recorded viewport aspect ≠ player pane
aspect). We make that gap read as intentional and add modern playback controls.

Hand-off contract: the tests in
`packages/viewer/src/__tests__/player-controls-modern.test.tsx` encode the target
DOM/behavior. Implement until they (and the existing suite) are green, then the
viewer is launched to verify the visual items.

## Scope — the 4 items

1. **A1 — dark stage (DONE).** `.bugzarv-replay-outer` background `#fff → #0f0f12`.
   Only the letterbox (outside the recorded-page iframe) picks up the color; the
   page screen keeps its own background. Already applied in `styles.ts`.
2. **Controls features:** playback **speed**, **clickable error ticks**, **fullscreen**.
   - Error-jump is realized as *clickable scrubber ticks*, NOT prev/next buttons.
     Those buttons were deliberately removed before (see `Controls.test.tsx`
     comment: "navigation is now via the scrubber + hover preview"); clickable
     ticks add jump-to-issue while honoring that decision.
3. **B1 — vertical center.** Center the replay mount box in the stage so the dark
   letterbox is balanced (not a one-sided bottom void).
4. **Timeline.** Realized as a *taller, richer scrubber/timeline row inside the
   controls* (clearer markers + time ticks + taller hit zone), NOT a standalone
   `flex:1` panel below the replay.
   - Why not the standalone panel: it would steal height from the replay (the main
     content) and risk layout reflow on short recordings. A taller controls row
     delivers the same "absorb the gap" effect (the controls grow → the flex
     `replay-outer` shrinks → the letterbox shrinks) and stays consistent with the
     scrubber-centric navigation already in the codebase.
   - **Decision flag:** if a standalone timeline panel is actually wanted, say so
     before running `goal` — it changes the layout and tests materially.

### How items 3 and 4 coexist (they look like they conflict)

"Center the gap" (3) vs "fill the gap" (4) are reconciled by NOT fighting over the
same space:
- The replay stage stays `flex:1` and centers the replay (3) — A1+B1 make any
  residual letterbox look intentional.
- The timeline (4) lives in the controls and only makes the *controls* taller,
  which shrinks `replay-outer` and thus the residual letterbox. No second region
  competes with the replay for height.

## Files touched

- `packages/viewer/src/styles.ts`
  - A1 (done).
  - B1: center the replay in `.bugzarv-replay-scroll` with overflow-safe alignment.
  - New control styles: speed menu, fullscreen button, taller timeline track.
- `packages/viewer/src/player/Controls.tsx`
  - New **optional** props (optional so existing render sites/tests stay valid):
    - `speed?: number` (default 1)
    - `onSetSpeed?: (n: number) => void`
    - `onToggleFullscreen?: () => void`
    - `isFullscreen?: boolean`
  - Speed control, clickable markers, fullscreen button, richer timeline track.
- `packages/viewer/src/player/Player.tsx`
  - Own `speed` state; pass `speed` + `onSetSpeed={(n) => { handle.setSpeed(n); setSpeed(n); }}`.
    (`handle.setSpeed` already exists in `use-replayer.ts` — currently unused.)
  - Own a fullscreen target ref (the replay-outer wrapper); `onToggleFullscreen`
    calls `requestFullscreen()` / `document.exitFullscreen()`; track `isFullscreen`
    via a `fullscreenchange` listener.
- `packages/viewer/src/player/use-replayer.ts` — no change (setSpeed already there).

No new helper module is needed (clickable ticks seek to the clicked marker's `t`;
there is no prev/next adjacency math).

## DOM / behavior contract (what the tests assert)

### Speed
- A trigger `button[aria-label="Playback speed"]` whose text shows the current
  multiplier (e.g. `1×`, `2×`), reflecting the `speed` prop.
- Clicking it reveals options (a menu of buttons), each labelled `"{n}x speed"`
  for n ∈ {0.5, 1, 1.5, 2, 4}.
- Selecting an option calls `onSetSpeed(n)`.

### Clickable error ticks
- The existing markers keep `data-testid="bugzarv-marker"` (one per error).
- Each tick is a real, focusable control; **clicking a tick calls `onSeek(marker.t)`**
  exactly once (must `stopPropagation` so the track's pointer-seek doesn't also fire).
- Keyboard: Enter/Space on a focused tick seeks to it (native `<button>` is fine).
- Tooltip/aria conveys kind + time (e.g. "Console issue at 0:02").

### Fullscreen
- A `button[aria-label="Fullscreen"]` that calls `onToggleFullscreen` on click.
- When `isFullscreen` is true the control is labelled `"Exit fullscreen"`.

### B1 + timeline (visual — verified in the viewer, not unit-tested)
- Replay centered in the dark stage; when the replay is taller than the pane the
  top is NOT clipped (overflow-safe centering — `place-content: safe center` or
  `margin:auto`).
- Timeline track is taller with clearer markers + time ticks; controls remain a
  single coherent bar (modern, dark theme `#18181b` family).

## Success criteria

- [ ] `pnpm --filter @bugzar/viewer test` green (new + existing).
- [ ] `pnpm --filter @bugzar/viewer typecheck` clean.
- [ ] `pnpm check` (Biome) clean on touched files.
- [ ] Viewer launched on a wide-aspect report: dark balanced letterbox (A1+B1),
      working speed menu, clickable error ticks that seek, fullscreen toggle,
      taller timeline. Before/after screenshots captured.

## Verification (after implementation)

Run the viewer dev server, load a wide-aspect session report (a real export or an
eval seed), and screenshot: (a) dark + centered letterbox, (b) speed menu open,
(c) error-tick seek, (d) fullscreen, (e) the taller timeline.

## Out of scope (was in the broader menu, not these 4)

skip-inactive toggle, current-URL-at-playhead, relocating the floating zoom,
browser-frame chrome, page-background-color sampling (A2).
