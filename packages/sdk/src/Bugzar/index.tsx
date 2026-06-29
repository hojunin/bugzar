'use client';

import { captureSnapshot, collectSystemInfo } from '@bugzar/capture-core';
import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type PickerHandle, startDesignPick } from '../picker/picker';
import type {
  DesignAnnotation,
  ExportMeta,
  JiraConfig,
  PublishResult,
  ReportBundle,
  RrwebEvent,
  SystemInfo,
} from '../public-types';
import { ReviewDrawer } from '../ReviewDrawer';
import { injectStyles } from '../styles';
import type { Endpoint } from '../upload';
import { buildDesignBlob, buildReplayBlob } from './export-blobs';
import { Toolbar } from './Toolbar';
import { useAutoHide } from './useAutoHide';
import { useRecorder } from './useRecorder';

/** Open review-drawer session: a `bug` (bundle) or `design` (annotations) issue. */
type DrawerState =
  | { mode: 'bug'; url?: string; bundle: ReportBundle }
  | { mode: 'design'; url?: string; annotations: DesignAnnotation[] };

export interface BugzarProps {
  /** Fired when recording starts. */
  onStart?: () => void;
  /** Mask every text input (passwords are always masked regardless). Default true. */
  mask?: boolean;
  /**
   * Toolbar corner the widget anchors to.
   *
   * @default 'bottom-right'
   */
  position?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  /**
   * Inset, in pixels, from the two anchored corner edges (the `position` corner).
   * Pass a single number to inset both axes equally, or `{ x, y }` to set them
   * independently — an omitted axis falls back to `20`. Applies to both the
   * toolbar and the review drawer; when `autoHide` is on, the tucked-away toolbar
   * also slides fully past this inset so it sits off-screen.
   *
   * @default 20
   * @example offset={32}               // 32px from both anchored edges
   * @example offset={{ x: 24, y: 88 }} // clear a bottom-right action button
   */
  offset?: number | { x?: number; y?: number };
  /**
   * Auto-hide the toolbar so it isn't always-on chrome. When `true` it stays
   * tucked off the anchored edge and slides into view only while the cursor is
   * inside the corner `hoverZone`, while the widget is in use (recording /
   * annotating / uploading / review drawer), or for a 2s grace period after use.
   * Reveal is mouse-only by design (geometric hover, not focus/touch). When
   * `false` the toolbar is always visible (classic behavior, unchanged).
   *
   * @default false
   */
  autoHide?: boolean;
  /**
   * Size, in pixels, of the invisible corner region you hover to reveal the
   * auto-hidden toolbar. Shrink it when the default zone overlaps your own UI
   * (e.g. a chat bubble or CTA sharing that corner). `{ width, height }`; an
   * omitted axis keeps its default. Only used when `autoHide` is `true`.
   *
   * @default { width: 300, height: 30 }
   * @example hoverZone={{ width: 80, height: 16 }}
   */
  hoverZone?: { width?: number; height?: number };
  /** Color theme. Default 'auto' (follows prefers-color-scheme). */
  theme?: 'light' | 'dark' | 'auto';
  /**
   * Receive the built self-contained replay HTML so you can upload it to your own
   * storage (S3/R2/…). Return the public URL the report is now reachable at. Fires
   * on recording stop AND design-pick finish (`meta.mode` distinguishes). Active on
   * the no-`endpoint` path.
   */
  onExport?: (blob: Blob, meta: ExportMeta) => Promise<string | void>;
  /**
   * Bugzar Worker base URL (e.g. `https://bugzar-backend.<sub>.workers.dev`),
   * or `{ url, headers? }`. The Worker is the **Jira backend only** (auth + AI
   * draft + issue creation); set it together with `jira` to enable the review
   * drawer. Web sharing is via `onExport` → your storage, not the Worker.
   */
  endpoint?: Endpoint;
  /** Fired if `onExport` or a publish attempt fails. */
  onError?: (error: Error) => void;
  /** Show the "Pick" button for design-feedback element annotation. Default true. */
  design?: boolean;
  /**
   * Fired when the user finishes a design pick with the annotated elements.
   * When omitted (and no `endpoint`), finishing a Pick builds an offline HTML
   * design report and offers it via the share chip.
   */
  onAnnotate?: (annotations: DesignAnnotation[]) => void;
  /**
   * Jira publish config. When `jira.enabled` AND `endpoint` are set, stopping
   * uploads the bundle and opens a review drawer that files a Jira issue via the
   * Worker's service account (the browser never holds an Atlassian token). Without
   * both, there is no drawer — the callbacks/upload path runs as usual.
   */
  jira?: JiraConfig;
  /**
   * Fired after a publish attempt. `result.stubbed === true` means the Worker was
   * unconfigured and NO real issue was created — do not treat it as filed.
   */
  onPublished?: (result: PublishResult) => void;
  /**
   * Capture host app-state into the bundle's `state` timeline at start + stop +
   * throttle. Each snapshot is serialized + redacted. Omit to capture none.
   */
  captureState?: () => unknown;
  /** Redact each state snapshot (runs after the built-in key/JWT masking). */
  redactState?: (state: unknown) => unknown;
}

/**
 * Embeddable Bugzar. Drop `<Bugzar />` anywhere in a React tree; a
 * floating toolbar mounts to `document.body` (SSR-safe) and records the page's
 * rrweb DOM + console + network + storage on demand. On stop the bundle is
 * handed to `onSubmit`/`onStop`, or downloaded as JSON with no config.
 *
 * This container orchestrates: recording (useRecorder), design picking, the
 * export → review-drawer flow, and the autoHide reveal (useAutoHide).
 */
export function Bugzar({
  onStart,
  mask = true,
  position = 'bottom-right',
  offset,
  theme = 'auto',
  autoHide = false,
  hoverZone,
  onExport,
  endpoint,
  onError,
  design = true,
  onAnnotate,
  jira,
  onPublished,
  captureState,
  redactState,
}: BugzarProps) {
  const [mounted, setMounted] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [picking, setPicking] = useState(false);
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const pickRef = useRef<PickerHandle | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // HTML export needs assets inlined at capture time (offline replay). We build the
  // offline HTML only on the no-backend, no-`endpoint` path; inline assets only then
  // (it's the heavy bit and pointless otherwise).
  const wantsHtml = !endpoint && !!onExport;

  const {
    recording,
    elapsed,
    start,
    stop: stopRecorder,
  } = useRecorder({
    mask,
    inlineAssets: wantsHtml,
    onStart,
    captureState,
    redactState,
  });

  // Portal target only exists in the browser — defer mount past SSR.
  useEffect(() => {
    injectStyles();
    setMounted(true);
    return () => {
      // Restore page globals if unmounted mid-pick. The recorder intentionally
      // survives unmount (so recordings outlive client-side navigation), so only
      // the picker is torn down here.
      pickRef.current?.stop();
    };
  }, []);

  // Keep an open outside-click-dismissable host component (Select / Modal /
  // Popover / Drawer) OPEN through the FAB press, so startPick's captureSnapshot
  // freezes the actual open screen instead of the dismissed one (#21). The host's
  // dismiss is typically a document bubble-phase pointer listener; a document
  // capture-phase guard runs first and stops the press from ever reaching it.
  // Scoped to the toolbar controls (.bugzar-fab/.bugzar-pill) only — the
  // ReviewDrawer shares .bugzar-root and we must not swallow its form inputs.
  // The FAB's React onClick (delegated at the portal root, document.body) is a
  // separate event and still fires startPick. Only covers the common bubble /
  // focus-dismiss case; capture-phase or sync-vanilla dismissals need the
  // deferred freeze-overlay backstop (see docs/issue-21-…-design.md §6).
  useEffect(() => {
    const onFab = (e: Event): boolean =>
      !!(e.target as Element | null)?.closest?.('.bugzar-fab, .bugzar-pill');
    // pointerdown: stop propagation only. preventDefault here can swallow the
    // activating click on touch, so we never cancel it.
    const onPointerDown = (e: Event): void => {
      if (onFab(e)) e.stopPropagation();
    };
    // mousedown (mouse-only): also preventDefault to block the focus-steal that
    // would trigger a focusout/blur dismiss — never suppresses a touch tap.
    const onMouseDown = (e: Event): void => {
      if (onFab(e)) {
        e.stopPropagation();
        e.preventDefault();
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('mousedown', onMouseDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('mousedown', onMouseDown, true);
    };
  }, []);

  // Build the offline HTML and hand it to the consumer to upload; resolves to the
  // public URL they return (used as the Jira ticket's replay link, when set).
  const exportBlob = useCallback(
    async (produce: () => Promise<Blob>, meta: ExportMeta): Promise<string | void> => {
      if (!onExport) return undefined;
      return onExport(await produce(), meta);
    },
    [onExport],
  );

  const stop = useCallback(() => {
    const bundle = stopRecorder();
    if (!bundle) return;

    // Build the offline HTML → `onExport` returns the share URL. When jira+endpoint
    // is configured, open the review drawer (HOLD) linking to that URL.
    const jiraOn = !!((jira?.clientId || jira?.enabled) && endpoint);
    if (!onExport && !jiraOn) return; // no sink — capture discarded
    setUploading(true);
    exportBlob(() => buildReplayBlob(bundle), { ...bundle.meta, mode: 'session' })
      .then((url) => {
        if (jiraOn) setDrawer({ mode: 'bug', bundle, ...(url ? { url } : {}) });
      })
      .catch((err) => onError?.(err instanceof Error ? err : new Error(String(err))))
      .finally(() => setUploading(false));
  }, [endpoint, jira, onExport, onError, exportBlob, stopRecorder]);

  const startPick = useCallback(() => {
    if (pickRef.current?.isActive()) return;
    // Snapshot the page NOW, before our overlay mounts, so the report shows the
    // actual screen with the annotations pinned on it (own UI excluded).
    let snapshot: RrwebEvent[] = [];
    try {
      // Inline page assets into the snapshot when we'll export an offline HTML.
      // `mask` (maskAllInputs) carries through so the design snapshot masks
      // inputs exactly like the recording path — never cleartext credentials.
      snapshot = captureSnapshot(
        '.bugzar-root, .bugzar-pick-root',
        wantsHtml,
        mask,
      ) as RrwebEvent[];
    } catch {
      snapshot = [];
    }
    // Device/browser/environment snapshot for the design report's System Info tab.
    let system: SystemInfo | null = null;
    try {
      system = collectSystemInfo();
    } catch {
      system = null;
    }
    setPicking(true);
    pickRef.current = startDesignPick({
      onComplete: (annotations) => {
        pickRef.current = null;
        setPicking(false);
        // onAnnotate always fires — no data loss, even in the jira flow.
        onAnnotate?.(annotations);
        const jiraOn = !!((jira?.clientId || jira?.enabled) && endpoint);
        if (!onExport && !jiraOn) return; // no sink
        const now = Date.now();
        const designMeta: ExportMeta = {
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
        };
        setUploading(true);
        exportBlob(() => buildDesignBlob(annotations, snapshot, system), designMeta)
          .then((url) => {
            if (jiraOn) setDrawer({ mode: 'design', annotations, ...(url ? { url } : {}) });
          })
          .catch((err) => onError?.(err instanceof Error ? err : new Error(String(err))))
          .finally(() => setUploading(false));
      },
      onCancel: () => {
        pickRef.current = null;
        setPicking(false);
      },
    });
  }, [onAnnotate, jira, endpoint, onExport, onError, exportBlob, wantsHtml, mask]);

  // "In use" → pin the toolbar open regardless of hover (the fix rule).
  const inUse = recording || uploading || picking || !!drawer;
  const { revealed, collapsed } = useAutoHide({
    autoHide,
    mounted,
    position,
    inUse,
    rootRef,
    ...(hoverZone ? { hoverZone } : {}),
  });

  // Custom corner inset → CSS variables the position rules (and autoHide slide)
  // read; left unset, the stylesheet keeps its 20px default.
  const offX = typeof offset === 'number' ? offset : (offset?.x ?? 20);
  const offY = typeof offset === 'number' ? offset : (offset?.y ?? 20);
  const rootStyle =
    offset === undefined
      ? undefined
      : ({ '--bugzar-offset-x': `${offX}px`, '--bugzar-offset-y': `${offY}px` } as CSSProperties);

  if (!mounted || typeof document === 'undefined') return null;
  // While picking, the picker renders its own panel — hide the toolbar.
  if (picking) return null;

  // Review drawer (jira flow) — replaces the toolbar until Publish/Cancel.
  if (drawer && endpoint) {
    return createPortal(
      <ReviewDrawer
        mode={drawer.mode}
        endpoint={endpoint}
        {...(drawer.url ? { url: drawer.url } : {})}
        {...(jira?.clientId ? { clientId: jira.clientId } : {})}
        {...(jira?.defaultEpicKey ? { defaultEpicKey: jira.defaultEpicKey } : {})}
        {...(drawer.mode === 'bug'
          ? { bundle: drawer.bundle }
          : { annotations: drawer.annotations })}
        position={position}
        theme={theme}
        {...(rootStyle ? { style: rootStyle } : {})}
        {...(onPublished ? { onPublished } : {})}
        onClose={() => setDrawer(null)}
      />,
      document.body,
    );
  }

  return createPortal(
    <Toolbar
      position={position}
      theme={theme}
      {...(rootStyle ? { style: rootStyle } : {})}
      recording={recording}
      uploading={uploading}
      elapsed={elapsed}
      design={design}
      autoHide={autoHide}
      revealed={revealed}
      collapsed={collapsed}
      rootRef={rootRef}
      onStart={start}
      onStop={stop}
      onPick={startPick}
    />,
    document.body,
  );
}
