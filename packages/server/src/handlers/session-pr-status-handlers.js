/**
 * Session ↔ pull-request / CI status handler (#7344, display slice).
 *
 * One request type, one reply type:
 *
 *   session_pr_status_request → session_pr_status
 *
 * ## Why this is not a Control Room survey
 *
 * The Control Room surveys answer *"what is happening in this repo"* and are
 * host-authority gated — a pairing-bound (share-a-session) token is refused
 * outright. This one answers *"what is the state of the thing THIS session
 * produced"*, which is a question the bound client legitimately has about its
 * own session. So the gate is the SESSION-scoped one used by the other
 * per-session handlers: a bound client may ask about the session it is bound to
 * and about nothing else.
 *
 * ## Always a snapshot, never a spinner
 *
 * Every path — unauthorised, unknown session, survey failure, a survey already
 * running for this client — replies with a schema-valid `session_pr_status`
 * carrying a `reason`. A client that only ever receives one reply type cannot
 * be left waiting on a reply that never comes, and "cannot determine" renders
 * as cannot-determine rather than as an implied green (see the field contracts
 * on `ServerSessionPrStatusSchema`).
 *
 * The authority check runs BEFORE the session lookup, so a bound client cannot
 * use the difference between "not authorised" and "not found" to probe which
 * session ids exist.
 *
 * ## The reply also ARMS the CI watcher (#7427)
 *
 * `SessionCiWatcher` (#7426) fires only on a pending→settled transition it
 * observed, and its own sweep only surveys an unarmed session every five
 * minutes — so a run that starts and finishes between two of those passes was
 * never noticed. This handler surveys the same thing on demand, at the moment
 * someone is actually looking, so the snapshot is handed to `observe()` on the
 * way out: opening the dashboard arms the watch.
 *
 * Note this endpoint is therefore no longer read-only — it MUTATES daemon watch
 * state — while `isInFlight` below still only bars CONCURRENT surveys per
 * client, not back-to-back ones. `observe()` is written to be safe under an
 * un-throttled caller (see its doc); a server-side rate limit is #7436.
 *
 * `observe()` arms and never fires, so nothing a client does can produce a
 * completion event. Note the order and the isolation below — the reply goes out
 * FIRST, and the hand-off is wrapped separately, because an exception raised
 * after `send()` would fall into the survey's catch and emit a SECOND reply,
 * breaking the one-reply-per-request property this whole handler is built on.
 *
 * NOTE the binding check below duplicates the one in `handler-utils.js`'s
 * `resolveSession`. That is deliberate — `resolveSession` collapses "not
 * authorised" and "not found" into a single `null`, and this handler must keep
 * them apart AND check authority first — but it means a change to the binding
 * rule there will not reach here. `resolveSession` carries the matching
 * back-reference. See docs/security/bearer-token-authority.md §4.
 */
import { surveySessionPrStatus } from '../session-pr-status.js'
import { createLogger } from '../logger.js'
import { getErrorMessage } from '../utils/error-message.js'

const log = createLogger('ws')

/** Reason when a bound client asks about a session it is not bound to. */
export const NOT_AUTHORIZED_REASON = 'not authorized to view this session\'s pull-request status'

/** Reason when the requested (or active) session id resolves to nothing. */
export const NO_SESSION_REASON = 'no such session'

/** Reason when this client already has a survey running. */
export const IN_PROGRESS_REASON = 'a pull-request status survey is already running for this client'

/**
 * One survey per (client, session) at a time. `gh` + git spawn subprocesses, so
 * an un-guarded client could fan out a subprocess per click.
 *
 * Keyed on the SESSION as well as the client, deliberately. A client-global
 * guard conflated "this client is spamming Refresh" with "this client switched
 * tabs while a survey was running" — and the second is not abuse. It produced a
 * real defect: switching from session A to B mid-survey had B's request refused
 * on account of A's, and because every reply is stored under its own session id,
 * B's chip was left reading "CI unavailable" with nothing scheduled to retry it.
 *
 * A WeakMap keyed on the client keeps the disconnected-client collection
 * property the WeakSet had; the inner Set is bounded by the client's session
 * count, and entries are removed in the `finally` below.
 */
const inFlight = new WeakMap()

/** True when this client already has a survey running for `sessionId`. */
function isInFlight(client, sessionId) {
  return inFlight.get(client)?.has(sessionId) === true
}

/** Mark `sessionId` in flight for this client. */
function markInFlight(client, sessionId) {
  const set = inFlight.get(client)
  if (set) set.add(sessionId)
  else inFlight.set(client, new Set([sessionId]))
}

/** Release `sessionId` for this client, dropping the bag when it empties. */
function clearInFlight(client, sessionId) {
  const set = inFlight.get(client)
  if (!set) return
  set.delete(sessionId)
  if (set.size === 0) inFlight.delete(client)
}

/** Build the degraded reply used by every non-survey path. */
function degraded({ requestId, sessionId, reason, now = new Date() }) {
  return {
    type: 'session_pr_status',
    requestId,
    sessionId: sessionId ?? null,
    generatedAt: now.toISOString(),
    branch: null,
    repo: null,
    pr: null,
    checks: null,
    merge: null,
    reason,
  }
}

/**
 * Handle `session_pr_status_request`.
 *
 * @param {WebSocket} ws
 * @param {object} client
 * @param {object} msg
 * @param {object} ctx
 */
export async function handleSessionPrStatusRequest(ws, client, msg, ctx) {
  const requestId = typeof msg?.requestId === 'string' ? msg.requestId : null
  const targetSessionId = (typeof msg?.sessionId === 'string' && msg.sessionId.length > 0)
    ? msg.sessionId
    : (client?.activeSessionId ?? null)

  // Authority first — before any lookup, so the reply cannot reveal existence.
  if (client?.boundSessionId && client.boundSessionId !== targetSessionId) {
    ctx.transport.send(ws, degraded({ requestId, sessionId: targetSessionId, reason: NOT_AUTHORIZED_REASON }))
    return
  }

  const entry = ctx.sessions?.sessionManager?.getSession?.(targetSessionId) ?? null
  if (!entry) {
    ctx.transport.send(ws, degraded({ requestId, sessionId: targetSessionId, reason: NO_SESSION_REASON }))
    return
  }

  if (isInFlight(client, targetSessionId)) {
    ctx.transport.send(ws, degraded({ requestId, sessionId: targetSessionId, reason: IN_PROGRESS_REASON }))
    return
  }

  // Tests can inject `ctx.surveySessionPrStatus` to stub the survey, matching the
  // `ctx.surveyRepos` seam the Control Room handlers use — so a handler test
  // never shells out to real git/gh.
  const surveyFn = typeof ctx?.surveySessionPrStatus === 'function' ? ctx.surveySessionPrStatus : surveySessionPrStatus

  markInFlight(client, targetSessionId)
  try {
    const snapshot = await surveyFn({ sessionId: targetSessionId, cwd: entry.cwd })
    ctx.transport.send(ws, { type: 'session_pr_status', requestId, ...snapshot })
    // #7427: arm the CI watcher off the reading we just paid for. Absent
    // whenever `sessionCi.watch` is off, and in ctx mocks that do not wire it.
    try {
      ctx.services?.sessionCiWatcher?.observe?.(targetSessionId, snapshot)
    } catch (err) {
      log.warn(`session_pr_status_request: ci-watch observe failed: ${getErrorMessage(err, 'unknown error')}`)
    }
  } catch (err) {
    // surveySessionPrStatus degrades environmental failures itself, so reaching
    // here means a genuine defect — log it, and still answer.
    const message = getErrorMessage(err, 'unknown error')
    log.warn(`session_pr_status_request failed: ${message}`)
    ctx.transport.send(ws, degraded({
      requestId,
      sessionId: targetSessionId,
      reason: `pull-request status survey failed: ${message}`,
    }))
  } finally {
    clearInFlight(client, targetSessionId)
  }
}

export const sessionPrStatusHandlers = {
  session_pr_status_request: handleSessionPrStatusRequest,
}
