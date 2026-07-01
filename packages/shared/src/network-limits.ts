/**
 * Network capture size limits (#20) — the single source of truth for the client
 * capture (`@bugzar/capture-core`); the backend enforces the same asset cap so
 * the two can never drift out of lockstep.
 *
 * Units: the per-body and total-budget caps are enforced in **UTF-8 bytes**
 * (`TextEncoder`), the same unit the backend asset cap counts (`chunk.byteLength`).
 * This matters for non-ASCII (CJK/emoji) bodies, where 1 char can be 2–4 bytes —
 * a char-based cap would let the asset 413 far sooner than the numbers suggest.
 *
 * Lockstep invariant (enforced by network-limits.test.ts):
 *   NETWORK_TOTAL_BUDGET_BYTES + NETWORK_BODY_MAX_BYTES <= NETWORK_ASSET_CAP_BYTES
 * i.e. a budget-respecting client can never produce a network asset the backend
 * would reject — so the whole-session-loss 413 can't happen.
 */

/** Per response/request body: truncate to this many UTF-8 bytes, then `…[truncated]`. */
export const NETWORK_BODY_MAX_BYTES = 1_000_000; // 1 MB

/** Per session: once captured bodies cross this, further bodies are dropped to a
 *  `…[budget exceeded]` marker (entry + metadata kept) — bounds tab memory and
 *  guarantees the network asset stays under the backend cap. */
export const NETWORK_TOTAL_BUDGET_BYTES = 20 * 1024 * 1024; // 20 MB

/** Backend ceiling for the single `network` JSON asset upload (→ 413 above this).
 *  25MB, not 50MB: the Worker buffers the whole body in memory (~128MB isolate)
 *  and the viewer eager-loads the network JSON. 50MB is a follow-up gated on
 *  viewer lazy-loading. */
export const NETWORK_ASSET_CAP_BYTES = 25 * 1024 * 1024; // 25 MB
