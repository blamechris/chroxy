/**
 * #5547 — pending `summarize_session` request registry.
 *
 * The summarize flow is request/response: the store sends a `summarize_session`
 * tagged with a `requestId` and awaits a `summarize_session_result` (resolve)
 * or a `SUMMARIZE_FAILED` session_error (reject). This module owns the bridge
 * between the two halves (connection.ts sends + registers; message-handler.ts
 * resolves/rejects) so neither has to reach into the other's closure.
 *
 * A plain Map keyed by requestId. Entries are deleted on settle; a disconnect
 * rejects all outstanding requests so an awaiting caller never hangs forever.
 */

export interface SummarizeResult {
  summary: string
  truncated: boolean
}

interface PendingSummarize {
  resolve: (result: SummarizeResult) => void
  reject: (err: Error) => void
  // Per-request watchdog timer (set by connection.summarizeSession). Cleared on
  // any settle so the request never lingers in the Map if the server stalls or
  // drops the reply while the socket stays open — mirrors the evaluator
  // registry's timeout discipline.
  timeoutId?: ReturnType<typeof setTimeout>
}

const pending = new Map<string, PendingSummarize>()

/** Register a pending summarize request keyed by its requestId. */
export function registerSummarizeRequest(requestId: string, handlers: PendingSummarize): void {
  pending.set(requestId, handlers)
}

/**
 * Cancel a pending summarize request without settling its promise — used by the
 * watchdog timeout, which rejects the promise itself before clearing the entry.
 * No-op if unknown. Clears the timer to avoid a dangling handle.
 */
export function cancelSummarizeRequest(requestId: string): void {
  const entry = pending.get(requestId)
  if (!entry) return
  if (entry.timeoutId !== undefined) clearTimeout(entry.timeoutId)
  pending.delete(requestId)
}

/**
 * Resolve a pending summarize request (a `summarize_session_result` arrived).
 * No-op if the requestId is unknown (e.g. already settled or a stale reply).
 */
export function resolveSummarizeRequest(requestId: string, result: SummarizeResult): void {
  const entry = pending.get(requestId)
  if (!entry) return
  if (entry.timeoutId !== undefined) clearTimeout(entry.timeoutId)
  pending.delete(requestId)
  entry.resolve(result)
}

/**
 * Reject a pending summarize request (a SUMMARIZE_FAILED session_error arrived,
 * or the socket dropped). No-op if the requestId is unknown.
 */
export function rejectSummarizeRequest(requestId: string, message: string): void {
  const entry = pending.get(requestId)
  if (!entry) return
  if (entry.timeoutId !== undefined) clearTimeout(entry.timeoutId)
  pending.delete(requestId)
  entry.reject(new Error(message))
}

/**
 * Reject every outstanding summarize request — called on disconnect so an
 * awaiting UI flow surfaces an error instead of hanging.
 */
export function rejectAllSummarizeRequests(message: string): void {
  for (const [, entry] of pending) {
    if (entry.timeoutId !== undefined) clearTimeout(entry.timeoutId)
    entry.reject(new Error(message))
  }
  pending.clear()
}
