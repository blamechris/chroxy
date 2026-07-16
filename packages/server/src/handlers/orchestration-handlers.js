/**
 * WS handlers for the orchestration/delegation harness ("committee", epic
 * #6691, delivery step S-2). This is the SERVER SURFACE: it routes the six
 * client->server messages to the engine (`ctx.services.orchestrationManager`,
 * wired for real in E-4) and enforces the auth posture. The engine is driven
 * through a small interface so this layer is testable against a stub.
 *
 * Auth posture (docs/security/bearer-token-authority.md):
 *  - Every handler is FLAG-gated: a silent no-op when the orchestration feature
 *    is off (fail-closed; the IDE-handlers pattern, so a runtime flag flip needs
 *    no re-registration).
 *  - Host authority: runs are host-wide cross-session objects, so a
 *    session-bound (share-a-session) token is rejected — unbound clients only.
 *  - Strict-primary (`client.isPrimaryToken`) for `orchestration_run_start` and
 *    for a spend-unblocking gate approval (approve on epic_plan / budget_overrun):
 *    these spawn write-capable worker sessions, the same escalation class as
 *    user-shell creation.
 *  - `orchestration_run_start` validates its cwd against the allowlist —
 *    SessionManager.createSession does NOT, so an in-process orchestrator must.
 */

import { createLogger } from '../logger.js'
import { isOrchestrationEnabled } from '../config.js'
import { validateCwdAllowed } from '../handler-utils.js'
import { makeSurveyHandler, makeActionError } from '../control-room/handler-factory.js'
import { getErrorMessage } from '../utils/error-message.js'

const log = createLogger('ws')

// Per-client in-flight guards (WeakSet — GC'd with the client, no cleanup path).
const runsInFlight = new WeakSet()
const detailInFlight = new WeakSet()

const orchestrationActionError = makeActionError('ORCHESTRATION_ACTION_FAILED', (msg) => ({
  runId: msg.runId ?? null,
  gateId: msg.gateId ?? null,
  action: msg.action ?? msg.decision ?? null,
}))

const nowIso = () => new Date().toISOString()
const enabled = (ctx) => isOrchestrationEnabled(ctx?.services?.config)
const manager = (ctx) => ctx?.services?.orchestrationManager || null

function requestIdOf(msg) {
  return typeof msg?.requestId === 'string' ? msg.requestId : undefined
}

// -- surveys (pull snapshots) ----------------------------------------------

const runsSurvey = makeSurveyHandler({
  inFlight: runsInFlight,
  logName: 'orchestration_runs_request',
  forbidden: ({ requestId }) => ({
    type: 'orchestration_runs_snapshot', generatedAt: nowIso(), runs: [],
    error: { code: 'host_authority_required', message: 'orchestration is host-level; a session-bound token cannot list runs' },
    requestId: requestId ?? null,
  }),
  inProgress: ({ requestId }) => ({
    type: 'orchestration_runs_snapshot', generatedAt: nowIso(), runs: [],
    error: { code: 'in_progress', message: 'a runs request is already in flight' }, requestId: requestId ?? null,
  }),
  failed: ({ requestId, err }) => ({
    type: 'orchestration_runs_snapshot', generatedAt: nowIso(), runs: [],
    error: { code: 'survey_failed', message: getErrorMessage(err, 'unknown error') }, requestId: requestId ?? null,
  }),
  run: async ({ ctx, requestId }) => {
    const mgr = manager(ctx)
    const runs = mgr ? await mgr.listRuns() : []
    return { type: 'orchestration_runs_snapshot', generatedAt: nowIso(), runs, requestId: requestId ?? null }
  },
})

const detailSurvey = makeSurveyHandler({
  inFlight: detailInFlight,
  logName: 'orchestration_run_detail_request',
  forbidden: ({ requestId }) => ({
    type: 'orchestration_run_snapshot', generatedAt: nowIso(), seq: 0, run: null,
    error: { code: 'host_authority_required', message: 'orchestration is host-level; a session-bound token cannot read a run' },
    requestId: requestId ?? null,
  }),
  inProgress: ({ requestId }) => ({
    type: 'orchestration_run_snapshot', generatedAt: nowIso(), seq: 0, run: null,
    error: { code: 'in_progress', message: 'a run-detail request is already in flight' }, requestId: requestId ?? null,
  }),
  failed: ({ requestId, err }) => ({
    type: 'orchestration_run_snapshot', generatedAt: nowIso(), seq: 0, run: null,
    error: { code: 'survey_failed', message: getErrorMessage(err, 'unknown error') }, requestId: requestId ?? null,
  }),
  run: async ({ ctx, msg, requestId }) => {
    const mgr = manager(ctx)
    const snap = mgr ? await mgr.getRunSnapshot(msg.runId) : null
    if (!snap || !snap.run) {
      return {
        type: 'orchestration_run_snapshot', generatedAt: nowIso(), seq: 0, run: null,
        error: { code: 'not_found', message: `run ${msg.runId} not found` }, requestId: requestId ?? null,
      }
    }
    return { type: 'orchestration_run_snapshot', generatedAt: nowIso(), seq: snap.seq ?? 0, run: snap.run, requestId: requestId ?? null }
  },
})

function orchestration_runs_request(ws, client, msg, ctx) {
  if (!enabled(ctx)) return // silent no-op when the feature is off
  return runsSurvey(ws, client, msg, ctx)
}

function orchestration_run_detail_request(ws, client, msg, ctx) {
  if (!enabled(ctx)) return
  return detailSurvey(ws, client, msg, ctx)
}

// -- action helpers --------------------------------------------------------

// Host-authority + optional strict-primary gate. Returns true if the request
// may proceed; otherwise sends a session_error and returns false.
function guardAction(ws, client, msg, ctx, { requirePrimary = false } = {}) {
  if (client?.boundSessionId) {
    orchestrationActionError(ws, ctx, msg, 'forbidden', 'orchestration is host-level; a session-bound token cannot drive runs')
    return false
  }
  if (requirePrimary && client?.isPrimaryToken !== true) {
    orchestrationActionError(ws, ctx, msg, 'primary_token_required', 'this action requires the primary token (it can spawn write-capable worker sessions)')
    return false
  }
  const mgr = manager(ctx)
  if (!mgr) {
    orchestrationActionError(ws, ctx, msg, 'unavailable', 'the orchestration engine is not running on this server')
    return false
  }
  return true
}

function sendAck(ws, ctx, msg, action, runId, gateId) {
  ctx.transport.send(ws, {
    type: 'orchestration_action_ack',
    action,
    runId,
    ...(gateId ? { gateId } : {}),
    requestId: requestIdOf(msg) ?? null,
  })
}

// A gate approval that unblocks spend requires the primary token.
function gateNeedsPrimary(msg) {
  return msg?.decision === 'approve'
}

// -- actions ----------------------------------------------------------------

function orchestration_run_start(ws, client, msg, ctx) {
  if (!enabled(ctx)) return
  if (!guardAction(ws, client, msg, ctx, { requirePrimary: true })) return
  // cwd allowlist — createSession does NOT enforce it, so the surface must.
  // validateCwdAllowed RETURNS an error string (falsy = allowed), it does not throw.
  const cwdError = validateCwdAllowed(msg.cwd, ctx.services.config)
  if (cwdError) {
    orchestrationActionError(ws, ctx, msg, 'invalid-cwd', cwdError)
    return
  }
  Promise.resolve()
    .then(() => manager(ctx).startRun({
      title: msg.title ?? null,
      goal: msg.epicPrompt ?? null,
      preset: msg.preset ?? null,
      cwd: msg.cwd,
      budgetUsd: msg.budgetUsd ?? null,
      autoApprovePlan: msg.autoApprovePlan === true,
      roleOverrides: msg.roles ?? null,
    }))
    .then((run) => sendAck(ws, ctx, msg, 'start', run?.runId ?? null))
    .catch((err) => {
      log.warn(`orchestration_run_start failed: ${getErrorMessage(err, 'unknown')}`)
      orchestrationActionError(ws, ctx, msg, 'start-failed', getErrorMessage(err, 'failed to start run'))
    })
}

function orchestration_gate_response(ws, client, msg, ctx) {
  if (!enabled(ctx)) return
  if (!guardAction(ws, client, msg, ctx, { requirePrimary: gateNeedsPrimary(msg) })) return
  Promise.resolve()
    .then(() => manager(ctx).resolveGate(msg.runId, msg.gateId, {
      decision: msg.decision, note: msg.note ?? null, budgetUsd: msg.budgetUsd ?? null,
    }))
    .then(() => sendAck(ws, ctx, msg, 'gate_response', msg.runId, msg.gateId))
    .catch((err) => orchestrationActionError(ws, ctx, msg, 'gate-failed', getErrorMessage(err, 'failed to resolve gate')))
}

function orchestration_run_action(ws, client, msg, ctx) {
  if (!enabled(ctx)) return
  if (!guardAction(ws, client, msg, ctx)) return
  Promise.resolve()
    .then(() => manager(ctx).runAction(msg.runId, msg.action))
    .then(() => sendAck(ws, ctx, msg, msg.action, msg.runId))
    .catch((err) => orchestrationActionError(ws, ctx, msg, 'action-failed', getErrorMessage(err, `failed to ${msg.action} run`)))
}

function orchestration_run_annotate(ws, client, msg, ctx) {
  if (!enabled(ctx)) return
  if (!guardAction(ws, client, msg, ctx)) return
  Promise.resolve()
    .then(() => manager(ctx).annotate(msg.runId, {
      baselineSessionId: msg.baselineSessionId ?? null, verdictQuality: msg.verdictQuality ?? undefined,
    }))
    .then(() => sendAck(ws, ctx, msg, 'annotate', msg.runId))
    .catch((err) => orchestrationActionError(ws, ctx, msg, 'annotate-failed', getErrorMessage(err, 'failed to annotate run')))
}

export const orchestrationHandlers = {
  orchestration_runs_request,
  orchestration_run_detail_request,
  orchestration_run_start,
  orchestration_gate_response,
  orchestration_run_action,
  orchestration_run_annotate,
}
