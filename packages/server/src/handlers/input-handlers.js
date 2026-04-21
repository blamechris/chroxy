/**
 * Input and user interaction message handlers.
 *
 * Handles: input, interrupt, resume_budget, register_push_token, user_question_response
 */
import { validateAttachments, resolveFileRefAttachments, resolveSession } from '../handler-utils.js'
import { createLogger } from '../logger.js'

const log = createLogger('ws')

// Stable user-input message IDs (issue #2902). A client that sends its own
// `clientMessageId` gets it adopted verbatim — that lets the sender dedup its
// optimistic entry against the rehydrated history after a reconnect. Only
// loose format validation: we don't trust client input beyond size/charset,
// but collisions inside one session's ring buffer are the client's problem.
const USER_INPUT_ID_RE = /^[A-Za-z0-9_-]+$/
const MAX_CLIENT_MESSAGE_ID_LEN = 128
let _userInputIdCounter = 0
function generateUserInputId() {
  _userInputIdCounter = (_userInputIdCounter + 1) % Number.MAX_SAFE_INTEGER
  return `uin-${Date.now()}-${_userInputIdCounter}`
}
function resolveUserInputId(candidate) {
  if (typeof candidate !== 'string') return generateUserInputId()
  if (candidate.length === 0 || candidate.length > MAX_CLIENT_MESSAGE_ID_LEN) return generateUserInputId()
  if (!USER_INPUT_ID_RE.test(candidate)) return generateUserInputId()
  return candidate
}

function handleInput(ws, client, msg, ctx) {
  const text = msg.data
  let attachments = Array.isArray(msg.attachments) ? msg.attachments : undefined
  const targetSessionId = msg.sessionId || client.activeSessionId
  const entry = resolveSession(ctx, msg, client)
  if (!entry) {
    const message = msg.sessionId
      ? `Session not found: ${msg.sessionId}`
      : 'No active session'
    ctx.send(ws, { type: 'session_error', message })
    return
  }

  if (attachments?.length) {
    const err = validateAttachments(attachments)
    if (err) {
      ctx.send(ws, { type: 'session_error', message: `Invalid attachment: ${err}` })
      return
    }
  }

  // Resolve file_ref attachments to actual file content
  if (attachments?.length) {
    attachments = resolveFileRefAttachments(attachments, entry.cwd)
  }

  if ((!text || !text.trim()) && !attachments?.length) return
  const trimmed = text?.trim() || ''
  const attCount = attachments?.length || 0
  log.debug(`Message from ${client.id} to session ${targetSessionId}: "${trimmed.slice(0, 80)}"${attCount ? ` (+${attCount} attachment(s))` : ''}`)

  if (ctx.sessionManager.isBudgetPaused(targetSessionId)) {
    ctx.send(ws, { type: 'session_error', message: 'Session is paused — cost budget exceeded. Use "Resume Budget" to continue.' })
    return
  }

  // Input conflict: reject if session is already processing input from a different client
  if (entry.session.isRunning) {
    const primaryClientId = ctx.primaryClients.get(targetSessionId)
    if (primaryClientId && primaryClientId !== client.id) {
      ctx.send(ws, {
        type: 'session_error',
        category: 'input_conflict',
        message: 'Session is already processing input from another device. Wait for it to finish or interrupt first.',
      })
      return
    }
  }

  if (entry.session.resumeSessionId) {
    ctx.checkpointManager.createCheckpoint({
      sessionId: targetSessionId,
      resumeSessionId: entry.session.resumeSessionId,
      cwd: entry.cwd,
      description: trimmed.slice(0, 100),
      messageCount: ctx.sessionManager.getHistoryCount(targetSessionId),
    }).catch((err) => log.warn(`Auto-checkpoint failed: ${err.message}`))
  }
  const historyText = attCount ? `${trimmed}${trimmed ? ' ' : ''}[${attCount} file(s) attached]` : trimmed
  // Adopt the sender's clientMessageId if present and well-formed; otherwise
  // generate one. Same ID is stored in history and emitted in the live-echo
  // broadcast so any reconnecting client can match rehydrated entries
  // against their optimistic/echo copies (issue #2902).
  const messageId = resolveUserInputId(msg.clientMessageId)
  ctx.sessionManager.recordUserInput(targetSessionId, historyText, messageId)
  ctx.sessionManager.touchActivity(targetSessionId)
  entry.session.sendMessage(trimmed, attachments, { isVoice: !!msg.isVoice })

  ctx.updatePrimary(targetSessionId, client.id)

  // Echo user_input to other clients so they see what was sent (#1119)
  ctx.broadcast(
    { type: 'user_input', sessionId: targetSessionId, clientId: client.id, text: trimmed, messageId, timestamp: Date.now() },
    (c) => c.id !== client.id
  )
}

function handleInterrupt(ws, client, msg, ctx) {
  const interruptSessionId = msg.sessionId || client.activeSessionId
  const entry = resolveSession(ctx, msg, client)
  if (entry) {
    log.info(`Interrupt from ${client.id} to session ${interruptSessionId}`)
    entry.session.interrupt()
  }
}

function handleResumeBudget(ws, client, msg, ctx) {
  const budgetSessionId = msg.sessionId || client.activeSessionId
  if (!budgetSessionId || !resolveSession(ctx, msg, client)) {
    ctx.send(ws, { type: 'session_error', message: 'No valid session for budget resume' })
    return
  }
  if (ctx.sessionManager.isBudgetPaused(budgetSessionId)) {
    ctx.sessionManager.resumeBudget(budgetSessionId)
    ctx.broadcastToSession(budgetSessionId, { type: 'budget_resumed', sessionId: budgetSessionId })
    log.info(`Budget resumed for session ${budgetSessionId} by ${client.id}`)
  }
}

function handleRegisterPushToken(ws, client, msg, ctx) {
  if (!ctx.pushManager || typeof msg.token !== 'string') return

  // Pass the client's stable ID as the token owner so PushManager can
  // ref-count ownership for multi-connection scenarios (2026-04-11
  // audit blocker 6 + Copilot review on PR #2806): two clients that
  // register the same token must both be released before the token
  // is actually pruned from the registry. Without ref-counting, the
  // first disconnect would strip the token from the second client's
  // active session.
  const ok = ctx.pushManager.registerToken(msg.token, client.id)
  if (!ok) {
    ctx.send(ws, {
      type: 'push_token_error',
      // Keep the wording close to the actual validator: minimum length
      // plus a blacklist of obvious garbage characters. The check is a
      // heuristic, not a true Expo/FCM format enforcement (found by
      // Copilot review on PR #2806).
      message: 'Push token rejected — token must be at least 20 characters and contain no whitespace, quotes, URL/shell/JSON punctuation',
    })
    return
  }

  // Track which tokens this client registered so _handleClientDeparture
  // can release ownership when they disconnect. Without this, an
  // attacker who authenticated, registered their token, and
  // disconnected would leave their token in the registry forever,
  // continuing to receive every future permission prompt.
  if (!client._ownedPushTokens) {
    client._ownedPushTokens = new Set()
  }
  client._ownedPushTokens.add(msg.token)
}

function handleUserQuestionResponse(ws, client, msg, ctx) {
  const questionSessionId = (msg.toolUseId && ctx.questionSessionMap.get(msg.toolUseId))
    || client.activeSessionId

  // Enforce session binding before consuming the mapping — if the client
  // is bound to a different session, leave the mapping intact so the
  // correct client can still respond.
  if (client.boundSessionId && client.boundSessionId !== questionSessionId) return

  if (msg.toolUseId) ctx.questionSessionMap.delete(msg.toolUseId)

  const entry = ctx.sessionManager.getSession(questionSessionId)
  if (entry && typeof entry.session.respondToQuestion === 'function' && typeof msg.answer === 'string') {
    entry.session.respondToQuestion(msg.answer, msg.answers)
  }
}

export const inputHandlers = {
  input: handleInput,
  interrupt: handleInterrupt,
  resume_budget: handleResumeBudget,
  register_push_token: handleRegisterPushToken,
  user_question_response: handleUserQuestionResponse,
}
