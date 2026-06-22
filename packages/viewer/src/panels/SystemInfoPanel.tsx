// System Info tab — device / browser / environment for triage. Prefers the
// captured `system` asset; falls back to whatever `meta` carries (URL, viewport,
// userAgent) so reports recorded before System Info capture still show the
// essentials. Web Vitals (captured but otherwise unsurfaced) ride along here.

import type { WebVitals } from '@bugzar/shared';
import type { ReactNode } from 'react';
import type { ReportData, ReportMeta } from '../report/types';

type SystemInfo = NonNullable<ReportData['system']>;

/** Minimal UA → browser/OS derivation for the no-`system`-asset fallback. */
function parseUA(ua: string): { browser: string; os: string } {
  const s = ua || '';
  const ver = (re: RegExp) => s.match(re)?.[1] ?? '';
  let browser = 'Unknown';
  if (/Edg\//.test(s)) browser = `Edge ${ver(/Edg\/(\d+)/)}`;
  else if (/OPR\//.test(s)) browser = `Opera ${ver(/OPR\/(\d+)/)}`;
  else if (/Firefox\//.test(s)) browser = `Firefox ${ver(/Firefox\/(\d+)/)}`;
  else if (/Chrome\//.test(s)) browser = `Chrome ${ver(/Chrome\/(\d+)/)}`;
  else if (/Version\/[\d.]+.*Safari/.test(s)) browser = `Safari ${ver(/Version\/(\d+)/)}`;
  let os = 'Unknown';
  if (/Windows NT 10/.test(s)) os = 'Windows 10/11';
  else if (/Windows/.test(s)) os = 'Windows';
  else if (/Mac OS X ([0-9_]+)/.test(s))
    os = `macOS ${ver(/Mac OS X ([0-9_]+)/).replace(/_/g, '.')}`;
  else if (/Android ([0-9.]+)/.test(s)) os = `Android ${ver(/Android ([0-9.]+)/)}`;
  else if (/iPhone OS ([0-9_]+)/.test(s))
    os = `iOS ${ver(/iPhone OS ([0-9_]+)/).replace(/_/g, '.')}`;
  else if (/Linux/.test(s)) os = 'Linux';
  return { browser: browser.trim(), os };
}

const fmtOffset = (min: number) => {
  const sign = min <= 0 ? '+' : '-';
  const abs = Math.abs(min);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
};

function Section({ title, rows }: { title: string; rows: Array<[string, ReactNode]> }) {
  const shown = rows.filter(([, v]) => v != null && v !== '');
  if (shown.length === 0) return null;
  return (
    <section className="bugzarv-net-section">
      <h4 className="bugzarv-net-section-title">{title}</h4>
      <table className="bugzarv-kv">
        <tbody>
          {shown.map(([k, v]) => (
            <tr key={k}>
              <td className="bugzarv-kv-k">{k}</td>
              <td className="bugzarv-kv-v">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function vitalsRows(v: WebVitals): Array<[string, ReactNode]> {
  return [
    ['LCP', v.lcp != null ? `${Math.round(v.lcp)} ms` : ''],
    ['CLS', v.cls != null ? v.cls.toFixed(3) : ''],
    ['INP', v.inp != null ? `${Math.round(v.inp)} ms` : ''],
    ['TTFB', v.ttfb != null ? `${Math.round(v.ttfb)} ms` : ''],
  ];
}

export function SystemInfoPanel({
  system,
  meta,
  vitals,
}: {
  system: SystemInfo | null;
  meta: ReportMeta | null;
  vitals: WebVitals;
}) {
  const ua = system?.browser.userAgent || meta?.userAgent || '';
  const parsed = parseUA(ua);
  const bool = (b: boolean | undefined) => (b == null ? '' : b ? 'Yes' : 'No');

  const browser: Array<[string, ReactNode]> = [
    ['Browser', parsed.browser],
    ['OS / Platform', system?.browser.platform || parsed.os],
    ['Mobile', bool(system?.browser.mobile)],
    ['Vendor', system?.browser.vendor],
    ['Language', system?.browser.language],
    ['Languages', system?.browser.languages?.join(', ')],
    ['CPU cores', system?.browser.hardwareConcurrency],
    [
      'Device memory',
      system?.browser.deviceMemory != null ? `${system.browser.deviceMemory} GB` : '',
    ],
    ['Touch points', system?.browser.maxTouchPoints],
    ['Cookies enabled', bool(system?.browser.cookieEnabled)],
    ['Do Not Track', system?.browser.doNotTrack ?? ''],
    ['Online', bool(system?.browser.online)],
    ['UA brands', system?.browser.brands?.map((b) => `${b.brand} ${b.version}`).join(', ')],
    [
      'User agent',
      ua ? (
        <span key="ua" className="bugzarv-sysinfo-ua">
          {ua}
        </span>
      ) : (
        ''
      ),
    ],
  ];

  const vp = system?.viewport ?? meta?.viewport;
  const display: Array<[string, ReactNode]> = [
    ['Viewport', vp ? `${vp.width} × ${vp.height}` : ''],
    ['Screen', system ? `${system.screen.width} × ${system.screen.height}` : ''],
    ['Available', system ? `${system.screen.availWidth} × ${system.screen.availHeight}` : ''],
    ['Device pixel ratio', system?.screen.devicePixelRatio],
    ['Color depth', system ? `${system.screen.colorDepth}-bit` : ''],
    ['Orientation', system?.screen.orientation],
  ];

  const conn = system?.connection;
  const network: Array<[string, ReactNode]> = [
    ['Effective type', conn?.effectiveType],
    ['Downlink', conn?.downlink != null ? `${conn.downlink} Mbps` : ''],
    ['RTT', conn?.rtt != null ? `${conn.rtt} ms` : ''],
    ['Save data', bool(conn?.saveData)],
    ['Connection type', conn?.type],
  ];

  const locale: Array<[string, ReactNode]> = system
    ? [
        ['Time zone', system.locale.timeZone],
        ['UTC offset', fmtOffset(system.locale.timezoneOffsetMin)],
        ['Locale', system.locale.locale],
      ]
    : [];

  const page: Array<[string, ReactNode]> = [
    ['URL', system?.page.url || meta?.url],
    ['Title', system?.page.title],
    ['Referrer', system?.page.referrer],
    ['Color scheme', system?.page.prefersColorScheme],
    ['Reduced motion', bool(system?.page.prefersReducedMotion)],
  ];

  return (
    <div className="bugzarv-sysinfo">
      {!system ? (
        <div className="bugzarv-sysinfo-note">
          Detailed system info wasn't captured for this report — showing what the session metadata
          carries.
        </div>
      ) : null}
      <Section title="Browser" rows={browser} />
      <Section title="Display" rows={display} />
      <Section title="Network" rows={network} />
      <Section title="Locale & Time" rows={locale} />
      <Section title="Page" rows={page} />
      <Section title="Web Vitals" rows={vitalsRows(vitals)} />
    </div>
  );
}
