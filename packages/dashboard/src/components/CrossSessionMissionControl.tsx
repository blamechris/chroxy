/**
 * CrossSessionMissionControl (#6183, Control Room v2 phase 2 / #5964) — the
 * aggregate, read-only mission-control view spanning ALL sessions, the promotion
 * of the v1 per-session ActivityTree (#5176) to "every session chroxy can see".
 *
 * Pure + prop-driven (same shape as ActivityTree): the parent passes the whole
 * `activity` reducer state + the session list; this component derives the
 * cross-session rollup via store-core's `selectCrossSessionActivity` (#6182) —
 * sessions grouped by repo+worktree (cwd), each group + the overall set carrying
 * running/blocked/failed/idle SESSION counts. Each session row drills down into
 * its v1 `ActivityTree`, so the per-session tree stays the single source of
 * truth (no regression) and this view is purely the aggregation layer on top.
 *
 * Read-only: no cancel affordance here (whole-turn / per-node control lives in
 * the per-session surfaces). The overall rollup is what the tray badge (#6184)
 * will consume off the same selector.
 */
import { useCallback, useState } from 'react'
import type { ActivityState, CrossSessionMeta, SessionDerivedStatus } from '@chroxy/store-core'
import { selectCrossSessionActivity } from '@chroxy/store-core'
import { ActivityTree } from './ActivityTree'

export interface CrossSessionMissionControlProps {
  /** Whole-store activity state (one tree per session). */
  activity: ActivityState
  /** The authoritative session list (drives membership + grouping). */
  sessions: readonly CrossSessionMeta[]
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

export function CrossSessionMissionControl({ activity, sessions, now = Date.now }: CrossSessionMissionControlProps) {
  const agg = selectCrossSessionActivity(activity, sessions)

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

  if (agg.groups.length === 0) {
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

          <ul className="mission-control-session-list">
            {group.sessions.map((s) => {
              const isOpen = expanded.has(s.sessionId)
              return (
                <li key={s.sessionId} className="mission-control-session" data-testid={`mission-control-session-${s.sessionId}`}>
                  <button
                    type="button"
                    className={`mission-control-session-row status-${s.status}`}
                    data-status={s.status}
                    data-testid={`mission-control-session-toggle-${s.sessionId}`}
                    aria-expanded={isOpen}
                    onClick={() => toggle(s.sessionId)}
                  >
                    <span className="mission-control-session-name">{s.name}</span>
                    <span
                      className={`mc-status-badge status-${s.status}`}
                      data-testid={`mission-control-session-status-${s.sessionId}`}
                      role="status"
                      aria-label={`Status: ${STATUS_LABEL[s.status]}`}
                    >
                      {STATUS_LABEL[s.status]}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="mission-control-session-tree" data-testid={`mission-control-session-tree-${s.sessionId}`}>
                      <ActivityTree activity={activity} sessionId={s.sessionId} now={now} />
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}
