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

/**
 * How recently the automatic pull must have asked before it skips (#7344,
 * Copilot review). Long enough that cycling tabs does not spawn a git + `gh`
 * pair per switch, short enough that returning to a tab after reading a diff
 * still re-checks. The manual Refresh ignores it entirely.
 */
export const SESSION_PR_STATUS_AUTO_PULL_MAX_AGE_MS = 30_000

export interface SessionCiChipProps {
  /** Latest snapshot for the active session, or null before one lands. */
  status: ServerSessionPrStatusMessage | null
  /** True between dispatching a request and its snapshot. */
  loading?: boolean
  /** Re-request the snapshot. */
  onRefresh: () => void
  /**
   * Stage this snapshot as a status line in the composer (#7423). PREFILL ONLY —
   * the user presses Enter. Omit it and the action is not offered; it is also
   * withheld whenever there is no PR, because "no open PR" is not verified state
   * worth handing an agent.
   */
  onPrefill?: () => void
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
  // A skipped check satisfies branch protection, so it counts toward "settled".
  // Reporting `passed/total` alone rendered a fully-skipped rollup as "0/5
  // green", which is very reachable here given the repo's path-filtered jobs.
  const settled = counts.passed + counts.skipped
  // The unknown bucket exists to surface entries the server did not recognise.
  // Leaving it out of the label made it invisible in exactly the branch where a
  // reader most needs it.
  const unknownSuffix = counts.unknown > 0 ? ` · ${counts.unknown} unrecognised` : ''
  switch (state) {
    case 'none':
      // Not a green: this head produced no run at all.
      return 'No checks'
    case 'pending':
      return counts.failed > 0
        ? `${counts.failed} failed / ${counts.pending} pending${unknownSuffix}`
        : `${settled}/${counts.total} · ${counts.pending} pending${unknownSuffix}`
    case 'failure':
      return `${counts.failed} failed${unknownSuffix}`
    case 'success':
      return `${settled}/${counts.total} green`
    case 'unknown':
    default:
      return `${counts.unknown} unrecognised`
  }
}

/**
 * Short label for the merge state.
 *
 * Returns null in exactly ONE case: `merge` itself is null, i.e. there is no PR
 * to have a merge state. Whenever there IS a PR, this always renders something —
 * because the pill's absence beside a green check label is read as "ready", and
 * that is the one impression this chip exists to avoid giving.
 *
 * So the two thin cases render explicitly rather than vanishing:
 *   - `UNKNOWN` → "recomputing". GitHub reports it while recalculating after a
 *     base change; it means not-yet-known, not "no blocker".
 *   - `null` (schema-valid: `mergeStateStatus` is `.nullable()`) → "unknown".
 *     Dropping it was the defect: a PR with 21/21 green and a null merge state
 *     rendered a green chip with no merge pill at all.
 */
export function formatMergeState(merge: ServerSessionPrStatusMessage['merge']): string | null {
  if (!merge) return null
  const status = merge.mergeStateStatus
  if (!status) return 'merge: unknown'
  if (status === 'UNKNOWN') return 'merge: recomputing'
  return `merge: ${status.toLowerCase()}`
}

export function SessionCiChip({ status, loading = false, onRefresh, onPrefill }: SessionCiChipProps) {
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
      {status.pr.isDraft && (
        <span className="session-ci-chip__draft" data-testid="session-ci-chip-draft">draft</span>
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
      {onPrefill && (
        // Offered for EVERY state that has a PR — a failing or pending run is
        // exactly what a user most wants to hand the agent, so this must not be
        // gated on the tone.
        <button
          type="button"
          className="session-ci-chip__prefill"
          data-testid="session-ci-chip-prefill"
          onClick={onPrefill}
          aria-label="Insert this CI status into the message box"
          title="Insert this CI status into the message box (does not send)"
        >
          {'↳'}
        </button>
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
