// One-shot device/browser/environment snapshot for the System Info panel.
// Pure read of navigator/screen/window — no patching, no listeners. Every
// non-standard API (UA Client Hints, Network Information, deviceMemory) is read
// defensively so a missing one just omits its field.

import type { SystemInfo } from '@bugzar/shared';

interface UADataLike {
  brands?: Array<{ brand: string; version: string }>;
  mobile?: boolean;
  platform?: string;
}
interface ConnectionLike {
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
  saveData?: boolean;
  type?: string;
}
type NavigatorExtras = Navigator & {
  userAgentData?: UADataLike;
  connection?: ConnectionLike;
  deviceMemory?: number;
};

export function collectSystemInfo(): SystemInfo {
  const nav = (typeof navigator !== 'undefined' ? navigator : undefined) as
    | NavigatorExtras
    | undefined;
  const win = typeof window !== 'undefined' ? window : undefined;
  const scr = typeof screen !== 'undefined' ? screen : undefined;
  const doc = typeof document !== 'undefined' ? document : undefined;
  const uaData = nav?.userAgentData;
  const conn = nav?.connection;
  const media = (q: string): boolean => (win?.matchMedia ? win.matchMedia(q).matches : false);

  // Pull non-standard numerics into locals so `typeof x === 'number'` narrows
  // them for the conditional spreads (exactOptionalPropertyTypes is on).
  const hardwareConcurrency = nav?.hardwareConcurrency;
  const deviceMemory = nav?.deviceMemory;
  const maxTouchPoints = nav?.maxTouchPoints;
  const downlink = conn?.downlink;
  const rtt = conn?.rtt;

  const prefersColorScheme: SystemInfo['page']['prefersColorScheme'] = media(
    '(prefers-color-scheme: dark)',
  )
    ? 'dark'
    : media('(prefers-color-scheme: light)')
      ? 'light'
      : 'no-preference';

  let timeZone = '';
  let locale = '';
  try {
    const opts = Intl.DateTimeFormat().resolvedOptions();
    timeZone = opts.timeZone ?? '';
    locale = opts.locale ?? '';
  } catch {
    // Intl unavailable — leave blank.
  }

  return {
    collectedAt: Date.now(),
    browser: {
      userAgent: nav?.userAgent ?? '',
      ...(uaData?.brands ? { brands: uaData.brands } : {}),
      ...(uaData?.platform ? { platform: uaData.platform } : {}),
      ...(typeof uaData?.mobile === 'boolean' ? { mobile: uaData.mobile } : {}),
      ...(nav?.vendor ? { vendor: nav.vendor } : {}),
      language: nav?.language ?? '',
      languages: nav?.languages ? [...nav.languages] : [],
      cookieEnabled: nav?.cookieEnabled ?? false,
      doNotTrack: nav?.doNotTrack ?? null,
      ...(typeof hardwareConcurrency === 'number' ? { hardwareConcurrency } : {}),
      ...(typeof deviceMemory === 'number' ? { deviceMemory } : {}),
      ...(typeof maxTouchPoints === 'number' ? { maxTouchPoints } : {}),
      online: nav?.onLine ?? true,
    },
    screen: {
      width: scr?.width ?? 0,
      height: scr?.height ?? 0,
      availWidth: scr?.availWidth ?? 0,
      availHeight: scr?.availHeight ?? 0,
      colorDepth: scr?.colorDepth ?? 0,
      pixelDepth: scr?.pixelDepth ?? 0,
      devicePixelRatio: win?.devicePixelRatio ?? 1,
      ...(scr?.orientation?.type ? { orientation: scr.orientation.type } : {}),
    },
    viewport: {
      width: win?.innerWidth ?? 0,
      height: win?.innerHeight ?? 0,
    },
    ...(conn
      ? {
          connection: {
            ...(conn.effectiveType ? { effectiveType: conn.effectiveType } : {}),
            ...(typeof downlink === 'number' ? { downlink } : {}),
            ...(typeof rtt === 'number' ? { rtt } : {}),
            ...(typeof conn.saveData === 'boolean' ? { saveData: conn.saveData } : {}),
            ...(conn.type ? { type: conn.type } : {}),
          },
        }
      : {}),
    locale: {
      timeZone,
      timezoneOffsetMin: new Date().getTimezoneOffset(),
      locale,
    },
    page: {
      url: typeof location !== 'undefined' ? location.href : '',
      referrer: doc?.referrer ?? '',
      title: doc?.title ?? '',
      prefersColorScheme,
      prefersReducedMotion: media('(prefers-reduced-motion: reduce)'),
    },
  };
}
