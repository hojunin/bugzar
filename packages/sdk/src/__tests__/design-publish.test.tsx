import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ── picker mock: capture onComplete so a pick can be "finished" deterministically ──
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

// Design mode never records — stub capture-core so real rrweb isn't loaded.
vi.mock('@bugzar/capture-core', () => ({
  createRecorder: () => ({ start: () => {}, stop: () => ({}), isActive: () => false }),
  captureSnapshot: () => [],
}));

import { Bugzar } from '../Bugzar';

const ANNOTATIONS = [
  {
    id: 'a1',
    selector: '.btn-buy',
    tagName: 'BUTTON',
    textContent: 'Buy',
    cssClasses: 'btn-buy',
    rect: { x: 0, y: 0, width: 10, height: 10 },
    attributes: { 'data-testid': 'buy', id: 'buy-btn' },
    figmaUrl: 'https://figma.com/file/xyz',
    note: 'wrong color',
  },
  {
    id: 'a2',
    selector: '.price',
    tagName: 'SPAN',
    textContent: '$10',
    cssClasses: 'price',
    rect: { x: 0, y: 0, width: 10, height: 10 },
    note: 'misaligned',
  },
];

const json = (o: unknown, status = 200): Response =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

// The design draft (POST /jira/draft mode:'design') returns `description` as an
// ADF doc (jsonToDesignAdf) — same shape as bug mode; the drawer flattens it.
const DESIGN_DRAFT_ADF = {
  type: 'doc',
  version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'AI design body' }] }],
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
  // The backend already exposes a `design` slot (worker ASSETS); the SDK uploads
  // the picked annotations here as metadata-only (no screenshots).
  design: 'https://w.dev/reports/rep1/design.json',
};

interface Overrides {
  draft?: () => Response;
  publish?: () => Response;
}

const makeFetch = (over: Overrides = {}) =>
  vi.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'POST' && url.endsWith('/reports')) {
      return json({ reportId: 'rep1', reportUrl: 'https://w.dev/r/rep1', assetUrls: ASSET_URLS });
    }
    if (method === 'PUT') return json({ ok: true });
    if (method === 'GET' && url.includes('/jira/epics')) {
      return json({ epics: [{ key: 'BUGZAR-10', summary: 'Checkout epic' }] });
    }
    if (method === 'POST' && url.endsWith('/jira/draft')) {
      return (
        over.draft?.() ??
        json({
          title: 'AI design title',
          description: DESIGN_DRAFT_ADF,
          mode: 'design',
          stub: false,
        })
      );
    }
    if (method === 'POST' && url.endsWith('/publish')) {
      return (
        over.publish?.() ??
        json({
          stubbed: false,
          issueKey: 'BUGZAR-77',
          issueUrl: 'https://x.atlassian.net/browse/BUGZAR-77',
        })
      );
    }
    return json({ ok: true });
  });

const renderDesign = (props: Record<string, unknown> = {}, fetchMock = makeFetch()) => {
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

const pickThenFinish = async (): Promise<void> => {
  fireEvent.click(screen.getByLabelText('Leave design feedback on elements'));
  await act(async () => {
    pickerRef.onComplete?.(ANNOTATIONS);
  });
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('F4.3 design-mode publish', () => {
  it('opens the drawer on pick-complete (jira flow) — no Worker upload', async () => {
    const onAnnotate = vi.fn();
    const fetchMock = renderDesign({ onAnnotate });
    await pickThenFinish();

    // Drawer opens for the design issue.
    expect(await screen.findByRole('button', { name: 'Publish' })).toBeTruthy();
    // The annotations are NOT uploaded to a Worker design asset anymore.
    const designPut = fetchMock.mock.calls.find(
      ([u, i]) => String(u) === ASSET_URLS.design && (i as RequestInit)?.method === 'PUT',
    );
    expect(designPut).toBeUndefined();
    // No data loss — onAnnotate still fires with the picked elements.
    expect(onAnnotate).toHaveBeenCalledWith(ANNOTATIONS);
    // Imageless cards: the picked element notes render in the drawer.
    expect(screen.getByText(/wrong color/)).toBeTruthy();
  });

  it('design cards show an index + the note only (no CSS selector noise)', async () => {
    renderDesign();
    await pickThenFinish();
    await screen.findByRole('button', { name: 'Publish' });
    // The reviewer's note is shown…
    expect(screen.getByText('wrong color')).toBeTruthy();
    // …but the CSS selector is not (an index badge replaces it).
    expect(screen.queryByText('.btn-buy')).toBeNull();
  });

  it('links to the uploaded design report before filing', async () => {
    renderDesign(); // onExport returns https://cdn.example.com/r/x.html
    await pickThenFinish();
    const link = (await screen.findByRole('link', { name: /View report/i })) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://cdn.example.com/r/x.html');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('Write with AI posts the design draft inline (mode:design, note→userNote)', async () => {
    const fetchMock = renderDesign();
    await pickThenFinish();
    await screen.findByRole('button', { name: 'Publish' });

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'spacing is off' } });
    fireEvent.click(screen.getByRole('button', { name: 'Write with AI' }));
    await waitFor(() =>
      expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('AI design title'),
    );
    const draftCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/jira/draft'));
    const draftBody = JSON.parse((draftCall?.[1] as RequestInit).body as string);
    expect(draftBody.mode).toBe('design');
    expect(draftBody.reportId).toBeUndefined();
    // CRITICAL: the reviewer note must survive under the key the BACKEND reads.
    expect(draftBody.elements[0].selector).toBe('.btn-buy');
    expect(draftBody.elements[0].userNote).toBe('wrong color');
  });

  it('publishes a design issue → onPublished + post-publish view', async () => {
    const onPublished = vi.fn();
    const fetchMock = renderDesign({ onPublished });
    await pickThenFinish();
    await screen.findByRole('button', { name: 'Publish' });

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Button color wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));

    await waitFor(() =>
      expect(onPublished).toHaveBeenCalledWith({
        issueKey: 'BUGZAR-77',
        issueUrl: 'https://x.atlassian.net/browse/BUGZAR-77',
        stubbed: false,
      }),
    );
    const pub = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/publish'));
    const body = JSON.parse((pub?.[1] as RequestInit).body as string);
    expect(body.title).toBe('Button color wrong');
    expect(body.projectKey).toBe('BUGZAR');
    expect(await screen.findByText('BUGZAR-77')).toBeTruthy();
  });

  it('does NOT open a drawer when jira is disabled — onAnnotate fires instead', async () => {
    const onAnnotate = vi.fn();
    vi.stubGlobal('fetch', makeFetch());
    render(<Bugzar onAnnotate={onAnnotate} />); // no endpoint, no jira
    await pickThenFinish();
    expect(onAnnotate).toHaveBeenCalledWith(ANNOTATIONS);
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
  });
});
