import type { RrwebEvent } from '@bugzar/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesignView, expandScrollContainers } from '../design/DesignView';
import type { DesignElement, ReportData } from '../report/types';

// Stub rrweb so visual mode doesn't try to build a real replayer in happy-dom.
// The stub creates no iframe → the snapshot stays "rendering", and the side list
// (which is what we assert) renders regardless.
vi.mock('rrweb', () => ({
  Replayer: vi.fn().mockImplementation(() => ({ pause: vi.fn(), destroy: vi.fn() })),
}));

afterEach(cleanup);

const elements: DesignElement[] = [
  {
    selector: '.btn-buy',
    tagName: 'BUTTON',
    textContent: 'Buy',
    cssClasses: 'btn-buy',
    rect: { x: 0, y: 0, width: 80, height: 32 },
    componentName: 'BuyButton',
    userNote: 'wrong color',
  },
  {
    selector: '.price',
    tagName: 'SPAN',
    textContent: '$10',
    cssClasses: 'price',
    rect: { x: 0, y: 40, width: 40, height: 16 },
    attributes: { 'data-testid': 'unit-price' },
    figmaUrl: 'https://figma.com/file/abc',
    userNote: 'misaligned',
  },
];

const SNAPSHOT: RrwebEvent[] = [
  { type: 4, timestamp: 0, data: {} },
  { type: 2, timestamp: 1, data: {} },
];

describe('DesignView', () => {
  it('falls back to a card per element when there is no page snapshot', () => {
    render(<DesignView elements={elements} events={[]} />);
    expect(screen.getByText('.btn-buy')).toBeTruthy();
    expect(screen.getByText(/wrong color/)).toBeTruthy();
    expect(screen.getByText('.price')).toBeTruthy();
    expect(screen.getByText(/misaligned/)).toBeTruthy();
  });

  it('surfaces the React component name in the fallback', () => {
    render(<DesignView elements={elements} events={[]} />);
    expect(screen.getByText(/BuyButton/)).toBeTruthy();
  });

  it('with a snapshot, shows the message list alongside the screen (pinned mode)', () => {
    render(<DesignView elements={elements} events={SNAPSHOT} />);
    // The side panel lists each annotation's selector + note next to the screen.
    expect(screen.getByRole('tab', { name: /Annotations 2/ })).toBeTruthy();
    expect(screen.getByText('.btn-buy')).toBeTruthy();
    expect(screen.getByText('wrong color')).toBeTruthy();
    expect(screen.getByText('misaligned')).toBeTruthy();
  });

  it('hides system info behind a tab and reveals it on click', () => {
    const system = {
      collectedAt: 0,
      browser: {
        userAgent: 'Mozilla/5.0 (Macintosh) Chrome/120.0 Safari/537',
        language: 'ko-KR',
        languages: ['ko-KR'],
        cookieEnabled: true,
        doNotTrack: null,
        online: true,
      },
      screen: {
        width: 1920,
        height: 1080,
        availWidth: 1920,
        availHeight: 1040,
        colorDepth: 24,
        pixelDepth: 24,
        devicePixelRatio: 2,
      },
      viewport: { width: 1280, height: 720 },
      locale: { timeZone: 'Asia/Seoul', timezoneOffsetMin: -540, locale: 'ko-KR' },
      page: {
        url: 'https://app/catalog',
        referrer: '',
        title: 'Catalog',
        prefersColorScheme: 'light',
        prefersReducedMotion: false,
      },
    } as NonNullable<ReportData['system']>;
    render(
      <DesignView elements={elements} events={SNAPSHOT} system={system} meta={null} vitals={{}} />,
    );

    // Default tab is annotations → system info stays hidden until requested.
    expect(screen.queryByText('Asia/Seoul')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'System' }));
    // System tab reveals the SystemInfoPanel (captured environment).
    expect(screen.getByText('Asia/Seoul')).toBeTruthy(); // captured time zone (unique value)
  });

  it('expandScrollContainers un-clips only the annotated element’s ancestors, sparing unrelated widgets', () => {
    document.body.innerHTML =
      '<div id="shell"><div id="scroller"><button id="target"></button></div></div><div id="widget"></div>';
    const shell = document.getElementById('shell') as HTMLElement;
    const scroller = document.getElementById('scroller') as HTMLElement;
    const widget = document.getElementById('widget') as HTMLElement;
    const style = (o: Partial<CSSStyleDeclaration>) =>
      ({
        overflow: 'visible',
        overflowX: 'visible',
        overflowY: 'visible',
        position: 'static',
        ...o,
      }) as CSSStyleDeclaration;
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el) => {
      if (el === scroller) return style({ overflow: 'auto', overflowY: 'auto' });
      if (el === shell) return style({ position: 'fixed' });
      if (el === widget) return style({ position: 'fixed' }); // unrelated floating widget
      return style({});
    });

    expandScrollContainers(document, ['#target']);

    // The annotated element's scroll-container ancestor is expanded…
    expect(scroller.style.overflow).toBe('visible');
    expect(scroller.style.height).toBe('auto');
    // …and its fixed ancestor drops into flow.
    expect(shell.style.position).toBe('static');
    // The document root is freed to grow to its content.
    expect(document.body.style.overflow).toBe('visible');
    expect(document.documentElement.style.height).toBe('auto');
    // But an UNRELATED fixed widget (e.g. the devtools button) is left untouched
    // — touching it would balloon its SVG once the size constraint is removed.
    expect(widget.style.position).toBe('');

    vi.mocked(window.getComputedStyle).mockRestore();
  });

  it('surfaces identifying attributes, the Figma link, and copy actions', () => {
    render(<DesignView elements={elements} events={SNAPSHOT} pageUrl="https://app/catalog" />);
    // Attribute chips for code lookup.
    expect(screen.getByText('data-testid')).toBeTruthy();
    // Figma link is clickable.
    const figma = screen.getByRole('link', { name: /Figma/ }) as HTMLAnchorElement;
    expect(figma.href).toBe('https://figma.com/file/abc');
    // Copy-for-AI affordances exist (per-item + copy all).
    expect(screen.getByText('Copy all')).toBeTruthy();
    expect(screen.getAllByText('Copy for AI').length).toBe(2);
  });
});
