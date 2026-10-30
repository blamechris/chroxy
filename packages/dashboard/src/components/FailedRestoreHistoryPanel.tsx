/**
 * FailedRestoreHistoryPanel (#8860) — the read-only transcript of ONE parked
 * failed restore, opened from the Failed restores tab ("View history").
 *
 * WHY IT EXISTS. A Codex app-server session in `auto` permission mode never
 * captures a native resume locator, so after a daemon restart it is refused
 * (`CODEX_NATIVE_LOCATOR_MISSING`) and parked, and every Retry re-parks it. That
 * fail-closed behaviour is deliberate (docs/providers.md "Native restart
 * continuity"): Chroxy must not resume, or rebuild a native thread from
 * displayed history, with approval authority it cannot prove. The gap this
 * closes is only that the preserved transcript was unreachable. This panel READS
 * it; it offers no way to resume, continue or re-send.
 *
 * A thin store binding: the rendering is the shared HistoryPagePanel, which the
 * archived-session panel also uses.
 */
import { useConnectionStore } from '../store/connection';
import { HistoryPagePanel } from './HistoryPagePanel';

export { summarizeToolInput } from './HistoryPagePanel';

/** The panel's element id, which the row's View history toggle points `aria-controls` at. */
export function failedRestoreHistoryPanelId(sessionId: string): string {
  return `failed-restore-history-panel-${sessionId}`;
}

export function FailedRestoreHistoryPanel({ sessionId }: { sessionId: string }) {
  const view = useConnectionStore((s) => s.failedRestoreHistories[sessionId]);
  const connected = useConnectionStore((s) => s.connectionPhase === 'connected');
  const requestHistory = useConnectionStore((s) => s.requestFailedRestoreHistory);

  return (
    <HistoryPagePanel
      view={view}
      connected={connected}
      onRequest={(more) => requestHistory(sessionId, more)}
      panelId={failedRestoreHistoryPanelId(sessionId)}
      testIdPrefix="failed-restore-history"
      idKey={sessionId}
      refusedText="This device is paired to a single session, so it cannot read a failed restore’s history. Open the dashboard with the primary token."
      notFoundText="That entry is no longer parked — refresh the list."
      notFoundCode="FAILED_RESTORE_NOT_FOUND"
    />
  );
}
