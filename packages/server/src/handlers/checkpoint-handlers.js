/**
 * Checkpoint management handlers.
 *
 * Handles: create_checkpoint, list_checkpoints, restore_checkpoint, delete_checkpoint
 */
import { sendSessionError } from '../handler-utils.js'

async function handleCreateCheckpoint(ws, client, msg, ctx) {
  const sid = client.activeSessionId
  if (!sid || !ctx.sessionManager) {
    sendSessionError(ws, ctx, 'No active session')
    return
  }
  const entry = ctx.sessionManager.getSession(sid)
  if (!entry) {
    sendSessionError(ws, ctx, `Session not found: ${sid}`)
    return
  }
  if (!entry.session.resumeSessionId) {
    sendSessionError(ws, ctx, 'Cannot create checkpoint before first message')
    return
  }
  try {
    const checkpoint = await ctx.checkpointManager.createCheckpoint({
      sessionId: sid,
      resumeSessionId: entry.session.resumeSessionId,
      cwd: entry.cwd,
      name: typeof msg.name === 'string' ? msg.name.slice(0, 100) : undefined,
      description: typeof msg.description === 'string' ? msg.description.slice(0, 500) : undefined,
      messageCount: ctx.sessionManager.getHistoryCount(sid),
    })
    ctx.send(ws, {
      type: 'checkpoint_created',
      sessionId: sid,
      checkpoint: {
        id: checkpoint.id,
        name: checkpoint.name,
        description: checkpoint.description,
        messageCount: checkpoint.messageCount,
        createdAt: checkpoint.createdAt,
        hasGitSnapshot: !!checkpoint.gitRef,
      },
    })
  } catch (err) {
    sendSessionError(ws, ctx, `Failed to create checkpoint: ${err.message}`)
  }
}

function handleListCheckpoints(ws, client, msg, ctx) {
  const sid = client.activeSessionId
  if (!sid) {
    ctx.send(ws, { type: 'checkpoint_list', sessionId: null, checkpoints: [] })
    return
  }
  const checkpoints = ctx.checkpointManager.listCheckpoints(sid)
  ctx.send(ws, { type: 'checkpoint_list', sessionId: sid, checkpoints })
}

async function handleRestoreCheckpoint(ws, client, msg, ctx) {
  const sid = client.activeSessionId
  if (!sid || !ctx.sessionManager) {
    sendSessionError(ws, ctx, 'No active session')
    return
  }
  if (typeof msg.checkpointId !== 'string') {
    sendSessionError(ws, ctx, 'Missing checkpointId')
    return
  }
  const currentEntry = ctx.sessionManager.getSession(sid)
  if (currentEntry?.session?.isRunning) {
    sendSessionError(ws, ctx, 'Cannot restore checkpoint while session is busy. Wait for the current task to finish or interrupt first.')
    return
  }
  try {
    const checkpoint = await ctx.checkpointManager.restoreCheckpoint(sid, msg.checkpointId)
    const newSessionId = await ctx.sessionManager.createSession({
      resumeSessionId: checkpoint.resumeSessionId,
      cwd: checkpoint.cwd,
      name: `Rewind: ${checkpoint.name}`,
    })
    // #5563: index-maintaining helper. Checkpoint restore moves the active
    // session WITHOUT subscribing, so the index must follow activeSessionId.
    ctx.setActiveSession(client, newSessionId)
    const newEntry = ctx.sessionManager.getSession(newSessionId)
    ctx.send(ws, {
      type: 'checkpoint_restored',
      checkpointId: checkpoint.id,
      newSessionId,
      name: newEntry?.name || `Rewind: ${checkpoint.name}`,
    })
    ctx.broadcastSessionList()
  } catch (err) {
    sendSessionError(ws, ctx, `Failed to restore checkpoint: ${err.message}`)
  }
}

function handleDeleteCheckpoint(ws, client, msg, ctx) {
  const sid = client.activeSessionId
  if (!sid) return
  if (typeof msg.checkpointId === 'string') {
    ctx.checkpointManager.deleteCheckpoint(sid, msg.checkpointId)
    const checkpoints = ctx.checkpointManager.listCheckpoints(sid)
    ctx.send(ws, { type: 'checkpoint_list', sessionId: sid, checkpoints })
  }
}

export const checkpointHandlers = {
  create_checkpoint: handleCreateCheckpoint,
  list_checkpoints: handleListCheckpoints,
  restore_checkpoint: handleRestoreCheckpoint,
  delete_checkpoint: handleDeleteCheckpoint,
}
