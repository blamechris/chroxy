/**
 * Session PR → unresolved review-thread count handler (#7430).
 *
 * One request type, one reply type:
 *
 *   session_pr_threads_request → session_pr_threads
 *
 * A deliberate SECOND pair beside `session_pr_status_request`, rather than a
 * flag on it. Since #7426 the status survey runs on a daemon-side sweep across
 * every session; the count needs a GraphQL read that survey cannot serve, so
 * folding it in would put an extra `gh` subprocess on every tick of a
 * background poll to enrich a string only a click builds. This pair is sent by
 * the click and never by the sweep. (See session-pr-threads.js for the full
 * rationale, and the schema comment for the field contracts.)
 *
 * ## Same authority shape as its sibling
 *
 * SESSION-scoped, exactly like `session_pr_status_request`: this answers a
 * question the bound client legitimately has about its OWN session, so a
 * pairing-bound token may ask about the session it is bound to and nothing
 * else. The authority check runs BEFORE the session lookup, so a bound client
 * cannot use the difference between "not authorised" and "not found" to probe
 * which session ids exist (docs/security/bearer-token-authority.md §4).
 *
 * NOTE the binding check below duplicates the one in `handler-utils.js`'s
 * `resolveSession` for the same reason its sibling does: `resolveSession`
 * collapses "not authorised" and "not found" into a single `null`, and this
 * handler must keep them apart AND check authority first.
 *
 * ## Always a count-shaped answer, never a spinner and never a zero
 *
 * Every path — unauthorised, unknown session, throttled, already running,
 * survey failure — replies with a schema-valid `session_pr_threads` carrying a
 * `reason` and a NULL count. Both halves matter: a path that replied with
 * nothing leaves a caller unable to tell "still counting" from "never
 * answered", and a refusal that came back as `unresolvedCount: 0` would be
 * indistinguishable from a real zero — the false green the issue was filed
 * against.
 *
 * ## Throttled, because a click costs subprocesses
 *
 * The read spawns `git` + `gh pr list` (resolution, delegated) + `gh api
 * graphql` (the count). `isInFlight` bars CONCURRENT counts per client;
 * `COUNT_MIN_INTERVAL_MS` bounds back-to-back ones across clients, answering a
 * throttled request by REPLAYING the last completed count rather than
 * degrading — a degraded reply would blank a count the user is looking at, with
 * nothing scheduled to repair it. The window/replay/rollback machinery is
 * shared with the status handler via `survey-throttle.js`; it is not a second
 * copy of it.
 *
 * Unlike its sibling this endpoint is READ-ONLY — nothing here arms a watcher
 * or mutates daemon state.
 */
import { surveySessionPrThreads } from '../session-pr-threads.js'
import { createSurveyThrottle } from './survey-throttle.js'
import { createLogger } from '../logger.js'
import { getErrorMessage } from '../utils/error-message.js'

const log = createLogger('ws')

/** Reason when a bound client asks about a session it is not bound to. */
export const NOT_AUTHORIZED_REASON = 'not authorized to view this session\'s review threads'

/** Reason when the requested (or active) session id resolves to nothing. */
export const NO_SESSION_REASON = 'no such session'

/** Reason when this client already has a count running for this session. */
export const IN_PROGRESS_REASON = 'a review-thread count is already running for this client'

/**
 * Reason when a throttled request arrives before ANY count has been cached for
 * the session — the one unreplayable case: some other client's very first count
 * is still in flight. Every later throttled request replays the cached count
 * instead, because the throttle exists to bound subprocesses, not to punish the
 * click (#7445's review of the sibling handler).
 */
export const RATE_LIMITED_REASON = 'review threads were counted moments ago — retry in a few seconds'

/**
 * Minimum interval between counts of ONE session, across all clients.
 *
 * Matched to the sibling survey's five seconds deliberately: the two are
 * triggered by the same clicks (Refresh fires both), so a different window
 * would make one of them silently the slower path and the pair would disagree
 * about how fresh "just now" is. Five seconds keeps a Refresh useful to someone
 * actually waiting on a review while bounding the `gh` fan-out.
 *
 * Per SESSION, not per (client, session): a pairing-bound token is
 * authoritative for its own session, so there are no token classes to keep
 * apart, and a per-client stamp would let N clients multiply the cost N-fold.
 *
 * Tests drive the clock through the `ctx._nowMs` seam — the one flat
 * test-injection field this handler reads; production takes `Date.now()`.
 */
export const COUNT_MIN_INTERVAL_MS = 5_000

/** This handler's own throttle instance (see survey-throttle.js). */
const countThrottle = createSurveyThrottle()

/**
 * One count per (client, session) at a time.
 *
 * Keyed on the SESSION as well as the client for the reason #7445 established
 * on the sibling: a client-global guard conflates "spamming Refresh" with
 * "switched tabs mid-count", and the second is not abuse — it left the new
 * tab's chip refused on account of the old one's, with nothing to retry it.
 */
const inFlight = new WeakMap()

/** True when this client already has a count running for `sessionId`. */
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

/**
 * Build the degraded reply used by every non-count path.
 *
 * The three count fields are pinned NULL/false here rather than defaulted,
 * which is the whole safety property: there is no code path in this file that
 * can emit a zero it did not count.
 */
function degraded({ requestId, sessionId, reason, now = new Date() }) {
  return {
    type: 'session_pr_threads',
    requestId,
    sessionId: sessionId ?? null,
    countedAt: now.toISOString(),
    prNumber: null,
    unresolvedCount: null,
    totalCount: null,
    truncated: false,
    reason,
  }
}

/**
 * Handle `session_pr_threads_request`.
 *
 * @param {WebSocket} ws
 * @param {object} client
 * @param {object} msg
 * @param {object} ctx
 */
export async function handleSessionPrThreadsRequest(ws, client, msg, ctx) {
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

  // Checked AFTER the in-flight guard so a concurrent duplicate keeps its more
  // specific reason, and the window is only stamped when a count actually
  // starts — a replayed or refused request must not extend it.
  const manager = ctx.sessions?.sessionManager
  const nowMs = typeof ctx._nowMs === 'function' ? ctx._nowMs() : Date.now()
  const sendCount = (snapshot) => {
    ctx.transport.send(ws, { type: 'session_pr_threads', requestId, ...snapshot })
  }
  const gate = countThrottle.open(manager, targetSessionId, nowMs, COUNT_MIN_INTERVAL_MS)
  if (!gate.admitted) {
    // Never downgrade a usable answer: the cached count goes out under THIS
    // request's id, with its original `countedAt` — honest about when it was
    // taken. Only before the first completed count is there nothing to replay.
    if (gate.cached) sendCount(gate.cached)
    else ctx.transport.send(ws, degraded({ requestId, sessionId: targetSessionId, reason: RATE_LIMITED_REASON }))
    return
  }

  // Tests inject `ctx.surveySessionPrThreads` to stub the count, matching the
  // `ctx.surveySessionPrStatus` seam its sibling uses — so a handler test never
  // shells out to real git/gh.
  const surveyFn = typeof ctx?.surveySessionPrThreads === 'function' ? ctx.surveySessionPrThreads : surveySessionPrThreads

  markInFlight(client, targetSessionId)
  try {
    const snapshot = await surveyFn({ sessionId: targetSessionId, cwd: entry.cwd })
    // #7469 S1: cache ONLY a reading that actually carries a count. #7445's
    // "replay, don't degrade" does not help when the replayed thing is itself a
    // degradation — one transient `gh api graphql` failure would be handed to
    // every client of this session for the whole window, long after the
    // condition cleared. The requester that paid for the failed read still gets
    // it below, under its own request id; the CACHE keeps the last good count.
    //
    // The window is still STAMPED (that happened in `open()`): a read that
    // reached `gh` spent the budget the throttle protects, whatever it came
    // back with. Only a THROWN survey, which never got that far, rolls back.
    if (snapshot?.reason == null && snapshot?.unresolvedCount != null) gate.commit(snapshot)
    sendCount(snapshot)
  } catch (err) {
    // A thrown count did not spend the subprocess budget the throttle protects,
    // and the retry the user reaches for next must not be refused for it. The
    // rollback is compare-and-restore inside the throttle, so a newer client's
    // stamp survives this one's late failure.
    gate.rollback()
    // surveySessionPrThreads degrades environmental failures itself, so reaching
    // here means a genuine defect — log it, and still answer.
    const message = getErrorMessage(err, 'unknown error')
    log.warn(`session_pr_threads_request failed: ${message}`)
    ctx.transport.send(ws, degraded({
      requestId,
      sessionId: targetSessionId,
      reason: `review-thread count failed: ${message}`,
    }))
  } finally {
    clearInFlight(client, targetSessionId)
  }
}

export const sessionPrThreadsHandlers = {
  session_pr_threads_request: handleSessionPrThreadsRequest,
}
