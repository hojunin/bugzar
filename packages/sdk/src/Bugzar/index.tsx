'use client';

import { captureSnapshot, collectSystemInfo } from '@bugzar/capture-core';
import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { downloadReplay } from '../download';
import { type PickerHandle, startDesignPick } from '../picker/picker';
import type { ExportMeta, RrwebEvent, SystemInfo } from '../public-types';
import { ReviewDrawer } from '../ReviewDrawer';
import { injectStyles } from '../styles';
import { buildDesignBlob, buildReplayBlob } from './export-blobs';
import type { ResultState } from './ResultChip';
import { Toolbar } from './Toolbar';
import type { BugzarProps, DrawerState } from './types';
import { useAutoHide } from './useAutoHide';
import { useRecorder } from './useRecorder';

// BugzarProps moved to ./types; re-exported so `index.ts` and consumers keep
// importing it from the component module.
export type { BugzarProps } from './types';

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
  const [result, setResult] = useState<ResultState | null>(null);
  const pickRef = useRef<PickerHandle | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // HTML export needs assets inlined at capture time (offline replay). On every
  // no-`endpoint` path we now deliver a self-contained HTML — uploaded via
  // `onExport` OR downloaded locally as the floor (#22) — so inline whenever there's
  // no Jira backend. The endpoint/Jira path keeps assets un-inlined (the Worker
  // viewer reconstructs the replay), so this stays false there.
  const wantsHtml = !endpoint;

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

  // Surface a failure: prefer the host's handler, else don't swallow it silently.
  const reportErr = useCallback(
    (err: unknown) => {
      const e = err instanceof Error ? err : new Error(String(err));
      if (onError) onError(e);
      else console.error('[bugzar]', e);
    },
    [onError],
  );

  // Deliver a finished capture without ever discarding it (#22). Build the offline
  // HTML once and hold it, then route on the RESOLVED sink value:
  //   jira on        → review drawer (HOLD), linked to the onExport URL if any
  //   url string     → share chip the host can open/copy
  //   void/empty     → host self-handled (e.g. downloadReplay) → show nothing
  //   reject (jiraOff)→ download the held blob as the floor + report + chip
  //   no onExport    → download the held blob as the floor + chip
  // A build throw leaves no blob to download → report only.
  const deliver = useCallback(
    async (produce: () => Promise<Blob>, meta: ExportMeta, toDrawer: (url?: string) => void) => {
      setUploading(true);
      let blob: Blob;
      try {
        blob = await produce();
      } catch (err) {
        reportErr(err);
        setUploading(false);
        return;
      }
      const jiraOn = !!((jira?.clientId || jira?.enabled) && endpoint);
      const chipMode = meta.mode === 'design' ? 'design' : 'bug';
      try {
        const url = onExport ? await onExport(blob, meta) : undefined;
        if (jiraOn) toDrawer(typeof url === 'string' && url ? url : undefined);
        else if (typeof url === 'string' && url) setResult({ kind: 'link', mode: chipMode, url });
        else if (!onExport) {
          downloadReplay(blob, meta);
          setResult({ kind: 'downloaded', mode: chipMode });
        }
        // else: onExport returned void/empty → host self-handled → show nothing.
      } catch (err) {
        reportErr(err);
        // Reject on the jiraOff path → fall back to a local download so the capture
        // is never lost. The jira path keeps its existing reject behavior (no drawer).
        if (!jiraOn) {
          downloadReplay(blob, meta);
          setResult({ kind: 'downloaded', mode: chipMode });
        }
      } finally {
        setUploading(false);
      }
    },
    [onExport, endpoint, jira, reportErr],
  );

  const stop = useCallback(() => {
    const bundle = stopRecorder();
    if (!bundle) return;
    deliver(
      () => buildReplayBlob(bundle),
      { ...bundle.meta, mode: 'session' },
      (url) => setDrawer({ mode: 'bug', bundle, ...(url ? { url } : {}) }),
    );
  }, [stopRecorder, deliver]);

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
        deliver(
          () => buildDesignBlob(annotations, snapshot, system),
          designMeta,
          (url) => setDrawer({ mode: 'design', annotations, ...(url ? { url } : {}) }),
        );
      },
      onCancel: () => {
        pickRef.current = null;
        setPicking(false);
      },
    });
  }, [onAnnotate, deliver, wantsHtml, mask]);

  // "In use" → pin the toolbar open regardless of hover (the fix rule). The result
  // chip counts: autoHide must not tuck it away before the user opens/copies it.
  const inUse = recording || uploading || picking || !!drawer || !!result;
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
      result={result}
      onStart={start}
      onStop={stop}
      onPick={startPick}
      onDismissResult={() => setResult(null)}
    />,
    document.body,
  );
}
