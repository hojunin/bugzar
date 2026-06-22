import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── capture-core mock: stop() yields a fixed bundle (no real rrweb) ──
const bundle = {
  events: [{ type: 2, timestamp: 1, data: {} }],
  // 2 console errors + 1 failed request + an LCP → the drawer's capture summary (③).
  console: [
    { level: 'error', tFromStart: 5, args: ['boom'] },
    { level: 'error', tFromStart: 6, args: ['kaboom'] },
    { level: 'log', tFromStart: 7, args: ['ok'] },
  ],
  network: [
    { tFromStart: 8, method: 'POST', url: '/api/pay', status: 500 },
    { tFromStart: 9, method: 'GET', url: '/api/ok', status: 200 },
  ],
  storage: [],
  vitals: { lcp: 2400 },
  meta: {
    url: 'https://app.example/checkout',
    userAgent: 'test',
    viewport: { width: 800, height: 600 },
    startedAt: 1000,
    endedAt: 2000,
    durationMs: 1000,
  },
};

vi.mock('@bugzar/capture-core', () => {
  let active = false;
  return {
    createRecorder: () => ({
      start: () => {
        active = true;
      },
      stop: () => {
        active = false;
        return bundle;
      },
      isActive: () => active,
    }),
    captureSnapshot: () => [{ type: 2 }],
  };
});

vi.mock('@bugzar/sdk/export', () => ({
  exportReportHtml: vi.fn(async () => new Blob(['<!doctype html>'], { type: 'text/html' })),
  exportDesignHtml: vi.fn(async () => new Blob(['<!doctype html>'], { type: 'text/html' })),
}));

import { Bugzar } from '../Bugzar';

const json = (o: unknown, status = 200): Response =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

// The real POST /jira/draft returns `description` as an ADF doc (jsonToBugAdf),
// NOT a plain string. The drawer flattens it to text for the editable field and
// forwards the original ADF on publish (descriptionAdf) so the AI's structure
// (repro steps / env / replay link) survives instead of being dropped.
const AI_DRAFT_ADF = {
  type: 'doc',
  version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'AI description' }] }],
};

const ASSET_URLS = {
  meta: 'https://w.dev/reports/rep1/meta.json',
  events: 'https://w.dev/reports/rep1/events.json',
  console: 'https://w.dev/reports/rep1/console.json',
  network: 'https://w.dev/reports/rep1/network.json',
  storage: 'https://w.dev/reports/rep1/storage.json',
  replay: 'https://w.dev/reports/rep1/replay.html',
  vitals: 'https://w.dev/reports/rep1/vitals.json',
  resources: 'https://w.dev/reports/rep1/resources.json',
  state: 'https://w.dev/reports/rep1/state.json',
};

interface FetchOverrides {
  draft?: () => Response;
  epics?: () => Response;
  publish?: () => Response;
}

const makeFetch = (over: FetchOverrides = {}) =>
  vi.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'POST' && url.endsWith('/reports')) {
      return json({ reportId: 'rep1', reportUrl: 'https://w.dev/r/rep1', assetUrls: ASSET_URLS });
    }
    if (method === 'PUT') return json({ ok: true });
    if (method === 'GET' && url.includes('/jira/epics')) {
      return over.epics?.() ?? json({ epics: [{ key: 'BUGZAR-10', summary: 'Checkout epic' }] });
    }
    if (method === 'POST' && url.endsWith('/jira/draft')) {
      // ADF `description` (matches the real worker), not a plain string.
      return (
        over.draft?.() ??
        json({ title: 'AI title', description: AI_DRAFT_ADF, mode: 'bug', stub: false })
      );
    }
    if (method === 'POST' && url.endsWith('/publish')) {
      return (
        over.publish?.() ??
        json({
          stubbed: false,
          issueKey: 'BUGZAR-42',
          issueUrl: 'https://x.atlassian.net/browse/BUGZAR-42',
        })
      );
    }
    return json({ ok: true });
  });

const renderJira = (props: Record<string, unknown> = {}, fetchMock = makeFetch()) => {
  vi.stubGlobal('fetch', fetchMock);
  render(
    <Bugzar
      endpoint="https://w.dev"
      jira={{ enabled: true, defaultEpicKey: 'BUGZAR-1' }}
      onExport={async () => 'https://cdn.example.com/r/x.html'}
      {...props}
    />,
  );
  return fetchMock;
};

const startThenStop = (): void => {
  fireEvent.click(screen.getByLabelText('Start recording'));
  fireEvent.click(screen.getByLabelText('Stop recording'));
};

beforeEach(() => {
  /* real timers — waitFor covers the debounce */
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('M4 review drawer — open + upload', () => {
  it('opens the review drawer on stop (jira flow) — no Worker upload', async () => {
    const fetchMock = renderJira();
    startThenStop();

    // Drawer appears once the HTML is built + handed to onExport.
    expect(await screen.findByRole('button', { name: 'Publish' })).toBeTruthy();
    // The bundle is NOT uploaded to the Worker anymore (report-less).
    const reportPosts = fetchMock.mock.calls.filter(
      ([u, i]) => String(u).endsWith('/reports') && (i as RequestInit)?.method === 'POST',
    );
    expect(reportPosts.length).toBe(0);
  });

  it('links to the uploaded replay so the reviewer can open it before filing', async () => {
    renderJira(); // onExport returns https://cdn.example.com/r/x.html
    startThenStop();
    const link = (await screen.findByRole('link', { name: /View replay/i })) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://cdn.example.com/r/x.html');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('does NOT open a drawer when jira is disabled — fires onExport instead', async () => {
    const onExport = vi.fn(async () => undefined);
    vi.stubGlobal('fetch', makeFetch());
    render(<Bugzar onExport={onExport} />); // no endpoint, no jira
    startThenStop();
    await waitFor(() => expect(onExport).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
  });

  it('shows NO drawer when endpoint is set yet jira is disabled', async () => {
    const onExport = vi.fn(async () => 'https://cdn/x.html');
    vi.stubGlobal('fetch', makeFetch());
    render(<Bugzar endpoint="https://w.dev" onExport={onExport} />); // endpoint, no jira
    startThenStop();
    await waitFor(() => expect(onExport).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
  });
});

describe('M4 review drawer — fields + publish', () => {
  it('disables Publish until a title is entered', async () => {
    renderJira();
    startThenStop();
    const publish = (await screen.findByRole('button', { name: 'Publish' })) as HTMLButtonElement;
    expect(publish.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Checkout breaks' } });
    expect(publish.disabled).toBe(false);
  });

  it('searches epics globally (no projectKey) and lets you pick one', async () => {
    const fetchMock = renderJira();
    startThenStop();
    await screen.findByRole('button', { name: 'Publish' });

    fireEvent.change(screen.getByLabelText('Epic'), { target: { value: 'check' } });
    await waitFor(() =>
      expect(
        // Global epic search — no project scope; the project is derived from the
        // chosen epic key on publish.
        fetchMock.mock.calls.some(
          ([u]) =>
            String(u).includes('/jira/epics') &&
            String(u).includes('check') &&
            !String(u).includes('projectKey'),
        ),
      ).toBe(true),
    );
    // The matched substring is wrapped in <mark> (highlight) so the text is split
    // across nodes — match the option button by its full textContent.
    const option = await screen.findByText(
      (_content, el) => el?.tagName === 'BUTTON' && !!el.textContent?.includes('Checkout epic'),
    );
    fireEvent.click(option);
    // selection reflected (the option text now shows as the chosen epic)
    expect((screen.getByLabelText('Epic') as HTMLInputElement).value).toBe('Checkout epic');
  });

  it('shows the epic ticket key next to the title in the dropdown', async () => {
    renderJira();
    startThenStop();
    await screen.findByRole('button', { name: 'Publish' });

    fireEvent.change(screen.getByLabelText('Epic'), { target: { value: 'check' } });
    // The option lists the key (BUGZAR-10) alongside the title.
    const option = await screen.findByText(
      (_c, el) => el?.tagName === 'BUTTON' && !!el.textContent?.includes('BUGZAR-10'),
    );
    expect(option.textContent).toContain('Checkout epic');
  });

  it('AI polish fills title/description from /jira/draft (inline artifacts, no reportId)', async () => {
    const fetchMock = renderJira();
    startThenStop();
    await screen.findByRole('button', { name: 'Publish' });

    // Seed a one-liner — the real /jira/draft 400s on empty userInput.
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'checkout broke' } });
    fireEvent.click(screen.getByRole('button', { name: 'AI polish' }));
    await waitFor(() =>
      expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('AI title'),
    );
    // The ADF `description` is flattened to plain text for the editable field.
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe(
      'AI description',
    );
    // The draft request carries inline artifacts + a non-empty userInput — no reportId.
    const draftCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/jira/draft'));
    const draftBody = JSON.parse((draftCall?.[1] as RequestInit).body as string);
    expect(draftBody.reportId).toBeUndefined();
    expect(draftBody.artifacts).toBeTruthy();
    expect(String(draftBody.userInput ?? '').length).toBeGreaterThan(0);
  });

  it('forwards the AI draft body to publish as descriptionAdf when unedited (no AI-body loss)', async () => {
    const fetchMock = renderJira();
    startThenStop();
    await screen.findByRole('button', { name: 'Publish' });

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'seed' } });
    fireEvent.click(screen.getByRole('button', { name: 'AI polish' }));
    await waitFor(() =>
      expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('AI title'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await screen.findByText('BUGZAR-42');

    const pub = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/publish'));
    const body = JSON.parse((pub?.[1] as RequestInit).body as string);
    // The rich ADF the AI produced survives to publish (not flattened/dropped).
    expect(body.descriptionAdf?.type).toBe('doc');
  });

  it('shows an AI-fail fallback when /jira/draft fails, keeping manual publish usable', async () => {
    renderJira({}, makeFetch({ draft: () => json({ error: 'AI down' }, 500) }));
    startThenStop();
    await screen.findByRole('button', { name: 'Publish' });

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'seed' } });
    fireEvent.click(screen.getByRole('button', { name: 'AI polish' }));
    // The AI-fail fallback message (the button label also contains "AI", so match
    // the distinctive fallback copy to stay unambiguous).
    expect(await screen.findByText(/AI polish is unavailable/i)).toBeTruthy();
    // manual publish still works
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Manual title' } });
    expect((screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('publishes with title + projectKey + epic, shows the post-publish view, fires onPublished', async () => {
    const onPublished = vi.fn();
    const fetchMock = renderJira({ onPublished });
    startThenStop();
    await screen.findByRole('button', { name: 'Publish' });

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Checkout 500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));

    await waitFor(() =>
      expect(onPublished).toHaveBeenCalledWith({
        issueKey: 'BUGZAR-42',
        issueUrl: 'https://x.atlassian.net/browse/BUGZAR-42',
        stubbed: false,
      }),
    );

    // the /publish request carried the right payload
    const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/publish'));
    expect(call).toBeTruthy();
    const body = JSON.parse((call?.[1] as RequestInit).body as string);
    expect(body.title).toBe('Checkout 500');
    expect(body.projectKey).toBe('BUGZAR');
    // defaultEpicKey pre-fills the epic and threads into the payload.
    expect(body.epicKey).toBe('BUGZAR-1');

    // post-publish view links to the created issue
    expect(await screen.findByText('BUGZAR-42')).toBeTruthy();
  });

  it('shows a NOT-REAL affordance when publish is stubbed (never a fabricated real issue)', async () => {
    const onPublished = vi.fn();
    renderJira(
      { onPublished },
      makeFetch({
        publish: () =>
          json({
            stubbed: true,
            issueKey: 'STUB-12345',
            issueUrl: 'https://example.invalid/browse/STUB-12345',
          }),
      }),
    );
    startThenStop();
    await screen.findByRole('button', { name: 'Publish' });

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Checkout 500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));

    await waitFor(() =>
      expect(onPublished).toHaveBeenCalledWith({
        stubbed: true,
        issueKey: 'STUB-12345',
        issueUrl: 'https://example.invalid/browse/STUB-12345',
      }),
    );
    // The stub key is shown, but explicitly flagged not-real and NOT a clickable real link.
    expect(await screen.findByText(/STUB-12345/)).toBeTruthy();
    expect(screen.getByText(/not a real|placeholder|not configured/i)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /STUB-12345/ })).toBeNull();
  });

  it('Cancel closes the drawer without publishing (D3)', async () => {
    const fetchMock = renderJira();
    startThenStop();
    await screen.findByRole('button', { name: 'Publish' });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull());
    // Cancel files nothing — no /publish request.
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/publish'))).toBe(false);
  });
});
