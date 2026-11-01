/**
 * ArchivedSessionsSection — the Control Room "Archived" tab.
 *
 * The daemon keeps a provider-neutral archive of sessions that ENDED (closed,
 * idle-timed-out, stopped after repeated crashes, dropped as stale at restart,
 * or a failed restore that expired / was dismissed), bounded by the
 * `sessionArchive` config policy. This tab lists those records and lets the
 * operator READ a transcript, CONTINUE it, or DELETE a record.
 *
 * Viewing is READ-ONLY. A session only comes back on an explicit click on
 * Resume (same conversation, #8866) or Continue as new thread (a new session
 * seeded with the transcript); see ArchivedSessionRestoreActions. Deleting an
 * archive record is two-step (a first click only arms "Confirm delete", it never
 * sends).
 *
 * RENDERING. Plain text only: every value is a React text node (no markdown, no
 * `dangerouslySetInnerHTML`, no links), because name/cwd/transcript content is
 * whatever the session held. A pairing-bound device gets a refused reply and an
 * explanation, never an "archive is empty" claim it has no basis for.
 *
 * STYLING: class names only, zero inline `style`, rules in theme/components.css
 * with `var(--token)`. It reuses the Failed restores `fr-*` rules (same chrome,
 * same 44px floor) and adds only the `aa-*` rules it needs.
 */
import { useEffect, useState } from 'react';
import { useConnectionStore } from '../store/connection';
import { useShallow } from 'zustand/react/shallow';
import { ArchivedSessionHistoryPanel, archivedSessionHistoryPanelId } from './ArchivedSessionHistoryPanel';
import { ArchivedSessionRestoreActions } from './ArchivedSessionRestoreActions';

const REASON_LABELS: Record<string, string> = {
  closed: 'Closed',
  idle_timeout: 'Idle timeout',
  respawn_exhausted: 'Stopped after repeated crashes',
  stale: 'Inactive for 24h at restart',
  failed_restore_expired: 'Failed restore expired',
  failed_restore_dismissed: 'Failed restore dismissed',
};

/** A human label for an archive reason; a value this build does not know is shown as-is. */
export function archiveReasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? reason;
}

/** When a record was archived, in the viewer's locale; a missing/invalid stamp is shown as unknown. */
export function archivedAtLabel(archivedAt: number | null): string {
  if (typeof archivedAt !== 'number' || !Number.isFinite(archivedAt)) return 'Unknown time';
  return new Date(archivedAt).toLocaleString();
}

/** Shown when a pairing-bound device asks for the host's archive. */
export const ARCHIVE_REFUSED_TEXT =
  "This device is paired to a single session, so it cannot view the host's archived sessions. Open the dashboard with the primary token to manage them."

export interface ArchivePolicy {
  enabled: boolean
  maxAgeDays: number
  maxEntries: number
  maxMegabytes: number
}

/** The retention-policy sentence, shared by the Control Room tab and the sidebar section. */
export function ArchivePolicyNote({ policy, testId, className = 'aa-policy' }: { policy: ArchivePolicy; testId: string; className?: string }) {
  return (
    <p className={className} data-testid={testId}>
      {policy.enabled ? (
        <>
          Ended sessions are kept here for up to {policy.maxAgeDays} days ({policy.maxEntries} sessions,{' '}
          {policy.maxMegabytes} MB). Change or turn off in Settings → Session archive.
        </>
      ) : (
        <>Archiving is off — ended sessions are not kept. Existing archives stay until deleted or aged out.</>
      )}
    </p>
  )
}

export function ArchivedSessionsSection() {
  const { snapshot, loading, connected, histories, deleting, deletingAll, deleteError } = useConnectionStore(
    useShallow((s) => ({
      snapshot: s.archivedSessions,
      loading: s.archivedSessionsLoading,
      connected: s.connectionPhase === 'connected',
      histories: s.archivedSessionHistories,
      deleting: s.deletingArchiveIds,
      deletingAll: s.deletingAllArchives,
      deleteError: s.archiveDeleteError,
    })),
  );
  const requestArchivedSessions = useConnectionStore((s) => s.requestArchivedSessions);
  const requestArchivedSessionHistory = useConnectionStore((s) => s.requestArchivedSessionHistory);
  const closeArchivedSessionHistory = useConnectionStore((s) => s.closeArchivedSessionHistory);
  const deleteArchivedSession = useConnectionStore((s) => s.deleteArchivedSession);
  const deleteAllArchivedSessions = useConnectionStore((s) => s.deleteAllArchivedSessions);

  // Which delete is armed (waiting for the second click). Local UI state: it is
  // never sent, and a list refresh that removes the row simply orphans it.
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);

  // `null` is "not asked yet" — distinct from a list that is empty ("asked,
  // nothing archived").
  const rows = snapshot?.sessions ?? null;
  const refused = snapshot?.refused === true;
  const policy = snapshot?.policy;
  const refreshDisabled = loading || !connected;
  const sectionError = deleteError && deleteError.archiveId === undefined ? deleteError : null;
  const rowCount = rows?.length ?? 0;
  const truncated = snapshot?.truncated === true;

  // An armed confirmation is bound to the list it was armed against. A refreshed
  // list (new generatedAt) may hold different rows than the ones the operator
  // looked at, and an empty one leaves nothing to confirm: either way "Confirm
  // delete all" must not stay armed for a click that now means something else.
  const generatedAt = snapshot?.generatedAt;
  useEffect(() => {
    setConfirmAll(false);
    setConfirmId(null);
  }, [generatedAt]);
  useEffect(() => {
    if (rowCount === 0) {
      setConfirmAll(false);
      setConfirmId(null);
    }
  }, [rowCount]);

  return (
    <div className="fr-section" data-testid="archived-sessions-section">
      <div className="fr-toolbar">
        <span className="fr-title">Archived sessions</span>
        <div className="aa-toolbar-actions">
          {rows && rows.length > 0 && !refused ? (
            confirmAll ? (
              <>
                <button
                  type="button"
                  className="aa-confirm-btn"
                  onClick={() => {
                    setConfirmAll(false);
                    deleteAllArchivedSessions();
                  }}
                  disabled={deletingAll || !connected}
                  data-testid="archived-sessions-delete-all-confirm"
                >
                  {/* A truncated roster lists only the newest rows, and delete-all
                      removes every record, so the count would understate it. */}
                  {truncated ? 'Confirm delete all (more than listed)' : `Confirm delete all (${rowCount})`}
                </button>
                <button
                  type="button"
                  className="aa-cancel-btn"
                  onClick={() => setConfirmAll(false)}
                  data-testid="archived-sessions-delete-all-cancel"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                className="aa-delete-btn"
                onClick={() => setConfirmAll(true)}
                disabled={deletingAll || !connected}
                data-testid="archived-sessions-delete-all"
              >
                {deletingAll ? 'Deleting…' : 'Delete all'}
              </button>
            )
          ) : null}
          <button
            type="button"
            className="fr-refresh-btn"
            onClick={() => requestArchivedSessions()}
            disabled={refreshDisabled}
            data-testid="archived-sessions-refresh"
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {policy && !refused ? <ArchivePolicyNote policy={policy} testId="archived-sessions-policy" /> : null}

      {truncated && !refused ? (
        <p className="aa-policy" data-testid="archived-sessions-truncated">
          Showing the newest {rowCount} archived sessions. Older ones are kept but not listed here; delete some to see them.
        </p>
      ) : null}

      {sectionError ? (
        <p className="fr-result-error" data-testid="archived-sessions-delete-error">
          {sectionError.refused
            ? 'This device is paired to a single session, so it cannot delete archived sessions.'
            : (sectionError.message ?? 'Could not delete the archived sessions.')}
        </p>
      ) : null}

      {refused ? (
        <p className="fr-empty" data-testid="archived-sessions-refused">
          {ARCHIVE_REFUSED_TEXT}
        </p>
      ) : rows === null ? (
        // Not asked yet — never render "nothing archived" without a request behind it.
        <p className="fr-empty">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="fr-empty" data-testid="archived-sessions-empty">
          No archived sessions.
        </p>
      ) : (
        <ul className="fr-list">
          {rows.map((r) => {
            const id = r.archiveId;
            const historyOpen = histories?.[id] !== undefined;
            const pending = deleting.has(id) || deletingAll;
            const label = r.name || r.sessionId;
            const armed = confirmId === id;
            const rowError = deleteError && deleteError.archiveId === id ? deleteError : null;
            return (
              <li className="fr-row" key={id} data-testid={`archived-session-${id}`}>
                <div className="fr-row-main">
                  <span className="fr-name">{r.name || r.sessionId}</span>
                  {r.provider ? <span className="fr-provider">{r.provider}</span> : null}
                  {r.cwd ? (
                    <span className="aa-cwd" title={r.cwd}>
                      {r.cwd}
                    </span>
                  ) : null}
                </div>
                <div className="fr-row-detail">
                  <span className="aa-reason">{archiveReasonLabel(r.reason)}</span>
                  <span>{archivedAtLabel(r.archivedAt)}</span>
                  <span className="fr-history">
                    {r.historyLength} message{r.historyLength === 1 ? '' : 's'}
                  </span>
                  {typeof r.omittedOldest === 'number' && r.omittedOldest > 0 ? (
                    <span className="fr-history" data-testid={`archived-session-omitted-${id}`}>
                      ({r.omittedOldest} earliest message{r.omittedOldest === 1 ? ' was' : 's were'} too large to keep)
                    </span>
                  ) : null}
                </div>
                {rowError ? (
                  <p className="fr-result-error" data-testid={`archived-session-delete-error-${id}`}>
                    {rowError.refused
                      ? 'This device is paired to a single session, so it cannot delete archived sessions.'
                      : rowError.code === 'ARCHIVED_SESSION_NOT_FOUND'
                        ? 'That archive no longer exists — refresh the list.'
                        : (rowError.message ?? 'Delete failed.')}
                  </p>
                ) : null}
                <div className="fr-row-actions">
                  <button
                    type="button"
                    className="fr-history-btn"
                    onClick={() => (historyOpen ? closeArchivedSessionHistory(id) : requestArchivedSessionHistory(id))}
                    // Closing never needs the socket; only opening does.
                    disabled={!historyOpen && !connected}
                    aria-label={`${historyOpen ? 'Hide history for' : 'View history for'} ${label}`}
                    aria-expanded={historyOpen}
                    // Only while the panel is mounted: an id that does not exist would break the disclosure convention.
                    aria-controls={historyOpen ? archivedSessionHistoryPanelId(id) : undefined}
                    data-testid={`archived-session-history-toggle-${id}`}
                  >
                    {historyOpen ? 'Hide history' : 'View history'}
                  </button>
                  {armed ? (
                    <>
                      <button
                        type="button"
                        className="aa-confirm-btn"
                        onClick={() => {
                          setConfirmId(null);
                          deleteArchivedSession(id);
                        }}
                        disabled={pending || !connected}
                        aria-label={`Confirm delete archived session ${label}`}
                        data-testid={`archived-session-delete-confirm-${id}`}
                      >
                        Confirm delete
                      </button>
                      <button
                        type="button"
                        className="aa-cancel-btn"
                        onClick={() => setConfirmId(null)}
                        aria-label={`Cancel deleting archived session ${label}`}
                        data-testid={`archived-session-delete-cancel-${id}`}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="aa-delete-btn"
                      onClick={() => setConfirmId(id)}
                      disabled={pending || !connected}
                      aria-label={`Delete archived session ${label}`}
                      data-testid={`archived-session-delete-${id}`}
                    >
                      {pending ? 'Deleting…' : 'Delete'}
                    </button>
                  )}
                </div>
                <ArchivedSessionRestoreActions row={r} />
                {historyOpen ? <ArchivedSessionHistoryPanel archiveId={id} /> : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
