/**
 * ArchivedSessionHistoryPanel — the read-only transcript of ONE archived
 * session, opened from the Archived sessions tab ("View history"). A thin store
 * binding over the shared HistoryPagePanel (the same viewer the Failed restores
 * tab uses). Reading resumes nothing.
 */
import { useConnectionStore } from '../store/connection';
import { HistoryPagePanel } from './HistoryPagePanel';

/**
 * Where a panel is mounted. The sidebar and the Control Room tab can both be
 * mounted with the same archive open (the open state is shared by archiveId),
 * so each surface gets its own element ids and test ids.
 */
export type ArchivedHistorySurface = 'control-room' | 'sidebar';

const SURFACE_PREFIX: Record<ArchivedHistorySurface, string> = {
  'control-room': '',
  sidebar: 'sidebar-',
};

/** The panel's element id, which the row's View history toggle points `aria-controls` at. */
export function archivedSessionHistoryPanelId(archiveId: string, surface: ArchivedHistorySurface = 'control-room'): string {
  return `${SURFACE_PREFIX[surface]}archived-session-history-panel-${archiveId}`;
}

export function ArchivedSessionHistoryPanel({
  archiveId,
  surface = 'control-room',
}: {
  archiveId: string;
  surface?: ArchivedHistorySurface;
}) {
  const view = useConnectionStore((s) => s.archivedSessionHistories[archiveId]);
  const connected = useConnectionStore((s) => s.connectionPhase === 'connected');
  const requestHistory = useConnectionStore((s) => s.requestArchivedSessionHistory);

  return (
    <HistoryPagePanel
      view={view}
      connected={connected}
      onRequest={(more) => requestHistory(archiveId, more)}
      panelId={archivedSessionHistoryPanelId(archiveId, surface)}
      testIdPrefix={`${SURFACE_PREFIX[surface]}archived-session-history`}
      idKey={archiveId}
      refusedText="This device is paired to a single session, so it cannot read archived sessions. Open the dashboard with the primary token."
      notFoundText="That archive no longer exists — it was deleted or aged out. Refresh the list."
      notFoundCode="ARCHIVED_SESSION_NOT_FOUND"
    />
  );
}
