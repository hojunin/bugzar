# Vendored react-grab

Source: https://github.com/aidenybai/react-grab @ `4ab9d7dcd7f696bf68e6a6eb1c4c184fa5ec4f47`
Imported: 2026-05-22

## Files

| File here | Origin (in react-grab) | Our modifications |
|---|---|---|
| `find-unique-selector.ts` | `packages/react-grab/src/utils/find-unique-selector.ts` | Inlined `MAX_SELECTOR_COMBINATIONS` constant and replaced the 3 custom error classes with native `Error` (no behavioral change) |
| `relevant-css-properties.ts` | extracted from `packages/react-grab/src/constants.ts` (`RELEVANT_CSS_PROPERTIES`) | none |

## What we did NOT vendor and why

The plan's original assumption — that react-grab exposes flat `hover.ts` /
`outline.ts` / `fiber-traverse.ts` / `meta-extract.ts` files — does not match
the current upstream. The real upstream is a Solid.js monorepo:

- Hover detection lives in `core/events.ts` and is driven by Solid signals
  and a plugin registry. Cannot be excised standalone without dragging in
  `solid-js`, the store, and the plugin system.
- Outline rendering is `components/overlay-canvas.tsx` (a Solid component).
- Fiber traversal is split across `core/context.ts` (gated by an
  instrumentation runtime) and a `bippy` dependency for `getFiberFromHostInstance`.
- Element metadata helpers (`create-component-name-for-element.ts`) are
  Solid-signal wrappers and cannot run outside the Solid render context.

So we vendor only the **pure** pieces (selector builder + CSS whitelist) and
write our own thin hover / outline / fiber-traverse / meta-extract on top —
these are short enough to maintain ourselves and don't carry the same hard-won
edge cases the selector heuristic does.

## Upstream update procedure

See `docs/superpowers/specs/2026-05-22-bugzar-phase-2.md` §5.8 (Vendor
갱신 정책). Manual diff + reapply — no auto-sync.
