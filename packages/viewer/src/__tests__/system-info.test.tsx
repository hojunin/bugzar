import type { SystemInfo } from '@bugzar/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SystemInfoPanel } from '../panels/SystemInfoPanel';
import type { ReportMeta } from '../report/types';

afterEach(cleanup);

const sys: SystemInfo = {
  collectedAt: 0,
  browser: {
    userAgent: 'UA',
    platform: 'macOS',
    language: 'ko-KR',
    languages: ['ko-KR', 'en'],
    cookieEnabled: true,
    doNotTrack: null,
    hardwareConcurrency: 10,
    online: true,
  },
  screen: {
    width: 1920,
    height: 1080,
    availWidth: 1920,
    availHeight: 1055,
    colorDepth: 24,
    pixelDepth: 24,
    devicePixelRatio: 2,
  },
  viewport: { width: 1280, height: 720 },
  connection: { effectiveType: '4g', rtt: 50 },
  locale: { timeZone: 'Asia/Seoul', timezoneOffsetMin: -540, locale: 'ko-KR' },
  page: {
    url: 'https://app',
    referrer: '',
    title: 'App',
    prefersColorScheme: 'dark',
    prefersReducedMotion: false,
  },
};

describe('SystemInfoPanel', () => {
  it('renders collected device/browser/locale/vitals info', () => {
    render(<SystemInfoPanel system={sys} meta={null} vitals={{ lcp: 1234.6 }} />);
    expect(screen.getByText('Time zone')).toBeTruthy();
    expect(screen.getByText('Asia/Seoul')).toBeTruthy();
    expect(screen.getByText('UTC+09:00')).toBeTruthy();
    expect(screen.getByText('macOS')).toBeTruthy();
    expect(screen.getByText('1920 × 1080')).toBeTruthy();
    expect(screen.getByText('4g')).toBeTruthy();
    // Web Vitals (otherwise unsurfaced) ride along, LCP rounded.
    expect(screen.getByText('Web Vitals')).toBeTruthy();
    expect(screen.getByText('1235 ms')).toBeTruthy();
  });

  it('falls back to meta + UA parsing when no system asset', () => {
    const meta: ReportMeta = {
      url: 'https://x',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Chrome/120.0 Mobile',
      viewport: { width: 390, height: 844 },
      startedAt: 0,
      endedAt: 1,
      durationMs: 1,
    };
    render(<SystemInfoPanel system={null} meta={meta} vitals={{}} />);
    expect(screen.getByText(/wasn't captured/)).toBeTruthy();
    expect(screen.getByText(/Chrome 120/)).toBeTruthy();
    expect(screen.getByText('390 × 844')).toBeTruthy();
  });
});
