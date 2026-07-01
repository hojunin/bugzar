import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    loadSession: vi.fn(),
    connectAtlassian: vi.fn(),
    getValidAccessToken: vi.fn(),
    clearSession: vi.fn(),
  },
}));

vi.mock('../oauth/atlassian', () => mocks);

import { useAtlassianAuth } from '../oauth/use-atlassian-auth';

const SESSION = {
  tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 1e6, scope: 's' },
  site: { id: 'cloud-1', url: 'https://acme.atlassian.net', name: 'acme' },
  profile: { accountId: 'acc', displayName: '홍길동', email: null, avatarUrl: null },
};

function Harness() {
  const a = useAtlassianAuth('https://w.dev', 'cid');
  return (
    <div>
      <span data-testid="state">{a.state.kind}</span>
      {a.state.kind === 'authenticated' ? (
        <span data-testid="who">{a.state.session.profile.displayName}</span>
      ) : null}
      <button type="button" onClick={() => void a.connect()}>
        connect
      </button>
      <button type="button" onClick={a.disconnect}>
        disconnect
      </button>
    </div>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('useAtlassianAuth', () => {
  it('starts not-connected when there is no stored session', () => {
    mocks.loadSession.mockReturnValue(null);
    render(<Harness />);
    expect(screen.getByTestId('state').textContent).toBe('not-connected');
  });

  it('hydrates as authenticated from a stored session', () => {
    mocks.loadSession.mockReturnValue(SESSION);
    render(<Harness />);
    expect(screen.getByTestId('state').textContent).toBe('authenticated');
    expect(screen.getByTestId('who').textContent).toBe('홍길동');
  });

  it('connect() runs OAuth and becomes authenticated; disconnect() clears', async () => {
    mocks.loadSession.mockReturnValue(null);
    mocks.connectAtlassian.mockResolvedValue({ ok: true, session: SESSION });
    render(<Harness />);
    expect(screen.getByTestId('state').textContent).toBe('not-connected');

    fireEvent.click(screen.getByText('connect'));
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('authenticated'));
    expect(mocks.connectAtlassian).toHaveBeenCalled();

    fireEvent.click(screen.getByText('disconnect'));
    expect(screen.getByTestId('state').textContent).toBe('not-connected');
    expect(mocks.clearSession).toHaveBeenCalled();
  });
});
