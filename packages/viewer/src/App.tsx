// Top-level state machine: parse params → load report → render one of
// NeedParams / Loading / LoadError / VersionMismatch / the main view.
// `search` is injectable for tests; defaults to the page's query string.

import { SCHEMA_VERSION } from '@bugzar/shared';
import { useEffect, useState } from 'react';
import { DesignView } from './design/DesignView';
import { ASSET_NAMES, loadReport } from './report/load-report';
import { reportMode } from './report/mode';
import { isParamsError, parseReportParams } from './report/params';
import type { ReportLoad } from './report/types';
import { SessionView } from './SessionView';
import { LoadError, Loading, NeedParams, VersionMismatch } from './ui/states';

export interface AppProps {
  search?: string;
  /**
   * Pre-loaded report — when present (the self-contained offline HTML export),
   * the viewer renders it directly and never parses params or fetches over the
   * network. The default path (served by the Worker) leaves this undefined.
   */
  inlineLoad?: ReportLoad;
}

export function App({ search, inlineLoad }: AppProps = {}) {
  // The viewer is served by the Worker, so a report's data lives on the same
  // origin by default; `?endpoint=` only overrides it for cross-Worker viewing.
  const params = parseReportParams(search ?? window.location.search, window.location.origin);
  const valid = inlineLoad ? true : !isParamsError(params);
  const endpoint = valid && !isParamsError(params) ? params.endpoint : '';
  const id = valid && !isParamsError(params) ? params.id : '';

  const [load, setLoad] = useState<ReportLoad | null>(inlineLoad ?? null);
  const [loading, setLoading] = useState(inlineLoad ? false : valid);

  useEffect(() => {
    if (inlineLoad || !valid) return; // inline mode skips the network entirely
    let cancelled = false;
    setLoading(true);
    loadReport({ endpoint, id }).then((r) => {
      if (!cancelled) {
        setLoad(r);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [valid, endpoint, id, inlineLoad]);

  if (!valid) return <NeedParams />;
  if (loading || !load) return <Loading />;

  // Wholesale failure (every slot 404'd — bad endpoint/id). A valid design
  // report only 404s its session slots, so it is NOT wholesale failure.
  if (load.failed.length === ASSET_NAMES.length) {
    return <LoadError url={`${endpoint}/reports/${id}/`} />;
  }
  if (load.version === 'older' || load.version === 'newer') {
    return <VersionMismatch reported={load.data.meta?.schemaVersion} supported={SCHEMA_VERSION} />;
  }

  return (
    <div className="bugzarv-app">
      {reportMode(load.data) === 'design' ? (
        <>
          {/* Design reports have no diagnostic bar — show just the captured URL
              (the one fact worth a header); resolution/env live in System Info. */}
          {load.data.meta?.url ? (
            <header className="bugzarv-urlbar" title={load.data.meta.url}>
              {load.data.meta.url}
            </header>
          ) : null}
          <DesignView
            elements={load.data.design}
            events={load.data.events}
            system={load.data.system}
            meta={load.data.meta}
            vitals={load.data.vitals}
            {...(load.data.meta?.url ? { pageUrl: load.data.meta.url } : {})}
          />
        </>
      ) : (
        <SessionView data={load.data} />
      )}
    </div>
  );
}
