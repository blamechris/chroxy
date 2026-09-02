/**
 * Feature handlers: extension messages, web tasks, dev preview, environments.
 *
 * Handles: extension_message, launch_web_task, list_web_tasks, teleport_web_task,
 *          close_dev_preview, create_environment, list_environments,
 *          destroy_environment, get_environment
 *
 * These handlers were previously split across extension-handlers.js,
 * web-task-handlers.js, and environment-handlers.js. Consolidated here to
 * reduce file fragmentation (each file had 1–4 small functions).
 */
import { createLogger, loggerForSession } from '../logger.js'
import { validateCwdAllowed, buildSessionTokenMismatchPayload, sendSessionError } from '../handler-utils.js'
import { validateDockerImage } from '../docker-image-allowlist.js'
import { WebTaskUnavailableError } from '../web-task-manager.js'
import { destroyEnvironmentWithSessions, ENVIRONMENT_HAS_LIVE_SESSIONS } from '../environments/destroy-with-sessions.js'
import { environmentsForClient, environmentForClient, broadcastEnvironmentList } from '../environments/redact.js'

const log = createLogger('ws')

// -- Extension message --

function handleExtensionMessage(ws, client, msg, ctx) {
  const { provider, subtype, data } = msg
  if (typeof provider !== 'string' || !provider) {
    sendSessionError(ws, ctx, 'extension_message requires a non-empty provider field')
    return
  }
  if (typeof subtype !== 'string' || !subtype) {
    sendSessionError(ws, ctx, 'extension_message requires a non-empty subtype field')
    return
  }

  const targetSessionId = msg.sessionId || client.activeSessionId

  // Enforce session binding
  if (client.boundSessionId && client.boundSessionId !== targetSessionId) {
    ctx.transport.send(ws, {
      type: 'session_error',
      ...buildSessionTokenMismatchPayload({
        sessionManager: ctx.sessions.sessionManager,
        boundSessionId: client.boundSessionId,
      }),
    })
    return
  }

  const entry = ctx.sessions.sessionManager.getSession(targetSessionId)
  if (!entry) {
    const message = msg.sessionId
      ? `Session not found: ${msg.sessionId}`
      : 'No active session'
    sendSessionError(ws, ctx, message)
    return
  }

  if (typeof entry.session.handleExtensionMessage === 'function') {
    entry.session.handleExtensionMessage({ provider, subtype, data })
  } else {
    // #4828: session-scoped — targetSessionId is in scope and bound.
    // Legacy single-session callers may surface an empty value, so fall
    // back to module-level `log` rather than throwing inside
    // loggerForSession (same pattern as the settings-handlers sites).
    ;(targetSessionId ? loggerForSession('ws', targetSessionId) : log).debug(`extension_message (${provider}/${subtype}) received; session does not handle it`)
  }
}

// -- Web task and dev preview --

// Adversary A10 (2026-04-11 audit): cap the launch_web_task prompt at
// 10KB. Without this, a bound mobile client could use the cloud
// `claude --remote` runner as a generic large-payload side channel
// (exfiltrate arbitrary file content into the prompt, instruct the
// cloud agent to POST it elsewhere). 10KB is plenty for a realistic
// task description and keeps abuse economics bad.
const MAX_WEB_TASK_PROMPT_BYTES = 10 * 1024

function handleLaunchWebTask(ws, client, msg, ctx) {
  // Prompt size / type guard — applies to every client.
  if (typeof msg.prompt !== 'string' || !msg.prompt.trim()) {
    ctx.transport.send(ws, { type: 'web_task_error', taskId: null, message: 'Task prompt is required' })
    return
  }
  if (Buffer.byteLength(msg.prompt, 'utf-8') > MAX_WEB_TASK_PROMPT_BYTES) {
    ctx.transport.send(ws, {
      type: 'web_task_error',
      taskId: null,
      message: `Task prompt exceeds ${MAX_WEB_TASK_PROMPT_BYTES / 1024}KB limit (Adversary A10 rate-limit)`,
      code: 'WEB_TASK_PROMPT_TOO_LARGE',
    })
    return
  }

  // Adversary A10: bound pairing-issued clients must not be able to
  // pick an arbitrary cwd for a web task. Force the cwd to the bound
  // session's cwd so the cloud runner (and any later teleport) only
  // sees files the client already has legitimate access to. Reject
  // client-supplied cwds that don't match.
  let effectiveCwd = msg.cwd
  if (client.boundSessionId) {
    const entry = ctx.sessions.sessionManager?.getSession?.(client.boundSessionId)
    const boundCwd = entry?.cwd
    if (!boundCwd) {
      ctx.transport.send(ws, {
        type: 'web_task_error',
        taskId: null,
        ...buildSessionTokenMismatchPayload({
          sessionManager: ctx.sessions.sessionManager,
          boundSessionId: client.boundSessionId,
          message: 'Not authorized to launch web tasks from this session',
        }),
      })
      return
    }
    if (effectiveCwd && effectiveCwd !== boundCwd) {
      ctx.transport.send(ws, {
        type: 'web_task_error',
        taskId: null,
        ...buildSessionTokenMismatchPayload({
          sessionManager: ctx.sessions.sessionManager,
          boundSessionId: client.boundSessionId,
          message: 'Bound clients may only launch web tasks inside the bound session cwd',
        }),
      })
      return
    }
    effectiveCwd = boundCwd
  }

  if (effectiveCwd) {
    const cwdError = validateCwdAllowed(effectiveCwd, ctx.services.config)
    if (cwdError) {
      ctx.transport.send(ws, { type: 'web_task_error', taskId: null, message: cwdError })
      return
    }
  }
  try {
    const { taskId } = ctx.services.webTaskManager.launchTask(msg.prompt, { cwd: effectiveCwd })
    log.info(`Web task launched: ${taskId} — "${msg.prompt.slice(0, 60)}"`)
  } catch (err) {
    const errorMsg = err instanceof WebTaskUnavailableError
      ? err.message
      : `Failed to launch web task: ${err.message}`
    ctx.transport.send(ws, { type: 'web_task_error', taskId: null, message: errorMsg })
  }
}

function handleListWebTasks(ws, client, msg, ctx) {
  const tasks = ctx.services.webTaskManager.listTasks()
  // Adversary A10: bound clients only see tasks whose cwd matches the
  // bound session's cwd, so the list endpoint doesn't become a side
  // channel for enumerating cross-session task state.
  if (client.boundSessionId) {
    const entry = ctx.sessions.sessionManager?.getSession?.(client.boundSessionId)
    const boundCwd = entry?.cwd
    const scoped = boundCwd ? tasks.filter((t) => t.cwd === boundCwd) : []
    ctx.transport.send(ws, { type: 'web_task_list', tasks: scoped })
    return
  }
  ctx.transport.send(ws, { type: 'web_task_list', tasks })
}

function handleTeleportWebTask(ws, client, msg, ctx) {
  // Adversary A10: teleport runs `claude --teleport <id>` locally via
  // execFile. Bound pairing-issued clients must not trigger local
  // execution of cloud-task output — that's an unbounded SSRF-style
  // escalation from a scoped mobile pairing back to full-shell access.
  if (client.boundSessionId) {
    const task = ctx.services.webTaskManager.getTask?.(msg.taskId)
    const entry = ctx.sessions.sessionManager?.getSession?.(client.boundSessionId)
    const boundCwd = entry?.cwd
    if (!task || !boundCwd || task.cwd !== boundCwd) {
      ctx.transport.send(ws, {
        type: 'web_task_error',
        taskId: msg.taskId,
        ...buildSessionTokenMismatchPayload({
          sessionManager: ctx.sessions.sessionManager,
          boundSessionId: client.boundSessionId,
          message: 'Not authorized to teleport this task',
        }),
      })
      return
    }
  }
  ctx.services.webTaskManager.teleportTask(msg.taskId).then(() => {
    log.info(`Teleported task ${msg.taskId}`)
    ctx.transport.send(ws, { type: 'server_status', message: `Task ${msg.taskId} teleported to local session` })
  }).catch(err => {
    ctx.transport.send(ws, { type: 'web_task_error', taskId: msg.taskId, message: err.message })
  })
}

function handleCloseDevPreview(ws, client, msg, ctx) {
  const previewSessionId = msg.sessionId || client.activeSessionId
  // Enforce session binding
  if (client.boundSessionId && client.boundSessionId !== previewSessionId) return
  if (previewSessionId && typeof msg.port === 'number') {
    ctx.services.devPreview.closePreview(previewSessionId, msg.port)
  }
}

// -- Environment management --

/**
 * #7576 — create a host container environment.
 *
 * SECURITY (docs/security/bearer-token-authority.md): `create_environment`
 * spawns a HOST container the daemon will run. The image, cwd, name, and
 * resource limits are all caller-chosen — `validateDockerImage` constrains the
 * image to an allowlist, but per the doc's §9 step 4 ("can a caller choose a
 * binary, argv, or environment this daemon will spawn?") this is the creation of
 * new host state, not an action on an existing session, so it takes the STRICT
 * PRIMARY bar (`client.isPrimaryToken === true`) — stricter than
 * `destroy_environment`'s unbound check. A pairing-issued (share-a-session)
 * token is never primary and is refused. The gate runs FIRST — before the
 * feature-enabled check and any input validation — so an unauthorised caller
 * gets one identical refusal regardless of feature state or arguments (no oracle
 * on whether the manager is wired).
 */
function handleCreateEnvironment(ws, client, msg, ctx) {
  if (client?.isPrimaryToken !== true) {
    log.warn(
      `Client ${client?.id} attempted create_environment without a primary token — rejected (spawning a host container requires the primary/host token)`,
    )
    ctx.transport.send(ws, {
      type: 'environment_error',
      error: 'Creating a container environment requires the primary (host) token — pairing-issued session tokens cannot spawn host containers.',
      code: 'ENVIRONMENT_CREATE_FORBIDDEN_NON_PRIMARY',
    })
    return
  }

  if (!ctx.services.environmentManager) {
    ctx.transport.send(ws, { type: 'environment_error', error: 'Environment management is not enabled' })
    return
  }

  const name = (typeof msg.name === 'string' && msg.name.trim()) ? msg.name.trim() : undefined
  const cwd = (typeof msg.cwd === 'string' && msg.cwd.trim()) ? msg.cwd.trim() : undefined
  const image = (typeof msg.image === 'string' && msg.image.trim()) ? msg.image.trim() : undefined
  const memoryLimit = (typeof msg.memoryLimit === 'string' && msg.memoryLimit.trim()) ? msg.memoryLimit.trim() : undefined
  const cpuLimit = (typeof msg.cpuLimit === 'string' && msg.cpuLimit.trim()) ? msg.cpuLimit.trim() : undefined

  if (!name) {
    ctx.transport.send(ws, { type: 'environment_error', error: 'Environment name is required' })
    return
  }
  if (!cwd) {
    ctx.transport.send(ws, { type: 'environment_error', error: 'Environment cwd is required' })
    return
  }

  const cwdError = validateCwdAllowed(cwd, ctx.services.config)
  if (cwdError) {
    ctx.transport.send(ws, { type: 'environment_error', error: cwdError })
    return
  }

  // Validate the Docker image against the allowlist. Closes the
  // 2026-04-11 audit Adversary A7 attack where an authenticated client
  // could register any attacker-controlled image and run it inside the
  // operator's Docker daemon. Default allowlist covers common base
  // images; operators can override via config.allowedDockerImages.
  const imageError = validateDockerImage(image, ctx.services.config)
  if (imageError) {
    ctx.transport.send(ws, { type: 'environment_error', error: imageError, code: 'DOCKER_IMAGE_NOT_ALLOWED' })
    return
  }

  ctx.services.environmentManager.create({ name, cwd, image, memoryLimit, cpuLimit })
    .then((env) => {
      ctx.transport.send(ws, {
        type: 'environment_created',
        environmentId: env.id,
        name: env.name,
        status: env.status,
      })
      // #7576: redact the sibling-session roster per recipient — a plain
      // broadcast would hand every bound listener the roster the list/get gate
      // strips.
      broadcastEnvironmentList(ctx.transport.broadcast, ctx.services.environmentManager.list())
    })
    .catch((err) => {
      log.error(`Failed to create environment: ${err.message}`)
      ctx.transport.send(ws, { type: 'environment_error', error: err.message })
    })
}

function handleListEnvironments(ws, client, _msg, ctx) {
  if (!ctx.services.environmentManager) {
    ctx.transport.send(ws, { type: 'environment_list', environments: [] })
    return
  }

  // #7576: a pairing-bound (share-a-session) token cannot list sibling sessions,
  // so blank the `sessions` roster on each descriptor for a bound caller. The
  // env ids/names remain for a legitimate picker.
  ctx.transport.send(ws, {
    type: 'environment_list',
    environments: environmentsForClient(ctx.services.environmentManager.list(), client),
  })
}

/**
 * #7562 — destroy an environment, refusing while sessions are running inside
 * it unless the client sets `force: true`.
 *
 * The refusal and the cascade both live in
 * `environments/destroy-with-sessions.js` / `EnvironmentManager.destroy()`, so
 * this handler and the Control Room's `containers_action` share ONE
 * implementation. `force` cascades: the attached sessions are destroyed cleanly
 * first, then the environment. The refusal reply carries
 * `code: 'ENVIRONMENT_HAS_LIVE_SESSIONS'` and the session ids, so a client can
 * name them (or offer the escalation) rather than showing a bare string.
 *
 * SECURITY (docs/security/bearer-token-authority.md checklist):
 *   1. Host-level authority — destroying an environment is a host-wide
 *      lifecycle action, and with the `force` cascade above it also destroys
 *      every session attached to it. A pairing-bound (share-a-session) client is
 *      scoped to ONE session and must not reach it: the doc's rule is "bound
 *      tokens cannot create, destroy, switch, or list sibling sessions", and a
 *      bound client forcing this would destroy siblings it has no authority
 *      over. Gated below, mirroring `containers_action`, which is the same
 *      operation on the Control Room surface and has always gated (#7571 review
 *      B1 — this handler took `_client` and never looked at it, so unifying the
 *      destroy POLICY across both paths had left the AUTHORITY check on only one
 *      of them: the same one-caller-guarded shape #7562 is otherwise about).
 *   2. Environment membership — the client-supplied `environmentId` is a lookup
 *      key into the manager's own registry, never a path or a host container id;
 *      an unknown id resolves to nothing and `destroy()` throws.
 *
 * The authority gate runs FIRST — before the feature-enabled check, before
 * `environmentId` validation and before any lookup — so an unauthorised client
 * gets one identical refusal whether or not the environment exists and whether
 * or not sessions are attached. Otherwise the reply is an existence oracle, and
 * the `ENVIRONMENT_HAS_LIVE_SESSIONS` refusal would hand a bound client the ids
 * of sessions it was never entitled to ask about.
 */
function handleDestroyEnvironment(ws, client, msg, ctx) {
  // Authority gate (#1): host-level (unbound) clients only.
  if (client?.boundSessionId) {
    loggerForSession('ws', client.boundSessionId).warn(
      `Client ${client.id} (bound to ${client.boundSessionId}) attempted destroy_environment — rejected (bound tokens cannot run host lifecycle actions or destroy sibling sessions)`,
    )
    ctx.transport.send(ws, {
      type: 'environment_error',
      error: 'Pairing-issued session tokens cannot destroy container environments — this requires a host-level (unbound) client, such as the primary token or the app\'s own device.',
      code: 'ENVIRONMENT_DESTROY_FORBIDDEN_BOUND_CLIENT',
    })
    return
  }

  if (!ctx.services.environmentManager) {
    ctx.transport.send(ws, { type: 'environment_error', error: 'Environment management is not enabled' })
    return
  }

  const environmentId = (typeof msg.environmentId === 'string' && msg.environmentId.trim())
    ? msg.environmentId.trim() : undefined

  if (!environmentId) {
    ctx.transport.send(ws, { type: 'environment_error', error: 'environmentId is required' })
    return
  }

  // Strict boolean: only an explicit `true` escalates. A truthy string from a
  // hand-rolled client must not silently destroy live sessions.
  const force = msg.force === true

  return destroyEnvironmentWithSessions({
    environmentManager: ctx.services.environmentManager,
    sessionManager: ctx.sessions.sessionManager,
    environmentId,
    force,
  })
    .then(({ destroyedSessions }) => {
      if (destroyedSessions.length > 0) {
        log.warn(`Force-destroyed environment ${environmentId} with ${destroyedSessions.length} live session(s): ${destroyedSessions.join(', ')}`)
      }
      ctx.transport.send(ws, { type: 'environment_destroyed', environmentId })
      // #7576: redact the sibling-session roster per recipient (see create).
      broadcastEnvironmentList(ctx.transport.broadcast, ctx.services.environmentManager.list())
    })
    .catch((err) => {
      if (err?.code === ENVIRONMENT_HAS_LIVE_SESSIONS) {
        // Not an operational failure — the guard doing its job. Info, not error.
        log.info(`Refused destroy of environment ${environmentId}: ${err.message}`)
        ctx.transport.send(ws, {
          type: 'environment_error',
          environmentId,
          error: err.message,
          code: ENVIRONMENT_HAS_LIVE_SESSIONS,
          sessions: err.sessions || [],
        })
        return
      }
      log.error(`Failed to destroy environment: ${err.message}`)
      ctx.transport.send(ws, { type: 'environment_error', environmentId, error: err.message })
    })
}

function handleGetEnvironment(ws, client, msg, ctx) {
  if (!ctx.services.environmentManager) {
    ctx.transport.send(ws, { type: 'environment_error', error: 'Environment management is not enabled' })
    return
  }

  const environmentId = (typeof msg.environmentId === 'string' && msg.environmentId.trim())
    ? msg.environmentId.trim() : undefined

  if (!environmentId) {
    ctx.transport.send(ws, { type: 'environment_error', error: 'environmentId is required' })
    return
  }

  const env = ctx.services.environmentManager.get(environmentId)
  if (!env) {
    ctx.transport.send(ws, { type: 'environment_error', environmentId, error: 'Environment not found' })
    return
  }

  // #7576: blank the `sessions` roster for a pairing-bound (share-a-session)
  // caller — get() returns the live object, so environmentForClient copies it.
  ctx.transport.send(ws, { type: 'environment_info', environment: environmentForClient(env, client) })
}

export const featureHandlers = {
  extension_message: handleExtensionMessage,
  launch_web_task: handleLaunchWebTask,
  list_web_tasks: handleListWebTasks,
  teleport_web_task: handleTeleportWebTask,
  close_dev_preview: handleCloseDevPreview,
  create_environment: handleCreateEnvironment,
  list_environments: handleListEnvironments,
  destroy_environment: handleDestroyEnvironment,
  get_environment: handleGetEnvironment,
}
