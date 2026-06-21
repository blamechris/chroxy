/**
 * Control Room v2 — shared factories for the Host/Repo status WS handlers.
 *
 * The control-room handlers all share two skeletons that were copied ~11× and
 * ~7× respectively. This module captures the *control flow* once so each handler
 * only contributes its own snapshot shapes + survey call:
 *
 *   - {@link makeSurveyHandler} — the async read-only survey handlers
 *     (host/runner/containers/repo-runtime/byok-pool/host-prune/simulator/
 *     emulator/wsl/integration/skills-inventory). Every one ran the same
 *     requestId-parse → host-authority gate → per-client in-flight guard →
 *     try/survey/reply → catch/log/degrade → finally/release skeleton.
 *   - {@link makeActionError} — the `*_ACTION_FAILED` `session_error` builders
 *     (integration/container/byok-pool/host-prune/simulator/emulator/wsl), which
 *     were identical apart from the `code` and the echoed correlation fields.
 *
 * The factories own ONLY the boilerplate; each handler's snapshot/reply shapes,
 * survey seams, and security-sensitive ordering stay in the call site so the
 * refactor is behaviour-preserving.
 */
import { createLogger } from '../logger.js'
import { getErrorMessage } from '../utils/error-message.js'

const log = createLogger('ws')

/** Parse the optional correlation id off a request, normalising to null. */
export function requestIdOf(msg) {
  return typeof msg?.requestId === 'string' ? msg.requestId : null
}

/**
 * Build an async read-only survey handler with the shared host-authority +
 * per-client in-flight + degraded-reply contract.
 *
 * Each survey supplies snapshot-shaping closures rather than control flow:
 *
 * @param {object} opts
 * @param {WeakSet} opts.inFlight   - per-client in-flight guard (one survey/client).
 * @param {string}  opts.logName    - request type, used in the failure log line.
 * @param {(args:{ctx:object,msg:object}) => any} [opts.prepare]
 *        Optional pre-gate computation (e.g. resolving the discovery root from
 *        config) whose result is threaded to every closure as `prep`. Runs
 *        BEFORE the authority gate — so it must read only non-sensitive config
 *        (the same ordering the hand-written handlers used). Security note: do
 *        NOT compute host-only secrets here; a session-bound client reaches the
 *        FORBIDDEN reply, so anything in `prep` may surface to it.
 * @param {(args:{ctx,msg,requestId,prep}) => object} opts.forbidden
 *        Degraded snapshot for a session-bound (unauthorised) client.
 * @param {(args:{ctx,msg,requestId,prep}) => object} opts.inProgress
 *        Degraded snapshot when a survey is already in flight for this client.
 * @param {(args:{ctx,msg,requestId,prep,err}) => object} opts.failed
 *        Degraded snapshot when the survey throws.
 * @param {(args:{ctx,msg,requestId,prep}) => Promise<object>} opts.run
 *        Runs the survey and returns the success reply (the factory sends it).
 * @returns {(ws, client, msg, ctx) => Promise<void>}
 */
export function makeSurveyHandler({ inFlight, logName, prepare, forbidden, inProgress, failed, run }) {
  return async function surveyHandler(ws, client, msg, ctx) {
    const requestId = requestIdOf(msg)
    const prep = prepare ? prepare({ ctx, msg }) : null
    const args = { ctx, msg, requestId, prep }

    // Authority gate: a host-wide survey is for host-level (unbound) clients
    // only — a pairing-bound (share-a-session) token is scoped to one session.
    if (client?.boundSessionId) {
      ctx.transport.send(ws, forbidden(args))
      return
    }

    // In-flight guard: one survey per client at a time.
    if (inFlight.has(client)) {
      ctx.transport.send(ws, inProgress(args))
      return
    }

    inFlight.add(client)
    try {
      ctx.transport.send(ws, await run(args))
    } catch (err) {
      log.warn(`${logName} failed: ${getErrorMessage(err, 'unknown error')}`)
      ctx.transport.send(ws, failed({ ...args, err }))
    } finally {
      inFlight.delete(client)
    }
  }
}

/**
 * Build a synchronous host-survey handler for the in-memory snapshots
 * (mailbox / external-sessions) that read only SessionManager state — no
 * git/gh survey, so no in-flight guard. Shares the host-authority + degraded-
 * reply contract: a session-bound client gets a schema-valid empty snapshot
 * carrying an additive `error` so the view renders the refusal rather than
 * spinning.
 *
 * @param {object} opts
 * @param {string} opts.type             - the snapshot message type.
 * @param {object} opts.emptyFields      - the snapshot's zeroed data fields
 *        (e.g. `{ registrations: [], recentEvents: [] }`); they back the
 *        FORBIDDEN reply and are overwritten by `resolve` on the success path.
 * @param {string} opts.forbiddenMessage - the FORBIDDEN error message.
 * @param {(ctx:object) => object} opts.resolve
 *        Returns the real data fields to spread over `emptyFields` for a
 *        host-level client.
 * @returns {(ws, client, msg, ctx) => void}
 */
export function makeSyncHostSurvey({ type, emptyFields, forbiddenMessage, resolve }) {
  return function syncHostSurvey(ws, client, msg, ctx) {
    const base = { type, requestId: requestIdOf(msg), generatedAt: new Date().toISOString(), ...emptyFields }
    if (client?.boundSessionId) {
      ctx.transport.send(ws, { ...base, error: { code: 'FORBIDDEN', message: forbiddenMessage } })
      return
    }
    ctx.transport.send(ws, { ...base, ...resolve(ctx) })
  }
}

/**
 * Build a `*_ACTION_FAILED` `session_error` reply function. Mirrors how the
 * CANCEL_ACTIVITY_FAILED session_error is built in input-handlers.js: a
 * `session_error` envelope with a stable `code`, a `reason` discriminator, and
 * the request's correlation fields echoed so the dashboard can clear the exact
 * row's pending state.
 *
 * @param {string} code - the stable `*_ACTION_FAILED` code.
 * @param {(msg:object) => object} correlate
 *        Returns the action-specific correlation fields to echo (e.g.
 *        `{ action, repoPath, runId }`). `requestId` is always appended.
 * @returns {(ws, ctx, msg, reason, message) => void}
 */
export function makeActionError(code, correlate) {
  return function actionError(ws, ctx, msg, reason, message) {
    ctx.transport.send(ws, {
      type: 'session_error',
      code,
      message,
      reason,
      ...correlate(msg),
      requestId: requestIdOf(msg),
    })
  }
}
