/**
 * ArchivedSessionHistoryPanel — the read-only transcript of ONE archived
 * session, opened from the Archived sessions tab ("View history"). A thin store
 * binding over the shared HistoryPagePanel (the same viewer the Failed restores
 * tab uses). Reading resumes nothing.
 */
import { useConnectionStore } from '../store/connection';
import { HistoryPagePanel } from './HistoryPagePanel';

/** The panel's element id, which the row's View history toggle points `aria-controls` at. */
export function archivedSessionHistoryPanelId(archiveId: string): string {
  return `archived-session-history-panel-${archiveId}`;
}

export function ArchivedSessionHistoryPanel({ archiveId }: { archiveId: string }) {
  const view = useConnectionStore((s) => s.archivedSessionHistories[archiveId]);
  const connected = useConnectionStore((s) => s.connectionPhase === 'connected');
  const requestHistory = useConnectionStore((s) => s.requestArchivedSessionHistory);

  return (
    <HistoryPagePanel
      view={view}
      connected={connected}
      onRequest={(more) => requestHistory(archiveId, more)}
      panelId={archivedSessionHistoryPanelId(archiveId)}
      testIdPrefix="archived-session-history"
      idKey={archiveId}
      refusedText="This device is paired to a single session, so it cannot read archived sessions. Open the dashboard with the primary token."
      notFoundText="That archive no longer exists — it was deleted or aged out. Refresh the list."
      notFoundCode="ARCHIVED_SESSION_NOT_FOUND"
    />
  );
}
