// Non-main view states: no params, loading, total load failure, version mismatch.

export function NeedParams() {
  return (
    <div className="bugzarv-state">
      <h1>QA Replay Viewer</h1>
      <p>
        Open a report by adding <code>?endpoint=&lt;worker-url&gt;&amp;id=&lt;reportId&gt;</code> to
        this page's URL.
      </p>
    </div>
  );
}

export function Loading() {
  return <output className="bugzarv-state">Loading report…</output>;
}

export function LoadError({ url }: { url: string }) {
  return (
    <div className="bugzarv-state">
      <h1>Couldn't load this report</h1>
      <p>None of its assets could be fetched. Tried:</p>
      <code>{url}</code>
    </div>
  );
}

export function VersionMismatch({
  reported,
  supported,
}: {
  reported: number | undefined;
  supported: number;
}) {
  return (
    <div className="bugzarv-state">
      <h1>Incompatible report</h1>
      <p>
        Captured with schema version {reported ?? 'unknown'}; this viewer supports version{' '}
        {supported}.
      </p>
    </div>
  );
}
