/**
 * ControlRoomSection (#5175, epic #5170) — the marquee Host/Repo Status surface
 * of the Control Room. Renders the wide host/fleet survey the server returns in
 * a `host_status_snapshot`: an eyebrow + title + subtitle, a row of summary
 * chips (live / onboarded / abandoned / investigate / recent), a "how to read
 * the verdict" callout, and a table of every managed repo with a colour-coded
 * verdict tag, onboarding state, tree state, worktree / PR / attribution
 * columns, a live green dot, and an annotated `↳` note sub-row.
 *
 * Lives in the dashboard's MAIN content tab bar (the wide area where Chat /
 * Output / Files / System / Envs / Snapshots live) — the fleet table is too
 * wide for the narrow sidebar.
 *
 * #5176 (epic #5170): the Control Room v1 per-session activity tree (the old
 * sidebar `ControlRoomPanel`, retired here) is folded in as a per-repo
 * drill-down. Each repo row maps its filesystem `path` to the active chroxy
 * session whose `cwd` matches (`sessionIdForRepoPath`); expanding the row
 * reveals that session's live activity tree (subagents / shells / tools) via
 * the reused `ActivityTree` + v1 `selectActivityTree`. So nothing the v1 panel
 * surfaced is lost — it just moved into the Control Room next to the verdict.
 *
 * Data flow: the Refresh button dispatches `host_status_request` via the store's
 * `requestHostStatus` action; the server replies with one `host_status_snapshot`
 * handled into `hostStatus`. There is no delta stream — each refresh replaces
 * the whole survey. Empty/loading state renders until the first snapshot lands.
 *
 * Verdict → colour (matches the brief):
 *   - live        → bad   (red)    — an agent is working now; leave it.
 *   - investigate → warn  (amber)  — worth a human look (e.g. a worktree leak).
 *   - abandoned   → warn  (amber)  — dirty tree, no live agent; review & discard.
 *   - recent      → warn  (amber)  — recent uncommitted work; eyeball before touching.
 *   - onboarded   → ok    (green)  — on the pull-model; just needs a checkout+pull.
 */
import { useCallback, useState } from 'react'
import { useConnectionStore } from '../store/connection'
import type { RepoStatus, RepoVerdict, ServerHostStatusSnapshotMessage } from '@chroxy/protocol'
import type { ActivityState, SessionInfo } from '@chroxy/store-core'
import { createEmptyActivityState } from '@chroxy/store-core'
import { ActivityTree } from './ActivityTree'

// Verdict → semantic accent. The three buckets map onto the dashboard's
// ok/warn/bad theme accents (green/amber/red). A single named map keeps the tag
// colour, the chip dot colour, and the test assertions in lockstep.
type Accent = 'ok' | 'warn' | 'bad'

const VERDICT_ACCENT: Record<RepoVerdict, Accent> = {
  live: 'bad',
  investigate: 'warn',
  abandoned: 'warn',
  recent: 'warn',
  onboarded: 'ok',
}

// Human-readable verdict label shown in the tag. LIVE is upper-cased for the
// same "stop, this is hot" emphasis the brief uses.
const VERDICT_LABEL: Record<RepoVerdict, string> = {
  live: 'LIVE',
  investigate: 'Investigate',
  abandoned: 'Likely abandoned',
  recent: 'Recent / your call',
  onboarded: 'Onboarded',
}

/**
 * A worktree or open-PR count at or above this threshold renders in the "bad"
 * colour — the brief flags runaway worktree/PR counts (e.g. 172 worktrees =
 * leak) so the operator's eye lands on them. Kept low enough to surface a
 * genuine leak but above a normal handful of parallel worktrees.
 */
export const HIGH_COUNT_THRESHOLD = 20

/**
 * Format the age of a snapshot as a compact "generated Nm ago" relative string.
 * Exported for direct unit testing. `generatedAtMs` and `nowMs` are epoch ms.
 *
 * Buckets: < 1 min → "just now"; < 1 h → "Nm ago"; < 24 h → "Nh ago";
 * otherwise "Nd ago". Future / clock-skewed timestamps (generatedAt > now)
 * clamp to "just now" rather than rendering a negative age.
 */
export function formatGeneratedAgo(generatedAtMs: number, nowMs: number): string {
  const deltaSec = Math.floor((nowMs - generatedAtMs) / 1000)
  if (!Number.isFinite(deltaSec) || deltaSec < 60) return 'generated just now'
  const min = Math.floor(deltaSec / 60)
  if (min < 60) return `generated ${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `generated ${hr}h ago`
  const days = Math.floor(hr / 24)
  return `generated ${days}d ago`
}

/** ISO date (no time) for the eyebrow line, e.g. "2026-06-04". */
function isoDate(iso: string): string {
  // The snapshot's generatedAt is an ISO-8601 datetime; slice the date portion.
  // Defensive: if it doesn't look like an ISO date, render it verbatim.
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso)
  return m ? m[1]! : iso
}

/**
 * Normalize a filesystem path for comparison: convert backslashes to forward
 * slashes, then strip a single trailing slash (but keep root "/"). The host
 * survey's `repo.path` and a session's `cwd` come from independent sources
 * (server-side `git` walk vs. the session's launch cwd) and one may carry a
 * trailing slash the other doesn't.
 *
 * This deliberately mirrors the server's own Control Room binding normalization
 * (`pathKey` in `packages/server/src/control-room/survey.js`) so the dashboard
 * decides "this repo has a live session" on exactly the same key the server
 * used to derive the repo's `live` verdict — including the backslash → slash
 * fold that lets the drill-down resolve on Windows.
 */
function normalizePath(path: string): string {
  const slashed = path.replace(/\\/g, '/')
  if (slashed.length > 1 && slashed.endsWith('/')) return slashed.slice(0, -1)
  return slashed
}

/**
 * Map a repo (by its filesystem `path`) to the session id of the active chroxy
 * session whose `cwd` matches that path — the link that lets the Control Room
 * drill down into a repo's live activity tree.
 *
 * Match precedence:
 *   1. Exact (normalized) `cwd === repo.path`.
 *   2. A session whose `cwd` is nested under `repo.path` (e.g. a worktree or
 *      subdir launch) — closest (longest) match wins so a session in
 *      `/repo/sub` prefers `/repo/sub` over `/repo`.
 *
 * Returns null when no session maps to the repo. Exported for direct unit
 * testing of the mapping rule.
 */
export function sessionIdForRepoPath(repoPath: string, sessions: readonly SessionInfo[]): string | null {
  const target = normalizePath(repoPath)
  // Exact match first.
  for (const s of sessions) {
    if (normalizePath(s.cwd) === target) return s.sessionId
  }
  // Nested fallback: pick the session whose cwd is the deepest path under the
  // repo (a `${target}/...` prefix). Longest cwd wins the tie.
  let best: { sessionId: string; depth: number } | null = null
  const prefix = target === '/' ? '/' : `${target}/`
  for (const s of sessions) {
    const cwd = normalizePath(s.cwd)
    if (cwd.startsWith(prefix)) {
      const depth = cwd.length
      if (best === null || depth > best.depth) best = { sessionId: s.sessionId, depth }
    }
  }
  return best ? best.sessionId : null
}

interface SummaryChip {
  key: keyof ServerHostStatusSnapshotMessage['summary']
  label: string
  accent: Accent
}

// Chip order + dot accent mirrors the brief's summary row.
const SUMMARY_CHIPS: readonly SummaryChip[] = [
  { key: 'live', label: 'Live agents', accent: 'bad' },
  { key: 'onboarded', label: 'Onboarded', accent: 'ok' },
  { key: 'abandoned', label: 'Likely abandoned', accent: 'warn' },
  { key: 'investigate', label: 'Needs investigation', accent: 'warn' },
  { key: 'recent', label: 'Recent / your call', accent: 'warn' },
]

function VerdictTag({ verdict }: { verdict: RepoVerdict }) {
  const accent = VERDICT_ACCENT[verdict]
  return (
    <span
      className={`cr-tag cr-tag-${accent}`}
      data-testid={`cr-verdict-${verdict}`}
      data-accent={accent}
    >
      {VERDICT_LABEL[verdict]}
    </span>
  )
}

/** A right-aligned count cell that turns "bad" when alarmingly high. */
function CountCell({ value, testid }: { value: number | null; testid: string }) {
  if (value === null) {
    return (
      <td className="cr-num">
        <span className="cr-dim">—</span>
      </td>
    )
  }
  const high = value >= HIGH_COUNT_THRESHOLD
  return (
    <td className="cr-num">
      <span
        className={high ? 'cr-bad' : undefined}
        data-testid={testid}
        data-high={high ? 'true' : 'false'}
      >
        {value}
      </span>
    </td>
  )
}

function TreeCell({ repo }: { repo: RepoStatus }) {
  if (repo.tree.state === 'clean') {
    return <td className="cr-tree" data-testid={`cr-tree-${repo.name}`}>clean</td>
  }
  const { untracked, modified, staged } = repo.tree
  const total = untracked + modified + staged
  return (
    <td className="cr-tree" data-testid={`cr-tree-${repo.name}`}>
      {total} <span className="cr-dim">({untracked}u/{modified}m/{staged}s)</span>
    </td>
  )
}

function AttributionCell({ attribution }: { attribution: boolean | null }) {
  if (attribution === null) {
    return (
      <td>
        <span className="cr-dim">—</span>
      </td>
    )
  }
  return (
    <td>
      {attribution ? <span className="cr-ok">✓</span> : <span className="cr-bad">✗</span>}
    </td>
  )
}

interface RepoRowsProps {
  repo: RepoStatus
  /** Whole-store activity state, for the drill-down tree. */
  activity: ActivityState
  /** Active sessions, used to map this repo's path → its session id. */
  sessions: readonly SessionInfo[]
  /** Whether this repo's activity drill-down is expanded. */
  expanded: boolean
  /** Toggle the drill-down for this repo (keyed by repo.path). */
  onToggleExpand: (path: string) => void
  /** Injectable clock for the activity tree's elapsed timers (tests). */
  now?: () => number
}

function RepoRows({ repo, activity, sessions, expanded, onToggleExpand, now }: RepoRowsProps) {
  // Map repo → its active chroxy session (by cwd). When a session is found the
  // name cell becomes a disclosure toggle that reveals that session's live
  // activity tree (subagents / shells / tools — the retired v1 panel's view).
  const sessionId = sessionIdForRepoPath(repo.path, sessions)
  const drillable = sessionId !== null

  return (
    <>
      <tr data-testid={`cr-row-${repo.name}`} className={repo.live ? 'cr-row-live' : undefined}>
        <td>
          {drillable ? (
            <button
              type="button"
              className="cr-drill-toggle"
              data-testid={`cr-drill-toggle-${repo.name}`}
              aria-expanded={expanded}
              onClick={() => onToggleExpand(repo.path)}
              title={expanded ? 'Hide live activity' : 'Show live activity'}
            >
              <span className="cr-drill-chevron" aria-hidden="true">{expanded ? '▼' : '▶'}</span>
              <b data-testid={`cr-name-${repo.name}`}>{repo.name}</b>
            </button>
          ) : (
            <b data-testid={`cr-name-${repo.name}`}>{repo.name}</b>
          )}
          {repo.live && (
            <span
              className="cr-live-dot"
              data-testid={`cr-live-dot-${repo.name}`}
              role="img"
              aria-label="Live agent"
              title="Live agent here right now"
            />
          )}
          {/* #5201: long branch names ellipsis-truncate with the full value on
              hover (title) instead of forcing the table wider / clipping. */}
          <div className="cr-dim cr-mono cr-branch" data-testid={`cr-branch-${repo.name}`} title={repo.branch}>{repo.branch}</div>
        </td>
        <td><VerdictTag verdict={repo.verdict} /></td>
        {/* #5201: ellipsis-truncate on an inner block element, not the <td>
            itself — text-overflow on display:table-cell is unreliable and can
            still let long content widen the column. The branch cell already
            wraps its text in a div for the same reason. */}
        <td><div className="cr-onboarding" title={repo.onboarding}>{repo.onboarding}</div></td>
        <TreeCell repo={repo} />
        <CountCell value={repo.worktrees} testid={`cr-wt-${repo.name}`} />
        <CountCell value={repo.openPRs} testid={`cr-prs-${repo.name}`} />
        <AttributionCell attribution={repo.attribution} />
        <td className="cr-dim cr-last">{relativeLast(repo.lastTouched)}</td>
      </tr>
      {repo.note && (
        <tr className="cr-act" data-testid={`cr-note-row-${repo.name}`}>
          <td colSpan={8}>
            <span className="cr-arrow" aria-hidden="true">↳</span> {repo.note}
          </td>
        </tr>
      )}
      {drillable && expanded && (
        <tr className="cr-activity-row" data-testid={`cr-activity-row-${repo.name}`}>
          <td colSpan={8}>
            <div className="cr-activity-drill">
              <div className="cr-activity-heading" data-testid={`cr-activity-heading-${repo.name}`}>
                Live activity · {repo.name}
              </div>
              <ActivityTree activity={activity} sessionId={sessionId} now={now} />
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

/**
 * Render the `lastTouched` ISO timestamp as a coarse relative string for the
 * "Last" column. Kept independent of the snapshot-age formatter — this is a
 * per-repo activity age, not the survey freshness. Falls back to the raw ISO
 * string if it can't be parsed.
 */
function relativeLast(iso: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return iso
  const deltaSec = Math.floor((Date.now() - ms) / 1000)
  if (deltaSec < 60) return 'just now'
  const min = Math.floor(deltaSec / 60)
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`
  const days = Math.floor(hr / 24)
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`
  const months = Math.floor(days / 30)
  return `${months} month${months === 1 ? '' : 's'} ago`
}

export interface ControlRoomSectionProps {
  /**
   * Latest survey snapshot, or null before the first one lands. Defaults to the
   * store's `hostStatus`. Injectable for deterministic tests.
   */
  snapshot?: ServerHostStatusSnapshotMessage | null
  /** True while a refresh is in flight. Defaults to the store's flag. */
  loading?: boolean
  /**
   * Whether the WS connection is up. Defaults to the store's
   * `connectionPhase === 'connected'`. When false, the Refresh / Run survey
   * buttons are disabled (a `host_status_request` would be silently dropped by
   * `requestHostStatus` per the #4559 fail-loud contract) and a "not connected"
   * hint is shown.
   */
  connected?: boolean
  /** Refresh action. Defaults to the store's `requestHostStatus`. */
  onRefresh?: () => void
  /**
   * Whole-store activity state (one tree per session) for the per-repo
   * drill-down. Defaults to the store's `activity`. Injectable for tests.
   */
  activity?: ActivityState
  /**
   * Active sessions, used to map a repo's `path` → its session id for the
   * drill-down. Defaults to the store's `sessions`. Injectable for tests.
   */
  sessions?: readonly SessionInfo[]
  /** Injectable clock (epoch ms) for the "generated Nm ago" string. */
  now?: () => number
}

// Stable empty-activity default so the `activity` prop falling back to its
// default doesn't allocate a new object each render.
const EMPTY_ACTIVITY: ActivityState = createEmptyActivityState()

export function ControlRoomSection({
  snapshot: snapshotProp,
  loading: loadingProp,
  connected: connectedProp,
  onRefresh: onRefreshProp,
  activity: activityProp,
  sessions: sessionsProp,
  now = Date.now,
}: ControlRoomSectionProps = {}) {
  const storeSnapshot = useConnectionStore((s) => s.hostStatus)
  const storeLoading = useConnectionStore((s) => s.hostStatusLoading)
  const storeConnected = useConnectionStore((s) => s.connectionPhase === 'connected')
  const requestHostStatus = useConnectionStore((s) => s.requestHostStatus)
  const storeActivity = useConnectionStore((s) => s.activity)
  const storeSessions = useConnectionStore((s) => s.sessions)

  const snapshot = snapshotProp !== undefined ? snapshotProp : storeSnapshot
  const loading = loadingProp !== undefined ? loadingProp : storeLoading
  const connected = connectedProp !== undefined ? connectedProp : storeConnected
  const onRefresh = onRefreshProp ?? requestHostStatus
  const activity = activityProp ?? storeActivity ?? EMPTY_ACTIVITY
  const sessions = sessionsProp ?? storeSessions ?? []

  // Per-repo drill-down expansion, keyed by repo.path. A repo's row reveals its
  // active session's live activity tree (subagents / shells / tools) when
  // toggled — the per-session view folded in from the retired v1 panel (#5176).
  const [expandedRepos, setExpandedRepos] = useState<ReadonlySet<string>>(() => new Set())
  const handleToggleRepo = useCallback((path: string) => {
    setExpandedRepos((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  // Gate the refresh on connection state: a dropped request would otherwise
  // spin/no-op silently. Disabled while a refresh is in flight or disconnected.
  const refreshDisabled = loading || !connected
  const handleRefresh = () => {
    if (refreshDisabled) return
    onRefresh()
  }

  const generatedAtMs = snapshot ? Date.parse(snapshot.generatedAt) : NaN

  return (
    <div className="cr-section" data-testid="control-room-section">
      <header className="cr-header">
        <div className="cr-eyebrow" data-testid="cr-eyebrow">
          host · repo status{snapshot ? ` · ${isoDate(snapshot.generatedAt)}` : ''}
        </div>
        <div className="cr-titlerow">
          <h1 className="cr-title">Project &amp; onboarding status</h1>
          <button
            type="button"
            className="cr-refresh"
            data-testid="cr-refresh"
            onClick={handleRefresh}
            disabled={refreshDisabled}
            aria-busy={loading}
            title={connected ? undefined : 'Not connected — reconnect to run the survey'}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        {snapshot && (
          <p className="cr-sub" data-testid="cr-sub">
            All {snapshot.repos.length} managed repo{snapshot.repos.length === 1 ? '' : 's'} under{' '}
            <span className="cr-mono">{snapshot.root}</span> — git state, pull-model onboarding, and a
            triage verdict for each. <span className="cr-live-dot cr-live-dot-inline" aria-hidden="true" /> = a live
            agent you told me about.
          </p>
        )}
        {snapshot && !Number.isNaN(generatedAtMs) && (
          <p className="cr-generated" data-testid="cr-generated">
            {formatGeneratedAgo(generatedAtMs, now())}
          </p>
        )}
      </header>

      {!snapshot && (
        <div className="cr-empty" data-testid="cr-empty">
          {loading ? (
            <span>Running the host survey…</span>
          ) : (
            <>
              <p>No host status survey yet.</p>
              <button
                type="button"
                className="cr-refresh"
                data-testid="cr-empty-refresh"
                onClick={handleRefresh}
                disabled={!connected}
                title={connected ? undefined : 'Not connected — reconnect to run the survey'}
              >
                Run survey
              </button>
              {!connected && (
                <p className="cr-dim" data-testid="cr-not-connected">Not connected to the server.</p>
              )}
            </>
          )}
        </div>
      )}

      {snapshot && (
        <>
          <div className="cr-chips" data-testid="cr-chips">
            {SUMMARY_CHIPS.map((chip) => (
              <span className="cr-chip" key={chip.key} data-testid={`cr-chip-${chip.key}`}>
                <span className={`cr-dot cr-dot-${chip.accent}`} aria-hidden="true" />
                {chip.label}: <b data-testid={`cr-chip-count-${chip.key}`}>{snapshot.summary[chip.key]}</b>
              </span>
            ))}
          </div>

          <div className="cr-callout" data-testid="cr-callout">
            <b>How to read the verdict:</b> <b>LIVE</b> = agent working now, leave it.{' '}
            <b>Likely abandoned</b> = dirty tree last touched months ago with no live agent — almost
            certainly an old/terminated session. <b>Recent / your call</b> = uncommitted work from the
            last few days. <b>Investigate</b> = a worktree leak. <b>Onboarded</b> = on the pull-model;
            local clone may just need a checkout+pull.
          </div>

          <section className="cr-table-wrap">
            <table className="cr-table" data-testid="cr-table">
              <thead>
                <tr>
                  <th>Repo / branch</th>
                  <th>Verdict</th>
                  <th>Onboarding</th>
                  <th>Tree</th>
                  <th>Wt</th>
                  <th>PRs</th>
                  <th>Attr</th>
                  <th>Last</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.repos.length === 0 ? (
                  <tr data-testid="cr-no-repos">
                    <td colSpan={8} className="cr-dim">No repos found under {snapshot.root}.</td>
                  </tr>
                ) : (
                  snapshot.repos.map((repo) => (
                    <RepoRows
                      key={repo.path}
                      repo={repo}
                      activity={activity}
                      sessions={sessions}
                      expanded={expandedRepos.has(repo.path)}
                      onToggleExpand={handleToggleRepo}
                      now={now}
                    />
                  ))
                )}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  )
}
