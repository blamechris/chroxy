/**
 * CrossSessionMissionControl (#6183, Control Room v2 phase 2 / #5964) — the
 * aggregate mission-control view spanning ALL sessions, the promotion of the v1
 * per-session ActivityTree (#5176) to "every session chroxy can see".
 *
 * Pure + prop-driven (same shape as ActivityTree): the parent passes the whole
 * `activity` reducer state + the session list; this component derives the
 * cross-session rollup via store-core's `selectCrossSessionActivity` (#6182) —
 * sessions grouped by repo+worktree (cwd), each group + the overall set carrying
 * running/blocked/failed/idle SESSION counts. Each session row drills down into
 * its v1 `ActivityTree`, so the per-session tree stays the single source of
 * truth (no regression) and this view is purely the aggregation layer on top.
 *
 * Control actions (#6125, epic #5422 phase 1): when the parent supplies the
 * optional `onCancelActivity` / `onJumpToSession` callbacks, each session's tree
 * becomes actionable — cancel a subagent (session-scoped) or jump-to-intervene
 * on a blocked session. Omit them and the view stays read-only. External
 * (/api/events) sessions are always read-only — chroxy has no handle on those.
 * The overall rollup is what the tray badge (#6184) consumes off the same selector.
 */
import { useCallback, useState } from 'react'
import type { ActivityState, CrossSessionMeta, SessionDerivedStatus } from '@chroxy/store-core'
import { selectCrossSessionActivity } from '@chroxy/store-core'
import type { ExternalSessionEntry } from '@chroxy/protocol'
import { ActivityTree } from './ActivityTree'

export interface CrossSessionMissionControlProps {
  /** Whole-store activity state (one tree per session). */
  activity: ActivityState
  /** The authoritative session list (drives membership + grouping). */
  sessions: readonly CrossSessionMeta[]
  /**
   * #5969 — LIVE external sessions (ingested via /api/events; sessions chroxy
   * did NOT launch). Rendered READ-ONLY in their own section: no drill-down (no
   * activity tree exists for them) and no control affordances (no PTY/handle).
   */
  external?: readonly ExternalSessionEntry[]
  /**
   * #6125 (epic #5422 phase 1) — cancel a subagent in ANY session's tree. The
   * sessionId is threaded so the cross-session cancel targets the right session
   * (cancel_activity is session-scoped). Omit → trees stay read-only.
   */
  onCancelActivity?: (activityId: string, sessionId: string) => void
  /**
   * #6125 — in-flight cancels, keyed `${sessionId}:${activityId}` (the store's
   * shape, since activity ids are only unique within a session). Scoped per tree
   * before being handed to ActivityTree.
   */
  cancellingActivityIds?: ReadonlySet<string>
  /**
   * #6125 — jump-to-intervene: switch the active session to the one whose tree
   * has a blocked node. Omit → no jump button.
   */
  onJumpToSession?: (sessionId: string) => void
  /** Injectable clock for the per-session trees' elapsed timers (tests). */
  now?: () => number
}

const STATUS_LABEL: Record<SessionDerivedStatus, string> = {
  running: 'Running',
  blocked: 'Blocked',
  failed: 'Failed',
  idle: 'Idle',
}

/** running/blocked/failed chips for a rollup (idle implied; omitted to cut noise). */
function RollupChips({ rollup, testidPrefix }: {
  rollup: { running: number; blocked: number; failed: number; idle: number }
  testidPrefix: string
}) {
  return (
    <span className="mc-rollup" data-testid={testidPrefix}>
      <span className="mc-chip mc-chip-running" data-testid={`${testidPrefix}-running`}>{rollup.running} running</span>
      <span className="mc-chip mc-chip-blocked" data-testid={`${testidPrefix}-blocked`}>{rollup.blocked} blocked</span>
      <span className="mc-chip mc-chip-failed" data-testid={`${testidPrefix}-failed`}>{rollup.failed} failed</span>
    </span>
  )
}

export function CrossSessionMissionControl({ activity, sessions, external = [], onCancelActivity, cancellingActivityIds, onJumpToSession, now = Date.now }: CrossSessionMissionControlProps) {
  const agg = selectCrossSessionActivity(activity, sessions)

  // Scope the `${sessionId}:${activityId}` cancelling set down to a single
  // session's plain activity ids — ActivityTree keys by entry id alone (the v1
  // panel does the same strip, since activity ids are only unique per session).
  const scopedCancelling = useCallback((sessionId: string): ReadonlySet<string> | undefined => {
    if (!cancellingActivityIds || cancellingActivityIds.size === 0) return undefined
    const prefix = `${sessionId}:`
    const out = new Set<string>()
    for (const key of cancellingActivityIds) {
      if (key.startsWith(prefix)) out.add(key.slice(prefix.length))
    }
    return out
  }, [cancellingActivityIds])

  // Per-session drill-down expansion, keyed by sessionId (globally unique, so —
  // unlike ActivityTree's per-session entry ids — no cross-session collision).
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = useCallback((sessionId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(sessionId)) next.delete(sessionId)
      else next.add(sessionId)
      return next
    })
  }, [])

  if (agg.groups.length === 0 && external.length === 0) {
    return (
      <div className="mission-control" data-testid="mission-control">
        <div className="mission-control-empty" data-testid="mission-control-empty">
          No active sessions
        </div>
      </div>
    )
  }

  return (
    <div className="mission-control" data-testid="mission-control">
      <header className="mission-control-header">
        <span className="mc-total-label">All sessions</span>
        <RollupChips rollup={agg.total} testidPrefix="mission-control-total" />
      </header>

      {agg.groups.map((group) => (
        <section
          key={group.key}
          className="mission-control-group"
          data-testid="mission-control-group"
          data-group-key={group.key}
        >
          <h3 className="mission-control-group-head">
            <span className="mission-control-group-label" data-testid="mission-control-group-label">
              {group.label}
            </span>
            {group.worktree && (
              <span className="mc-worktree-badge" data-testid="mission-control-group-worktree">worktree</span>
            )}
            <RollupChips rollup={group.rollup} testidPrefix="mission-control-group-rollup" />
          </h3>

          {/* Reuse the v1 ActivityTree list reset (control-room-entry-list) so the
              session rows share the tree's spacing/markers-off styling. */}
          <ul className="mission-control-session-list control-room-entry-list">
            {group.sessions.map((s) => {
              const isOpen = expanded.has(s.sessionId)
              // aria-controls must reference the expanded region's id (set below).
              const treeId = `mission-control-session-tree-${s.sessionId}`
              return (
                <li key={s.sessionId} className="mission-control-session" data-testid={`mission-control-session-${s.sessionId}`}>
                  {/* Reuse control-room-entry so the row matches the v1 tree rows. */}
                  <button
                    type="button"
                    className={`control-room-entry mission-control-session-row status-${s.status}`}
                    data-status={s.status}
                    data-testid={`mission-control-session-toggle-${s.sessionId}`}
                    aria-expanded={isOpen}
                    aria-controls={isOpen ? treeId : undefined}
                    onClick={() => toggle(s.sessionId)}
                  >
                    <span className="control-room-entry-label mission-control-session-name">{s.name}</span>
                    <span
                      className={`control-room-status-badge status-${s.status}`}
                      data-testid={`mission-control-session-status-${s.sessionId}`}
                      role="status"
                      aria-label={`Status: ${STATUS_LABEL[s.status]}`}
                    >
                      {STATUS_LABEL[s.status]}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="mission-control-session-tree" id={treeId} data-testid={treeId}>
                      <ActivityTree
                        activity={activity}
                        sessionId={s.sessionId}
                        now={now}
                        onCancelActivity={onCancelActivity ? (activityId) => onCancelActivity(activityId, s.sessionId) : undefined}
                        cancellingActivityIds={scopedCancelling(s.sessionId)}
                        onJumpToSession={onJumpToSession}
                      />
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      ))}

      {external.length > 0 && (
        <section
          className="mission-control-group mission-control-external"
          data-testid="mission-control-external"
        >
          <h3 className="mission-control-group-head">
            <span className="mission-control-group-label">External sessions</span>
            <span
              className="mc-readonly-badge"
              data-testid="mission-control-external-readonly"
              title="Sessions chroxy didn't launch (seen via /api/events) — observe-only"
            >
              read-only
            </span>
          </h3>

          <ul className="mission-control-session-list control-room-entry-list">
            {external.map((s) => (
              <li
                key={`${s.source} ${s.sessionId}`}
                className="mission-control-session mission-control-external-session"
                data-testid={`mission-control-external-${s.sessionId}`}
              >
                {/* Not a button: external sessions have no drill-down and no
                    control affordance — render a static row, not a toggle. */}
                <div className={`control-room-entry mission-control-session-row status-${s.status} is-readonly`} data-status={s.status}>
                  <span className="control-room-entry-label mission-control-session-name">{s.name}</span>
                  {s.subagents > 0 && (
                    <span className="mc-subagents" data-testid={`mission-control-external-subagents-${s.sessionId}`}>
                      {s.subagents} subagent{s.subagents === 1 ? '' : 's'}
                    </span>
                  )}
                  <span
                    className={`control-room-status-badge status-${s.status}`}
                    data-testid={`mission-control-external-status-${s.sessionId}`}
                    role="status"
                    aria-label={`Status: ${STATUS_LABEL[s.status]}`}
                  >
                    {STATUS_LABEL[s.status]}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
