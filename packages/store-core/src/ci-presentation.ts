import type { ServerSessionPrStatusMessage } from '@chroxy/protocol'

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

/** Labels a no-PR snapshot without treating a non-repository folder as an outage. */
export function describeNoPrStatus(status: ServerSessionPrStatusMessage): { label: string; reason: string | null } {
  if (status.reason === 'session working directory is not a git repository') {
    return { label: 'No repo', reason: null }
  }
  return status.reason !== null
    ? { label: 'CI unavailable', reason: status.reason }
    : { label: 'No PR', reason: null }
}
