import {
  Bugzar,
  type DesignAnnotation,
  type PublishResult,
  type ReportBundle,
  type UploadResult,
} from '@bugzar/sdk';
import { useState } from 'react';

// Expose capture results for the e2e smoke (and for poking in DevTools).
declare global {
  interface Window {
    __bugzarLastBundle?: ReportBundle;
    __bugzarUploadResult?: UploadResult;
    __bugzarAnnotations?: DesignAnnotation[];
    __bugzarPublished?: PublishResult;
  }
}

const buttonStyle: React.CSSProperties = {
  padding: '8px 14px',
  borderRadius: 8,
  border: '1px solid #d4d4d8',
  background: '#fafafa',
  cursor: 'pointer',
  fontSize: 14,
};

export function App() {
  const [count, setCount] = useState(0);
  const [items, setItems] = useState<string[]>([]);
  const [replayUrl, setReplayUrl] = useState<string | null>(null);
  const [published, setPublished] = useState<PublishResult | null>(null);
  const params = new URLSearchParams(window.location.search);
  // ?jira=1 — exercise the M4/F4.3 review drawer against the same-origin mock
  // Worker (publish returns a STUB). ?endpoint=… overrides the upload target.
  const jiraMode = params.has('jira');
  const endpoint = params.get('endpoint') ?? (jiraMode ? window.location.origin : undefined);

  return (
    <main
      style={{
        maxWidth: 640,
        margin: '40px auto',
        padding: '0 20px',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        lineHeight: 1.6,
      }}
    >
      <h1>Bugzar SDK — demo</h1>
      <p>
        Interact below, then click the <strong>QA</strong> button (bottom-right) to start recording.
        Click it again to stop — the captured bundle is logged to the console.
      </p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '20px 0' }}>
        <button
          type="button"
          style={buttonStyle}
          onClick={() => {
            const next = count + 1;
            setCount(next);
            console.log('[demo] count =', next);
          }}
        >
          Count: {count}
        </button>
        <button
          type="button"
          style={buttonStyle}
          onClick={() => {
            setItems((prev) => [...prev, `item ${prev.length + 1}`]);
            console.warn('[demo] item added (DOM mutation)');
          }}
        >
          Add item
        </button>
        <button
          type="button"
          style={buttonStyle}
          onClick={() => {
            // Same-origin JSON API (Vite mock) → real request/response bodies.
            fetch('/api/products')
              .then((r) => r.json())
              .then((d) => console.log('[demo] GET /api/products', d))
              .catch(() => {});
          }}
        >
          Fetch products
        </button>
        <button
          type="button"
          style={buttonStyle}
          onClick={() => {
            fetch('/api/order', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ items: [1, 2] }),
            })
              .then((r) => r.json())
              .then((d) => console.log('[demo] POST /api/order', d))
              .catch(() => {});
          }}
        >
          Place order
        </button>
        <button
          type="button"
          style={buttonStyle}
          onClick={() => console.error('[demo] simulated error')}
        >
          Log error
        </button>
        <button
          type="button"
          style={buttonStyle}
          onClick={() => {
            // Real 5xx WITH request payload + JSON error body → shows up in the
            // report's diagnostic bar + Copy-for-AI (request + response bodies).
            fetch('/api/checkout', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sku: 'WIDGET-1', qty: 3, coupon: 'SAVE10' }),
            })
              .then((r) => r.json())
              .then((d) => console.error('[demo] POST /api/checkout failed', d))
              .catch(() => {});
          }}
        >
          Checkout (fails 500)
        </button>
        <button
          type="button"
          style={buttonStyle}
          onClick={() => {
            // Thrown async → window.onerror captures stack + source(file:line) +
            // error.cause chain (R2b). Dev build is unminified, so "Where to look"
            // promotes the symbolic frame.
            setTimeout(() => {
              throw Object.assign(new Error('Render crashed reading cart.total'), {
                cause: new Error('cart is null'),
              });
            }, 0);
          }}
        >
          Throw error
        </button>
      </div>

      <ul>
        {items.map((it) => (
          <li key={it}>{it}</li>
        ))}
      </ul>

      {replayUrl && (
        <p data-testid="replay-link">
          Replay uploaded:{' '}
          <a href={replayUrl} target="_blank" rel="noreferrer">
            {replayUrl}
          </a>
        </p>
      )}

      {published && (
        <p data-testid="published">
          Published: <strong>{published.issueKey}</strong>
          {published.stubbed ? ' (stub — not a real issue)' : ''}
        </p>
      )}

      <Bugzar
        {...(endpoint ? { endpoint } : {})}
        {...(jiraMode
          ? {
              jira: { enabled: true, projectKey: 'BUGZAR', defaultEpicKey: 'BUGZAR-1' },
              user: { name: 'Demo User', email: 'demo@example.com' },
            }
          : {})}
        onExport={async (blob, meta) => {
          // In a real app: PUT `blob` to your storage and return its public URL.
          // The demo just object-URLs it so "View replay" works locally.
          console.log('[demo] exported replay HTML:', blob.size, 'bytes', meta.mode);
          const url = URL.createObjectURL(blob);
          setReplayUrl(url);
          return url;
        }}
        onPublished={(result) => {
          window.__bugzarPublished = result;
          setPublished(result);
          console.log('[demo] published:', result);
        }}
        onError={(err) => console.error('[demo] upload failed:', err)}
        onAnnotate={(annotations) => {
          window.__bugzarAnnotations = annotations;
          console.log('[demo] annotations:', annotations);
        }}
      />
    </main>
  );
}
