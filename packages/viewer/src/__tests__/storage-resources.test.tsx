import type { ResourceTimingEntry, StorageSnapshotPayload } from '@bugzar/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ResourcesPanel } from '../panels/ResourcesPanel';
import { StoragePanel } from '../panels/StoragePanel';

afterEach(cleanup);

describe('StoragePanel JSON values', () => {
  it('renders a JSON localStorage value as a foldable tree + parses cookies', () => {
    const snaps: StorageSnapshotPayload[] = [
      {
        tFromStart: 0,
        localStorage: { prefs: '{"theme":"dark","n":3}' },
        sessionStorage: {},
        cookies: 'sid=xyz',
      },
    ];
    render(<StoragePanel snapshots={snaps} currentTime={5} />);
    expect(screen.getByText('prefs:')).toBeTruthy();
    expect(screen.getByText('theme:')).toBeTruthy(); // nested JSON key
    expect(screen.getByText('"dark"')).toBeTruthy(); // nested value
    expect(screen.getByText('sid:')).toBeTruthy(); // cookie parsed into a node
  });

  it('always shows all three stores, marking empty ones', () => {
    const snaps: StorageSnapshotPayload[] = [
      { tFromStart: 0, localStorage: { a: '1' }, sessionStorage: {}, cookies: '' },
    ];
    render(<StoragePanel snapshots={snaps} currentTime={0} />);
    // All three section headers present even when empty.
    expect(screen.getByText('localStorage')).toBeTruthy();
    expect(screen.getByText('sessionStorage')).toBeTruthy();
    expect(screen.getByText('cookies')).toBeTruthy();
    // sessionStorage + cookies are empty here → two "(empty)" notes.
    expect(screen.getAllByText('(empty)')).toHaveLength(2);
  });
});

describe('ResourcesPanel detail', () => {
  const entries: ResourceTimingEntry[] = [
    {
      name: 'https://cdn/app.js',
      initiatorType: 'script',
      startTime: 10,
      duration: 50,
      transferSize: 2048,
      encodedBodySize: 1000,
      decodedBodySize: 4000,
      nextHopProtocol: 'h2',
    },
  ];

  it('expands a row to show the resource detail fields', () => {
    render(<ResourcesPanel entries={entries} />);
    expect(screen.queryByText('Decoded body')).toBeNull(); // collapsed
    fireEvent.click(screen.getByText(/app\.js/));
    expect(screen.getByText('Decoded body')).toBeTruthy();
    expect(screen.getByText('Protocol')).toBeTruthy();
  });

  it('tags resources by type and filters via the type chips', () => {
    const mixed: ResourceTimingEntry[] = [
      {
        name: 'https://cdn/app.js',
        initiatorType: 'script',
        startTime: 10,
        duration: 50,
        transferSize: 2048,
        encodedBodySize: 1000,
        decodedBodySize: 4000,
        nextHopProtocol: 'h2',
      },
      {
        name: 'https://cdn/logo.png',
        initiatorType: 'img',
        startTime: 0,
        duration: 5,
        transferSize: 512,
        encodedBodySize: 512,
        decodedBodySize: 512,
        nextHopProtocol: 'h2',
      },
    ];
    render(<ResourcesPanel entries={mixed} />);
    expect(screen.getByText(/app\.js/)).toBeTruthy();
    expect(screen.getByText(/logo\.png/)).toBeTruthy();
    // filter to Img → only the png remains
    fireEvent.click(screen.getByRole('button', { name: 'Img 1' }));
    expect(screen.queryByText(/app\.js/)).toBeNull();
    expect(screen.getByText(/logo\.png/)).toBeTruthy();
  });

  it('filters correctly when entries share (startTime, name) [dup-key regression]', () => {
    const poll: ResourceTimingEntry = {
      name: 'https://x/__poll',
      initiatorType: 'fetch',
      startTime: 5,
      duration: 1,
      transferSize: 10,
      encodedBodySize: 10,
      decodedBodySize: 10,
      nextHopProtocol: 'h2',
    };
    const dup: ResourceTimingEntry[] = [
      { ...poll },
      { ...poll }, // identical (startTime,name) → would collide on a content key
      {
        name: 'https://x/font.woff2',
        initiatorType: 'css',
        startTime: 6,
        duration: 1,
        transferSize: 20,
        encodedBodySize: 20,
        decodedBodySize: 20,
        nextHopProtocol: 'h2',
      },
    ];
    render(<ResourcesPanel entries={dup} />);
    fireEvent.click(screen.getByRole('button', { name: 'Font 1' }));
    expect(screen.queryByText(/__poll/)).toBeNull(); // no stale fetch rows
    expect(screen.getByText(/font\.woff2/)).toBeTruthy();
  });
});
