// Entry for the self-contained OFFLINE export (Phase D). Built as a single
// classic IIFE and inlined into the SDK's `exportReportHtml` output. Instead of
// parsing URL params + fetching from a Worker (impossible at `file://`), it
// renders a report object handed to it in-page.
//
// The export HTML inlines THIS bundle first (defining `__BUGZAR_MOUNT__`), then a
// tiny bootstrap script decodes the embedded data and calls `__BUGZAR_MOUNT__`.
// If the data global is already present, mount immediately.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { checkSchemaVersion } from './report/schema-version';
import type { ReportData, ReportLoad } from './report/types';
import { injectStyles } from './styles';

injectStyles();

const mount = (data: ReportData): void => {
  const root = document.getElementById('root');
  if (!root) return;
  const load: ReportLoad = {
    data,
    failed: [],
    version: checkSchemaVersion(data.meta?.schemaVersion),
  };
  createRoot(root).render(
    <StrictMode>
      <App inlineLoad={load} />
    </StrictMode>,
  );
};

const w = window as unknown as { __BUGZAR_REPORT__?: ReportData; __BUGZAR_MOUNT__?: typeof mount };
if (w.__BUGZAR_REPORT__) mount(w.__BUGZAR_REPORT__);
else w.__BUGZAR_MOUNT__ = mount;
