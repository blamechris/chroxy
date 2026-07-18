/**
 * Checkpoint management handlers.
 *
 * Handles: create_checkpoint, list_checkpoints, restore_checkpoint, delete_checkpoint
 */
import { realpathSync } from 'fs'
import { sendSessionError, broadcastFocusChanged } from '../handler-utils.js'
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
      // #6766: capture the conversation fork boundary so a later restore can
      // truncate the transcript to this point (SDK provider only; others → null).
      boundaryMessageId: entry.session.lastMessageUuid,
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
  // #6767: selective restore mode. 'files' reverts only the working tree and
  // keeps the CURRENT session/conversation (no fork, no new session); 'conversation'
  // branches the conversation at the checkpoint and leaves the working tree
  // untouched (fork-capable providers only); 'both' (the default and the pre-#6767
  // behaviour) does both. Any unknown value falls back to 'both'.
  const mode = msg.mode === 'files' || msg.mode === 'conversation' || msg.mode === 'both' ? msg.mode : 'both'
  const currentEntry = ctx.sessions.sessionManager.getSession(sid)
  if (currentEntry?.session?.isRunning) {
    sendSessionError(ws, ctx, 'Cannot restore checkpoint while session is busy. Wait for the current task to finish or interrupt first.')
    return
  }
  // #6767: whether the ORIGINAL session's provider can branch the conversation.
  const origSession = currentEntry?.session
  const forkCapable = !!(
    origSession &&
    origSession.supportsConversationFork === true &&
    typeof origSession.forkConversation === 'function'
  )
  // #6767: 'conversation' mode is meaningless on a provider that can't fork a
  // resumed transcript — reject clearly rather than silently doing nothing (or
  // a misleading full-transcript resume). 'files'/'both' still work everywhere.
  if (mode === 'conversation' && !forkCapable) {
    sendSessionError(ws, ctx, "This session's provider can't restore the conversation only — it can't branch a resumed transcript. Use \"Files\" or \"Both\" instead.")
    return
  }
  // #6767: only 'files'/'both' hard-reset the working tree. 'conversation' leaves
  // it untouched, so it neither needs the shared-cwd guard below nor the git restore.
  const restoreFiles = mode !== 'conversation'
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
  // than crashing the WS message handler. Skipped entirely for 'conversation'
  // mode (#6767), which never touches the working tree.
  if (restoreFiles) {
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
  }
  try {
    // #6767: 'files'/'both' restore the git snapshot; 'conversation' reads the
    // checkpoint WITHOUT touching the working tree.
    let checkpoint
    if (restoreFiles) {
      checkpoint = await ctx.services.checkpointManager.restoreCheckpoint(sid, msg.checkpointId)
    } else {
      checkpoint = ctx.services.checkpointManager.getCheckpoint(sid, msg.checkpointId)
      if (!checkpoint) throw new Error(`Checkpoint not found: ${msg.checkpointId}`)
    }

    // #6766/#6767: decide whether this rewind branches the conversation. A real
    // branch needs (a) a fork-capable provider on the ORIGINAL session, (b) a
    // captured fork boundary, and (c) a mode that includes the conversation
    // ('conversation'/'both'; 'files' never forks). When they hold, fork the
    // conversation truncated to the boundary so the rewound session resumes AT
    // the checkpoint's point (not the full latest transcript); otherwise resume
    // the checkpoint's conversation id unchanged and report the restore as
    // files-only so the UI never claims a conversation rewind it didn't do.
    const boundaryMessageId = checkpoint.boundaryMessageId
    const hasBoundary = typeof boundaryMessageId === 'string' && boundaryMessageId.length > 0
    // #6767: a 'conversation'-only rewind has no file restore to fall back on, so
    // a checkpoint with no branch point (created before fork support) can't be
    // honored — reject instead of resuming the full latest transcript with no
    // change. 'both' still degrades to files-only in that case (below).
    if (mode === 'conversation' && !hasBoundary) {
      sendSessionError(ws, ctx, 'This checkpoint has no conversation branch point (it predates conversation-fork support). Use "Files" or "Both" instead.')
      return
    }
    const branchConversation = mode !== 'files'
    let resumeSessionId = checkpoint.resumeSessionId
    let filesOnly = true
    if (branchConversation && forkCapable && hasBoundary) {
      try {
        const forkedId = await origSession.forkConversation({
          sessionId: checkpoint.resumeSessionId,
          upToMessageId: boundaryMessageId,
        })
        if (forkedId) {
          resumeSessionId = forkedId
          filesOnly = false
        } else {
          log.warn('Checkpoint conversation fork returned no id — restoring files only')
        }
      } catch (err) {
        log.warn(`Checkpoint conversation fork failed, restoring files only: ${err.message}`)
      }
    }
    // #6767: a 'conversation'-only rewind that failed to branch would create a
    // misleading full-transcript session with no file change — surface the
    // failure instead. (Verified fork-capable + boundary above, so this only
    // fires when forkConversation itself throws or returns no id.)
    if (mode === 'conversation' && filesOnly) {
      sendSessionError(ws, ctx, 'Failed to branch the conversation for this checkpoint. The working tree was left unchanged.')
      return
    }

    // #6767: 'files' mode reverts only the working tree — the current session and
    // conversation continue, so there is no new session and nothing to re-home.
    if (mode === 'files') {
      ctx.transport.send(ws, {
        type: 'checkpoint_restored',
        checkpointId: checkpoint.id,
        // No newSessionId: the client stays on the current session. `name` here
        // is the CHECKPOINT's name (there is no new session to name) so clients
        // can confirm "Files restored to checkpoint <name>" visibly (#6827).
        name: checkpoint.name,
        filesOnly: true,
        mode,
      })
      return
    }

    const newSessionId = await ctx.sessions.sessionManager.createSession({
      resumeSessionId,
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
      // #6766: true when only the working tree was restored (conversation NOT
      // branched); false when the conversation was forked/truncated to the
      // checkpoint. Lets clients describe what actually happened truthfully.
      filesOnly,
      // #6767: echo the selective-restore mode ('conversation' | 'both') so the
      // client can word the outcome precisely.
      mode,
    })
    // The initiator's active session moved to the rewound session above; announce
    // it to presence/Control-Room observers (the loop below does the same for the
    // other re-homed clients).
    broadcastFocusChanged(client, newSessionId, ctx)
    // #5700: re-home OTHER clients that were actively viewing the original
    // session onto the rewound session — mirroring the destroy path's
    // client-iteration (session-handlers.js). Without this the initiator
    // switches to the rewound session while every other subscriber keeps showing
    // the original session's pre-rewind history (two clients, two histories, no
    // reconciliation until a manual re-subscribe). The original session is NOT
    // destroyed; its active viewers simply follow the rewind.
    for (const [otherWs, c] of ctx.transport.clients) {
      if (c === client) continue // initiator already re-homed above
      if (!c.authenticated || c.activeSessionId !== sid) continue
      // A pairing-bound client is cryptographically scoped to its bound session.
      // Unlike the destroy path (where the session is gone, so re-homing is
      // forced), restore leaves the original session intact — so a bound client
      // must stay on it, never be auto-switched to the rewound session (mirrors
      // the switch_session boundSessionId enforcement). #5700 review.
      if (c.boundSessionId) continue
      ctx.transport.setActiveSession(c, newSessionId)
      ctx.transport.send(otherWs, {
        type: 'session_switched',
        sessionId: newSessionId,
        name: newEntry?.name || `Rewind: ${checkpoint.name}`,
        cwd: newEntry?.cwd,
        conversationId: newEntry?.session?.resumeSessionId || null,
      })
      ctx.transport.sendSessionInfo(otherWs, newSessionId)
      // #5555.3 — forced re-home after a rewind: authoritative full rebuild.
      ctx.transport.replayHistory(otherWs, newSessionId, { forceFull: true })
      broadcastFocusChanged(c, newSessionId, ctx)
    }
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
