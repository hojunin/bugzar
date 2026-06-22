// Refactor safety net for the ReviewDrawer + Bugzar "Thinking in React" split.
//
// These pin behavior at seams the refactor cuts that the existing suite does NOT
// yet assert: Escape-to-close, last-epic localStorage prefill/persist, the
// publish-failure fallback, the epic dropdown loading/empty states, the design
// cards, and Title autofocus. Everything is driven through the public <Bugzar>
// surface (never importing internals), so the same tests must stay green before
// AND after the components are moved into folders.
//
// See docs/superpowers/specs/2026-06-22-reviewdrawer-bugzar-refactor-design.md.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── capture-core mock: stop() yields a fixed bundle (no real rrweb) ──
const bundle = {
  events: [{ type: 2, timestamp: 1, data: {} }],
  console: [],
  network: [],
  storage: [],
  vitals: {},
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
    collectSystemInfo: () => null,
  };
});

vi.mock('@bugzar/sdk/export', () => ({
  exportReportHtml: vi.fn(async () => new Blob(['<!doctype html>'], { type: 'text/html' })),
  exportDesignHtml: vi.fn(async () => new Blob(['<!doctype html>'], { type: 'text/html' })),
}));

// ── picker mock: capture onComplete so a design pick can be finished on demand ──
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

import { Bugzar } from '../Bugzar';

const LAST_EPIC_KEY = 'bugzar:last-epic';

const json = (o: unknown, status = 200): Response =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

interface FetchOverrides {
  draft?: () => Response;
  epics?: () => Response;
  publish?: () => Response;
}

const makeFetch = (over: FetchOverrides = {}) =>
  vi.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.includes('/jira/epics')) {
      return over.epics?.() ?? json({ epics: [{ key: 'BUGZAR-10', summary: 'Checkout epic' }] });
    }
    if (method === 'POST' && url.endsWith('/jira/draft')) {
      return (
        over.draft?.() ??
        json({ title: 'AI title', description: { type: 'doc', version: 1, content: [] }, mode: 'bug' })
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

// Service-account flow (jira.enabled, no clientId) — no Atlassian OAuth module needed.
// `defaultEpicKey` is intentionally omitted by default so the localStorage prefill path
// (loadLastEpic) is exercised; pass `jira` via props to override.
const renderBug = (props: Record<string, unknown> = {}, fetchMock = makeFetch()) => {
  vi.stubGlobal('fetch', fetchMock);
  render(
    <Bugzar
      endpoint="https://w.dev"
      jira={{ enabled: true }}
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

const pickEpic = async (query = 'check'): Promise<void> => {
  fireEvent.change(screen.getByLabelText('Epic'), { target: { value: query } });
  fireEvent.click(
    await screen.findByText(
      (_c, el) => el?.tagName === 'BUTTON' && !!el.textContent?.includes('Checkout epic'),
    ),
  );
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
  {
    id: 'a2',
    selector: '.price',
    tagName: 'span',
    textContent: '$10',
    cssClasses: 'price',
    rect: { x: 0, y: 0, width: 10, height: 10 },
    note: 'misaligned',
  },
];

// A deterministic in-memory localStorage — the runner's ambient Storage lacks a
// full API, and the last-epic tests need real get/set round-trips.
beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k) : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('refactor safety net — drawer keyboard + lifecycle', () => {
  it('Escape closes the drawer without filing', async () => {
    const fetchMock = renderBug();
    startThenStop();
    await screen.findByRole('button', { name: 'Publish' });

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull());
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/publish'))).toBe(false);
  });

  it('focuses the Title field when the form opens', async () => {
    renderBug();
    startThenStop();
    const title = await screen.findByLabelText('Title');
    await waitFor(() => expect(document.activeElement).toBe(title));
  });
});

describe('refactor safety net — last-epic persistence', () => {
  it('prefills the Epic field from the last published epic (localStorage)', async () => {
    localStorage.setItem(LAST_EPIC_KEY, JSON.stringify({ key: 'BUGZAR-9', summary: 'Saved epic' }));
    renderBug(); // no defaultEpicKey → loadLastEpic wins
    startThenStop();
    await screen.findByRole('button', { name: 'Publish' });

    expect((screen.getByLabelText('Epic') as HTMLInputElement).value).toBe('Saved epic');
    // The epic KEY was loaded too → Publish enables as soon as a title is present.
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'A title' } });
    expect((screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('persists the chosen epic to localStorage on a successful publish', async () => {
    renderBug();
    startThenStop();
    await screen.findByRole('button', { name: 'Publish' });

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Checkout 500' } });
    await pickEpic();
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await screen.findByText('BUGZAR-42');

    expect(JSON.parse(localStorage.getItem(LAST_EPIC_KEY) ?? '{}')).toEqual({
      key: 'BUGZAR-10',
      summary: 'Checkout epic',
    });
  });

  it('does NOT persist the epic when the publish is stubbed', async () => {
    renderBug(
      {},
      makeFetch({
        publish: () =>
          json({
            stubbed: true,
            issueKey: 'STUB-1',
            issueUrl: 'https://example.invalid/browse/STUB-1',
          }),
      }),
    );
    startThenStop();
    await screen.findByRole('button', { name: 'Publish' });

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'A title' } });
    await pickEpic();
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await screen.findByText(/STUB-1/);

    expect(localStorage.getItem(LAST_EPIC_KEY)).toBeNull();
  });
});

describe('refactor safety net — publish failure', () => {
  it('shows the publish-failed fallback and keeps the form usable when publish errors', async () => {
    renderBug(
      { jira: { enabled: true, defaultEpicKey: 'BUGZAR-1' } },
      makeFetch({ publish: () => json({ error: 'boom' }, 500) }),
    );
    startThenStop();
    await screen.findByRole('button', { name: 'Publish' });

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Checkout 500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));

    expect(await screen.findByText(/Publish failed/i)).toBeTruthy();
    // phase returned to 'edit' → the form is still mounted and Publish is usable again.
    expect((screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});

describe('refactor safety net — epic combobox states', () => {
  it('shows a loading row immediately, then resolves to the epic results', async () => {
    renderBug();
    startThenStop();
    await screen.findByRole('button', { name: 'Publish' });

    fireEvent.change(screen.getByLabelText('Epic'), { target: { value: 'check' } });
    // The loading row renders synchronously, before the 250ms debounce resolves.
    expect(screen.getByText(/Searching/)).toBeTruthy();
    // …then the debounced search resolves to the option.
    expect(
      await screen.findByText(
        (_c, el) => el?.tagName === 'BUTTON' && !!el.textContent?.includes('Checkout epic'),
      ),
    ).toBeTruthy();
  });

  it('shows "No epics found" when the search returns nothing', async () => {
    renderBug({}, makeFetch({ epics: () => json({ epics: [] }) }));
    startThenStop();
    await screen.findByRole('button', { name: 'Publish' });

    fireEvent.change(screen.getByLabelText('Epic'), { target: { value: 'zzz' } });
    expect(await screen.findByText('No epics found')).toBeTruthy();
  });
});

describe('refactor safety net — design cards', () => {
  it('renders one indexed card per picked element in design mode', async () => {
    renderBug();
    fireEvent.click(screen.getByLabelText('Leave design feedback on elements'));
    await act(async () => {
      pickerRef.onComplete?.(ANNOTATIONS);
    });
    await screen.findByRole('button', { name: 'Publish' });

    expect(document.querySelectorAll('.bugzar-design-card').length).toBe(2);
    expect(screen.getByText('wrong color')).toBeTruthy();
    expect(screen.getByText('misaligned')).toBeTruthy();
    const indices = Array.from(document.querySelectorAll('.bugzar-card-index')).map(
      (n) => n.textContent,
    );
    expect(indices).toEqual(['1', '2']);
  });
});
