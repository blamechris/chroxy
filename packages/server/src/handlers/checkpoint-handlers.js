/**
 * Checkpoint management handlers.
 *
 * Handles: create_checkpoint, list_checkpoints, restore_checkpoint, delete_checkpoint
 */

async function handleCreateCheckpoint(ws, client, msg, ctx) {
  const sid = client.activeSessionId
  if (!sid || !ctx.sessionManager) {
    ctx.send(ws, { type: 'session_error', message: 'No active session' })
    return
  }
  const entry = ctx.sessionManager.getSession(sid)
  if (!entry) {
    ctx.send(ws, { type: 'session_error', message: `Session not found: ${sid}` })
    return
  }
  if (!entry.session.resumeSessionId) {
    ctx.send(ws, { type: 'session_error', message: 'Cannot create checkpoint before first message' })
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
    ctx.send(ws, { type: 'session_error', message: `Failed to create checkpoint: ${err.message}` })
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
    ctx.send(ws, { type: 'session_error', message: 'No active session' })
    return
  }
  if (typeof msg.checkpointId !== 'string') {
    ctx.send(ws, { type: 'session_error', message: 'Missing checkpointId' })
    return
  }
  const currentEntry = ctx.sessionManager.getSession(sid)
  if (currentEntry?.session?.isRunning) {
    ctx.send(ws, { type: 'session_error', message: 'Cannot restore checkpoint while session is busy. Wait for the current task to finish or interrupt first.' })
    return
  }
  try {
    const checkpoint = await ctx.checkpointManager.restoreCheckpoint(sid, msg.checkpointId)
    const newSessionId = await ctx.sessionManager.createSession({
      resumeSessionId: checkpoint.resumeSessionId,
      cwd: checkpoint.cwd,
      name: `Rewind: ${checkpoint.name}`,
    })
    client.activeSessionId = newSessionId
    const newEntry = ctx.sessionManager.getSession(newSessionId)
    ctx.send(ws, {
      type: 'checkpoint_restored',
      checkpointId: checkpoint.id,
      newSessionId,
      name: newEntry?.name || `Rewind: ${checkpoint.name}`,
    })
    ctx.broadcastSessionList()
  } catch (err) {
    ctx.send(ws, { type: 'session_error', message: `Failed to restore checkpoint: ${err.message}` })
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
