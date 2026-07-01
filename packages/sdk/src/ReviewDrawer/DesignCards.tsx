import type { DesignAnnotation } from '../public-types';

/** Design-mode imageless cards: an index badge + the reviewer's note per element. */
export function DesignCards({ annotations }: { annotations: DesignAnnotation[] | undefined }) {
  return (
    <div className="bugzar-design-cards">
      {(annotations ?? []).map((a, i) => (
        <div key={a.id} className="bugzar-design-card">
          <span className="bugzar-card-index">{i + 1}</span>
          <span className="bugzar-card-note">{a.note || '—'}</span>
        </div>
      ))}
    </div>
  );
}
