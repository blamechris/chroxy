/**
 * Input and user interaction message handlers.
 *
 * Handles: input, interrupt, resume_budget, register_push_token, user_question_response
 */
import { randomUUID } from 'node:crypto'
import { validateAttachments, resolveFileRefAttachments, resolveSession } from '../handler-utils.js'
import { evaluateDraft as defaultEvaluateDraft, shouldSkipEvaluator } from '../prompt-evaluator.js'
import { createLogger } from '../logger.js'

const log = createLogger('ws')

// #3186 — auto-evaluation hook config.
//
// MAX_EVALUATOR_ITERATIONS caps the clarify loop. After 3 consecutive clarify
// verdicts on a single session, the next user message force-forwards
// regardless of the verdict. Without the cap an evaluator that never settles
// would silently swallow every message.
const MAX_EVALUATOR_ITERATIONS = 3

// Per-session iteration counter, hung off the handler context. Reset to 0
// once the cap fires so a subsequent send starts fresh — see test
// "force-forwards original draft after 3 consecutive clarify verdicts".
function _getEvaluatorIterations(ctx) {
  if (!ctx._evaluatorIterations) ctx._evaluatorIterations = new Map()
  return ctx._evaluatorIterations
}

// #3636 — per-session evaluator-await lock. Without this, two messages
// arriving close together for the same session can both pass the pre-await
// input_conflict / primary checks, both invoke the evaluator concurrently,
// and produce non-deterministic interleaving (two evaluator round-trips,
// two `session.sendMessage` calls in unspecified order, broadcasts mixed).
// We reject the second concurrent draft with the same input_conflict
// category the user already understands — not queue it — so callers retry
// rather than silently waiting on an unbounded queue.
function _getEvaluatorAwaits(ctx) {
  if (!ctx._pendingEvaluatorAwaits) ctx._pendingEvaluatorAwaits = new Map()
  return ctx._pendingEvaluatorAwaits
}

// #3639 — build the config object passed into shouldSkipEvaluator. The
// per-session promptEvaluatorSkipPattern (string source) takes precedence;
// the server-wide ctx.config.promptEvaluatorSkipPattern (#3187) is the
// fallback so existing global-config deployments keep working unchanged.
// Returns a plain object — never mutates ctx.config.
function _resolveSkipConfig(entry, ctx) {
  const sessionSource = entry?.session?.promptEvaluatorSkipPattern
  const sessionPattern = typeof sessionSource === 'string' && sessionSource.length > 0
    ? sessionSource
    : null
  const globalSource = ctx?.config?.promptEvaluatorSkipPattern
  const globalPattern = typeof globalSource === 'string' && globalSource.length > 0
    ? globalSource
    : null
  return {
    ...(ctx?.config || {}),
    promptEvaluatorSkipPattern: sessionPattern ?? globalPattern,
  }
}

// Stable user-input message IDs (issue #2902). A client that sends its own
// `clientMessageId` gets it adopted verbatim — that lets the sender dedup its
// optimistic entry against the rehydrated history after a reconnect. Only
// loose format validation: we don't trust client input beyond size/charset,
// but collisions inside one session's ring buffer are the client's problem.
const USER_INPUT_ID_RE = /^[A-Za-z0-9_-]+$/
const MAX_CLIENT_MESSAGE_ID_LEN = 128
// IDs the clients treat specially in their stores (e.g. the "thinking"
// placeholder shown while waiting for the first stream_delta). Never let a
// client-supplied id collide with these — it would clobber the placeholder
// or cause the indicator to leak.
const RESERVED_USER_INPUT_IDS = new Set(['thinking', 'pending', 'queued'])
let _userInputIdCounter = 0
function generateUserInputId() {
  _userInputIdCounter = (_userInputIdCounter + 1) % Number.MAX_SAFE_INTEGER
  return `uin-${Date.now()}-${_userInputIdCounter}`
}
function resolveUserInputId(candidate) {
  if (typeof candidate !== 'string') return generateUserInputId()
  if (candidate.length === 0 || candidate.length > MAX_CLIENT_MESSAGE_ID_LEN) return generateUserInputId()
  if (!USER_INPUT_ID_RE.test(candidate)) return generateUserInputId()
  if (RESERVED_USER_INPUT_IDS.has(candidate)) return generateUserInputId()
  return candidate
}

async function handleInput(ws, client, msg, ctx) {
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
  // Adopt the sender's clientMessageId if present and well-formed; otherwise
  // generate one. Same ID is stored in history and emitted in the live-echo
  // broadcast so any reconnecting client can match rehydrated entries
  // against their optimistic/echo copies (issue #2902).
  const messageId = resolveUserInputId(msg.clientMessageId)

  // #3635 + #3636 merged: record-after-evaluator AND rejection-safe.
  //
  // #3635 — the auto-evaluator (#3186) can rewrite a draft before
  // forwarding. Historically we recorded the ORIGINAL draft to history
  // before awaiting the evaluator, so replayed history showed the
  // user's original text against an assistant response that answered
  // the rewrite (confusing divergence). Decision: record what was
  // actually forwarded on rewrite, original on forward/clarify/skip/
  // fail-open.
  //
  // #3636 — the auto-evaluator hook also added rejection paths
  // (pending-evaluator guard, post-await input_conflict re-check) that
  // return without forwarding. Recording before those checks would
  // produce phantom history entries — appears in replay/reconnect
  // history but was neither forwarded nor broadcast.
  //
  // Resolution: defer recording until a success boundary (clarify path
  // OR forward boundary), recording the text that was actually used.
  // Rejection paths return without calling recordHistoryEntry().
  // touchActivity moves with it so a rejected message doesn't bump the
  // session's activity timestamp.
  const buildHistoryText = (text) => attCount
    ? `${text}${text ? ' ' : ''}[${attCount} file(s) attached]`
    : text
  let _historyRecorded = false
  function recordHistoryEntry(text) {
    if (_historyRecorded) return
    _historyRecorded = true
    ctx.sessionManager.recordUserInput(targetSessionId, buildHistoryText(text), messageId)
    ctx.sessionManager.touchActivity(targetSessionId)
  }

  // #3186 — auto-evaluation hook. Gates message forwarding on a per-session
  // promptEvaluator toggle. Skips evaluation for trivial drafts (acks, short
  // replies) that wouldn't benefit from a round-trip. Verdict routing:
  //   - forward → original message goes through unchanged
  //   - rewrite → broadcast evaluator_rewrite, forward the rewritten text
  //   - clarify → broadcast evaluator_clarify, do NOT forward (wait for
  //               follow-up). Capped at MAX_EVALUATOR_ITERATIONS clarify
  //               cycles — the next message force-forwards.
  // Fail-open: any evaluator error is logged and the original message is
  // forwarded so a key-missing or upstream outage never blocks the user.
  //
  // #3639: per-session promptEvaluatorSkipPattern overrides the server-wide
  // `ctx.config.promptEvaluatorSkipPattern` when set, falling back to the
  // global default (#3187) when null. Mirrors how `entry.session.promptEvaluator`
  // (the toggle) is also per-session — the skip pattern shouldn't be the
  // odd one out forced through global config.
  let textToSend = trimmed
  if (
    entry.session.promptEvaluator === true
    && trimmed.length > 0
    && !shouldSkipEvaluator(trimmed, _resolveSkipConfig(entry, ctx))
  ) {
    const counters = _getEvaluatorIterations(ctx)
    const currentIteration = (counters.get(targetSessionId) || 0) + 1

    if (currentIteration > MAX_EVALUATOR_ITERATIONS) {
      // Cap fired — force-forward and reset for the next cycle so the
      // session isn't permanently locked out of evaluator gating.
      log.warn(`Evaluator iteration cap hit for session ${targetSessionId}; force-forwarding draft`)
      counters.delete(targetSessionId)
    } else {
      // #3636 — per-session serialization. Reject (don't queue) a second
      // concurrent draft for the same session while an evaluator round-trip
      // is in flight. Reuses the existing input_conflict category so the
      // user gets the same retry UX they already know.
      const pending = _getEvaluatorAwaits(ctx)
      if (pending.has(targetSessionId)) {
        ctx.send(ws, {
          type: 'session_error',
          category: 'input_conflict',
          message: 'Session is already evaluating a previous draft. Wait for it to finish or interrupt first.',
        })
        return
      }

      const evaluator = typeof ctx.evaluateDraft === 'function' ? ctx.evaluateDraft : defaultEvaluateDraft
      let result
      const evalPromise = (async () => {
        try {
          return await evaluator({ draft: trimmed, cwd: entry.cwd })
        } catch (err) {
          // Fail-open: logged-then-forwarded keeps the user moving when
          // ANTHROPIC_API_KEY is missing or the upstream is down.
          log.warn(`Auto-evaluator failed (${err?.code || 'UNKNOWN'}): ${err?.message || err}; forwarding original draft`)
          return null
        }
      })()
      pending.set(targetSessionId, evalPromise)
      try {
        result = await evalPromise
      } finally {
        // Always release the lock — even on rewrite/clarify/forward paths
        // and on fail-open. Without this, a single failed evaluator call
        // would permanently block all future input on the session.
        if (pending.get(targetSessionId) === evalPromise) {
          pending.delete(targetSessionId)
        }
      }

      // #3636 — re-check input_conflict after the await. State may have
      // flipped during the round-trip (e.g. another path started the
      // session). Without this, the rewritten/forward draft would race
      // ahead of the now-busy session and produce out-of-order sends.
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

      if (result?.verdict === 'rewrite' && typeof result.rewritten === 'string' && result.rewritten.trim()) {
        counters.delete(targetSessionId)
        const evaluatorIterationId = randomUUID()
        ctx.broadcastToSession(targetSessionId, {
          type: 'evaluator_rewrite',
          sessionId: targetSessionId,
          originalDraft: trimmed,
          rewritten: result.rewritten,
          reasoning: result.reasoning || '',
          evaluatorIterationId,
        })
        textToSend = result.rewritten
      } else if (result?.verdict === 'clarify' && typeof result.clarification === 'string' && result.clarification.trim()) {
        // Clarify path: hold the message, surface the question, increment
        // the counter. The user's NEXT input will be evaluated against the
        // same counter — once it reaches MAX_EVALUATOR_ITERATIONS+1 we cap.
        counters.set(targetSessionId, currentIteration)
        const evaluatorIterationId = randomUUID()
        // #3636: record the draft in history NOW (clarify path is a
        // legitimate persisted entry, not a rejection) so the dashboard
        // sees the draft + the clarification on replay.
        // #3635: record the ORIGINAL draft (not a rewrite) — the
        // dashboard renders the clarify card alongside what the user
        // typed, so the user's intent IS reflected by `trimmed`.
        recordHistoryEntry(trimmed)
        ctx.broadcastToSession(targetSessionId, {
          type: 'evaluator_clarify',
          sessionId: targetSessionId,
          originalDraft: trimmed,
          clarification: result.clarification,
          reasoning: result.reasoning || '',
          evaluatorIterationId,
          evaluatorIteration: currentIteration,
        })
        // DO NOT forward to the session — return early.
        //
        // Update primary even though the message wasn't forwarded — the
        // user's intent was to drive the session, and the input-conflict
        // and primary-changed bookkeeping that downstream clients depend
        // on should reflect that. Without this, two paired clients can
        // both have stale "you're primary" views during a clarify cycle.
        ctx.updatePrimary(targetSessionId, client.id)
        ctx.broadcast(
          { type: 'user_input', sessionId: targetSessionId, clientId: client.id, text: trimmed, messageId, timestamp: Date.now() },
          (c) => c.id !== client.id,
        )
        return
      } else {
        // forward verdict (or unrecognised result) — drop the iteration
        // counter so a clarify-then-forward sequence resets cleanly.
        counters.delete(targetSessionId)
      }
    }
  }

  // #3636: record history at the forward boundary. All earlier
  // rejection paths (input_conflict pre-await, pending-evaluator guard,
  // post-await re-check) returned without recording. The clarify path
  // already recorded above before its own return.
  // #3635: record what was actually forwarded — `textToSend` is the
  // rewritten string on the rewrite verdict, the original `trimmed`
  // draft on every other path (forward, skip-heuristic, fail-open,
  // cap-bypass).
  recordHistoryEntry(textToSend)

  entry.session.sendMessage(textToSend, attachments, { isVoice: !!msg.isVoice })

  ctx.updatePrimary(targetSessionId, client.id)

  // Echo user_input to other clients so they see what was sent (#1119).
  // The echo carries `trimmed` (the user's original text) so paired
  // clients can dedup their optimistic copy of what the user typed —
  // the rewritten text is signalled separately via evaluator_rewrite.
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
