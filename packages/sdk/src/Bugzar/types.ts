import type {
  DesignAnnotation,
  ExportMeta,
  JiraConfig,
  PublishResult,
  ReportBundle,
} from '../public-types';
import type { Endpoint } from '../upload';

/** Open review-drawer session: a `bug` (bundle) or `design` (annotations) issue. */
export type DrawerState =
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
  onExport?: (blob: Blob, meta: ExportMeta) => Promise<string | undefined>;
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
