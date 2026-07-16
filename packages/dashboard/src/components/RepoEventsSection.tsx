/**
 * RepoEventsSection (#5966, epic #5422 phase 5) — the "Repo events" Control Room tab.
 *
 * Renders the GitHub-webhook activity the daemon buffers in its bounded
 * RepoEventStore (github-webhook.js, HMAC-verified ingest #6468) and returns in a
 * `repo_events_snapshot`: an eyebrow + title + Refresh, summary chips (events /
 * repos / active-repo tallies), and a newest-first timeline grouped by repo.
 * Each event shows a kind badge (push / PR / issue / ping), the pre-rendered
 * `summary`, the actor, a relative timestamp, and a link when the event carries
 * a safe https URL.
 *
 * Active-repo scoping (AC#3): by default the pane scopes to the repos the live
 * sessions are working in — matched best-effort by the repo's `owner/REPO`
 * basename against each session's cwd basename. Two "nothing to show" cases are
 * handled distinctly: when there are NO active-session repos to scope BY, scoping
 * is off and every event shows (so a session-less dashboard never renders a
 * confusing empty feed); when there ARE active repos but none match a buffered
 * event, the pane renders an explicit "no events for your repos" state with a
 * "Show all" button rather than silently blanking. A "Show all repos" toggle
 * reveals everything either way. Exact remote-based scoping + live WS delta
 * broadcast + webhook-secret UX are a deferred PR-2 follow-up; PR-1 is the
 * pull-driven survey pane.
 *
 * Same pull-on-Refresh data flow as the sibling surveys: the Refresh button
 * dispatches `repo_events_request` via the store's `requestRepoEvents`; the
 * server replies with one `repo_events_snapshot` handled into `repoEventsSnapshot`.
 * No delta stream — each refresh replaces the whole survey.
 */
import { useState } from 'react'
import { useConnectionStore } from '../store/connection'
import type { RepoEvent, ServerRepoEventsSnapshotMessage } from '@chroxy/protocol'
import type { SessionInfo } from '@chroxy/store-core'
import { formatGeneratedAgo } from './ControlRoomSection'

/** ISO date (no time) for the eyebrow, e.g. "2026-07-02". */
function isoDate(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso)
  return m ? m[1]! : iso
}

/** Relative "ago" string for an event row, or "—" for an unparseable time. */
export function formatAgo(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return '—'
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return '—'
  const deltaSec = Math.floor((nowMs - ms) / 1000)
  if (!Number.isFinite(deltaSec) || deltaSec < 60) return 'just now'
  const min = Math.floor(deltaSec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

/**
 * Last path segment of an `owner/repo` full name OR a filesystem path, or null.
 * Splits on BOTH separators + collapses runs so it works for a repo full name
 * (`owner/repo`), a POSIX cwd (`/Users/me/chroxy`), AND a Windows session cwd
 * (`C:\Users\me\chroxy`) — a session on a Windows daemon sends backslash paths,
 * and a '/'-only split would return the whole string and hide every event.
 * Trailing separators are dropped by the `filter(Boolean)`.
 */
export function repoBasename(fullName: string | null | undefined): string | null {
  if (!fullName) return null
  const parts = fullName.split(/[\\/]+/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1]! : null
}

/**
 * The set of repo basenames the live sessions are working in, derived from each
 * session's cwd basename. Best-effort: a worktree dir may not match the repo
 * name exactly — that's what the "Show all repos" toggle is for.
 */
export function activeRepoBasenames(sessions: readonly Pick<SessionInfo, 'cwd'>[]): Set<string> {
  const set = new Set<string>()
  for (const s of sessions) {
    const base = repoBasename(s?.cwd)
    if (base) set.add(base)
  }
  return set
}

/** Kind → short badge label. */
const KIND_LABEL: Record<RepoEvent['kind'], string> = {
  push: 'Push',
  pull_request: 'PR',
  issues: 'Issue',
  ping: 'Ping',
}

/** A group of events for one repo, newest event first. */
export interface RepoEventGroup {
  repo: string
  events: RepoEvent[]
}

/**
 * The active-repo scope to filter events against. `#6539`: prefer the server's
 * EXACT `owner/repo` set (`exactRepos`, resolved from each session's git remote);
 * fall back to the best-effort cwd-`basenames` guess only when the server didn't
 * send it (older daemon, `exactRepos: null`).
 */
export interface RepoEventsScope {
  /** Exact `owner/repo` set from the snapshot's `activeRepos`, or null if absent. */
  exactRepos: ReadonlySet<string> | null
  /** Fallback: cwd basenames derived client-side. Used only when `exactRepos` is null. */
  basenames: ReadonlySet<string>
}

/**
 * Scope + group events for display. The store feed is most-recent-LAST, so we
 * reverse to newest-first. When `showAll` is false and the active set is
 * non-empty, events are filtered to those repos; otherwise all events pass.
 * `#6539`: matches by EXACT `owner/repo` when the server sent `activeRepos`,
 * else by cwd basename (backward-compatible fallback). Returns the visible
 * groups (ordered by their newest event) plus how many events were hidden.
 */
export function scopeAndGroupEvents(
  events: readonly RepoEvent[],
  scope: RepoEventsScope,
  showAll: boolean,
): { groups: RepoEventGroup[]; hiddenCount: number } {
  const newestFirst = events.slice().reverse()
  const useExact = scope.exactRepos !== null
  const activeSet = useExact ? scope.exactRepos! : scope.basenames
  const scoped = !showAll && activeSet.size > 0
  let hiddenCount = 0
  const byRepo = new Map<string, RepoEvent[]>()
  for (const ev of newestFirst) {
    if (scoped) {
      // Exact: the event's `owner/repo` must be in the set (case-insensitive —
      // GitHub names are, and a git-config remote can differ in case from the
      // canonical `full_name` the webhook stamps). Fallback: its cwd basename.
      const filterKey = useExact ? (ev.repo ? ev.repo.toLowerCase() : null) : repoBasename(ev.repo)
      if (!filterKey || !activeSet.has(filterKey)) {
        hiddenCount++
        continue
      }
    }
    const key = ev.repo ?? '(unknown repo)'
    const bucket = byRepo.get(key)
    if (bucket) bucket.push(ev)
    else byRepo.set(key, [ev])
  }
  // Insertion order over `newestFirst` already ranks groups by their newest
  // event (the first time we see a repo is its most-recent event).
  const groups: RepoEventGroup[] = [...byRepo.entries()].map(([repo, evs]) => ({ repo, events: evs }))
  return { groups, hiddenCount }
}

function KindBadge({ kind }: { kind: RepoEvent['kind'] }) {
  return (
    <span className="cr-tag" data-testid={`repo-event-kind-${kind}`} data-accent="neutral">
      {KIND_LABEL[kind]}
    </span>
  )
}

/** One event row: badge · summary · actor · time · optional link. */
function EventRow({ event, now }: { event: RepoEvent; now: number }) {
  const safeUrl = typeof event.url === 'string' && event.url.startsWith('https://') ? event.url : null
  return (
    <li className="cr-repo-event" data-testid="repo-event-row">
      <KindBadge kind={event.kind} />
      <span className="cr-repo-event-summary" data-testid="repo-event-summary">{event.summary}</span>
      {event.actor && <span className="cr-dim" data-testid="repo-event-actor"> · {event.actor}</span>}
      <span className="cr-dim" data-testid="repo-event-time"> · {formatAgo(event.at, now)}</span>
      {safeUrl && (
        <>
          {' '}
          <a
            href={safeUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="repo-event-link"
            title="Open on GitHub"
          >
            ↗
          </a>
        </>
      )}
    </li>
  )
}

export interface RepoEventsSectionProps {
  /** Latest snapshot, or null before the first one lands. Defaults to the store. */
  snapshot?: ServerRepoEventsSnapshotMessage | null
  /** True while a refresh is in flight. Defaults to the store flag. */
  loading?: boolean
  /** Whether the WS connection is up. Defaults to the store's connected phase. */
  connected?: boolean
  /** Live sessions, for active-repo scoping. Defaults to the store. */
  sessions?: readonly Pick<SessionInfo, 'cwd'>[]
  /** Refresh action. Defaults to the store's requestRepoEvents. */
  onRefresh?: () => void
  /** Injectable clock (epoch ms) for the "generated Nm ago" / event-time cells. */
  now?: () => number
}

export function RepoEventsSection({
  snapshot: snapshotProp,
  loading: loadingProp,
  connected: connectedProp,
  sessions: sessionsProp,
  onRefresh: onRefreshProp,
  now = Date.now,
}: RepoEventsSectionProps = {}) {
  const storeSnapshot = useConnectionStore((s) => s.repoEventsSnapshot)
  const storeLoading = useConnectionStore((s) => s.repoEventsLoading)
  const storeConnected = useConnectionStore((s) => s.connectionPhase === 'connected')
  const storeSessions = useConnectionStore((s) => s.sessions)
  const requestRepoEvents = useConnectionStore((s) => s.requestRepoEvents)

  const snapshot = snapshotProp !== undefined ? snapshotProp : storeSnapshot
  const loading = loadingProp !== undefined ? loadingProp : storeLoading
  const connected = connectedProp !== undefined ? connectedProp : storeConnected
  const sessions = sessionsProp !== undefined ? sessionsProp : storeSessions
  const onRefresh = onRefreshProp ?? requestRepoEvents

  const [showAll, setShowAll] = useState(false)

  const refreshDisabled = loading || !connected
  const handleRefresh = () => {
    if (refreshDisabled) return
    onRefresh()
  }

  const nowMs = now()
  const generatedAtMs = snapshot ? Date.parse(snapshot.generatedAt) : NaN

  const events = snapshot?.events ?? []
  // #6539: prefer the server's exact `owner/repo` set; fall back to cwd basenames
  // when an older daemon omits it. `exactRepos: null` ⇒ use the basename guess.
  // Lowercased for case-insensitive matching (GitHub names are case-insensitive).
  const exactRepos = Array.isArray(snapshot?.activeRepos)
    ? new Set(snapshot.activeRepos.map((r) => r.toLowerCase()))
    : null
  const basenames = activeRepoBasenames(sessions ?? [])
  const { groups, hiddenCount } = scopeAndGroupEvents(events, { exactRepos, basenames }, showAll)
  const activeScopeSize = exactRepos !== null ? exactRepos.size : basenames.size
  const scopingActive = !showAll && activeScopeSize > 0

  return (
    <div className="cr-section" data-testid="repo-events-section">
      <header className="cr-header">
        <div className="cr-eyebrow" data-testid="repo-events-eyebrow">
          host · repo events{snapshot ? ` · ${isoDate(snapshot.generatedAt)}` : ''}
        </div>
        <div className="cr-titlerow">
          <h1 className="cr-title">Repo events</h1>
          <button
            type="button"
            className="cr-refresh"
            data-testid="repo-events-refresh"
            onClick={handleRefresh}
            disabled={refreshDisabled}
            aria-busy={loading}
            title={connected ? undefined : 'Not connected — reconnect to run the survey'}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        {snapshot && (
          <p className="cr-sub" data-testid="repo-events-sub">
            GitHub-webhook activity (push / PR / issue) buffered from{' '}
            <span className="cr-mono">POST /api/github/webhook</span>
            {scopingActive ? ', scoped to the repos your sessions are working in.' : ' across all monitored repos.'}
          </p>
        )}
        {snapshot && !Number.isNaN(generatedAtMs) && (
          <p className="cr-generated" data-testid="repo-events-generated">
            {formatGeneratedAgo(generatedAtMs, nowMs)}
          </p>
        )}
      </header>

      {snapshot?.error && (
        <p className="cr-callout cr-callout-bad" data-testid="repo-events-error" role="alert">
          <b>Survey failed ({snapshot.error.code}):</b> {snapshot.error.message}
        </p>
      )}

      {!snapshot && (
        <div className="cr-empty" data-testid="repo-events-empty">
          {loading ? (
            <span>Running the repo-events survey…</span>
          ) : (
            <>
              <p>No repo-events survey yet.</p>
              <button
                type="button"
                className="cr-refresh"
                data-testid="repo-events-empty-refresh"
                onClick={handleRefresh}
                disabled={!connected}
                title={connected ? undefined : 'Not connected — reconnect to run the survey'}
              >
                Run survey
              </button>
              {!connected && (
                <p className="cr-dim" data-testid="repo-events-not-connected">Not connected to the server.</p>
              )}
            </>
          )}
        </div>
      )}

      {snapshot && (
        <>
          <div className="cr-chips" data-testid="repo-events-chips">
            <span className="cr-chip" data-testid="repo-events-chip-total">
              Events: <b data-testid="repo-events-chip-count-total">{events.length}</b>
            </span>
            <span className="cr-chip" data-testid="repo-events-chip-repos">
              Repos: <b data-testid="repo-events-chip-count-repos">{new Set(events.map((e) => e.repo ?? '(unknown repo)')).size}</b>
            </span>
            {activeScopeSize > 0 && (
              <label className="cr-chip" data-testid="repo-events-show-all">
                <input
                  type="checkbox"
                  checked={showAll}
                  onChange={(e) => setShowAll(e.target.checked)}
                  data-testid="repo-events-show-all-toggle"
                />{' '}
                Show all repos
              </label>
            )}
          </div>

          {events.length === 0 ? (
            <div className="cr-empty" data-testid="repo-events-none-buffered">
              <p>No repo events buffered yet.</p>
              <p className="cr-dim">
                Point a GitHub webhook (pull_request / issues / push) at{' '}
                <span className="cr-mono">POST /api/github/webhook</span> with the configured secret — events appear here as they arrive.
              </p>
            </div>
          ) : groups.length === 0 ? (
            <div className="cr-empty" data-testid="repo-events-all-hidden">
              <p>No events for the repos your sessions are working in.</p>
              <button
                type="button"
                className="cr-refresh"
                data-testid="repo-events-all-hidden-showall"
                onClick={() => setShowAll(true)}
              >
                Show all {events.length} event{events.length === 1 ? '' : 's'}
              </button>
            </div>
          ) : (
            <section className="cr-repo-event-groups" data-testid="repo-events-groups">
              {groups.map((group) => (
                <div className="cr-repo-event-group" key={group.repo} data-testid={`repo-events-group-${group.repo}`}>
                  <h3 className="cr-repo-event-repo" data-testid="repo-events-group-repo">{group.repo}</h3>
                  <ul className="cr-repo-event-list">
                    {group.events.map((event, i) => (
                      <EventRow key={`${event.at}-${i}`} event={event} now={nowMs} />
                    ))}
                  </ul>
                </div>
              ))}
              {hiddenCount > 0 && (
                <button
                  type="button"
                  className="cr-refresh"
                  data-testid="repo-events-showall-more"
                  onClick={() => setShowAll(true)}
                >
                  Show {hiddenCount} more from other repos
                </button>
              )}
            </section>
          )}
        </>
      )}
    </div>
  )
}
