/**
 * #5547 — `summarize_session` WS handler.
 *
 * Produces a model-written continuation brief from a session's PERSISTED
 * history (works even when the provider subprocess is gone — history is the
 * source, not the live session) and replies with a single
 * `summarize_session_result`. Failures surface as exactly one
 * `SUMMARIZE_FAILED` session_error.
 *
 * Mirrors the `integration_action` correlation discipline (control-room-
 * handlers.js): requestId echoed on success and failure, a per-session
 * in-flight guard rejects concurrent summarize for the same session, and
 * authority is checked BEFORE any work.
 *
 * Authority (docs/security/bearer-token-authority.md): the brief exposes a
 * session's conversation, so it is served only to clients that could ALREADY
 * read that session's history — a HOST-level (unbound) client, OR a client
 * bound to THIS session. A client bound to a DIFFERENT session is rejected
 * (it must not read across the boundary). This is the mirror of the
 * conversation-handlers session-binding check, widened to also admit host
 * clients.
 *
 * Cost: summarization runs a real (one-shot) model turn. It is initiated only
 * by an authorized operator click, so no rate-limit beyond the in-flight guard;
 * the burn surfaces honestly via the provider's normal usage accounting.
 */
import { createLogger } from '../logger.js'
import { summarizeSession as defaultSummarizeSession } from '../summarize-session.js'

const log = createLogger('ws')

/**
 * Per-session in-flight guard. A plain Set keyed by sessionId (a string), with
 * entries explicitly deleted in the handler's `finally`. Concurrent summarize
 * requests for the SAME session are rejected; different sessions proceed
 * independently.
 */
const summarizeInFlight = new Set()

/**
 * Single SUMMARIZE_FAILED reply builder. Mirrors INTEGRATION_ACTION_FAILED:
 * a `session_error` envelope with a stable `code`, a `reason` discriminator,
 * and the correlation fields (`sessionId` / `requestId`) echoed. NEVER leaks
 * token/key material — `message` is a curated, provider-agnostic string.
 */
function summarizeError(ws, ctx, sessionId, requestId, reason, message) {
  ctx.transport.send(ws, {
    type: 'session_error',
    code: 'SUMMARIZE_FAILED',
    message,
    reason,
    sessionId: typeof sessionId === 'string' ? sessionId : null,
    requestId: typeof requestId === 'string' ? requestId : null,
  })
}

async function handleSummarizeSession(ws, client, msg, ctx) {
  const sessionId = typeof msg?.sessionId === 'string' ? msg.sessionId : ''
  const requestId = typeof msg?.requestId === 'string' ? msg.requestId : null

  if (!sessionId) {
    summarizeError(ws, ctx, null, requestId, 'invalid-session-id',
      'summarize_session requires a non-empty sessionId')
    return
  }

  // Authority gate: host-level (unbound) clients OR a client bound to THIS
  // session. A client bound to a DIFFERENT session cannot read across the
  // boundary, so it is rejected. (Authentication itself is already enforced
  // before dispatch in ws-server._handleMessage.)
  if (client?.boundSessionId && client.boundSessionId !== sessionId) {
    summarizeError(ws, ctx, sessionId, requestId, 'forbidden',
      'Not authorized: client is bound to a different session')
    return
  }

  const entry = ctx.sessions.sessionManager?.getSession?.(sessionId)
  if (!entry) {
    summarizeError(ws, ctx, sessionId, requestId, 'unknown-session',
      `Session not found: ${sessionId}`)
    return
  }

  // Per-session in-flight guard: reject a concurrent summarize for the same
  // session (the model turn is expensive; one at a time).
  if (summarizeInFlight.has(sessionId)) {
    summarizeError(ws, ctx, sessionId, requestId, 'summarize-in-progress',
      'A summary is already being generated for this session')
    return
  }

  // History is the universal source — read it even if the provider subprocess
  // is gone. getHistory is the synchronous ring-buffer read.
  let history
  try {
    history = ctx.sessions.sessionManager.getHistory(sessionId)
  } catch (err) {
    // Curated, fixed message — never echo the raw error onto the wire. The raw
    // text is logged server-side only (a thrown history-read error could carry
    // internal paths or unexpected text; keep the SUMMARIZE_FAILED surface
    // leak-safe, matching the model-call failure path below).
    log.warn(`summarize_session history read failed for ${sessionId}: ${err && err.message ? err.message : 'unknown error'}`)
    summarizeError(ws, ctx, sessionId, requestId, 'history-failed',
      'Could not read this session\'s history')
    return
  }

  // Resolve the summarizer model: config override wins, else the session's own
  // model. `summarize.provider` is accepted in config for forward-compat but
  // the one-shot path runs through the SDK provider regardless; only the model
  // id is threaded through here.
  const config = ctx?.services?.config || {}
  const summarizeCfg = config.summarize && typeof config.summarize === 'object' ? config.summarize : {}
  const overrideModel = typeof summarizeCfg.model === 'string' && summarizeCfg.model.length > 0
    ? summarizeCfg.model
    : null
  const sessionModel = entry.session && typeof entry.session.model === 'string' ? entry.session.model : null
  const model = overrideModel || sessionModel || undefined

  // Test seam: ctx.summarizeSession lets tests stub the model call without a
  // live provider. Production falls through to the real implementation.
  const summarizeFn = typeof ctx?.summarizeSession === 'function' ? ctx.summarizeSession : defaultSummarizeSession

  summarizeInFlight.add(sessionId)
  try {
    const { summary, truncated } = await summarizeFn({
      history,
      model,
      cwd: entry.cwd,
      sessionName: entry.name,
    })
    log.info(`summarize_session completed for ${sessionId} (client=${client?.id}, truncated=${truncated})`)
    ctx.transport.send(ws, {
      type: 'summarize_session_result',
      sessionId,
      summary,
      truncated: Boolean(truncated),
      requestId,
    })
  } catch (err) {
    // Curated, provider-agnostic message — NEVER echo raw provider/API error
    // text (could leak key fragments, endpoints, or auth headers). Use the
    // thrown reason for the discriminator and a fixed message per reason.
    const reason = err && typeof err.reason === 'string' && err.reason.length > 0 ? err.reason : 'summarize-failed'
    const message = messageForReason(reason)
    log.warn(`summarize_session failed for ${sessionId}: reason=${reason} (${err && err.message ? err.message : 'unknown error'})`)
    summarizeError(ws, ctx, sessionId, requestId, reason, message)
  } finally {
    summarizeInFlight.delete(sessionId)
  }
}

/**
 * Curated user-facing message per failure reason. Keeping the message a fixed
 * string (not the raw error) is the leak guard: provider/API errors can carry
 * key fragments or endpoints, which must never reach the client.
 */
function messageForReason(reason) {
  switch (reason) {
    case 'empty-history':
      return 'This session has no conversation to summarize yet'
    case 'empty-summary':
      return 'The summarizer returned no text — try again'
    default:
      return 'Could not summarize this session — the model call failed'
  }
}

export const summarizeHandlers = {
  summarize_session: handleSummarizeSession,
}
