import { statSync, realpathSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { resolve, relative, basename } from 'path'
import { ALLOWED_MODEL_IDS, toShortModelId } from './models.js'
import { WebTaskUnavailableError } from './web-task-manager.js'
import { scanConversations, groupConversationsByRepo } from './conversation-scanner.js'
import { searchConversations } from './conversation-search.js'
import { readReposFromConfig, writeReposToConfig } from './config.js'

// -- Permission modes --
export const PERMISSION_MODES = [
  { id: 'approve', label: 'Approve' },
  { id: 'acceptEdits', label: 'Accept Edits' },
  { id: 'auto', label: 'Auto' },
  { id: 'plan', label: 'Plan' },
]
export const ALLOWED_PERMISSION_MODE_IDS = new Set(PERMISSION_MODES.map((m) => m.id))

// -- Attachment validation constants --
export const MAX_ATTACHMENT_COUNT = 5
export const MAX_IMAGE_SIZE = 2 * 1024 * 1024       // 2MB decoded
export const MAX_DOCUMENT_SIZE = 5 * 1024 * 1024    // 5MB decoded
export const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const ALLOWED_DOC_TYPES = new Set(['application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/json'])

/**
 * Validate an attachments array from a WebSocket message.
 * Returns null if valid, or an error string if invalid.
 */
export function validateAttachments(attachments) {
  if (!Array.isArray(attachments)) return 'attachments must be an array'
  if (attachments.length > MAX_ATTACHMENT_COUNT) return `too many attachments (max ${MAX_ATTACHMENT_COUNT})`
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i]
    if (!att || typeof att !== 'object') return `attachment[${i}]: not an object`
    if (typeof att.type !== 'string' || (att.type !== 'image' && att.type !== 'document' && att.type !== 'file_ref')) {
      return `attachment[${i}]: type must be 'image', 'document', or 'file_ref'`
    }

    // file_ref: project-relative path — server reads content before sending to Claude
    if (att.type === 'file_ref') {
      if (typeof att.path !== 'string' || !att.path.trim()) {
        return `attachment[${i}]: file_ref requires a non-empty path`
      }
      if (att.path.startsWith('/')) {
        return `attachment[${i}]: file_ref path must not be absolute`
      }
      if (att.path.split('/').includes('..')) {
        return `attachment[${i}]: file_ref path must not contain traversal (..)`
      }
      continue
    }

    if (typeof att.mediaType !== 'string') return `attachment[${i}]: missing mediaType`
    if (typeof att.data !== 'string') return `attachment[${i}]: missing data`
    if (typeof att.name !== 'string') return `attachment[${i}]: missing name`

    if (att.type === 'image' && !ALLOWED_IMAGE_TYPES.has(att.mediaType)) {
      return `attachment[${i}]: type 'image' requires an image mediaType`
    }
    if (att.type === 'document' && !ALLOWED_DOC_TYPES.has(att.mediaType)) {
      return `attachment[${i}]: type 'document' requires a document mediaType`
    }

    const decodedSize = Math.ceil(att.data.length * 3 / 4)
    const maxSize = att.type === 'image' ? MAX_IMAGE_SIZE : MAX_DOCUMENT_SIZE
    if (decodedSize > maxSize) {
      return `attachment[${i}]: exceeds ${maxSize / (1024 * 1024)}MB limit`
    }
  }
  return null
}

/**
 * Validate that a cwd path exists, is a directory, and is within the user's home directory.
 * Returns null if valid, or an error string describing the problem.
 * @param {string} cwd - The directory path to validate
 * @returns {string|null} Error message or null if valid
 */
function validateCwdWithinHome(cwd) {
  try {
    const s = statSync(cwd)
    if (!s.isDirectory()) return `Not a directory: ${cwd}`
  } catch {
    return `Directory does not exist: ${cwd}`
  }
  const home = homedir()
  let realCwd
  try {
    realCwd = realpathSync(cwd)
  } catch {
    return `Cannot resolve path: ${cwd}`
  }
  if (!realCwd.startsWith(home + '/') && realCwd !== home) {
    return 'Directory must be within your home directory'
  }
  return null
}

/**
 * Build merged repo list from auto-discovered and manual repos.
 * Manual repos come first, auto-discovered repos are deduplicated.
 */
async function buildRepoList() {
  const conversations = await scanConversations()
  const autoRepos = groupConversationsByRepo(conversations)
  const manualRepos = readReposFromConfig()
  const seen = new Set()
  const repos = []

  for (const repo of manualRepos) {
    seen.add(repo.path)
    let exists = false
    try { statSync(repo.path); exists = true } catch { /* noop */ }
    repos.push({ path: repo.path, name: repo.name || basename(repo.path), source: 'manual', exists })
  }

  for (const repo of autoRepos) {
    if (seen.has(repo.path)) continue
    seen.add(repo.path)
    let exists = false
    try { statSync(repo.path); exists = true } catch { /* noop */ }
    repos.push({ path: repo.path, name: repo.name, source: 'auto', exists })
  }

  return repos
}

const MAX_FILE_REF_SIZE = 1 * 1024 * 1024 // 1MB max per file_ref

/**
 * Resolve file_ref attachments by reading file content from the session's cwd.
 * Converts file_ref entries to standard document attachments with base64 data.
 * Non-file_ref attachments are passed through unchanged.
 *
 * @param {Array} attachments - Validated attachment array
 * @param {string} cwd - Session working directory
 * @returns {Array} Resolved attachments (file_ref → document with inline text)
 */
export function resolveFileRefAttachments(attachments, cwd) {
  if (!attachments?.length || !cwd) return attachments
  return attachments.map(att => {
    if (att.type !== 'file_ref') return att
    const absPath = resolve(cwd, att.path)
    // Security: ensure resolved path is within cwd
    const rel = relative(cwd, absPath)
    if (rel.startsWith('..') || resolve(cwd, rel) !== absPath) {
      return { type: 'document', mediaType: 'text/plain', data: Buffer.from(`[Error: cannot read file outside project: ${att.path}]`).toString('base64'), name: att.name || att.path }
    }
    // Security: verify after symlink resolution to prevent symlink escape
    try {
      const realAbs = realpathSync(absPath)
      const realCwd = realpathSync(cwd)
      const realRel = relative(realCwd, realAbs)
      if (realRel.startsWith('..')) {
        return { type: 'document', mediaType: 'text/plain', data: Buffer.from(`[Error: cannot read file outside project: ${att.path}]`).toString('base64'), name: att.name || att.path }
      }
    } catch {
      // realpathSync fails if file doesn't exist — let readFileSync handle ENOENT below
    }
    try {
      const stat = statSync(absPath)
      if (stat.size > MAX_FILE_REF_SIZE) {
        return { type: 'document', mediaType: 'text/plain', data: Buffer.from(`[Error: file too large (${(stat.size / 1024).toFixed(0)}KB, max 1MB): ${att.path}]`).toString('base64'), name: att.name || att.path }
      }
      // Detect binary files by checking for null bytes in the first 8KB
      const raw = readFileSync(absPath)
      const sample = raw.subarray(0, 8192)
      if (sample.includes(0)) {
        return { type: 'document', mediaType: 'text/plain', data: Buffer.from(`[Error: binary file not supported: ${att.path}]`).toString('base64'), name: att.name || att.path }
      }
      const content = raw.toString('utf-8')
      return { type: 'document', mediaType: 'text/plain', data: Buffer.from(content).toString('base64'), name: att.name || att.path }
    } catch (err) {
      const msg = err?.code === 'ENOENT' ? 'file not found' : err?.code === 'EACCES' ? 'permission denied' : 'read error'
      return { type: 'document', mediaType: 'text/plain', data: Buffer.from(`[Error: ${msg}: ${att.path}]`).toString('base64'), name: att.name || att.path }
    }
  })
}

/**
 * Handle messages in multi-session mode.
 *
 * ctx shape: {
 *   send, broadcast, broadcastToSession, broadcastSessionList,
 *   sessionManager, checkpointManager, devPreview, webTaskManager,
 *   pushManager, primaryClients, clients,
 *   permissionSessionMap, questionSessionMap, pendingPermissions,
 *   fileOps, permissions,
 *   updatePrimary, sendSessionInfo, replayHistory,
 *   draining,
 * }
 */
export async function handleSessionMessage(ws, client, msg, ctx) {
  switch (msg.type) {
    case 'input': {
      const text = msg.data
      let attachments = Array.isArray(msg.attachments) ? msg.attachments : undefined
      const targetSessionId = msg.sessionId || client.activeSessionId
      const entry = ctx.sessionManager.getSession(targetSessionId)
      if (!entry) {
        const message = msg.sessionId
          ? `Session not found: ${msg.sessionId}`
          : 'No active session'
        ctx.send(ws, { type: 'session_error', message })
        break
      }

      if (attachments?.length) {
        const err = validateAttachments(attachments)
        if (err) {
          ctx.send(ws, { type: 'session_error', message: `Invalid attachment: ${err}` })
          attachments = undefined
          break
        }
      }

      // Resolve file_ref attachments to actual file content
      if (attachments?.length) {
        attachments = resolveFileRefAttachments(attachments, entry.cwd)
      }

      if ((!text || !text.trim()) && !attachments?.length) break
      const trimmed = text?.trim() || ''
      const attCount = attachments?.length || 0
      console.log(`[ws] Message from ${client.id} to session ${targetSessionId}: "${trimmed.slice(0, 80)}"${attCount ? ` (+${attCount} attachment(s))` : ''}`)

      if (ctx.sessionManager.isBudgetPaused(targetSessionId)) {
        ctx.send(ws, { type: 'session_error', message: 'Session is paused — cost budget exceeded. Use "Resume Budget" to continue.' })
        break
      }

      if (entry.session.resumeSessionId) {
        ctx.checkpointManager.createCheckpoint({
          sessionId: targetSessionId,
          resumeSessionId: entry.session.resumeSessionId,
          cwd: entry.cwd,
          description: trimmed.slice(0, 100),
          messageCount: ctx.sessionManager.getHistoryCount(targetSessionId),
        }).catch((err) => console.warn(`[ws] Auto-checkpoint failed: ${err.message}`))
      }
      const historyText = attCount ? `${trimmed}${trimmed ? ' ' : ''}[${attCount} file(s) attached]` : trimmed
      ctx.sessionManager.recordUserInput(targetSessionId, historyText)
      ctx.sessionManager.touchActivity(targetSessionId)
      entry.session.sendMessage(trimmed, attachments, { isVoice: !!msg.isVoice })

      ctx.updatePrimary(targetSessionId, client.id)
      break
    }

    case 'interrupt': {
      const interruptSessionId = msg.sessionId || client.activeSessionId
      const entry = ctx.sessionManager.getSession(interruptSessionId)
      if (entry) {
        console.log(`[ws] Interrupt from ${client.id} to session ${interruptSessionId}`)
        entry.session.interrupt()
      }
      break
    }

    case 'resume_budget': {
      const budgetSessionId = msg.sessionId || client.activeSessionId
      if (!budgetSessionId || !ctx.sessionManager.getSession(budgetSessionId)) {
        ctx.send(ws, { type: 'session_error', message: 'No valid session for budget resume' })
        break
      }
      if (ctx.sessionManager.isBudgetPaused(budgetSessionId)) {
        ctx.sessionManager.resumeBudget(budgetSessionId)
        ctx.broadcastToSession(budgetSessionId, { type: 'budget_resumed', sessionId: budgetSessionId })
        console.log(`[ws] Budget resumed for session ${budgetSessionId} by ${client.id}`)
      }
      break
    }

    case 'set_model': {
      if (
        typeof msg.model === 'string' &&
        ALLOWED_MODEL_IDS.has(msg.model)
      ) {
        const modelSessionId = msg.sessionId || client.activeSessionId
        const entry = ctx.sessionManager.getSession(modelSessionId)
        if (entry) {
          console.log(`[ws] Model change from ${client.id} on session ${modelSessionId}: ${msg.model}`)
          entry.session.setModel(msg.model)
          ctx.broadcastToSession(modelSessionId, { type: 'model_changed', model: toShortModelId(msg.model) })
        }
      } else {
        console.warn(`[ws] Rejected invalid model from ${client.id}: ${JSON.stringify(msg.model)}`)
      }
      break
    }

    case 'set_permission_mode': {
      if (
        typeof msg.mode === 'string' &&
        ALLOWED_PERMISSION_MODE_IDS.has(msg.mode)
      ) {
        const permModeSessionId = msg.sessionId || client.activeSessionId
        const entry = ctx.sessionManager.getSession(permModeSessionId)
        if (entry) {
          if (msg.mode === 'plan' && !entry.session.constructor.capabilities?.planMode) {
            ctx.send(ws, { type: 'session_error', message: 'This provider does not support plan mode' })
            break
          }
          if (msg.mode === 'auto' && !msg.confirmed) {
            console.log(`[ws] Auto mode requested by ${client.id}, awaiting confirmation`)
            ctx.send(ws, {
              type: 'confirm_permission_mode',
              mode: 'auto',
              warning: 'Auto mode bypasses all permission checks. Claude will execute tools without asking.',
            })
          } else {
            if (msg.mode === 'auto') {
              console.log(`[ws] Auto permission mode CONFIRMED by ${client.id} at ${new Date().toISOString()}`)
            } else {
              console.log(`[ws] Permission mode change from ${client.id} on session ${permModeSessionId}: ${msg.mode}`)
            }
            entry.session.setPermissionMode(msg.mode)
            ctx.broadcastToSession(permModeSessionId, { type: 'permission_mode_changed', mode: msg.mode })
          }
        }
      } else {
        console.warn(`[ws] Rejected invalid permission mode from ${client.id}: ${JSON.stringify(msg.mode)}`)
      }
      break
    }

    case 'permission_response': {
      const { requestId, decision } = msg
      if (!requestId || !decision) break

      const originSessionId = ctx.permissionSessionMap.get(requestId) || client.activeSessionId
      ctx.permissionSessionMap.delete(requestId)

      if (originSessionId && ctx.sessionManager) {
        const entry = ctx.sessionManager.getSession(originSessionId)
        if (entry && typeof entry.session.respondToPermission === 'function') {
          const hasPending = entry.session._pendingPermissions?.has(requestId)
          if (hasPending !== false) {
            entry.session.respondToPermission(requestId, decision)
          } else {
            ctx.send(ws, { type: 'permission_expired', requestId, sessionId: originSessionId, message: 'This permission request has expired or was already handled' })
          }
          break
        }
      }

      if (ctx.pendingPermissions.has(requestId)) {
        ctx.permissions.resolvePermission(requestId, decision)
      } else {
        ctx.send(ws, { type: 'permission_expired', requestId, sessionId: originSessionId, message: 'This permission request has expired or was already handled' })
      }
      break
    }

    case 'list_sessions':
      ctx.send(ws, { type: 'session_list', sessions: ctx.sessionManager.listSessions() })
      break

    case 'switch_session': {
      const targetId = msg.sessionId
      const entry = ctx.sessionManager.getSession(targetId)
      if (!entry) {
        ctx.send(ws, { type: 'session_error', message: `Session not found: ${targetId}` })
        break
      }
      client.activeSessionId = targetId
      client.subscribedSessionIds.add(targetId)
      console.log(`[ws] Client ${client.id} switched to session ${targetId}`)
      ctx.send(ws, { type: 'session_switched', sessionId: targetId, name: entry.name, cwd: entry.cwd, conversationId: entry.session.resumeSessionId || null })
      ctx.sendSessionInfo(ws, targetId)
      ctx.replayHistory(ws, targetId)
      // Notify other clients about this client's focus change
      ctx.broadcast(
        { type: 'client_focus_changed', clientId: client.id, sessionId: targetId, timestamp: Date.now() },
        (c) => c.id !== client.id
      )
      break
    }

    case 'create_session': {
      const name = (typeof msg.name === 'string' && msg.name.trim()) ? msg.name.trim() : undefined
      const cwd = (typeof msg.cwd === 'string' && msg.cwd.trim()) ? msg.cwd.trim() : undefined
      const provider = (typeof msg.provider === 'string' && msg.provider.trim()) ? msg.provider.trim() : undefined

      if (cwd) {
        const cwdError = validateCwdWithinHome(cwd)
        if (cwdError) {
          ctx.send(ws, { type: 'session_error', message: cwdError })
          break
        }
      }

      try {
        const sessionId = ctx.sessionManager.createSession({ name, cwd, provider })
        client.activeSessionId = sessionId
        const entry = ctx.sessionManager.getSession(sessionId)
        ctx.send(ws, { type: 'session_switched', sessionId, name: entry.name, cwd: entry.cwd, conversationId: entry.session.resumeSessionId || null })
        ctx.sendSessionInfo(ws, sessionId)
        ctx.broadcast({ type: 'session_list', sessions: ctx.sessionManager.listSessions() })
      } catch (err) {
        ctx.send(ws, { type: 'session_error', message: err.message })
      }
      break
    }

    case 'destroy_session': {
      const targetId = msg.sessionId
      if (!ctx.sessionManager.getSession(targetId)) {
        ctx.send(ws, { type: 'session_error', message: `Session not found: ${targetId}` })
        break
      }

      if (ctx.sessionManager.listSessions().length <= 1) {
        ctx.send(ws, { type: 'session_error', message: 'Cannot destroy the last session' })
        break
      }

      ctx.sessionManager.destroySession(targetId)
      ctx.primaryClients.delete(targetId)

      const firstId = ctx.sessionManager.firstSessionId
      for (const [clientWs, c] of ctx.clients) {
        c.subscribedSessionIds?.delete(targetId)
        if (c.authenticated && c.activeSessionId === targetId) {
          c.activeSessionId = firstId
          const entry = ctx.sessionManager.getSession(firstId)
          if (entry) {
            ctx.send(clientWs, { type: 'session_switched', sessionId: firstId, name: entry.name, cwd: entry.cwd, conversationId: entry.session.resumeSessionId || null })
            ctx.sendSessionInfo(clientWs, firstId)
          }
        }
      }

      ctx.broadcast({ type: 'session_destroyed', sessionId: targetId })
      ctx.broadcast({ type: 'session_list', sessions: ctx.sessionManager.listSessions() })
      break
    }

    case 'rename_session': {
      const targetId = msg.sessionId
      const newName = (typeof msg.name === 'string' && msg.name.trim()) ? msg.name.trim() : null
      if (!newName) {
        ctx.send(ws, { type: 'session_error', message: 'Name is required' })
        break
      }
      if (ctx.sessionManager.renameSession(targetId, newName)) {
        ctx.broadcast({ type: 'session_list', sessions: ctx.sessionManager.listSessions() })
      } else {
        ctx.send(ws, { type: 'session_error', message: `Session not found: ${targetId}` })
      }
      break
    }

    case 'subscribe_sessions': {
      for (const sid of msg.sessionIds) {
        if (ctx.sessionManager.getSession(sid)) {
          client.subscribedSessionIds.add(sid)
        }
      }
      ctx.send(ws, {
        type: 'subscriptions_updated',
        subscribedSessionIds: [...client.subscribedSessionIds],
      })
      break
    }

    case 'unsubscribe_sessions': {
      for (const sid of msg.sessionIds) {
        if (sid !== client.activeSessionId) {
          client.subscribedSessionIds.delete(sid)
        }
      }
      ctx.send(ws, {
        type: 'subscriptions_updated',
        subscribedSessionIds: [...client.subscribedSessionIds],
      })
      break
    }

    case 'user_question_response': {
      const questionSessionId = (msg.toolUseId && ctx.questionSessionMap.get(msg.toolUseId))
        || client.activeSessionId
      if (msg.toolUseId) ctx.questionSessionMap.delete(msg.toolUseId)
      const entry = ctx.sessionManager.getSession(questionSessionId)
      if (entry && typeof entry.session.respondToQuestion === 'function' && typeof msg.answer === 'string') {
        entry.session.respondToQuestion(msg.answer)
      }
      break
    }

    case 'register_push_token':
      if (ctx.pushManager && typeof msg.token === 'string') {
        ctx.pushManager.registerToken(msg.token)
      }
      break

    case 'list_directory':
      ctx.fileOps.listDirectory(ws, msg.path)
      break

    case 'browse_files': {
      const browseSessionId = msg.sessionId || client.activeSessionId
      const browseEntry = ctx.sessionManager.getSession(browseSessionId)
      ctx.fileOps.browseFiles(ws, msg.path, browseEntry?.cwd || null)
      break
    }

    case 'list_files': {
      const listFilesSessionId = msg.sessionId || client.activeSessionId
      const listFilesEntry = ctx.sessionManager.getSession(listFilesSessionId)
      ctx.fileOps.listFiles(ws, listFilesEntry?.cwd || null, msg.query || null, listFilesSessionId)
      break
    }

    case 'read_file': {
      const readSessionId = msg.sessionId || client.activeSessionId
      const readEntry = ctx.sessionManager.getSession(readSessionId)
      ctx.fileOps.readFile(ws, msg.path, readEntry?.cwd || null)
      break
    }

    case 'get_diff': {
      const diffSessionId = msg.sessionId || client.activeSessionId
      const diffEntry = ctx.sessionManager.getSession(diffSessionId)
      ctx.fileOps.getDiff(ws, msg.base, diffEntry?.cwd || null)
      break
    }

    case 'list_slash_commands': {
      const cmdSessionId = msg.sessionId || client.activeSessionId
      const entry = ctx.sessionManager.getSession(cmdSessionId)
      const cwd = entry?.cwd || null
      ctx.fileOps.listSlashCommands(ws, cwd, cmdSessionId)
      break
    }

    case 'list_agents': {
      const agentSessionId = msg.sessionId || client.activeSessionId
      const entry = ctx.sessionManager.getSession(agentSessionId)
      const cwd = entry?.cwd || null
      ctx.fileOps.listAgents(ws, cwd, agentSessionId)
      break
    }

    case 'request_full_history': {
      const targetId = (typeof msg.sessionId === 'string' && msg.sessionId) || client.activeSessionId
      if (!targetId || !ctx.sessionManager.getSession(targetId)) {
        const message = msg.sessionId
          ? `Session not found: ${msg.sessionId}`
          : 'No active session'
        ctx.send(ws, { type: 'session_error', message })
        break
      }
      const fullHistory = await ctx.sessionManager.getFullHistoryAsync(targetId)
      ctx.send(ws, { type: 'history_replay_start', sessionId: targetId, fullHistory: true })
      for (const entry of fullHistory) {
        if (entry.type === 'user_input' || entry.type === 'response' || entry.type === 'tool_use') {
          ctx.send(ws, {
            type: 'message',
            messageType: entry.type,
            content: entry.content,
            tool: entry.tool,
            timestamp: entry.timestamp,
            sessionId: targetId,
          })
        } else {
          ctx.send(ws, { ...entry, sessionId: targetId })
        }
      }
      ctx.send(ws, { type: 'history_replay_end', sessionId: targetId })
      break
    }

    case 'list_conversations': {
      try {
        const conversations = await scanConversations()
        ctx.send(ws, { type: 'conversations_list', conversations })
      } catch (err) {
        console.warn(`[ws] Failed to scan conversations: ${err.message}`)
        ctx.send(ws, { type: 'conversations_list', conversations: [] })
      }
      break
    }

    case 'search_conversations': {
      const { query, maxResults } = msg
      try {
        const results = await searchConversations(query, { maxResults })
        ctx.send(ws, { type: 'search_results', query, results })
      } catch (err) {
        console.warn(`[ws] Failed to search conversations: ${err.message}`)
        ctx.send(ws, { type: 'search_results', query, results: [] })
      }
      break
    }

    case 'request_cost_summary': {
      const costSessions = ctx.sessionManager.listSessions()
      const sessionCosts = costSessions.map(s => ({
        sessionId: s.sessionId,
        name: s.name,
        cost: ctx.sessionManager.getSessionCost(s.sessionId),
        model: s.model || null,
      }))
      ctx.send(ws, {
        type: 'cost_summary',
        totalCost: ctx.sessionManager.getTotalCost(),
        budget: ctx.sessionManager.getCostBudget(),
        sessions: sessionCosts,
      })
      break
    }


    case 'resume_conversation': {
      // Check resume capability on the active session's provider
      const activeEntry = client.activeSessionId && ctx.sessionManager.getSession(client.activeSessionId)
      if (activeEntry && !activeEntry.session.constructor.capabilities?.resume) {
        ctx.send(ws, { type: 'session_error', message: 'This provider does not support conversation resume' })
        break
      }
      const { conversationId, cwd } = msg
      if (!conversationId || typeof conversationId !== 'string') {
        ctx.send(ws, { type: 'session_error', message: 'Missing conversationId' })
        break
      }
      // Validate conversationId is a UUID to prevent path traversal
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conversationId)) {
        ctx.send(ws, { type: 'session_error', message: 'Invalid conversationId format' })
        break
      }
      if (cwd) {
        const cwdError = validateCwdWithinHome(cwd)
        if (cwdError) {
          ctx.send(ws, { type: 'session_error', message: cwdError })
          break
        }
      }
      try {
        const name = (typeof msg.name === 'string' && msg.name.trim()) ? msg.name.trim() : 'Resumed'
        const sessionId = ctx.sessionManager.createSession({
          resumeSessionId: conversationId,
          cwd: cwd || undefined,
          name,
        })
        client.activeSessionId = sessionId
        const entry = ctx.sessionManager.getSession(sessionId)
        ctx.send(ws, { type: 'session_switched', sessionId, name: entry.name, cwd: entry.cwd, conversationId: entry.session.resumeSessionId || null })
        ctx.sendSessionInfo(ws, sessionId)
        ctx.replayHistory(ws, sessionId)
        ctx.broadcast({ type: 'session_list', sessions: ctx.sessionManager.listSessions() })
      } catch (err) {
        ctx.send(ws, { type: 'session_error', message: err.message })
      }
      break
    }

    case 'request_session_context': {
      const targetId = (typeof msg.sessionId === 'string' && msg.sessionId) || client.activeSessionId
      if (!targetId) {
        ctx.send(ws, { type: 'session_error', message: 'No active session' })
        break
      }
      try {
        const sessionCtx = await ctx.sessionManager.getSessionContext(targetId)
        if (sessionCtx) {
          ctx.send(ws, { type: 'session_context', ...sessionCtx })
        } else {
          ctx.send(ws, { type: 'session_error', message: `Session not found: ${targetId}` })
        }
      } catch (err) {
        console.warn(`[ws] Failed to read session context: ${err.message}`)
        ctx.send(ws, { type: 'session_error', message: `Failed to read session context: ${err.message}` })
      }
      break
    }

    case 'create_checkpoint': {
      const sid = client.activeSessionId
      if (!sid || !ctx.sessionManager) {
        ctx.send(ws, { type: 'session_error', message: 'No active session' })
        break
      }
      const entry = ctx.sessionManager.getSession(sid)
      if (!entry) {
        ctx.send(ws, { type: 'session_error', message: `Session not found: ${sid}` })
        break
      }
      if (!entry.session.resumeSessionId) {
        ctx.send(ws, { type: 'session_error', message: 'Cannot create checkpoint before first message' })
        break
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
      break
    }

    case 'list_checkpoints': {
      const sid = client.activeSessionId
      if (!sid) {
        ctx.send(ws, { type: 'checkpoint_list', sessionId: null, checkpoints: [] })
        break
      }
      const checkpoints = ctx.checkpointManager.listCheckpoints(sid)
      ctx.send(ws, { type: 'checkpoint_list', sessionId: sid, checkpoints })
      break
    }

    case 'restore_checkpoint': {
      const sid = client.activeSessionId
      if (!sid || !ctx.sessionManager) {
        ctx.send(ws, { type: 'session_error', message: 'No active session' })
        break
      }
      if (typeof msg.checkpointId !== 'string') {
        ctx.send(ws, { type: 'session_error', message: 'Missing checkpointId' })
        break
      }
      const currentEntry = ctx.sessionManager.getSession(sid)
      if (currentEntry?.session?.isRunning) {
        ctx.send(ws, { type: 'session_error', message: 'Cannot restore checkpoint while session is busy. Wait for the current task to finish or interrupt first.' })
        break
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
      break
    }

    case 'delete_checkpoint': {
      const sid = client.activeSessionId
      if (!sid) break
      if (typeof msg.checkpointId === 'string') {
        ctx.checkpointManager.deleteCheckpoint(sid, msg.checkpointId)
        const checkpoints = ctx.checkpointManager.listCheckpoints(sid)
        ctx.send(ws, { type: 'checkpoint_list', sessionId: sid, checkpoints })
      }
      break
    }

    case 'close_dev_preview': {
      const previewSessionId = (typeof msg.sessionId === 'string' && msg.sessionId) || client.activeSessionId
      if (previewSessionId && typeof msg.port === 'number') {
        ctx.devPreview.closePreview(previewSessionId, msg.port)
      }
      break
    }

    case 'launch_web_task': {
      if (msg.cwd) {
        const cwdError = validateCwdWithinHome(msg.cwd)
        if (cwdError) {
          ctx.send(ws, { type: 'web_task_error', taskId: null, message: cwdError })
          break
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
      break
    }

    case 'list_web_tasks': {
      const tasks = ctx.webTaskManager.listTasks()
      ctx.send(ws, { type: 'web_task_list', tasks })
      break
    }

    case 'teleport_web_task': {
      ctx.webTaskManager.teleportTask(msg.taskId).then(() => {
        console.log(`[ws] Teleported task ${msg.taskId}`)
        ctx.send(ws, { type: 'server_status', message: `Task ${msg.taskId} teleported to local session` })
      }).catch(err => {
        ctx.send(ws, { type: 'web_task_error', taskId: msg.taskId, message: err.message })
      })
      break
    }

    case 'list_repos': {
      try {
        const repos = await buildRepoList()
        ctx.send(ws, { type: 'repo_list', repos })
      } catch (err) {
        ctx.send(ws, { type: 'server_error', message: `Failed to list repos: ${err.message}`, recoverable: true })
      }
      break
    }

    case 'add_repo': {
      const repoPath = msg.path
      const cwdError = validateCwdWithinHome(repoPath)
      if (cwdError) {
        ctx.send(ws, { type: 'session_error', message: cwdError })
        break
      }

      try {
        const resolvedPath = realpathSync(repoPath)
        const existing = readReposFromConfig()
        if (!existing.some(r => r.path === resolvedPath)) {
          existing.push({ path: resolvedPath, name: msg.name || basename(resolvedPath) })
          writeReposToConfig(existing)
        }
        const repos = await buildRepoList()
        ctx.send(ws, { type: 'repo_list', repos })
      } catch (err) {
        ctx.send(ws, { type: 'session_error', message: `Failed to add repo: ${err.message}` })
      }
      break
    }

    case 'remove_repo': {
      const existing = readReposFromConfig()
      const filtered = existing.filter(r => r.path !== msg.path)
      writeReposToConfig(filtered)

      try {
        const repos = await buildRepoList()
        ctx.send(ws, { type: 'repo_list', repos })
      } catch (err) {
        ctx.send(ws, { type: 'server_error', message: `Failed to list repos: ${err.message}`, recoverable: true })
      }
      break
    }

    default:
      console.log(`[ws] Unknown message type: ${msg.type}`)
  }
}

/** Handle messages in legacy single CLI mode */
export function handleCliMessage(ws, client, msg, ctx) {
  switch (msg.type) {
    case 'input': {
      const text = msg.data
      let attachments = Array.isArray(msg.attachments) ? msg.attachments : undefined
      if (attachments?.length) {
        const err = validateAttachments(attachments)
        if (err) {
          ctx.send(ws, { type: 'session_error', message: `Invalid attachment: ${err}` })
          attachments = undefined
          break
        }
      }
      // Resolve file_ref attachments to actual file content
      if (attachments?.length) {
        attachments = resolveFileRefAttachments(attachments, ctx.cliSession?.cwd || null)
      }
      if ((!text || !text.trim()) && !attachments?.length) break
      const trimmed = text?.trim() || ''
      const attCount = attachments?.length || 0
      console.log(`[ws] Message from ${client.id}: "${trimmed.slice(0, 80)}"${attCount ? ` (+${attCount} attachment(s))` : ''}`)
      ctx.cliSession.sendMessage(trimmed, attachments, { isVoice: !!msg.isVoice })
      ctx.updatePrimary('default', client.id)
      break
    }

    case 'interrupt':
      console.log(`[ws] Interrupt from ${client.id}`)
      ctx.cliSession.interrupt()
      break

    case 'set_model': {
      if (
        typeof msg.model === 'string' &&
        ALLOWED_MODEL_IDS.has(msg.model)
      ) {
        console.log(`[ws] Model change from ${client.id}: ${msg.model}`)
        ctx.cliSession.setModel(msg.model)
        ctx.broadcast({ type: 'model_changed', model: toShortModelId(msg.model) })
      } else {
        console.warn(`[ws] Rejected invalid model from ${client.id}: ${JSON.stringify(msg.model)}`)
      }
      break
    }

    case 'set_permission_mode': {
      if (
        typeof msg.mode === 'string' &&
        ALLOWED_PERMISSION_MODE_IDS.has(msg.mode)
      ) {
        if (msg.mode === 'auto' && !msg.confirmed) {
          console.log(`[ws] Auto mode requested by ${client.id}, awaiting confirmation`)
          ctx.send(ws, {
            type: 'confirm_permission_mode',
            mode: 'auto',
            warning: 'Auto mode bypasses all permission checks. Claude will execute tools without asking.',
          })
        } else {
          if (msg.mode === 'auto') {
            console.log(`[ws] Auto permission mode CONFIRMED by ${client.id} at ${new Date().toISOString()}`)
          } else {
            console.log(`[ws] Permission mode change from ${client.id}: ${msg.mode}`)
          }
          ctx.cliSession.setPermissionMode(msg.mode)
          ctx.broadcast({ type: 'permission_mode_changed', mode: msg.mode })
        }
      } else {
        console.warn(`[ws] Rejected invalid permission mode from ${client.id}: ${JSON.stringify(msg.mode)}`)
      }
      break
    }

    case 'permission_response': {
      const { requestId, decision } = msg
      if (requestId && decision) {
        ctx.permissions.resolvePermission(requestId, decision)
      }
      break
    }

    case 'user_question_response': {
      if (ctx.cliSession && typeof msg.answer === 'string') {
        ctx.cliSession.respondToQuestion(msg.answer)
      }
      break
    }

    case 'list_directory':
      ctx.fileOps.listDirectory(ws, msg.path)
      break

    case 'browse_files':
      ctx.fileOps.browseFiles(ws, msg.path, ctx.cliSession?.cwd || null)
      break

    case 'list_files':
      ctx.fileOps.listFiles(ws, ctx.cliSession?.cwd || null, msg.query || null)
      break

    case 'read_file':
      ctx.fileOps.readFile(ws, msg.path, ctx.cliSession?.cwd || null)
      break

    case 'get_diff':
      ctx.fileOps.getDiff(ws, msg.base, ctx.cliSession?.cwd || null)
      break

    case 'list_slash_commands': {
      const cwd = ctx.cliSession?.cwd || null
      ctx.fileOps.listSlashCommands(ws, cwd, null)
      break
    }

    case 'list_agents': {
      const cwd = ctx.cliSession?.cwd || null
      ctx.fileOps.listAgents(ws, cwd, null)
      break
    }

    default:
      console.log(`[ws] Unknown message type: ${msg.type}`)
  }
}

