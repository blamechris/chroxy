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
 * One survey per client at a time. `gh` + git spawn subprocesses, so an
 * un-guarded client could fan out a subprocess per click; the guard is keyed on
 * the client object (a WeakSet, so a disconnected client is collected).
 */
const inFlight = new WeakSet()

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

  if (inFlight.has(client)) {
    ctx.transport.send(ws, degraded({ requestId, sessionId: targetSessionId, reason: IN_PROGRESS_REASON }))
    return
  }

  // Tests can inject `ctx.surveySessionPrStatus` to stub the survey, matching the
  // `ctx.surveyRepos` seam the Control Room handlers use — so a handler test
  // never shells out to real git/gh.
  const surveyFn = typeof ctx?.surveySessionPrStatus === 'function' ? ctx.surveySessionPrStatus : surveySessionPrStatus

  inFlight.add(client)
  try {
    const snapshot = await surveyFn({ sessionId: targetSessionId, cwd: entry.cwd })
    ctx.transport.send(ws, { type: 'session_pr_status', requestId, ...snapshot })
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
    inFlight.delete(client)
  }
}

export const sessionPrStatusHandlers = {
  session_pr_status_request: handleSessionPrStatusRequest,
}
