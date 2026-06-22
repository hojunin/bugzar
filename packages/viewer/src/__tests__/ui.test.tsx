import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Tab } from '../panels/tabs';
import type { ReportMeta } from '../report/types';
import { MetaHeader } from '../ui/MetaHeader';
import { Tabs } from '../ui/Tabs';

afterEach(cleanup);

describe('Tabs', () => {
  const tabs: Tab[] = [
    { key: 'console', label: 'Console', count: 2 },
    { key: 'network', label: 'Network', count: 1 },
  ];
  it('renders labels + counts and fires onSelect', () => {
    const onSelect = vi.fn();
    render(<Tabs tabs={tabs} active="console" onSelect={onSelect} />);
    expect(screen.getByText('Console')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    fireEvent.click(screen.getByText('Network'));
    expect(onSelect).toHaveBeenCalledWith('network');
  });
});

describe('MetaHeader', () => {
  const meta: ReportMeta = {
    url: 'https://app.example/checkout',
    userAgent: 'ua',
    viewport: { width: 800, height: 600 },
    startedAt: 1000,
    endedAt: 6000,
    durationMs: 5000,
    schemaVersion: 1,
  };
  it('shows the captured URL and duration', () => {
    render(<MetaHeader meta={meta} />);
    expect(screen.getByText(/app\.example\/checkout/)).toBeTruthy();
    expect(screen.getByText(/5/)).toBeTruthy(); // 5s duration
  });

  // Design reports' meta has no startedAt/durationMs/viewport — must render the
  // URL instead of crashing on `new Date(undefined).toISOString()`.
  it('renders a design report meta (no startedAt/viewport) without crashing', () => {
    const designMeta = {
      url: 'https://app.example/catalog',
      mode: 'design',
      source: 'sdk',
      schemaVersion: 1,
    } as unknown as ReportMeta;
    render(<MetaHeader meta={designMeta} />);
    expect(screen.getByText(/app\.example\/catalog/)).toBeTruthy();
  });
});
