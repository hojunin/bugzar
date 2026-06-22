import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { pickerRef } = vi.hoisted(() => ({
  pickerRef: {} as { onComplete?: (a: unknown[]) => void; onCancel?: () => void },
}));
vi.mock('../picker/picker', () => ({
  startDesignPick: (opts: { onComplete: (a: unknown[]) => void; onCancel: () => void }) => {
    pickerRef.onComplete = opts.onComplete;
    pickerRef.onCancel = opts.onCancel;
    return { stop: () => {}, isActive: () => true };
  },
}));
vi.mock('@bugzar/capture-core', () => ({
  createRecorder: () => ({ start: () => {}, stop: () => ({}), isActive: () => false }),
  captureSnapshot: () => [],
}));

const { atl } = vi.hoisted(() => ({
  atl: {
    loadSession: vi.fn(),
    connectAtlassian: vi.fn(),
    getValidAccessToken: vi.fn(),
    clearSession: vi.fn(),
    publishIssue: vi.fn(),
    searchEpics: vi.fn(),
  },
}));
vi.mock('../oauth/atlassian', () => atl);

import { Bugzar } from '../Bugzar';

const SESSION = {
  tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 1e6, scope: 's' },
  site: { id: 'cloud-1', url: 'https://acme.atlassian.net', name: 'acme' },
  profile: { accountId: 'acc', displayName: '홍길동', email: null, avatarUrl: null },
};

const ANNOTATIONS = [
  {
    id: 'a1',
    selector: '.btn',
    tagName: 'button',
    textContent: 'Buy',
    cssClasses: 'btn',
    rect: { x: 0, y: 0, width: 10, height: 10 },
    note: 'wrong color',
  },
];

const ASSET_URLS = {
  meta: 'https://w.dev/reports/r1/meta.json',
  events: 'https://w.dev/reports/r1/events.json',
  design: 'https://w.dev/reports/r1/design.json',
};

beforeEach(() => {
  atl.loadSession.mockReturnValue(null);
  atl.getValidAccessToken.mockResolvedValue('tok');
  atl.connectAtlassian.mockResolvedValue({ ok: true, session: SESSION });
  atl.publishIssue.mockResolvedValue({
    issueKey: 'BUGZAR-5',
    issueUrl: 'https://acme.atlassian.net/browse/BUGZAR-5',
  });
  atl.searchEpics.mockResolvedValue([]);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST' && url.endsWith('/reports')) {
        return new Response(
          JSON.stringify({
            reportId: 'r1',
            reportUrl: 'https://w.dev/r/r1',
            assetUrls: ASSET_URLS,
          }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 200 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('Jira OAuth drawer (clientId set)', () => {
  it('annotate → drawer asks to connect → connect → publishes AS THE USER', async () => {
    render(<Bugzar endpoint="https://w.dev" jira={{ clientId: 'cid' }} />);
    fireEvent.click(screen.getByLabelText('Leave design feedback on elements'));
    await act(async () => {
      pickerRef.onComplete?.(ANNOTATIONS);
    });

    // Not connected yet → the drawer shows the Connect step (not the publish form).
    expect(await screen.findByText('Connect Atlassian')).toBeTruthy();
    expect(screen.queryByLabelText('Title')).toBeNull();

    fireEvent.click(screen.getByText('Connect Atlassian'));
    await waitFor(() => expect(screen.getByLabelText('Title')).toBeTruthy());
    expect(atl.connectAtlassian).toHaveBeenCalled();
    // Connected account is shown.
    expect(screen.getByText('홍길동')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Color off' } });

    // An epic is required — the project is derived from it (BUGZAR-12 → BUGZAR).
    atl.searchEpics.mockResolvedValue([{ key: 'BUGZAR-12', summary: 'Checkout epic' }]);
    fireEvent.change(screen.getByLabelText('Epic'), { target: { value: 'check' } });
    fireEvent.click(
      await screen.findByText(
        (_c, el) => el?.tagName === 'BUTTON' && !!el.textContent?.includes('Checkout epic'),
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'File Jira ticket' }));

    await waitFor(() => expect(screen.getByText('BUGZAR-5')).toBeTruthy());
    expect(atl.publishIssue).toHaveBeenCalledTimes(1);
    const [, token, input] = atl.publishIssue.mock.calls[0] as [
      unknown,
      string,
      { cloudId: string; projectKey: string; issueType: string; title: string; epicKey: string },
    ];
    expect(token).toBe('tok');
    expect(input).toMatchObject({
      cloudId: 'cloud-1',
      projectKey: 'BUGZAR',
      issueType: 'Task', // design → Task
      title: 'Color off',
      epicKey: 'BUGZAR-12',
    });
  });

  it('puts the account avatar in the header with name and disconnect in its popover', async () => {
    atl.loadSession.mockReturnValue(SESSION);
    render(<Bugzar endpoint="https://w.dev" jira={{ clientId: 'cid' }} />);
    fireEvent.click(screen.getByLabelText('Leave design feedback on elements'));
    await act(async () => {
      pickerRef.onComplete?.(ANNOTATIONS);
    });
    await screen.findByLabelText('Title');
    // Header shows only the avatar (labelled with the account); name + disconnect
    // live in its hover/focus popover (rendered, revealed on demand).
    expect(screen.getByRole('button', { name: '홍길동' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy();
  });

  it('shows the profile photo when avatarUrl is set, falling back to initials on load error', async () => {
    atl.loadSession.mockReturnValue({
      ...SESSION,
      profile: { ...SESSION.profile, avatarUrl: 'https://cdn.example.com/a.png' },
    });
    render(<Bugzar endpoint="https://w.dev" jira={{ clientId: 'cid' }} />);
    fireEvent.click(screen.getByLabelText('Leave design feedback on elements'));
    await act(async () => {
      pickerRef.onComplete?.(ANNOTATIONS);
    });
    await screen.findByLabelText('Title');
    const avatar = screen.getByRole('button', { name: '홍길동' });
    const img = avatar.querySelector('img');
    expect(img?.getAttribute('src')).toBe('https://cdn.example.com/a.png');
    // Host-page CSP block / 404 → onError swaps the photo out for initials.
    fireEvent.error(img as HTMLImageElement);
    expect(avatar.querySelector('img')).toBeNull();
    expect(avatar.textContent).toContain('홍');
  });

  it('hydrates straight to the form when a session is already stored', async () => {
    atl.loadSession.mockReturnValue(SESSION);
    render(<Bugzar endpoint="https://w.dev" jira={{ clientId: 'cid' }} />);
    fireEvent.click(screen.getByLabelText('Leave design feedback on elements'));
    await act(async () => {
      pickerRef.onComplete?.(ANNOTATIONS);
    });
    // Already connected → no Connect button, form is ready.
    expect(await screen.findByLabelText('Title')).toBeTruthy();
    expect(screen.queryByText('Connect Atlassian')).toBeNull();
  });
});
