import type { IncomingMessage, ServerResponse } from 'node:http';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const ORIGIN = 'http://localhost:5273';

const sendJson = (res: ServerResponse, body: unknown, status = 200): void => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
};

const adf = (text: string) => ({
  type: 'doc',
  version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

// Same-origin mock API. /api/* feeds real request/response bodies into network
// capture; /reports + /jira/* mock the Worker contract so the M4/F4.3 review
// drawer flow runs end-to-end (publish returns a STUB — no real Jira issue),
// making the demo a self-contained visual + e2e harness for the SDK UI.
const mockApi = (): Plugin => ({
  name: 'bugzar-mock-api',
  configureServer(server) {
    let seq = 0;

    server.middlewares.use('/api/products', (_req, res) => {
      sendJson(res, {
        products: [
          { id: 1, name: 'Tee' },
          { id: 2, name: 'Cap' },
        ],
      });
    });
    server.middlewares.use('/api/order', (req, res) => {
      const ok = req.method === 'POST';
      sendJson(res, { ok, orderId: ok ? 'ord_123' : null }, ok ? 201 : 405);
    });

    // A real server error WITH a JSON error body — exercises R1a (Copy-for-AI now
    // carries the request payload + this response body) and the diagnostic-bar
    // headline ("POST /api/checkout → 500").
    server.middlewares.use('/api/checkout', (_req, res) => {
      sendJson(
        res,
        { error: 'OUT_OF_STOCK', detail: 'sku WIDGET-1 has 0 available', traceId: 'trace_abc123' },
        500,
      );
    });

    // ── mock Worker: report allocation + asset PUTs + publish ──
    server.middlewares.use('/reports', (req: IncomingMessage, res) => {
      const url = req.url ?? '';
      const method = req.method ?? 'GET';
      if (method === 'POST' && (url === '' || url === '/')) {
        const id = `demo${++seq}`;
        const slot = (name: string): string => `${ORIGIN}/reports/${id}/${name}`;
        sendJson(res, {
          reportId: id,
          reportUrl: `${ORIGIN}/r/${id}`,
          assetUrls: {
            meta: slot('meta.json'),
            events: slot('events.json'),
            console: slot('console.json'),
            network: slot('network.json'),
            storage: slot('storage.json'),
            replay: slot('replay.html'),
            vitals: slot('vitals.json'),
            resources: slot('resources.json'),
            state: slot('state.json'),
            design: slot('design.json'),
          },
        });
        return;
      }
      if (method === 'POST' && url.endsWith('/publish')) {
        // Unconfigured Worker → honest STUB (never a fabricated real issue).
        const key = `STUB-${1000 + seq}`;
        sendJson(res, { stubbed: true, issueKey: key, issueUrl: `${ORIGIN}/r/stub/${key}` });
        return;
      }
      if (method === 'PUT') {
        sendJson(res, { ok: true });
        return;
      }
      sendJson(res, { error: 'not found' }, 404);
    });

    server.middlewares.use('/jira/epics', (req, res) => {
      const q = new URL(req.url ?? '', ORIGIN).searchParams.get('query') ?? '';
      sendJson(res, {
        epics: [
          { key: 'BUGZAR-10', summary: `Checkout epic (${q || 'all'})` },
          { key: 'BUGZAR-11', summary: 'Onboarding epic' },
        ],
      });
    });

    server.middlewares.use('/jira/draft', (_req, res) => {
      sendJson(res, {
        title: 'Checkout button misfires on mobile Safari',
        description: adf(
          'Steps: 1) open /checkout 2) tap Pay. Expected the order to submit; got a 500. ' +
            'Console shows two errors and POST /api/pay returned 500.',
        ),
        mode: 'bug',
        stub: false,
      });
    });
  },
});

export default defineConfig({
  plugins: [react(), mockApi()],
  // Distinct port from the extension dev server (5173).
  server: { port: 5273, strictPort: true },
});
