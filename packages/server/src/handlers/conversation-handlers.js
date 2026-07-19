/**
 * Conversation, history, and cost summary handlers.
 *
 * Handles: list_conversations, search_conversations, resume_conversation,
 *          request_conversation_transcript, request_full_history,
 *          request_session_context, request_cost_summary
 */
import { scanConversations as defaultScanConversations } from '../conversation-scanner.js'
import { searchConversations as defaultSearchConversations } from '../conversation-search.js'
import { resolveJsonlPath, readConversationHistoryAsync as defaultReadConversationHistoryAsync } from '../jsonl-reader.js'
import { validateCwdAllowed, broadcastFocusChanged, resolveSession, autoSubscribeOtherClients, buildSessionTokenMismatchPayload, sendSessionError } from '../handler-utils.js'
import { scopeConversationsToClient } from '../conversation-scope.js'
import { createLogger, loggerForSession } from '../logger.js'

const log = createLogger('ws')

// UUID v4-ish shape guard shared by resume_conversation and the read-only
// transcript handler — rejects anything that isn't a canonical conversation id
// before it reaches the filesystem, closing path-traversal via the id segment.
const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function handleListConversations(ws, client, msg, ctx) {
  // ctx.scanConversations override allows tests to inject a stub and skip real fs.
  const scan = ctx.scanConversations || defaultScanConversations
  try {
    // Pass provider-driven projectsDirs when available (#2965); falls back to
    // the scanner's default (~/.claude/projects) when not set.
    const scanOpts = ctx.runtime.projectsDirs ? { projectsDirs: ctx.runtime.projectsDirs } : {}
    const all = await scan(scanOpts)
    // Adversary A8: scope results so a bound pairing-issued client
    // cannot enumerate conversations outside its session cwd.
    const conversations = scopeConversationsToClient(all, client, ctx)
    ctx.transport.send(ws, { type: 'conversations_list', conversations })
  } catch (err) {
    log.warn(`Failed to scan conversations: ${err.message}`)
    ctx.transport.send(ws, { type: 'conversations_list', conversations: [] })
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
    ctx.transport.send(ws, { type: 'search_results', query, results })
  } catch (err) {
    log.warn(`Failed to search conversations: ${err.message}`)
    ctx.transport.send(ws, { type: 'search_results', query, results: [] })
  }
}

async function handleResumeConversation(ws, client, msg, ctx) {
  // Bound clients cannot create new sessions via resume
  if (client.boundSessionId) {
    // See #2904 — include bound session name so the client can show an
    // actionable message instead of an opaque "Not authorized".
    // Issue #2912: shape is shared with every other SESSION_TOKEN_MISMATCH
    // emit site via buildSessionTokenMismatchPayload.
    ctx.transport.send(ws, {
      type: 'session_error',
      ...buildSessionTokenMismatchPayload({
        sessionManager: ctx.sessions.sessionManager,
        boundSessionId: client.boundSessionId,
        message: 'Not authorized: client is bound to a specific session',
      }),
    })
    return
  }

  // Check resume capability on the active session's provider
  const activeEntry = client.activeSessionId && ctx.sessions.sessionManager.getSession(client.activeSessionId)
  if (activeEntry && !activeEntry.session.constructor.capabilities?.resume) {
    sendSessionError(ws, ctx, 'This provider does not support conversation resume')
    return
  }
  const { conversationId, cwd } = msg
  if (!conversationId || typeof conversationId !== 'string') {
    sendSessionError(ws, ctx, 'Missing conversationId')
    return
  }
  // Validate conversationId is a UUID to prevent path traversal
  if (!CONVERSATION_ID_RE.test(conversationId)) {
    sendSessionError(ws, ctx, 'Invalid conversationId format')
    return
  }
  if (cwd) {
    const cwdError = validateCwdAllowed(cwd, ctx.services.config)
    if (cwdError) {
      sendSessionError(ws, ctx, cwdError)
      return
    }
  }
  try {
    const name = (typeof msg.name === 'string' && msg.name.trim()) ? msg.name.trim() : 'Resumed'
    const sessionId = ctx.sessions.sessionManager.createSession({
      resumeSessionId: conversationId,
      cwd: cwd || undefined,
      name,
    })
    // #5563: index-maintaining helpers.
    ctx.transport.setActiveSession(client, sessionId)
    ctx.transport.subscribeClient(client, sessionId)
    const entry = ctx.sessions.sessionManager.getSession(sessionId)
    ctx.transport.send(ws, { type: 'session_switched', sessionId, name: entry.name, cwd: entry.cwd, conversationId: entry.session.resumeSessionId || null })
    ctx.transport.sendSessionInfo(ws, sessionId)
    ctx.transport.replayHistory(ws, sessionId)
    ctx.transport.broadcastSessionList()
    autoSubscribeOtherClients(sessionId, ws, ctx)
    broadcastFocusChanged(client, sessionId, ctx)
  } catch (err) {
    sendSessionError(ws, ctx, err.message)
  }
}

/**
 * Read-only transcript endpoint (#6860, epic #6765).
 *
 * Streams a CLOSED conversation's full history back to the requesting client
 * straight off the persisted store (the Claude Code CLI JSONL layer under
 * `~/.claude/projects/`) — WITHOUT calling `createSession` or spawning any
 * provider process. Because it reads persisted bytes rather than driving a live
 * process, it works uniformly for every provider, including those whose
 * `capabilities.resume === false` (BYOK, Codex, Gemini, user-shell) for which
 * `resume_conversation` is refused outright.
 *
 * Access follows the same cwd-scoping as `list_conversations`/`search_conversations`
 * (`scopeConversationsToClient`): an UNBOUND client (primary token / dashboard)
 * may read any conversation; a BOUND pairing-issued client may only read
 * conversations recorded under its bound session's cwd — anything else is
 * rejected. This mirrors bearer-token-authority.md: read-only history is the
 * same authority class as other session-state reads.
 *
 * The response reuses the existing `history_replay_start` / `message` /
 * `history_replay_end` server→client frames (identical to `handleRequestFullHistory`,
 * only sourced from disk) so clients render it with their existing renderers.
 * The replay frames carry the `conversationId` in the `sessionId` field — there
 * is no live session, and a resumed session always gets a fresh id distinct from
 * the conversationId, so this cannot collide with or clobber a live session's
 * transcript.
 */
async function handleRequestConversationTranscript(ws, client, msg, ctx) {
  const { conversationId } = msg
  if (!conversationId || typeof conversationId !== 'string') {
    sendSessionError(ws, ctx, 'Missing conversationId')
    return
  }
  // UUID guard — path-traversal protection (same gate as resume_conversation).
  if (!CONVERSATION_ID_RE.test(conversationId)) {
    sendSessionError(ws, ctx, 'Invalid conversationId format')
    return
  }

  // Resolve the conversation's recorded cwd authoritatively from the persisted
  // store (the scanner reads the same JSONL layer list_conversations does). Only
  // fall back to a client-provided cwd hint when the scan can't find it (e.g. a
  // tiny conversation below the scanner's MIN_FILE_SIZE floor).
  const scan = ctx.scanConversations || defaultScanConversations
  let conv = null
  try {
    const scanOpts = ctx.runtime.projectsDirs ? { projectsDirs: ctx.runtime.projectsDirs } : {}
    const all = await scan(scanOpts)
    conv = Array.isArray(all) ? all.find((c) => c?.conversationId === conversationId) || null : null
  } catch (err) {
    // Scan failure is non-fatal — fall through to the client-provided cwd hint.
    log.warn(`Transcript scan failed for ${conversationId}: ${err.message}`)
  }

  let cwd = conv?.cwd || null
  if (!cwd && typeof msg.cwd === 'string' && msg.cwd) {
    // Client-supplied fallback: validate it against the same path hygiene the
    // create/resume paths enforce before trusting it to resolve a filesystem path.
    const cwdError = validateCwdAllowed(msg.cwd, ctx.services.config)
    if (cwdError) {
      sendSessionError(ws, ctx, cwdError)
      return
    }
    cwd = msg.cwd
  }

  if (!cwd) {
    sendSessionError(ws, ctx, `Conversation not found: ${conversationId}`)
    return
  }

  // Scope enforcement — reuse the guard list_conversations/search_conversations
  // use. A bound client that can't see this cwd gets an empty set → reject.
  const scoped = scopeConversationsToClient([{ conversationId, cwd }], client, ctx)
  if (scoped.length === 0) {
    sendSessionError(ws, ctx, 'Not authorized to view this conversation')
    return
  }

  // Read the transcript from disk. NO createSession, NO provider spawn. Reader is
  // injectable for tests so the suite never touches the real ~/.claude/projects.
  const readTranscript = ctx.readConversationTranscript || defaultReadConversationHistoryAsync
  let messages = []
  try {
    messages = await readTranscript(resolveJsonlPath(cwd, conversationId))
  } catch (err) {
    // A read error is graceful — surface an empty transcript rather than a crash.
    log.warn(`Failed to read transcript for ${conversationId}: ${err.message}`)
    messages = []
  }

  // Stream back using the SAME wire shape as request_full_history so existing
  // renderers light up. `sessionId` carries the conversationId (read-only; no
  // live session exists for a closed conversation).
  ctx.transport.send(ws, { type: 'history_replay_start', sessionId: conversationId, fullHistory: true, conversationId })
  for (const entry of messages) {
    ctx.transport.send(ws, {
      type: 'message',
      messageType: entry.type,
      content: entry.content,
      tool: entry.tool,
      timestamp: entry.timestamp,
      sessionId: conversationId,
    })
  }
  ctx.transport.send(ws, { type: 'history_replay_end', sessionId: conversationId })
}

async function handleRequestFullHistory(ws, client, msg, ctx) {
  const targetId = (typeof msg.sessionId === 'string' && msg.sessionId) || client.activeSessionId
  if (!targetId || !resolveSession(ctx, msg, client)) {
    const message = msg.sessionId
      ? `Session not found: ${msg.sessionId}`
      : 'No active session'
    sendSessionError(ws, ctx, message)
    return
  }
  const fullHistory = await ctx.sessions.sessionManager.getFullHistoryAsync(targetId)
  ctx.transport.send(ws, { type: 'history_replay_start', sessionId: targetId, fullHistory: true })
  for (const entry of fullHistory) {
    if (entry.type === 'user_input' || entry.type === 'response' || entry.type === 'tool_use') {
      ctx.transport.send(ws, {
        type: 'message',
        messageType: entry.type,
        content: entry.content,
        tool: entry.tool,
        timestamp: entry.timestamp,
        sessionId: targetId,
      })
    } else {
      ctx.transport.send(ws, { ...entry, sessionId: targetId })
    }
  }
  ctx.transport.send(ws, { type: 'history_replay_end', sessionId: targetId })
}

async function handleRequestSessionContext(ws, client, msg, ctx) {
  const targetId = (typeof msg.sessionId === 'string' && msg.sessionId) || client.activeSessionId
  if (!targetId) {
    sendSessionError(ws, ctx, 'No active session')
    return
  }

  // Enforce session binding
  if (client.boundSessionId && client.boundSessionId !== targetId) {
    ctx.transport.send(ws, {
      type: 'session_error',
      ...buildSessionTokenMismatchPayload({
        sessionManager: ctx.sessions.sessionManager,
        boundSessionId: client.boundSessionId,
      }),
    })
    return
  }

  try {
    const sessionCtx = await ctx.sessions.sessionManager.getSessionContext(targetId)
    if (sessionCtx) {
      ctx.transport.send(ws, { type: 'session_context', ...sessionCtx })
    } else {
      sendSessionError(ws, ctx, `Session not found: ${targetId}`)
    }
  } catch (err) {
    // #4828: session-scoped — `targetId` is the active session ID in
    // scope. Legacy single-session callers may surface an empty value,
    // so fall back to module-level `log` rather than throwing inside
    // loggerForSession (same pattern as the settings-handlers sites).
    ;(targetId ? loggerForSession('ws', targetId) : log).warn(`Failed to read session context: ${err.message}`)
    sendSessionError(ws, ctx, `Failed to read session context: ${err.message}`)
  }
}

function handleRequestCostSummary(ws, client, msg, ctx) {
  const costSessions = ctx.sessions.sessionManager.listSessions()
  const sessionCosts = costSessions.map(s => ({
    sessionId: s.sessionId,
    name: s.name,
    cost: ctx.sessions.sessionManager.getSessionCost(s.sessionId),
    model: s.model || null,
  }))
  ctx.transport.send(ws, {
    type: 'cost_summary',
    totalCost: ctx.sessions.sessionManager.getTotalCost(),
    budget: ctx.sessions.sessionManager.getCostBudget(),
    sessions: sessionCosts,
    costByModel: ctx.sessions.sessionManager.getCostByModel(),
    spendRate: ctx.sessions.sessionManager.getSpendRate(),
  })
}

export const conversationHandlers = {
  list_conversations: handleListConversations,
  search_conversations: handleSearchConversations,
  resume_conversation: handleResumeConversation,
  request_conversation_transcript: handleRequestConversationTranscript,
  request_full_history: handleRequestFullHistory,
  request_session_context: handleRequestSessionContext,
  request_cost_summary: handleRequestCostSummary,
}
