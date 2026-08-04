/**
 * Scheduled-tasks WS handlers (#6871, epic #6784) — the server half of the
 * dashboard scheduled-tasks panel, and the GUI counterpart to the
 * `chroxy schedule` CLI (#6868).
 *
 * Handles: scheduled_tasks_request (read), scheduled_task_action (CRUD),
 * set_scheduler_enabled (the global gate).
 *
 * ── Authority (the crux) ──────────────────────────────────────────────────────
 * A scheduled task is a standing arrangement for this machine to run an agent
 * session WITH NOBODY WATCHING. Creating one is therefore in the same
 * escalation class as adding an MCP server ("a configured MCP server is a
 * command this machine will run", #6974/#7001) or creating a `user-shell`
 * session: it causes future host-side execution the requester will not be
 * present to supervise. Every MUTATION here is consequently gated on the STRICT
 * PRIMARY token class AND on being unbound (`client.isPrimaryToken === true &&
 * !client.boundSessionId`) — a superset of, not an alternative to, the weaker
 * "any unbound client" host-authority bar, because an ordinary paired phone
 * holds an unbound linking-mode pairing token and must not be able to schedule
 * unattended execution. See docs/security/bearer-token-authority.md.
 *
 * Per the #6998 house pattern there is NO shared cross-surface reject helper:
 * each surface defines its own local one so the error CODE names the surface
 * that refused (`rejectMutationIfBound` in file-handlers.js,
 * `rejectCredentialWriteIfBound` in credential-handlers.js,
 * `rejectMcpConfigWriteUnlessPrimary` in settings-handlers.js, `guardAction` in
 * orchestration-handlers.js). Ours is `rejectSchedulerWriteUnlessPrimary` with
 * `SCHEDULER_FORBIDDEN_NON_PRIMARY_CLIENT`.
 *
 * The READ (`scheduled_tasks_request`) is deliberately NOT primary-gated: it is
 * host-level but non-mutating, and it is the read that lets the panel warn an
 * operator that the gate is closed or that a task will never fire. It follows
 * the Control Room surveys' bar — host-level authority, i.e. an UNBOUND client
 * (`client.boundSessionId` unset) — because the registry spans every repo/session
 * on the host and a pairing-BOUND (share-one-session) client must not receive it.
 *
 * ── Honest status ─────────────────────────────────────────────────────────────
 * This handler never computes a health verdict of its own. It ships the raw
 * record plus the ANSWERS from the engine's own exported helpers —
 * `scheduledProviderRefusalReason()`, `resolveScheduledPermissionMode()`,
 * `listSchedulableProviders()` and `SchedulerEngine.quarantinedTaskIds` — so the
 * panel renders the engine's real verdict instead of a second guess at it. The
 * health TAG is derived from the shared `@chroxy/protocol` helper that the CLI
 * uses, so the two surfaces cannot drift.
 */

import { createLogger, sessionLogger } from '../logger.js'
import { isSchedulerEnabled, writeSchedulerEnabledToConfig } from '../config.js'
import { DEFAULT_PROVIDER } from '../providers.js'
import {
  listSchedulableProviders,
  resolveScheduledPermissionMode,
  scheduledProviderRefusalReason,
} from '../scheduler.js'
import { ScheduledTaskValidationError } from '../scheduled-task-store.js'
import { getErrorMessage } from '../utils/error-message.js'

const log = createLogger('ws')

/** Actions that only need a taskId (no `task` payload). */
const ID_ONLY_ACTIONS = new Set(['pause', 'resume', 'delete'])

/**
 * Send a scheduled-task failure envelope.
 *
 * Deliberately `session_error` (with `code` + `message` + the echoed
 * `requestId`) rather than `sendError`'s `{ type: 'error' }` frame: the
 * dashboard correlates this panel's in-flight mutations by requestId inside its
 * `session_error` handler, exactly as the orchestration Runs surface does
 * (`makeActionError` in control-room/handler-factory.js emits this same shape).
 * Using one envelope for BOTH the authority rejections and the action failures
 * means every rejection releases the panel's pending state — a button that spins
 * forever because a refusal arrived on a frame the panel wasn't watching is its
 * own kind of dishonest status.
 */
function schedulerError(ws, ctx, msg, code, message) {
  ctx.transport.send(ws, {
    type: 'session_error',
    code,
    message,
    requestId: msg?.requestId ?? null,
  })
}

/**
 * MUTATION gate — require the STRICT PRIMARY token class before any validation,
 * store read, or config write.
 *
 * Rationale for strict-primary rather than the unbound-client bar used by the
 * credential-write / permission-rule / file-git gates: those reject only
 * `client.boundSessionId`, which leaves an ordinary paired phone (an unbound
 * linking-mode pairing token) with full authority. Scheduling unattended agent
 * execution on the host is the escalation class that checks
 * `client.isPrimaryToken === true` — the same tier as `user-shell` creation,
 * `terminal_input`, `revoke_token`, `orchestration_run_start` and MCP config
 * writes.
 *
 * The `boundSessionId` term keeps this gate strictly STRONGER than the read gate
 * below (#7025). Without it the two were asymmetric in the unsafe direction: a
 * bound + primary client was refused the harmless registry READ yet permitted
 * every MUTATION. That combination is not reachable over the wire today —
 * `ws-auth.js` derives `isPrimaryToken` as `!authRequired ||
 * !pairingManager?.isSessionTokenValid(token)`, so a session-bound token always
 * yields `false` — so this is defence in depth against a future auth change,
 * not a live hole. It costs one conjunct and removes the trap.
 *
 * Both refusals share `SCHEDULER_FORBIDDEN_NON_PRIMARY_CLIENT`: it is the code
 * the dashboard correlates a failed mutation on, and a second code for a state
 * no wire client can reach would be untestable surface for no gain. The message
 * text therefore states the WHOLE bar (an unbound primary token) rather than only
 * the reachable half, so one envelope describes both refusals honestly instead of
 * telling a bound primary that its problem is being "pairing-issued".
 *
 * Logging uses `sessionLogger` (never `loggerForSession`, which throws on an
 * absent sessionId) because a rejected client is frequently unbound.
 *
 * @returns {boolean} true if the caller was rejected (handler must return).
 */
function rejectSchedulerWriteUnlessPrimary(ws, client, msg, ctx, op) {
  if (client?.isPrimaryToken === true && !client?.boundSessionId) return false
  sessionLogger(client?.boundSessionId).warn(
    `Client ${client?.id}${client?.boundSessionId ? ` (bound to ${client.boundSessionId})` : ' (unbound, non-primary)'} attempted ${op} — rejected (scheduled-task writes require an UNBOUND primary token)`,
  )
  schedulerError(
    ws, ctx, msg,
    'SCHEDULER_FORBIDDEN_NON_PRIMARY_CLIENT',
    'Creating, changing, or deleting a scheduled task requires an UNBOUND primary token — neither a pairing-issued token nor a connection bound to a single shared session qualifies, because a scheduled task makes this machine run an agent session unattended. Use the primary API token from a device with physical access to this machine.',
  )
  return true
}

/**
 * READ gate — host-level authority, matching the Control Room surveys. The
 * registry spans every repo and session on the host, so a pairing-BOUND client
 * (scoped to one shared session) must not receive it.
 *
 * @returns {boolean} true if the caller was rejected (handler must return).
 */
function rejectSchedulerReadIfBound(ws, client, msg, ctx) {
  if (!client?.boundSessionId) return false
  schedulerError(
    ws, ctx, msg,
    'SCHEDULER_FORBIDDEN_BOUND_CLIENT',
    'A session-scoped (pairing-bound) client cannot read the host scheduled-task registry.',
  )
  return true
}

/** The registry, or null when no SessionManager is wired. */
function resolveStore(ctx) {
  return ctx?.sessions?.sessionManager?.scheduledTaskStore ?? null
}

/**
 * The provider a task would ACTUALLY resolve to — the same precedence
 * SchedulerEngine._resolveProviderName uses (task target → manager default →
 * DEFAULT_PROVIDER), so the refusal verdict judges the real target rather than
 * the stored field.
 */
function effectiveProvider(task, ctx) {
  const explicit = task?.target?.provider
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  const managerDefault = ctx?.sessions?.sessionManager?.providerType
  if (typeof managerDefault === 'string' && managerDefault.length > 0) return managerDefault
  return DEFAULT_PROVIDER
}

/**
 * Clamp a string to the wire schema's cap for its field.
 *
 * The store deliberately enforces NO length caps (its validation authority is
 * about shape, not size), but `ScheduledTaskSchema` does — `name`/`id` 256,
 * `provider` 128, `model` 256, `cwd` 4096, `lastRun.error` 2048. That asymmetry
 * was a live brick: a store-legal task (a 300-char `name` from the CLI, or a
 * long engine error in `lastRun.error`) made the WHOLE snapshot fail the
 * dashboard's `safeParse`, so every task vanished and the tab hung on
 * "Loading…". A snapshot the contract cannot represent is worse than a
 * shortened display string.
 *
 * ── The clamp is display-only, but ONLY if every writer cooperates (#7049) ────
 * This block used to end "and the store keeps the full value either way", which
 * was true of the READ and false of the write-back. A surface that seeds an EDIT
 * FORM from this projection and sends the fields back on save persists the
 * SHORTENED value, permanently — and nothing here can prevent it, because
 * `ScheduledTaskInputSchema`'s caps are the SAME numbers, so an over-cap value
 * cannot be sent back even deliberately. The only thing that keeps it is not
 * sending the field.
 *
 * So the dashboard's task form sends PATCH semantics on `update` — only the
 * fields the operator actually changed (ScheduledTasksSection.tsx `submit()`) —
 * and any NEW writer of `scheduled_task_action:update` must do the same. The
 * store's `update()` also replaces `target` WHOLESALE, so the same rule is what
 * keeps a `target.permissionMode` (which no form field owns) from being erased
 * by an unrelated save.
 */
function clampWire(value, max) {
  if (typeof value !== 'string') return value
  return value.length > max ? value.slice(0, max) : value
}

/** Clamp the target's string fields to their wire caps. */
function projectTarget(target) {
  if (!target || typeof target !== 'object') return {}
  const out = { ...target }
  if (typeof out.provider === 'string') out.provider = clampWire(out.provider, 128)
  if (typeof out.model === 'string') out.model = clampWire(out.model, 256)
  if (typeof out.cwd === 'string') out.cwd = clampWire(out.cwd, 4096)
  if (typeof out.permissionMode === 'string') out.permissionMode = clampWire(out.permissionMode, 64)
  return out
}

/**
 * Clamp the last-run block's string fields. `error` is the realistic offender —
 * an engine failure message (or a stack) easily exceeds the wire's 2048.
 */
function projectLastRun(lastRun) {
  if (!lastRun || typeof lastRun !== 'object') return null
  const out = { ...lastRun }
  // A clamped status is still an unrecognized status, which the shared health
  // helper maps to ERROR — the pessimistic direction, so this cannot invent health.
  if (typeof out.status === 'string') out.status = clampWire(out.status, 64)
  if (typeof out.sessionId === 'string') out.sessionId = clampWire(out.sessionId, 256)
  if (typeof out.error === 'string') out.error = clampWire(out.error, 2048)
  return out
}

/**
 * Project one stored task onto the wire shape, attaching the engine's own
 * verdicts. NOTHING here is re-derived: the refusal string is verbatim
 * `scheduledProviderRefusalReason()` output and the permission mode is verbatim
 * `resolveScheduledPermissionMode()` output, so the panel cannot disagree with
 * what the engine will actually do.
 *
 * String fields are clamped to the wire caps (see `clampWire`). `id` is
 * deliberately NOT clamped: it is the mutation key, so a truncated id would let
 * pause/delete address the wrong record (or nothing) — far worse than a rejected
 * snapshot. Store ids are generated, so an over-cap id means a hand-edited
 * registry, and the panel now surfaces that as a readable snapshot error rather
 * than hanging.
 */
function projectTask(task, ctx, quarantinedIds) {
  const provider = effectiveProvider(task, ctx)
  const requestedMode = task?.target?.permissionMode
  const effectiveMode = resolveScheduledPermissionMode(requestedMode)
  return {
    id: task.id,
    name: clampWire(task.name ?? null, 256),
    enabled: task.enabled === true,
    prompt: typeof task.prompt === 'string' ? task.prompt : '',
    target: projectTarget(task.target),
    cadence: task.cadence,
    nextRun: Number.isFinite(task.nextRun) ? task.nextRun : null,
    lastRun: projectLastRun(task.lastRun),
    createdAt: Number.isFinite(task.createdAt) ? task.createdAt : 0,
    updatedAt: Number.isFinite(task.updatedAt) ? task.updatedAt : 0,
    providerRefusal: clampWire(scheduledProviderRefusalReason(provider), 2048),
    effectiveProvider: clampWire(provider, 128),
    effectivePermissionMode: clampWire(effectiveMode, 64),
    // True only when the task ASKED for something and got clamped — an absent
    // mode is a default, not a downgrade the operator needs warning about.
    permissionModeClamped: typeof requestedMode === 'string'
      && requestedMode.length > 0
      && requestedMode !== effectiveMode,
    quarantined: quarantinedIds.has(task.id),
  }
}

/**
 * Where the gate's value came from. Surfaced so the panel can explain that a
 * config toggle cannot override `CHROXY_ENABLE_SCHEDULER=1`.
 */
function gateSource(ctx) {
  if (process.env.CHROXY_ENABLE_SCHEDULER === '1') return 'env'
  if (ctx?.services?.config?.features?.scheduler === true) return 'config'
  return 'default'
}

/**
 * Build the full snapshot. `engineArmed` is the RUNTIME truth (a live, armed
 * engine) which can disagree with the persisted gate, because the engine is
 * built once at daemon boot — `restartRequired` names that disagreement rather
 * than letting `enabled` imply something is firing.
 */
function buildSnapshot(ctx, requestId, { error = null } = {}) {
  const store = resolveStore(ctx)
  const engine = ctx?.services?.schedulerEngine ?? null
  const quarantinedIds = engine?.quarantinedTaskIds instanceof Set
    ? engine.quarantinedTaskIds
    : new Set()
  const enabled = isSchedulerEnabled(ctx?.services?.config)
  const engineArmed = engine?.armed === true
  let tasks = []
  if (store && !error) {
    try {
      tasks = store.list().map((t) => projectTask(t, ctx, quarantinedIds))
    } catch (err) {
      // Degrade to a structurally valid empty snapshot + error, the same posture
      // the Control Room surveys use — never a dead/unparseable reply.
      log.warn(`Failed to list scheduled tasks: ${getErrorMessage(err)}`)
      return buildSnapshot(ctx, requestId, {
        error: { code: 'SCHEDULER_REGISTRY_UNAVAILABLE', message: getErrorMessage(err) },
      })
    }
  }
  const defaultProvider = effectiveProvider(null, ctx)
  return {
    type: 'scheduled_tasks',
    requestId: requestId ?? null,
    generatedAt: new Date().toISOString(),
    scheduler: {
      enabled,
      engineArmed,
      restartRequired: enabled !== engineArmed,
      source: gateSource(ctx),
    },
    schedulableProviders: listSchedulableProviders(),
    defaultProvider,
    defaultProviderRefusal: scheduledProviderRefusalReason(defaultProvider),
    tasks,
    ...(error ? { error } : {}),
  }
}

/** Send the snapshot to the requesting client only. */
function replySnapshot(ws, ctx, requestId, opts) {
  ctx.transport.send(ws, buildSnapshot(ctx, requestId, opts))
}

/**
 * Read the registry + gate state. Reply is a `scheduled_tasks` snapshot to the
 * requesting client. Host-level (unbound) authority; see the file header.
 */
function handleScheduledTasksRequest(ws, client, msg, ctx) {
  if (rejectSchedulerReadIfBound(ws, client, msg, ctx)) return
  const requestId = msg?.requestId ?? null
  if (!resolveStore(ctx)) {
    replySnapshot(ws, ctx, requestId, {
      error: {
        code: 'SCHEDULER_REGISTRY_UNAVAILABLE',
        message: 'No scheduled-task registry is available on this server.',
      },
    })
    return
  }
  replySnapshot(ws, ctx, requestId)
}

/**
 * Create / update / pause / resume / delete a scheduled task.
 *
 * STRICT-PRIMARY gated (first statement, before any validation or store touch).
 * On success the reply is the re-emitted snapshot echoing `requestId` — that IS
 * the ack, mirroring #6998's `mcp_servers` re-broadcast. Every failure is a
 * `SCHEDULED_TASK_ACTION_FAILED` session_error echoing the same `requestId`, so
 * the panel can clear its pending entry either way and never shows a mutation
 * as applied when it was not.
 *
 * Validation authority is the store: its `ScheduledTaskValidationError` carries
 * the offending field, which is surfaced verbatim rather than re-implemented
 * here (a second validator would be free to accept what the store rejects).
 */
function handleScheduledTaskAction(ws, client, msg, ctx) {
  if (rejectSchedulerWriteUnlessPrimary(ws, client, msg, ctx, `scheduled_task_action:${msg?.action}`)) return
  const requestId = msg?.requestId ?? null
  const action = msg?.action
  const fail = (message, code = 'SCHEDULED_TASK_ACTION_FAILED') => {
    schedulerError(ws, ctx, msg, code, message)
  }

  const store = resolveStore(ctx)
  if (!store) {
    fail('No scheduled-task registry is available on this server.', 'SCHEDULER_REGISTRY_UNAVAILABLE')
    return
  }

  const taskId = typeof msg?.taskId === 'string' ? msg.taskId.trim() : ''
  if ((ID_ONLY_ACTIONS.has(action) || action === 'update') && !taskId) {
    fail(`scheduled_task_action '${action}' requires a taskId`)
    return
  }
  if (action === 'create' && (!msg?.task || typeof msg.task !== 'object')) {
    fail("scheduled_task_action 'create' requires a task payload")
    return
  }
  if (action === 'update' && (!msg?.task || typeof msg.task !== 'object')) {
    fail("scheduled_task_action 'update' requires a task payload")
    return
  }

  try {
    switch (action) {
      case 'create': {
        const created = store.add(msg.task)
        // Log the id + cadence kind only — a prompt is user content.
        log.info(`Scheduled task created: ${created.id} (cadence ${created.cadence?.kind})`)
        break
      }
      case 'update': {
        if (!store.update(taskId, msg.task)) {
          fail(`No scheduled task with id ${taskId}`, 'SCHEDULED_TASK_NOT_FOUND')
          return
        }
        log.info(`Scheduled task updated: ${taskId}`)
        break
      }
      case 'pause':
      case 'resume': {
        if (!store.update(taskId, { enabled: action === 'resume' })) {
          fail(`No scheduled task with id ${taskId}`, 'SCHEDULED_TASK_NOT_FOUND')
          return
        }
        log.info(`Scheduled task ${action}d: ${taskId}`)
        break
      }
      case 'delete': {
        if (!store.remove(taskId)) {
          fail(`No scheduled task with id ${taskId}`, 'SCHEDULED_TASK_NOT_FOUND')
          return
        }
        log.info(`Scheduled task deleted: ${taskId}`)
        break
      }
      default:
        fail(`Unsupported scheduled_task_action '${action}'`)
        return
    }
  } catch (err) {
    if (err instanceof ScheduledTaskValidationError) {
      // The store is the validation authority — pass its field-precise reason
      // straight through so the panel can point at the offending input.
      fail(`${err.field ? `${err.field}: ` : ''}${err.message}`, 'SCHEDULED_TASK_INVALID')
      return
    }
    log.error(`scheduled_task_action '${action}' failed: ${getErrorMessage(err)}`)
    fail(getErrorMessage(err))
    return
  }

  // The registry changed — let a running engine re-evaluate immediately instead
  // of waiting out its max-sleep tick. Best-effort: a refresh failure must not
  // turn an applied mutation into a reported failure.
  const engine = ctx?.services?.schedulerEngine ?? null
  try {
    engine?.refresh?.()
  } catch (err) {
    log.warn(`Scheduler refresh after ${action} failed: ${getErrorMessage(err)}`)
  }

  replySnapshot(ws, ctx, requestId)
}

/**
 * Flip the PERSISTED global enable gate (`features.scheduler` in config.json).
 *
 * STRICT-PRIMARY gated — this is the switch that decides whether the daemon runs
 * agent sessions with nobody watching at all.
 *
 * HONESTY CONTRACT: this writes the persisted flag and updates the in-memory
 * config so the reported gate state is accurate, but it does NOT arm or disarm a
 * running daemon — the engine is constructed once at boot (buildSchedulerEngine
 * returns null when the gate is closed) and `destroy()` is terminal. So the reply
 * snapshot reports `scheduler.restartRequired` whenever the gate and the live
 * engine disagree, and the panel says so. Pretending a toggle took effect would
 * be exactly the lie this panel exists to prevent.
 *
 * A gate forced by `CHROXY_ENABLE_SCHEDULER=1` cannot be turned off by a config
 * write, so that case is refused explicitly instead of writing a flag that has
 * no effect.
 */
function handleSetSchedulerEnabled(ws, client, msg, ctx) {
  if (rejectSchedulerWriteUnlessPrimary(ws, client, msg, ctx, 'set_scheduler_enabled')) return
  const requestId = msg?.requestId ?? null
  const enabled = msg?.enabled
  if (typeof enabled !== 'boolean') {
    schedulerError(ws, ctx, msg, 'SCHEDULER_GATE_FAILED', 'set_scheduler_enabled requires a boolean `enabled`')
    return
  }
  if (enabled === false && process.env.CHROXY_ENABLE_SCHEDULER === '1') {
    schedulerError(
      ws, ctx, msg, 'SCHEDULER_GATE_ENV_FORCED',
      'Scheduled execution is forced ON by the CHROXY_ENABLE_SCHEDULER=1 environment variable, which overrides config.json. Unset it in the daemon environment and restart to disable.',
    )
    return
  }

  try {
    writeSchedulerEnabledToConfig(enabled)
  } catch (err) {
    log.error(`Failed to persist features.scheduler=${enabled}: ${getErrorMessage(err)}`)
    schedulerError(ws, ctx, msg, 'SCHEDULER_GATE_FAILED', `Could not persist the scheduler gate: ${getErrorMessage(err)}`)
    return
  }

  // Keep the in-memory config in step so the snapshot reports the new gate value
  // (and `restartRequired`) rather than the stale boot-time one.
  const config = ctx?.services?.config
  if (config && typeof config === 'object') {
    if (!config.features || typeof config.features !== 'object') config.features = {}
    config.features.scheduler = enabled
  }
  log.warn(`Scheduled execution gate set to ${enabled} by the primary client — a daemon restart is required for it to take effect`)

  replySnapshot(ws, ctx, requestId)
}

export const schedulerHandlers = {
  scheduled_tasks_request: handleScheduledTasksRequest,
  scheduled_task_action: handleScheduledTaskAction,
  set_scheduler_enabled: handleSetSchedulerEnabled,
}
