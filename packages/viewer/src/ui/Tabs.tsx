import type { Tab, TabKey } from '../panels/tabs';

export interface TabsProps {
  tabs: Tab[];
  active: TabKey;
  onSelect: (key: TabKey) => void;
}

export function Tabs({ tabs, active, onSelect }: TabsProps) {
  return (
    <div className="bugzarv-tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={tab.key === active}
          className={`bugzarv-tab${tab.key === active ? ' bugzarv-tab-active' : ''}`}
          onClick={() => onSelect(tab.key)}
        >
          <span className="bugzarv-tab-label">{tab.label}</span>
          {tab.count != null ? <span className="bugzarv-tab-count">{tab.count}</span> : null}
        </button>
      ))}
    </div>
  );
}
