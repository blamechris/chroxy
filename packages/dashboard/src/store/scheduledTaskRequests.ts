/**
 * #6871 review (S1) — bounded one-shot registry for scheduler WS requests.
 *
 * Every scheduler request (the snapshot read, the five mutations, the gate
 * toggle) sets some in-flight UI state: `scheduledTasksLoading` disables Refresh
 * and reads "Refreshing…", a `scheduledTaskPendingActions` entry disables a
 * row's buttons and reads "Saving…". Each of those is released by a reply keyed
 * on `requestId`. If the reply never arrives, the UI state is permanent and
 * unrecoverable without a page reload.
 *
 * That was not hypothetical on this surface:
 *
 *   - The READ sent no `requestId` at all, so a refusal echoed `requestId: null`
 *     and the `session_error` branch — which requires a string — took no action.
 *     Refresh sat disabled reading "Refreshing…" forever, with no error shown.
 *   - Rejection frames that carry NO `requestId` by construction
 *     (`INVALID_MESSAGE` for an over-cap message, `rate_limited`, a drain-drop)
 *     can never match a pending entry, so no per-requestId branch can release it.
 *
 * Fixing the first at source (mint a `requestId`) is necessary but not
 * sufficient — it only covers replies the daemon chooses to correlate. So this
 * registry bounds every request: arm a watchdog alongside the send, and on
 * expiry hand the caller a failure so the flag clears and an error surfaces.
 * A disconnect fails everything immediately rather than making the operator wait
 * out the full timeout, since a dead socket means the reply can never come.
 *
 * Mirrors `summarizeRequests.ts` (the same connection.ts-arms /
 * message-handler.ts-settles split, so neither reaches into the other's
 * closure) and the git one-shot timeout discipline of #6939/#6954.
 */

/** Watchdog window, matching GIT_ONESHOT_CALLBACK_TIMEOUT_MS. */
export const SCHEDULER_REQUEST_TIMEOUT_MS = 30_000

export const SCHEDULER_TIMEOUT_ERROR =
  'No response from the daemon — the scheduler request timed out. Refresh to retry.'

export const SCHEDULER_DISCONNECT_ERROR =
  'Disconnected before the daemon replied — reconnect and retry.'

interface PendingSchedulerRequest {
  /**
   * Invoked ONLY when the registry itself gives up (watchdog expiry or a
   * disconnect). A real reply goes through `settleSchedulerRequest`, which
   * clears the watchdog without calling this — the reply handler has already
   * written the resulting state.
   */
  onFail: (reason: string) => void
  timeoutId?: ReturnType<typeof setTimeout>
}

const pending = new Map<string, PendingSchedulerRequest>()

/**
 * Arm `requestId` with its watchdog. Re-arming the same id is race-free: the
 * previous timer is cleared first, so a retry cannot leave a stale handle that
 * later fails a fresh request.
 */
export function armSchedulerRequest(requestId: string, onFail: (reason: string) => void): void {
  settleSchedulerRequest(requestId)
  const entry: PendingSchedulerRequest = { onFail }
  entry.timeoutId = setTimeout(() => {
    // Delete BEFORE invoking so the one-shot contract holds even if onFail
    // re-enters the registry.
    pending.delete(requestId)
    onFail(SCHEDULER_TIMEOUT_ERROR)
  }, SCHEDULER_REQUEST_TIMEOUT_MS)
  pending.set(requestId, entry)
}

/**
 * A reply landed for `requestId` — clear its watchdog and drop it WITHOUT
 * failing. No-op for an unknown id (already settled, or a stale/duplicate
 * reply), which is what makes this safe to call from every reply path.
 */
export function settleSchedulerRequest(requestId: string | null | undefined): void {
  if (!requestId) return
  const entry = pending.get(requestId)
  if (!entry) return
  if (entry.timeoutId !== undefined) clearTimeout(entry.timeoutId)
  pending.delete(requestId)
}

/**
 * Fail every outstanding scheduler request with `reason`. Called on socket
 * close/error/disconnect, and on an `INVALID_MESSAGE` error frame — which
 * carries no `requestId`, so it cannot be correlated, but does mean the message
 * just sent was rejected outright.
 */
export function failAllSchedulerRequests(reason: string): void {
  if (pending.size === 0) return
  // Snapshot then clear before invoking, so an onFail that arms a new request
  // (a retry) is not immediately swept by this same loop.
  const entries = [...pending.values()]
  pending.clear()
  for (const entry of entries) {
    if (entry.timeoutId !== undefined) clearTimeout(entry.timeoutId)
    entry.onFail(reason)
  }
}

/** True while any scheduler request is outstanding. */
export function hasPendingSchedulerRequests(): boolean {
  return pending.size > 0
}

/** Test seam — drop all state without invoking any failure callback. */
export function resetSchedulerRequestsForTest(): void {
  for (const entry of pending.values()) {
    if (entry.timeoutId !== undefined) clearTimeout(entry.timeoutId)
  }
  pending.clear()
}
