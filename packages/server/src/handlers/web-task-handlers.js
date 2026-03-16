/**
 * Web task and dev preview handlers.
 *
 * Handles: launch_web_task, list_web_tasks, teleport_web_task, close_dev_preview
 */
import { WebTaskUnavailableError } from '../web-task-manager.js'
import { validateCwdWithinHome } from '../handler-utils.js'

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
    console.log(`[ws] Web task launched: ${taskId} — "${msg.prompt.slice(0, 60)}"`)
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
    console.log(`[ws] Teleported task ${msg.taskId}`)
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

export const webTaskHandlers = {
  launch_web_task: handleLaunchWebTask,
  list_web_tasks: handleListWebTasks,
  teleport_web_task: handleTeleportWebTask,
  close_dev_preview: handleCloseDevPreview,
}
