/**
 * One-way postMessage channel between host script (MAIN world) and content
 * script (ISOLATED world). Both live in the same page but in different JS
 * realms; window.postMessage is the only legal channel.
 *
 * All envelopes are namespaced under `__bugzar__` so we don't process arbitrary
 * postMessage traffic from the page or other extensions.
 *
 * M1 uses one-way emit only. A request/response variant can be added later
 * by extending the envelope with `requestId` + a reverse channel — out of
 * scope here.
 */

const NS = '__bugzar__' as const;

type Envelope<T> = { [NS]: true; msg: T };

const isEnvelope = (v: unknown): v is Envelope<unknown> =>
  typeof v === 'object' && v !== null && (v as { [NS]?: boolean })[NS] === true;

export const createPostMessageEmitter =
  <T>(target: Window) =>
  (msg: T): void => {
    const env: Envelope<T> = { [NS]: true, msg };
    // Use '*' as targetOrigin: this is a same-window channel between ISOLATED
    // and MAIN worlds on the same page. The __bugzar__ namespace ensures we never
    // process unrelated traffic, so '*' is safe here. A specific origin would
    // break file:// pages (origin is "null") and data: pages (origin is "null").
    target.postMessage(env, '*');
  };

export const createPostMessageReceiver = <T>(
  source: Window,
  onMessage: (msg: T) => void,
): (() => void) => {
  const listener = (event: MessageEvent): void => {
    // event.source is null in jsdom (known bug); treat null as same-window
    if (event.source !== null && event.source !== source) return;
    // Origin check: enforce same-origin for http(s) pages. For file://, data:,
    // about:, and other opaque origins (where event.origin is "null" or ""),
    // skip the check — the __bugzar__ namespace + same-window source check are
    // the real security barriers.
    const expectedOrigin = source.location.origin;
    const actualOrigin = event.origin;
    const isOpaque =
      expectedOrigin === 'null' ||
      expectedOrigin === '' ||
      actualOrigin === 'null' ||
      actualOrigin === '' ||
      actualOrigin == null;
    if (!isOpaque && actualOrigin !== expectedOrigin) return;
    if (!isEnvelope(event.data)) return;
    onMessage(event.data.msg as T);
  };
  source.addEventListener('message', listener);
  return () => source.removeEventListener('message', listener);
};
