import type { ConsoleEntry, NetworkEntryPayload } from '@bugzar/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConsolePanel } from '../panels/ConsolePanel';
import { NetworkPanel } from '../panels/NetworkPanel';

afterEach(cleanup);

const net: NetworkEntryPayload = {
  tFromStart: 1,
  method: 'POST',
  url: '/api/pay',
  status: 500,
  durationMs: 10,
  requestHeaders: { 'x-req-header': 'reqval' },
  requestBody: 'REQUEST_BODY_TEXT',
  responseHeaders: { 'x-res-header': 'resval' },
  responseBody: 'RESPONSE_BODY_TEXT',
  error: null,
  initiator: 'fetch',
};

describe('NetworkPanel row detail', () => {
  it('hides request/response detail until the row is expanded', () => {
    render(<NetworkPanel entries={[net]} query="" currentTime={0} onSeek={vi.fn()} />);
    // collapsed
    expect(screen.queryByText('x-res-header')).toBeNull();
    expect(screen.queryByText('RESPONSE_BODY_TEXT')).toBeNull();

    fireEvent.click(screen.getByText('/api/pay'));

    // expanded: headers + bodies for both request and response
    expect(screen.getByText('x-req-header')).toBeTruthy();
    expect(screen.getByText('REQUEST_BODY_TEXT')).toBeTruthy();
    expect(screen.getByText('x-res-header')).toBeTruthy();
    expect(screen.getByText('RESPONSE_BODY_TEXT')).toBeTruthy();
  });

  it('still seeks the player when a row is clicked (timeline sync preserved)', () => {
    const onSeek = vi.fn();
    render(<NetworkPanel entries={[net]} query="" currentTime={0} onSeek={onSeek} />);
    fireEvent.click(screen.getByText('/api/pay'));
    expect(onSeek).toHaveBeenCalledWith(1);
  });
});

describe('ConsolePanel stack detail', () => {
  const withStack: ConsoleEntry = {
    level: 'error',
    tFromStart: 1,
    args: ['boom'],
    stack: 'STACK_LINE_ONE\n    at foo (a.ts:1:1)',
  };

  it('reveals the stack trace when an error row is expanded', () => {
    render(<ConsolePanel entries={[withStack]} query="" currentTime={0} onSeek={vi.fn()} />);
    expect(screen.queryByText(/STACK_LINE_ONE/)).toBeNull();
    fireEvent.click(screen.getByText('boom'));
    expect(screen.getByText(/STACK_LINE_ONE/)).toBeTruthy();
  });
});
