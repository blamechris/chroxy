/**
 * SidebarArchivedSection — a collapsible "Archived" section under the sidebar
 * project list (#8867). It lists sessions that ENDED (the daemon's archive) and
 * opens one's transcript read-only through the shared HistoryPagePanel (via
 * ArchivedSessionHistoryPanel). The Control Room "Archived" tab is the other
 * door onto the same store state: history views are keyed by archiveId, so one
 * viewer state serves both.
 *
 * READ-ONLY. Nothing here resumes, continues, re-sends, creates or deletes a
 * session; deleting stays in the Control Room tab.
 *
 * STATES are three different claims and render distinctly: `null` is "not asked
 * yet" (Loading…), an empty list is "asked, nothing archived", and `refused` is
 * "this pairing-bound device may not see the archive". Rows keep the server's
 * order (newest first); nothing is re-sorted here.
 *
 * FETCH. Once, when the section is expanded AND connected AND the snapshot is
 * `null` AND no request is in flight. The store resets the snapshot to `null` on
 * disconnect / server switch, so the same condition re-fetches after a
 * reconnect. No polling; Refresh is manual.
 *
 * RENDERING. Plain text only: every value is a React text node (no markdown, no
 * `dangerouslySetInnerHTML`, no links). Collapsed state is local (not persisted).
 *
 * STYLING: class names only, zero inline `style`, rules in theme/components.css
 * with `var(--token)`. Every button is at the 44px floor.
 */
import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useConnectionStore } from '../store/connection'
import { ArchivedSessionHistoryPanel, archivedSessionHistoryPanelId } from './ArchivedSessionHistoryPanel'
import { ARCHIVE_REFUSED_TEXT, ArchivePolicyNote, archiveReasonLabel, archivedAtLabel } from './ArchivedSessionsSection'

const BODY_ID = 'sidebar-archived-body'

/** The last path segment of a host path, tolerating both separators and trailing slashes. */
function projectLabel(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? cwd
}

export function SidebarArchivedSection() {
  const { snapshot, loading, connected, histories } = useConnectionStore(
    useShallow((s) => ({
      snapshot: s.archivedSessions,
      loading: s.archivedSessionsLoading,
      connected: s.connectionPhase === 'connected',
      histories: s.archivedSessionHistories,
    })),
  )
  const requestArchivedSessions = useConnectionStore((s) => s.requestArchivedSessions)
  const requestArchivedSessionHistory = useConnectionStore((s) => s.requestArchivedSessionHistory)
  const closeArchivedSessionHistory = useConnectionStore((s) => s.closeArchivedSessionHistory)

  const [expanded, setExpanded] = useState(false)

  const notAsked = snapshot === null || snapshot === undefined
  const rows = notAsked ? null : snapshot.sessions
  const refused = snapshot?.refused === true
  const policy = snapshot?.policy
  const truncated = snapshot?.truncated === true

  useEffect(() => {
    if (expanded && connected && notAsked && !loading) requestArchivedSessions()
  }, [expanded, connected, notAsked, loading, requestArchivedSessions])

  const count = rows && !refused ? rows.length : null

  return (
    <div className="sidebar-archived" data-testid="sidebar-archived">
      <button
        type="button"
        className="sidebar-archived-toggle"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={expanded ? BODY_ID : undefined}
        data-testid="sidebar-archived-toggle"
      >
        <span className="sidebar-archived-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        <span className="sidebar-archived-title">{count === null ? 'Archived' : `Archived (${count})`}</span>
      </button>

      {expanded ? (
        <div className="sidebar-archived-section" id={BODY_ID} data-testid="sidebar-archived-section">
          <button
            type="button"
            className="sidebar-archived-refresh"
            onClick={() => requestArchivedSessions()}
            disabled={loading || !connected}
            data-testid="sidebar-archived-refresh"
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>

          {refused ? (
            <p className="sidebar-archived-note" data-testid="sidebar-archived-refused">
              {ARCHIVE_REFUSED_TEXT}
            </p>
          ) : rows === null ? (
            // Not asked yet — never render "nothing archived" without a request behind it.
            <p className="sidebar-archived-note" data-testid="sidebar-archived-loading">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="sidebar-archived-note" data-testid="sidebar-archived-empty">No archived sessions.</p>
          ) : (
            <ul className="sidebar-archived-list">
              {rows.map((r) => {
                const id = r.archiveId
                const historyOpen = histories?.[id] !== undefined
                return (
                  <li className="sidebar-archived-item" key={id}>
                    <button
                      type="button"
                      className="sidebar-archived-row"
                      onClick={() => (historyOpen ? closeArchivedSessionHistory(id) : requestArchivedSessionHistory(id))}
                      // Closing never needs the socket; only opening does.
                      disabled={!historyOpen && !connected}
                      aria-expanded={historyOpen}
                      // Only while the panel is mounted: an id that does not exist would break the disclosure convention.
                      aria-controls={historyOpen ? archivedSessionHistoryPanelId(id, 'sidebar') : undefined}
                      data-testid={`sidebar-archived-row-${id}`}
                    >
                      <span className="sidebar-archived-name">{r.name || r.sessionId}</span>
                      {r.cwd ? (
                        <span className="sidebar-archived-project" title={r.cwd}>{projectLabel(r.cwd)}</span>
                      ) : null}
                      <span className="sidebar-archived-meta">
                        {archiveReasonLabel(r.reason)} · {archivedAtLabel(r.archivedAt)}
                      </span>
                    </button>
                    {historyOpen ? <ArchivedSessionHistoryPanel archiveId={id} surface="sidebar" /> : null}
                  </li>
                )
              })}
            </ul>
          )}

          {policy && !refused ? (
            <ArchivePolicyNote policy={policy} testId="sidebar-archived-policy" className="sidebar-archived-note" />
          ) : null}
          {truncated && !refused ? (
            <p className="sidebar-archived-note" data-testid="sidebar-archived-truncated">
              Showing the newest {rows?.length ?? 0} archived sessions. Older ones are kept but not listed here.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
