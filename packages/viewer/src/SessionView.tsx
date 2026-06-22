// The session main view: rrweb player (left) + searchable data sidebar (right).
// Owns the synced playhead (`currentTime`) + a `seek` bridge so panel rows can
// drive the player. Composed by <App/> for non-design reports.

import { useRef, useState } from 'react';
import { ConsolePanel } from './panels/ConsolePanel';
import { errorMarkers } from './panels/markers';
import { NetworkPanel } from './panels/NetworkPanel';
import { ResourcesPanel } from './panels/ResourcesPanel';
import { StatePanel } from './panels/StatePanel';
import { StoragePanel } from './panels/StoragePanel';
import { SystemInfoPanel } from './panels/SystemInfoPanel';
import type { TabKey } from './panels/tabs';
import { visibleTabs } from './panels/tabs';
import { Player } from './player/Player';
import type { ReportData } from './report/types';
import { Tabs } from './ui/Tabs';

export function SessionView({ data }: { data: ReportData }) {
  const [currentTime, setCurrentTime] = useState(0);
  const [tab, setTab] = useState<TabKey>('console');
  const [query, setQuery] = useState('');
  // Third-party (datadog/amplitude/…) noise is hidden by default.
  const [includeThirdParty, setIncludeThirdParty] = useState(false);
  const seekRef = useRef<((ms: number) => void) | null>(null);

  const tabs = visibleTabs(data);
  const markers = errorMarkers(data);
  const seek = (ms: number) => seekRef.current?.(ms);
  const active = tabs.some((t) => t.key === tab) ? tab : 'console';
  const showThirdPartyToggle = active === 'console' || active === 'network';

  return (
    <div className="bugzarv-session">
      <div className="bugzarv-left">
        <Player
          events={data.events}
          markers={markers}
          onTime={setCurrentTime}
          seekRef={seekRef}
          {...(data.meta?.viewport ? { viewport: data.meta.viewport } : {})}
        />
      </div>
      <div className="bugzarv-sidebar">
        <Tabs tabs={tabs} active={active} onSelect={setTab} />
        <div className="bugzarv-toolbar">
          <input
            className="bugzarv-search"
            type="search"
            placeholder="Search"
            aria-label="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {showThirdPartyToggle ? (
            <label className="bugzarv-toggle" title="datadog, amplitude, sentry, GA, …">
              <input
                type="checkbox"
                checked={includeThirdParty}
                onChange={(e) => setIncludeThirdParty(e.target.checked)}
              />
              3rd-party
            </label>
          ) : null}
        </div>
        <div className="bugzarv-panel">
          {active === 'console' && (
            <ConsolePanel
              entries={data.console}
              query={query}
              currentTime={currentTime}
              onSeek={seek}
              includeThirdParty={includeThirdParty}
            />
          )}
          {active === 'network' && (
            <NetworkPanel
              entries={data.network}
              query={query}
              currentTime={currentTime}
              onSeek={seek}
              includeThirdParty={includeThirdParty}
            />
          )}
          {active === 'storage' && (
            <StoragePanel snapshots={data.storage} currentTime={currentTime} />
          )}
          {active === 'resources' && <ResourcesPanel entries={data.resources} />}
          {active === 'state' && <StatePanel snapshots={data.state} currentTime={currentTime} />}
          {active === 'system' && (
            <SystemInfoPanel system={data.system} meta={data.meta} vitals={data.vitals} />
          )}
        </div>
      </div>
    </div>
  );
}
