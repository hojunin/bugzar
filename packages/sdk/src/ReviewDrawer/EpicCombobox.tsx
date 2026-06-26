import { getStrings } from '../i18n';
import type { EpicSearch } from './useEpicSearch';
import { highlightMatch } from './utils';

/** Epic search field + results dropdown (loading / results / empty states). */
export function EpicCombobox({ epic }: { epic: EpicSearch }) {
  const t = getStrings();
  return (
    <div className="bugzar-field bugzar-epic-field">
      <span className="bugzar-field-label">{t.jiraEpic}</span>
      <input
        className="bugzar-input"
        aria-label={t.jiraEpic}
        title={t.epicSearchHint}
        value={epic.query}
        onChange={(e) => epic.onQueryChange(e.target.value)}
        onFocus={epic.onFocus}
        placeholder={t.epicSearchPlaceholder}
      />
      {epic.open && (
        <ul className="bugzar-epic-list">
          {epic.loading ? (
            <li
              style={{
                padding: '8px 12px',
                opacity: 0.6,
                fontSize: 13,
              }}
            >
              {t.epicSearching}
            </li>
          ) : epic.results.length > 0 ? (
            epic.results.map((ep) => (
              <li key={ep.key}>
                <button
                  type="button"
                  className="bugzar-epic-option"
                  onClick={() => epic.select(ep)}
                >
                  <span className="bugzar-epic-key">{ep.key}</span>
                  <span className="bugzar-epic-summary">
                    {highlightMatch(ep.summary, epic.query)}
                  </span>
                </button>
              </li>
            ))
          ) : (
            <li
              style={{
                padding: '8px 12px',
                opacity: 0.6,
                fontSize: 13,
              }}
            >
              {t.epicNoResults}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
