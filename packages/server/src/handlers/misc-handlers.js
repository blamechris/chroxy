/**
 * Miscellaneous handlers: extension messages, web tasks, dev preview, environments.
 *
 * Handles: extension_message, launch_web_task, list_web_tasks, teleport_web_task,
 *          close_dev_preview, create_environment, list_environments,
 *          destroy_environment, get_environment
 *
 * These handlers were previously split across extension-handlers.js,
 * web-task-handlers.js, and environment-handlers.js. Consolidated here to
 * reduce file fragmentation (each file had 1–4 small functions).
 */
import { createLogger } from '../logger.js'
import { validateCwdWithinHome } from '../handler-utils.js'
import { WebTaskUnavailableError } from '../web-task-manager.js'

const log = createLogger('ws')

// -- Extension message --

function handleExtensionMessage(ws, client, msg, ctx) {
  const { provider, subtype, data } = msg
  if (typeof provider !== 'string' || !provider) {
    ctx.send(ws, { type: 'session_error', message: 'extension_message requires a non-empty provider field' })
    return
  }
  if (typeof subtype !== 'string' || !subtype) {
    ctx.send(ws, { type: 'session_error', message: 'extension_message requires a non-empty subtype field' })
    return
  }

  const targetSessionId = msg.sessionId || client.activeSessionId
  const entry = ctx.sessionManager.getSession(targetSessionId)
  if (!entry) {
    const message = msg.sessionId
      ? `Session not found: ${msg.sessionId}`
      : 'No active session'
    ctx.send(ws, { type: 'session_error', message })
    return
  }

  if (typeof entry.session.handleExtensionMessage === 'function') {
    entry.session.handleExtensionMessage({ provider, subtype, data })
  } else {
    log.debug(`extension_message (${provider}/${subtype}) received; session does not handle it`)
  }
}

// -- Web task and dev preview --

function handleLaunchWebTask(ws, client, msg, ctx) {
  if (msg.cwd) {
    const cwdError = validateCwdWithinHome(msg.cwd)
    if (cwdError) {
      ctx.send(ws, { type: 'web_task_error', taskId: null, message: cwdError })
      return
    }
  }
  try {
    const { taskId } = ctx.webTaskManager.launchTask(msg.prompt, { cwd: msg.cwd })
    log.info(`Web task launched: ${taskId} — "${msg.prompt.slice(0, 60)}"`)
  } catch (err) {
    const errorMsg = err instanceof WebTaskUnavailableError
      ? err.message
      : `Failed to launch web task: ${err.message}`
    ctx.send(ws, { type: 'web_task_error', taskId: null, message: errorMsg })
  }
}

function handleListWebTasks(ws, client, msg, ctx) {
  const tasks = ctx.webTaskManager.listTasks()
  ctx.send(ws, { type: 'web_task_list', tasks })
}

function handleTeleportWebTask(ws, client, msg, ctx) {
  ctx.webTaskManager.teleportTask(msg.taskId).then(() => {
    log.info(`Teleported task ${msg.taskId}`)
    ctx.send(ws, { type: 'server_status', message: `Task ${msg.taskId} teleported to local session` })
  }).catch(err => {
    ctx.send(ws, { type: 'web_task_error', taskId: msg.taskId, message: err.message })
  })
}

function handleCloseDevPreview(ws, client, msg, ctx) {
  const previewSessionId = msg.sessionId || client.activeSessionId
  if (previewSessionId && typeof msg.port === 'number') {
    ctx.devPreview.closePreview(previewSessionId, msg.port)
  }
}

// -- Environment management --

function handleCreateEnvironment(ws, _client, msg, ctx) {
  if (!ctx.environmentManager) {
    ctx.send(ws, { type: 'environment_error', error: 'Environment management is not enabled' })
    return
  }

  const name = (typeof msg.name === 'string' && msg.name.trim()) ? msg.name.trim() : undefined
  const cwd = (typeof msg.cwd === 'string' && msg.cwd.trim()) ? msg.cwd.trim() : undefined
  const image = (typeof msg.image === 'string' && msg.image.trim()) ? msg.image.trim() : undefined
  const memoryLimit = (typeof msg.memoryLimit === 'string' && msg.memoryLimit.trim()) ? msg.memoryLimit.trim() : undefined
  const cpuLimit = (typeof msg.cpuLimit === 'string' && msg.cpuLimit.trim()) ? msg.cpuLimit.trim() : undefined

  if (!name) {
    ctx.send(ws, { type: 'environment_error', error: 'Environment name is required' })
    return
  }
  if (!cwd) {
    ctx.send(ws, { type: 'environment_error', error: 'Environment cwd is required' })
    return
  }

  const cwdError = validateCwdWithinHome(cwd)
  if (cwdError) {
    ctx.send(ws, { type: 'environment_error', error: cwdError })
    return
  }

  ctx.environmentManager.create({ name, cwd, image, memoryLimit, cpuLimit })
    .then((env) => {
      ctx.send(ws, {
        type: 'environment_created',
        environmentId: env.id,
        name: env.name,
        status: env.status,
      })
      ctx.broadcast({
        type: 'environment_list',
        environments: ctx.environmentManager.list(),
      })
    })
    .catch((err) => {
      log.error(`Failed to create environment: ${err.message}`)
      ctx.send(ws, { type: 'environment_error', error: err.message })
    })
}

function handleListEnvironments(ws, _client, _msg, ctx) {
  if (!ctx.environmentManager) {
    ctx.send(ws, { type: 'environment_list', environments: [] })
    return
  }

  ctx.send(ws, {
    type: 'environment_list',
    environments: ctx.environmentManager.list(),
  })
}

function handleDestroyEnvironment(ws, _client, msg, ctx) {
  if (!ctx.environmentManager) {
    ctx.send(ws, { type: 'environment_error', error: 'Environment management is not enabled' })
    return
  }

  const environmentId = (typeof msg.environmentId === 'string' && msg.environmentId.trim())
    ? msg.environmentId.trim() : undefined

  if (!environmentId) {
    ctx.send(ws, { type: 'environment_error', error: 'environmentId is required' })
    return
  }

  ctx.environmentManager.destroy(environmentId)
    .then(() => {
      ctx.send(ws, { type: 'environment_destroyed', environmentId })
      ctx.broadcast({
        type: 'environment_list',
        environments: ctx.environmentManager.list(),
      })
    })
    .catch((err) => {
      log.error(`Failed to destroy environment: ${err.message}`)
      ctx.send(ws, { type: 'environment_error', environmentId, error: err.message })
    })
}

function handleGetEnvironment(ws, _client, msg, ctx) {
  if (!ctx.environmentManager) {
    ctx.send(ws, { type: 'environment_error', error: 'Environment management is not enabled' })
    return
  }

  const environmentId = (typeof msg.environmentId === 'string' && msg.environmentId.trim())
    ? msg.environmentId.trim() : undefined

  if (!environmentId) {
    ctx.send(ws, { type: 'environment_error', error: 'environmentId is required' })
    return
  }

  const env = ctx.environmentManager.get(environmentId)
  if (!env) {
    ctx.send(ws, { type: 'environment_error', environmentId, error: 'Environment not found' })
    return
  }

  ctx.send(ws, { type: 'environment_info', environment: env })
}

export const miscHandlers = {
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
