/**
 * SessionCiChip — the session's pull-request / CI state, in the header (#7344).
 *
 * Before this, the only signal that a session's PR had CI running at all was
 * prose the agent happened to type. The user could not tell a finished session
 * from one blocked on an external resource that would resolve on its own, and
 * the agent burned turns polling `gh pr checks`. This is the *display* half of
 * #7344 — the automatic completion event that wakes the agent is a follow-on.
 *
 * ## What it deliberately does NOT say
 *
 * It never renders a single "ready to merge?" verdict. Check state and merge
 * state are shown as two separate pills because they diverge: the session that
 * motivated the issue had 21/21 checks green while `mergeStateStatus` was
 * `BLOCKED` on one unresolved review thread, so a combined badge would have
 * been wrong in exactly the case the user needed it to be right.
 *
 * It also never renders "no checks" as a green. `checks.state === 'none'` means
 * this head SHA produced NO run — a push can legitimately create none — so it
 * gets its own neutral treatment, as does a snapshot whose `reason` says the
 * server could not determine the state at all.
 */
import type { ServerSessionPrStatusMessage } from '@chroxy/protocol'

export interface SessionCiChipProps {
  /** Latest snapshot for the active session, or null before one lands. */
  status: ServerSessionPrStatusMessage | null
  /** True between dispatching a request and its snapshot. */
  loading?: boolean
  /** Re-request the snapshot. */
  onRefresh: () => void
}

/** Visual severity, which is NOT the same question as "is it settled". */
type Tone = 'neutral' | 'success' | 'failure' | 'pending'

const CHECK_TONE: Record<string, Tone> = {
  success: 'success',
  failure: 'failure',
  pending: 'pending',
  none: 'neutral',
  unknown: 'neutral',
}

/**
 * Short label for the check rollup.
 *
 * `pending` deliberately surfaces the failure count alongside the pending one
 * ("3 failed / 5 pending") rather than hiding a known failure behind a spinner —
 * the server keeps both counts for exactly this reason.
 */
export function formatChecks(checks: ServerSessionPrStatusMessage['checks']): string {
  if (!checks) return 'No CI data'
  const { state, counts } = checks
  switch (state) {
    case 'none':
      // Not a green: this head produced no run at all.
      return 'No checks'
    case 'pending':
      return counts.failed > 0
        ? `${counts.failed} failed / ${counts.pending} pending`
        : `${counts.passed}/${counts.total} · ${counts.pending} pending`
    case 'failure':
      return `${counts.failed} failed`
    case 'success':
      return `${counts.passed}/${counts.total} green`
    case 'unknown':
    default:
      return `${counts.unknown} unrecognised`
  }
}

/**
 * Short label for the merge state, or null when there is nothing worth showing.
 *
 * `UNKNOWN` is rendered as "recomputing" rather than hidden or treated as a
 * blocker: GitHub reports it while it recalculates after a base change, and
 * silently dropping it would let a stale-looking chip imply a settled answer.
 */
export function formatMergeState(merge: ServerSessionPrStatusMessage['merge']): string | null {
  if (!merge) return null
  const status = merge.mergeStateStatus
  if (!status) return null
  if (status === 'UNKNOWN') return 'merge: recomputing'
  return `merge: ${status.toLowerCase()}`
}

export function SessionCiChip({ status, loading = false, onRefresh }: SessionCiChipProps) {
  const refresh = (
    <button
      type="button"
      className="session-ci-chip__refresh"
      data-testid="session-ci-chip-refresh"
      onClick={onRefresh}
      disabled={loading}
      aria-label="Refresh pull-request and CI status"
      title="Refresh pull-request and CI status"
    >
      {'↻'}
    </button>
  )

  if (loading && !status) {
    return (
      <span className="session-ci-chip session-ci-chip--neutral" data-testid="session-ci-chip" data-tone="neutral">
        <span className="session-ci-chip__label">CI{'…'}</span>
        {refresh}
      </span>
    )
  }

  if (!status) return null

  // A `reason` with no PR means the survey could not find out. It must read as
  // cannot-determine — never as an implied green — so it gets the neutral tone
  // and carries the server's own reason as the tooltip.
  if (!status.pr) {
    const cannotDetermine = status.reason !== null
    return (
      <span
        className="session-ci-chip session-ci-chip--neutral"
        data-testid="session-ci-chip"
        data-tone="neutral"
        title={cannotDetermine ? status.reason ?? undefined : 'This branch has no open pull request'}
      >
        <span className="session-ci-chip__label">
          {cannotDetermine ? 'CI unavailable' : 'No PR'}
        </span>
        {refresh}
      </span>
    )
  }

  const tone: Tone = CHECK_TONE[status.checks?.state ?? 'unknown'] ?? 'neutral'
  const mergeLabel = formatMergeState(status.merge)
  const prUrl = status.pr.url
  const prLabel = `#${status.pr.number}`
  // Same defensive scheme guard as DevPreviewChip: the URL crosses the wire, so
  // only http(s) may become a navigable href.
  const navigable = prUrl !== null && isHttpUrl(prUrl)

  return (
    <span
      className={`session-ci-chip session-ci-chip--${tone}`}
      data-testid="session-ci-chip"
      data-tone={tone}
      title={[
        status.pr.title,
        status.pr.headRefOid ? `head ${status.pr.headRefOid.slice(0, 7)}` : null,
        status.reason,
      ].filter(Boolean).join(' — ') || undefined}
    >
      {navigable ? (
        <a
          className="session-ci-chip__pr"
          href={prUrl as string}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open pull request ${prLabel} on GitHub`}
        >
          {prLabel}
        </a>
      ) : (
        <span className="session-ci-chip__pr">{prLabel}</span>
      )}
      <span className="session-ci-chip__label" data-testid="session-ci-chip-checks">
        {formatChecks(status.checks)}
      </span>
      {mergeLabel !== null && (
        // Rendered as a SEPARATE pill, never merged into the check label.
        <span className="session-ci-chip__merge" data-testid="session-ci-chip-merge">
          {mergeLabel}
        </span>
      )}
      {refresh}
    </span>
  )
}

function isHttpUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}
