// blocked-report.mjs — fold "what the browser case tried to reach" into its failure (#9232).
//
// The *-layout browser cases abort every request that leaves the fixture server and refuse
// every WebSocket, recording each attempt. That record used to be asserted empty only AFTER
// the case's own steps had succeeded, so a blocked request that CAUSED an earlier failure
// (a timeout waiting for a resource, a failed assertion on a page that never loaded it)
// surfaced as that failure alone, with the blocked URL nowhere in the output.
//
// Pure on purpose: no browser, no I/O, so it is unit-tested with plain `node --test`
// (scripts/__tests__/blocked-report.test.mjs).

export const BLOCKED_HEADLINE = 'no request left the fixture server and no WebSocket was attempted'

/** One line per blocked attempt, prefixed so it is greppable in CI output. */
export function describeBlocked(blocked) {
  return blocked.map((b) => `  - ${b}`).join('\n')
}

/**
 * What the case should throw, or `undefined` when it should pass.
 *
 * @param {string[]} blocked  every aborted request and refused WebSocket the case recorded
 * @param {unknown}  failure  whatever the case body threw, or `undefined` if it did not throw
 *
 * - nothing blocked: returns `failure` unchanged (same object, same stack), so a case with
 *   no blocked attempt fails or passes exactly as before;
 * - blocked, body threw: a new Error naming BOTH, with `cause` set to the original;
 * - blocked, body did not throw: an Error naming the blocked attempts. A blocked attempt
 *   still fails a case that would otherwise pass.
 */
export function blockedReport(blocked, failure) {
  if (blocked.length === 0) return failure
  const named = `${BLOCKED_HEADLINE}; ${blocked.length} blocked:\n${describeBlocked(blocked)}`
  if (failure === undefined) return new Error(named)
  const original = failure instanceof Error ? failure.message : String(failure)
  const err = new Error(`${original}\n\nThe case also hit blocked attempts, a possible cause. ${named}`, { cause: failure })
  err.blocked = [...blocked]
  return err
}
