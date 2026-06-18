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

function handleCreateEnvironment(ws, _client, msg, ctx) {
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
      ctx.transport.broadcast({
        type: 'environment_list',
        environments: ctx.services.environmentManager.list(),
      })
    })
    .catch((err) => {
      log.error(`Failed to create environment: ${err.message}`)
      ctx.transport.send(ws, { type: 'environment_error', error: err.message })
    })
}

function handleListEnvironments(ws, _client, _msg, ctx) {
  if (!ctx.services.environmentManager) {
    ctx.transport.send(ws, { type: 'environment_list', environments: [] })
    return
  }

  ctx.transport.send(ws, {
    type: 'environment_list',
    environments: ctx.services.environmentManager.list(),
  })
}

function handleDestroyEnvironment(ws, _client, msg, ctx) {
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

  ctx.services.environmentManager.destroy(environmentId)
    .then(() => {
      ctx.transport.send(ws, { type: 'environment_destroyed', environmentId })
      ctx.transport.broadcast({
        type: 'environment_list',
        environments: ctx.services.environmentManager.list(),
      })
    })
    .catch((err) => {
      log.error(`Failed to destroy environment: ${err.message}`)
      ctx.transport.send(ws, { type: 'environment_error', environmentId, error: err.message })
    })
}

function handleGetEnvironment(ws, _client, msg, ctx) {
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

  ctx.transport.send(ws, { type: 'environment_info', environment: env })
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
