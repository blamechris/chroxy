/**
 * Conversation, history, and cost summary handlers.
 *
 * Handles: list_conversations, search_conversations, resume_conversation,
 *          request_full_history, request_session_context, request_cost_summary
 */
import { scanConversations as defaultScanConversations } from '../conversation-scanner.js'
import { searchConversations as defaultSearchConversations } from '../conversation-search.js'
import { validateCwdAllowed, broadcastFocusChanged, resolveSession, autoSubscribeOtherClients } from '../handler-utils.js'
import { scopeConversationsToClient } from '../conversation-scope.js'
import { createLogger } from '../logger.js'

const log = createLogger('ws')

async function handleListConversations(ws, client, msg, ctx) {
  // ctx.scanConversations override allows tests to inject a stub and skip real fs.
  const scan = ctx.scanConversations || defaultScanConversations
  try {
    const all = await scan()
    // Adversary A8: scope results so a bound pairing-issued client
    // cannot enumerate conversations outside its session cwd.
    const conversations = scopeConversationsToClient(all, client, ctx)
    ctx.send(ws, { type: 'conversations_list', conversations })
  } catch (err) {
    log.warn(`Failed to scan conversations: ${err.message}`)
    ctx.send(ws, { type: 'conversations_list', conversations: [] })
  }
}

async function handleSearchConversations(ws, client, msg, ctx) {
  const { query, maxResults } = msg
  const search = ctx.searchConversations || defaultSearchConversations
  try {
    const all = await search(query, { maxResults })
    // Adversary A8: scope the search result set to the bound session's
    // cwd. Without this, a mobile client could substring-grep every
    // JSONL on disk for secrets-in-transcripts.
    const results = scopeConversationsToClient(all, client, ctx)
    ctx.send(ws, { type: 'search_results', query, results })
  } catch (err) {
    log.warn(`Failed to search conversations: ${err.message}`)
    ctx.send(ws, { type: 'search_results', query, results: [] })
  }
}

async function handleResumeConversation(ws, client, msg, ctx) {
  // Bound clients cannot create new sessions via resume
  if (client.boundSessionId) {
    ctx.send(ws, { type: 'session_error', message: 'Not authorized: client is bound to a specific session', code: 'SESSION_TOKEN_MISMATCH' })
    return
  }

  // Check resume capability on the active session's provider
  const activeEntry = client.activeSessionId && ctx.sessionManager.getSession(client.activeSessionId)
  if (activeEntry && !activeEntry.session.constructor.capabilities?.resume) {
    ctx.send(ws, { type: 'session_error', message: 'This provider does not support conversation resume' })
    return
  }
  const { conversationId, cwd } = msg
  if (!conversationId || typeof conversationId !== 'string') {
    ctx.send(ws, { type: 'session_error', message: 'Missing conversationId' })
    return
  }
  // Validate conversationId is a UUID to prevent path traversal
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conversationId)) {
    ctx.send(ws, { type: 'session_error', message: 'Invalid conversationId format' })
    return
  }
  if (cwd) {
    const cwdError = validateCwdAllowed(cwd, ctx.config)
    if (cwdError) {
      ctx.send(ws, { type: 'session_error', message: cwdError })
      return
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
    client.subscribedSessionIds.add(sessionId)
    const entry = ctx.sessionManager.getSession(sessionId)
    ctx.send(ws, { type: 'session_switched', sessionId, name: entry.name, cwd: entry.cwd, conversationId: entry.session.resumeSessionId || null })
    ctx.sendSessionInfo(ws, sessionId)
    ctx.replayHistory(ws, sessionId)
    ctx.broadcastSessionList()
    autoSubscribeOtherClients(sessionId, ws, ctx)
    broadcastFocusChanged(client, sessionId, ctx)
  } catch (err) {
    ctx.send(ws, { type: 'session_error', message: err.message })
  }
}

async function handleRequestFullHistory(ws, client, msg, ctx) {
  const targetId = (typeof msg.sessionId === 'string' && msg.sessionId) || client.activeSessionId
  if (!targetId || !resolveSession(ctx, msg, client)) {
    const message = msg.sessionId
      ? `Session not found: ${msg.sessionId}`
      : 'No active session'
    ctx.send(ws, { type: 'session_error', message })
    return
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
}

async function handleRequestSessionContext(ws, client, msg, ctx) {
  const targetId = (typeof msg.sessionId === 'string' && msg.sessionId) || client.activeSessionId
  if (!targetId) {
    ctx.send(ws, { type: 'session_error', message: 'No active session' })
    return
  }

  // Enforce session binding
  if (client.boundSessionId && client.boundSessionId !== targetId) {
    ctx.send(ws, { type: 'session_error', message: 'Not authorized to access this session', code: 'SESSION_TOKEN_MISMATCH' })
    return
  }

  try {
    const sessionCtx = await ctx.sessionManager.getSessionContext(targetId)
    if (sessionCtx) {
      ctx.send(ws, { type: 'session_context', ...sessionCtx })
    } else {
      ctx.send(ws, { type: 'session_error', message: `Session not found: ${targetId}` })
    }
  } catch (err) {
    log.warn(`Failed to read session context: ${err.message}`)
    ctx.send(ws, { type: 'session_error', message: `Failed to read session context: ${err.message}` })
  }
}

function handleRequestCostSummary(ws, client, msg, ctx) {
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
    costByModel: ctx.sessionManager.getCostByModel(),
    spendRate: ctx.sessionManager.getSpendRate(),
  })
}

export const conversationHandlers = {
  list_conversations: handleListConversations,
  search_conversations: handleSearchConversations,
  resume_conversation: handleResumeConversation,
  request_full_history: handleRequestFullHistory,
  request_session_context: handleRequestSessionContext,
  request_cost_summary: handleRequestCostSummary,
}
