/**
 * Checkpoint management handlers.
 *
 * Handles: create_checkpoint, list_checkpoints, restore_checkpoint, delete_checkpoint
 */
import { realpathSync } from 'fs'
import { sendSessionError } from '../handler-utils.js'
import { createLogger } from '../logger.js'

const log = createLogger('ws')

/**
 * Normalize a cwd for collision comparison so two sessions on the SAME physical
 * directory reached via different strings (trailing slash, symlink, an explicit
 * path vs the equivalent default) still compare equal. realpathSync resolves
 * symlinks and drops trailing slashes; if the path doesn't exist (or perms),
 * fall back to a trailing-slash-stripped form so '/repo' and '/repo/' still
 * match. Without this the #5731 T8 shared-cwd guard would miss a real collision.
 * @param {*} p
 * @returns {*}
 */
function normalizeCwd(p) {
  if (typeof p !== 'string' || !p) return p
  try {
    return realpathSync(p)
  } catch {
    return p.replace(/\/+$/, '') || p
  }
}

async function handleCreateCheckpoint(ws, client, msg, ctx) {
  const sid = client.activeSessionId
  if (!sid || !ctx.sessions.sessionManager) {
    sendSessionError(ws, ctx, 'No active session')
    return
  }
  const entry = ctx.sessions.sessionManager.getSession(sid)
  if (!entry) {
    sendSessionError(ws, ctx, `Session not found: ${sid}`)
    return
  }
  if (!entry.session.resumeSessionId) {
    sendSessionError(ws, ctx, 'Cannot create checkpoint before first message')
    return
  }
  try {
    const checkpoint = await ctx.services.checkpointManager.createCheckpoint({
      sessionId: sid,
      resumeSessionId: entry.session.resumeSessionId,
      cwd: entry.cwd,
      name: typeof msg.name === 'string' ? msg.name.slice(0, 100) : undefined,
      description: typeof msg.description === 'string' ? msg.description.slice(0, 500) : undefined,
      messageCount: ctx.sessions.sessionManager.getHistoryCount(sid),
    })
    ctx.transport.send(ws, {
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
    ctx.transport.send(ws, { type: 'checkpoint_list', sessionId: null, checkpoints: [] })
    return
  }
  const checkpoints = ctx.services.checkpointManager.listCheckpoints(sid)
  ctx.transport.send(ws, { type: 'checkpoint_list', sessionId: sid, checkpoints })
}

async function handleRestoreCheckpoint(ws, client, msg, ctx) {
  const sid = client.activeSessionId
  if (!sid || !ctx.sessions.sessionManager) {
    sendSessionError(ws, ctx, 'No active session')
    return
  }
  if (typeof msg.checkpointId !== 'string') {
    sendSessionError(ws, ctx, 'Missing checkpointId')
    return
  }
  const currentEntry = ctx.sessions.sessionManager.getSession(sid)
  if (currentEntry?.session?.isRunning) {
    sendSessionError(ws, ctx, 'Cannot restore checkpoint while session is busy. Wait for the current task to finish or interrupt first.')
    return
  }
  // #5731 T8 (confirms deferred #5700): restoring hard-resets the working tree
  // at the checkpoint's cwd. If ANOTHER non-destroying session shares that cwd
  // (the default for non-worktree sessions) and is mid-turn, the reset yanks
  // files out from under its active work. Refuse and name it — mirroring the
  // current-session busy guard above and the destroy-while-busy guard. Idle
  // co-located sessions aren't blocked (recoverable, and blocking the common
  // "two tabs on one repo" case would be more surprising than helpful);
  // worktree-isolated sessions each have a distinct cwd and never collide.
  // listSessions() already excludes sessions mid-destroy. Both accessors are
  // feature-detected so a partial/legacy manager can't crash the restore path,
  // and the whole scan is wrapped so an unexpected accessor failure (throw or a
  // non-array return) fails OPEN — the guard is defense-in-depth, so on its own
  // error we fall through to the normal restore (the pre-#5731 behaviour) rather
  // than crashing the WS message handler.
  try {
    const checkpointMgr = ctx.services.checkpointManager
    const sessionMgr = ctx.sessions.sessionManager
    if (typeof checkpointMgr.getCheckpoint === 'function' && typeof sessionMgr.listSessions === 'function') {
      const cp = checkpointMgr.getCheckpoint(sid, msg.checkpointId)
      const liveSessions = sessionMgr.listSessions()
      if (cp?.cwd && Array.isArray(liveSessions)) {
        const targetCwd = normalizeCwd(cp.cwd)
        const busyShare = liveSessions.find(
          (s) => s && s.sessionId !== sid && s.isBusy && normalizeCwd(s.cwd) === targetCwd,
        )
        if (busyShare) {
          sendSessionError(ws, ctx, `Cannot restore checkpoint: another session ("${busyShare.name}") is busy in the same working directory and would lose its in-progress changes. Wait for it to finish or interrupt it first.`)
          return
        }
      }
    }
  } catch (err) {
    log.warn(`Shared-cwd restore guard skipped (accessor error, failing open): ${err?.message || err}`)
  }
  try {
    const checkpoint = await ctx.services.checkpointManager.restoreCheckpoint(sid, msg.checkpointId)
    const newSessionId = await ctx.sessions.sessionManager.createSession({
      resumeSessionId: checkpoint.resumeSessionId,
      cwd: checkpoint.cwd,
      name: `Rewind: ${checkpoint.name}`,
    })
    // #5563: index-maintaining helper. Checkpoint restore moves the active
    // session WITHOUT subscribing, so the index must follow activeSessionId.
    ctx.transport.setActiveSession(client, newSessionId)
    const newEntry = ctx.sessions.sessionManager.getSession(newSessionId)
    ctx.transport.send(ws, {
      type: 'checkpoint_restored',
      checkpointId: checkpoint.id,
      newSessionId,
      name: newEntry?.name || `Rewind: ${checkpoint.name}`,
    })
    ctx.transport.broadcastSessionList()
  } catch (err) {
    sendSessionError(ws, ctx, `Failed to restore checkpoint: ${err.message}`)
  }
}

function handleDeleteCheckpoint(ws, client, msg, ctx) {
  const sid = client.activeSessionId
  if (!sid) return
  if (typeof msg.checkpointId === 'string') {
    ctx.services.checkpointManager.deleteCheckpoint(sid, msg.checkpointId)
    const checkpoints = ctx.services.checkpointManager.listCheckpoints(sid)
    ctx.transport.send(ws, { type: 'checkpoint_list', sessionId: sid, checkpoints })
  }
}

export const checkpointHandlers = {
  create_checkpoint: handleCreateCheckpoint,
  list_checkpoints: handleListCheckpoints,
  restore_checkpoint: handleRestoreCheckpoint,
  delete_checkpoint: handleDeleteCheckpoint,
}
