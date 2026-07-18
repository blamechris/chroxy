/**
 * Input and user interaction message handlers.
 *
 * Handles: input, interrupt, resume_budget, register_push_token,
 *          user_question_response, notification_prefs_get,
 *          notification_prefs_set (#4541)
 */
import { randomUUID } from 'node:crypto'
import { validateAttachments, resolveFileRefAttachments, resolveSession, sendError, sendSessionError, buildSessionTokenMismatchPayload, isSessionViewer, isUserShellSession } from '../handler-utils.js'
import { evaluateDraft as defaultEvaluateDraft, shouldSkipEvaluator } from '../prompt-evaluator.js'
import { PushManager } from '../push.js'
import { createLogger, sessionLogger } from '../logger.js'

const log = createLogger('ws')

// #3186 — auto-evaluation hook config.
//
// MAX_EVALUATOR_ITERATIONS caps the clarify loop. After 3 consecutive clarify
// verdicts on a session, the NEXT user message bypasses the evaluator call
// entirely — the cap fires BEFORE the await, so there is no verdict on that
// message; the original draft is force-forwarded sight-unseen and the
// counter resets so a subsequent send can re-enter the evaluator gate.
// Without the cap an evaluator that never settles would silently swallow
// every message. (#3642 tightened this comment — the cap doesn't
// "force-forward regardless of verdict", it bypasses the evaluator entirely
// so there's no verdict to override.)
const MAX_EVALUATOR_ITERATIONS = 3

// Per-session iteration counter. Owned by WsServer at runtime
// (`this._evaluatorIterations`, exposed on `ctx.runtime.evaluatorIterations`)
// because handler ctx is spread fresh on every dispatch — without a
// stable home the counter would reset on every message and the cap
// would never fire in production. Cleaned up by `_sessionDestroyedHandler`
// so destroyed sessions don't leak counter entries (#3637). The lazy
// creation below remains so tests that don't pass the Map through ctx
// still work.
//
// Reset to 0 once the cap fires so a subsequent send starts fresh — see
// test "force-forwards original draft after 3 consecutive clarify verdicts".
function _getEvaluatorIterations(ctx) {
  if (!ctx.runtime.evaluatorIterations) ctx.runtime.evaluatorIterations = new Map()
  return ctx.runtime.evaluatorIterations
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

// #3665 — build the history text appended for a recorded user input.
// When attachments are present we annotate the recorded text with a
// `[N file(s) attached]` marker so audit/replay shows what came alongside
// the message. The marker carries its own leading separator, so any
// trailing whitespace on `text` is stripped first — the auto-evaluator
// rewrite path commonly returns strings with a trailing newline, and
// without normalization the recorded text reads `'foo \n[1 file(s) attached]'`
// (double whitespace before the marker). Empty/whitespace-only text drops
// to a marker-only entry.
export function buildHistoryText(text, attCount) {
  if (!attCount) return text
  const stripped = typeof text === 'string' ? text.replace(/\s+$/, '') : ''
  return stripped
    ? `${stripped} [${attCount} file(s) attached]`
    : `[${attCount} file(s) attached]`
}

// #3639 — build the minimal config object passed into shouldSkipEvaluator.
// The per-session promptEvaluatorSkipPattern (string source) takes precedence;
// the server-wide ctx.services.config.promptEvaluatorSkipPattern (#3187) is the
// fallback so existing global-config deployments keep working unchanged.
// shouldSkipEvaluator only reads `config.promptEvaluatorSkipPattern` (verified
// in prompt-evaluator.js), so we return a single-key object rather than
// spreading the whole ctx.services.config — this runs on the user_input hot path and
// the spread was unnecessary allocation/copy work.
function _resolveSkipConfig(entry, ctx) {
  const sessionSource = entry?.session?.promptEvaluatorSkipPattern
  const sessionPattern = typeof sessionSource === 'string' && sessionSource.length > 0
    ? sessionSource
    : null
  const globalSource = ctx?.services?.config?.promptEvaluatorSkipPattern
  const globalPattern = typeof globalSource === 'string' && globalSource.length > 0
    ? globalSource
    : null
  return { promptEvaluatorSkipPattern: sessionPattern ?? globalPattern }
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

// #5281 ①.3 — an input_conflict rejection: the session can't accept this send
// right now (busy with another device's request, or still evaluating a previous
// draft on the same session). Echo the session and the rejected clientMessageId
// (when well-formed) so the dashboard can remove the stranded optimistic user
// message + clear its thinking spinner instead of leaving a ghost send behind a
// calm notice. `message` carries the specific reason so the dashboard can show
// it verbatim (cross-device vs same-session evaluator lock differ).
const INPUT_CONFLICT_CROSS_DEVICE_MESSAGE =
  'Session is already processing input from another device. Wait for it to finish or interrupt first.'
function buildInputConflictError(sessionId, clientMessageId, message = INPUT_CONFLICT_CROSS_DEVICE_MESSAGE) {
  const err = {
    type: 'session_error',
    category: 'input_conflict',
    message,
    sessionId,
  }
  // Echo only a well-formed id. Mirror resolveUserInputId's guards (incl. the
  // reserved-id exclusion) so we never reflect a value the history path itself
  // would have regenerated — keeps the echoed id consistent with the recorded
  // one and avoids reflecting a reserved placeholder like 'thinking'.
  if (
    typeof clientMessageId === 'string' &&
    clientMessageId.length > 0 &&
    clientMessageId.length <= MAX_CLIENT_MESSAGE_ID_LEN &&
    USER_INPUT_ID_RE.test(clientMessageId) &&
    !RESERVED_USER_INPUT_IDS.has(clientMessageId)
  ) {
    err.clientMessageId = clientMessageId
  }
  return err
}

async function handleInput(ws, client, msg, ctx) {
  const text = msg.data
  let attachments = Array.isArray(msg.attachments) ? msg.attachments : undefined
  const targetSessionId = msg.sessionId || client.activeSessionId
  const entry = resolveSession(ctx, msg, client)
  if (!entry) {
    // #4935 — visibility fix for the silent post-restart wedge. Before this,
    // a stale `sessionId` (common when the dashboard's persisted activeSessionId
    // references a pre-restart session ID that no longer exists after
    // session-manager regenerates IDs on restoreState) would silently drop
    // the input on the floor — sendSessionError ran but the operator log only
    // showed a debug-level `Message from ...` line below, and that line is
    // never reached on this branch. The dashboard's session_error toast DID
    // fire, but with a generic "Session not found: <id>" string that gave the
    // user nothing actionable. Now:
    //   1. Log at INFO with the attempted ID + client ID so chroxy.log
    //      shows the mismatch and operators can correlate against the
    //      session_list / session-state.json after a restart.
    //   2. Emit a structured `code: 'SESSION_NOT_FOUND'` + `attemptedSessionId`
    //      on the session_error envelope so the dashboard can surface an
    //      actionable hint ("session restarted — pick a session below")
    //      and clear its stale activeSessionId locally. Mirrors the existing
    //      `code: 'resume_unknown'` affordance (#4947).
    //
    // IMPORTANT (Copilot review #4979): `resolveSession()` returns null for
    // two distinct reasons — (a) the session truly does not exist, and
    // (b) the client has a `boundSessionId` and `msg.sessionId` disagrees with
    // it (session-token binding enforcement in handler-utils.js). Case (b) is
    // a SESSION_TOKEN_MISMATCH, not a SESSION_NOT_FOUND, and conflating them
    // would (i) mislabel the operator log line and (ii) cause a dashboard
    // consumer keyed on SESSION_NOT_FOUND to clear local state for what is
    // actually an authorization failure. Check the binding-mismatch case
    // FIRST and emit the canonical SESSION_TOKEN_MISMATCH envelope (#2912 —
    // unified shape across all call sites via buildSessionTokenMismatchPayload).
    if (msg.sessionId && client.boundSessionId && client.boundSessionId !== msg.sessionId) {
      log.info(`input rejected: session-token mismatch sessionId=${msg.sessionId} boundSessionId=${client.boundSessionId} client=${client.id}`)
      ctx.transport.send(ws, {
        type: 'session_error',
        ...buildSessionTokenMismatchPayload({
          sessionManager: ctx.sessions.sessionManager,
          boundSessionId: client.boundSessionId,
        }),
      })
      return
    }
    if (msg.sessionId) {
      log.info(`input dropped: session not found sessionId=${msg.sessionId} client=${client.id} (likely stale ID after daemon restart — see #4935)`)
      ctx.transport.send(ws, {
        type: 'session_error',
        code: 'SESSION_NOT_FOUND',
        message: `Session not found: ${msg.sessionId}`,
        attemptedSessionId: msg.sessionId,
      })
    } else {
      log.info(`input dropped: no active session client=${client.id}`)
      sendSessionError(ws, ctx, 'No active session')
    }
    return
  }

  if (attachments?.length) {
    const err = validateAttachments(attachments)
    if (err) {
      sendSessionError(ws, ctx, `Invalid attachment: ${err}`)
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

  // #4733 — wire-arrival fingerprint. Logs the byte/codepoint/whitespace
  // shape of the inbound `data` so a corrupted-text reproduction can be
  // localized to the dashboard boundary vs the server's PTY write path
  // by correlating against the `writePtyText (msg=… codePoints=… bytes=…)`
  // line in `claude-tui-session.js`. No content is logged — only counts —
  // so this stays safe to enable when the env flag is set.
  //
  // Concretely, the original #4733 repro showed `writePtyText … codePoints=332`
  // for a message the user intended at ~360 chars with ~24 spaces missing.
  // Without an inbound-side counter we cannot tell whether the 28-codepoint
  // delta was stripped before the WS arrived, in `trim()` (leading/trailing
  // only, max +2 codepoints), in the evaluator rewrite path (#3635), or by
  // the throttle. The four counts here pin which boundary stripped them.
  //
  // Gated behind `CHROXY_LOG_WIRE_FINGERPRINT=1` so it stays off by default
  // — the input handler is the hot path for every typed/pasted user message
  // and an unconditional info-level log line per message is too noisy for
  // production user logs. Flip the env var when actively investigating
  // #4733 (or any future "text stripped between dashboard and PTY" report).
  if (process.env.CHROXY_LOG_WIRE_FINGERPRINT === '1' && typeof text === 'string' && text.length > 0) {
    // Strip a SINGLE trailing newline (CR, LF, or CRLF) before fingerprinting
    // so counts line up with `_writePtyTextThrottled` in claude-tui-session.js,
    // which strips one trailing newline before the bracketed-paste body. Shift+
    // Enter ends multi-line dashboard drafts with a trailing \n; counting it
    // here would inflate `codePoints`/`wsTotal` by 1 (or 2 for \r\n) and skew
    // the dashboard-vs-PTY boundary correlation by the same amount.
    let fp = text
    if (fp.endsWith('\r\n')) fp = fp.slice(0, -2)
    else if (fp.endsWith('\n') || fp.endsWith('\r')) fp = fp.slice(0, -1)
    const bytes = Buffer.byteLength(fp, 'utf8')
    const codePoints = [...fp].length
    // Counts ALL interior whitespace runs as one-per-run AND total chars
    // separately — the run count survives a "double-space collapsed to
    // single" bug (each run keeps at least one char) while the total
    // catches "all interior spaces stripped" (run count → 0, total → 0).
    let whitespaceTotal = 0
    let whitespaceRuns = 0
    let maxWordLen = 0
    let currWordLen = 0
    let inWhitespace = false
    for (const ch of fp) {
      if (/\s/.test(ch)) {
        whitespaceTotal += 1
        if (!inWhitespace) whitespaceRuns += 1
        inWhitespace = true
        if (currWordLen > maxWordLen) maxWordLen = currWordLen
        currWordLen = 0
      } else {
        inWhitespace = false
        currWordLen += 1
      }
    }
    if (currWordLen > maxWordLen) maxWordLen = currWordLen
    log.info(`input wire-fingerprint (client=${client.id} session=${targetSessionId} bytes=${bytes} codePoints=${codePoints} wsTotal=${whitespaceTotal} wsRuns=${whitespaceRuns} maxWordLen=${maxWordLen}) (#4733)`)
  }

  if (ctx.sessions.sessionManager.isBudgetPaused(targetSessionId)) {
    sendSessionError(ws, ctx, 'Session is paused — cost budget exceeded. Use "Resume Budget" to continue.')
    return
  }

  // Input conflict: reject if session is already processing input from a different client
  if (entry.session.isRunning) {
    const primaryClientId = ctx.transport.getPrimary(targetSessionId)
    if (primaryClientId && primaryClientId !== client.id) {
      ctx.transport.send(ws, buildInputConflictError(targetSessionId, msg.clientMessageId))
      return
    }
  }

  // #3666 — hoist the per-session evaluator-await lock check above the
  // routing logic so trivial-skip-path messages also reject during an
  // in-flight evaluator round-trip. Without this, a fast trivial draft
  // (short ack, configured skip pattern, or evaluator-disabled session)
  // can sneak through to record+send while a slower non-trivial draft
  // is still awaiting the evaluator on the same session — history
  // insertion order then doesn't match arrival order. Same input_conflict
  // category as the existing pre-await check; rejection (not queueing)
  // matches the #3636 design.
  const _pendingAwaits = _getEvaluatorAwaits(ctx)
  if (_pendingAwaits.has(targetSessionId)) {
    ctx.transport.send(ws, buildInputConflictError(
      targetSessionId,
      msg.clientMessageId,
      'Session is already evaluating a previous draft. Wait for it to finish or interrupt first.',
    ))
    return
  }

  if (entry.session.resumeSessionId) {
    ctx.services.checkpointManager.createCheckpoint({
      sessionId: targetSessionId,
      resumeSessionId: entry.session.resumeSessionId,
      cwd: entry.cwd,
      description: trimmed.slice(0, 100),
      messageCount: ctx.sessions.sessionManager.getHistoryCount(targetSessionId),
      // #6766: capture the fork boundary (last assistant transcript UUID of the
      // turn that just ended) so restoring this pre-turn checkpoint can truncate
      // the conversation to here. Undefined on providers that don't track it.
      boundaryMessageId: entry.session.lastMessageUuid,
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
  let _historyRecorded = false
  function recordHistoryEntry(text) {
    if (_historyRecorded) return
    _historyRecorded = true
    ctx.sessions.sessionManager.recordUserInput(targetSessionId, buildHistoryText(text, attCount), messageId)
    ctx.sessions.sessionManager.touchActivity(targetSessionId)
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
  // `ctx.services.config.promptEvaluatorSkipPattern` when set, falling back to the
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
      // is in flight. The hoisted check at function entry (#3666) already
      // rejects messages arriving during an in-flight await, so by the time
      // we reach here the lock is guaranteed empty — we just take it.
      const pending = _pendingAwaits

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
        const primaryClientId = ctx.transport.getPrimary(targetSessionId)
        if (primaryClientId && primaryClientId !== client.id) {
          ctx.transport.send(ws, buildInputConflictError(targetSessionId, msg.clientMessageId))
          return
        }
      }

      if (result?.verdict === 'rewrite' && typeof result.rewritten === 'string' && result.rewritten.trim()) {
        counters.delete(targetSessionId)
        const evaluatorIterationId = randomUUID()
        ctx.transport.broadcastToSession(targetSessionId, {
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
        ctx.transport.broadcastToSession(targetSessionId, {
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
        ctx.transport.updatePrimary(targetSessionId, client.id)
        ctx.transport.broadcast(
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

  // #5313 (WP-1.3): sendMessage is fire-and-forget. If a provider's
  // sendMessage returns a rejecting promise, an unhandled rejection escapes
  // to process-level unhandledRejection → process.exit(1), crashing EVERY
  // session in the daemon over a single per-session send fault. Capture the
  // return and, if thenable, attach a .catch that logs and swallows — real
  // delivery failures still surface to the client via the provider's 'error'
  // event. Mirrors the start() guard in session-manager.js createSession.
  // #5936: forward the resolved clientMessageId so that if this send lands
  // mid-turn and the provider queues it (BaseSession `_outgoingQueue`), the
  // `message_queued` mirror carries the id the sender's optimistic copy uses —
  // letting that client reconcile its queued bubble. Providers that send
  // immediately ignore the extra option.
  const sendResult = entry.session.sendMessage(textToSend, attachments, { isVoice: !!msg.isVoice, clientMessageId: messageId })
  if (sendResult && typeof sendResult.catch === 'function') {
    sendResult.catch((err) => {
      const message = err?.message || String(err)
      log.error(`sendMessage rejected for session ${targetSessionId}: ${message}${err?.stack ? '\n' + err.stack : ''}`)
    })
  }

  ctx.transport.updatePrimary(targetSessionId, client.id)

  // Echo user_input to other clients so they see what was sent (#1119).
  // The echo carries `trimmed` (the user's original text) so paired
  // clients can dedup their optimistic copy of what the user typed —
  // the rewritten text is signalled separately via evaluator_rewrite.
  ctx.transport.broadcast(
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
    return
  }
  // #4935 — same visibility fix as handleInput for the silent post-restart
  // wedge. An interrupt addressed to a stale session ID used to drop on the
  // floor with no log line and no client-side error. Surface both so the
  // dashboard can clear stale state and the operator can grep chroxy.log.
  //
  // IMPORTANT (Copilot review #4979): like handleInput, resolveSession() can
  // return null for binding mismatches as well as truly-missing sessions.
  // Disambiguate before emitting so a binding mismatch surfaces as the
  // canonical SESSION_TOKEN_MISMATCH envelope rather than being mislabelled
  // as a stale-ID drop.
  if (msg.sessionId && client.boundSessionId && client.boundSessionId !== msg.sessionId) {
    log.info(`interrupt rejected: session-token mismatch sessionId=${msg.sessionId} boundSessionId=${client.boundSessionId} client=${client.id}`)
    ctx.transport.send(ws, {
      type: 'session_error',
      ...buildSessionTokenMismatchPayload({
        sessionManager: ctx.sessions.sessionManager,
        boundSessionId: client.boundSessionId,
      }),
    })
    return
  }
  if (msg.sessionId) {
    log.info(`interrupt dropped: session not found sessionId=${msg.sessionId} client=${client.id} (likely stale ID after daemon restart — see #4935)`)
    ctx.transport.send(ws, {
      type: 'session_error',
      code: 'SESSION_NOT_FOUND',
      message: `Session not found: ${msg.sessionId}`,
      attemptedSessionId: msg.sessionId,
    })
  }
}

/**
 * #5943 (epic #5935): cancel ONE queued send-while-busy follow-up by its
 * `clientMessageId`. Authority mirrors `interrupt` — acting on your OWN bound
 * session, not a privilege escalation — so resolveSession's binding check is the
 * only gate (a pairing-bound client may cancel a queued message in its own
 * session but not another's). Whole-queue cancellation stays on `interrupt`.
 *
 * The session removes the matching `_outgoingQueue` entry and emits
 * `message_dequeued { reason: 'cancelled' }`, which mirrors to every client via
 * the EventNormalizer — so there is no extra reply on success here. A
 * stale/duplicate cancel (id already flushed) is a silent no-op, like an
 * `interrupt` to an idle session. Binding/stale-id failures surface the same
 * session_error envelopes as handleInterrupt.
 */
function handleCancelQueued(ws, client, msg, ctx) {
  const entry = resolveSession(ctx, msg, client)
  if (entry) {
    const cancelled = entry.session.cancelQueuedMessage(msg.clientMessageId)
    log.info(`cancel_queued ${msg.clientMessageId} from ${client.id} → ${cancelled ? 'removed' : 'no-op (not queued)'}`)
    return
  }
  // Disambiguate a binding mismatch from a truly-missing session, exactly as
  // handleInterrupt does (Copilot review #4979).
  if (msg.sessionId && client.boundSessionId && client.boundSessionId !== msg.sessionId) {
    log.info(`cancel_queued rejected: session-token mismatch sessionId=${msg.sessionId} boundSessionId=${client.boundSessionId} client=${client.id}`)
    ctx.transport.send(ws, {
      type: 'session_error',
      ...buildSessionTokenMismatchPayload({
        sessionManager: ctx.sessions.sessionManager,
        boundSessionId: client.boundSessionId,
      }),
    })
    return
  }
  if (msg.sessionId) {
    log.info(`cancel_queued dropped: session not found sessionId=${msg.sessionId} client=${client.id}`)
    ctx.transport.send(ws, {
      type: 'session_error',
      code: 'SESSION_NOT_FOUND',
      message: `Session not found: ${msg.sessionId}`,
      attemptedSessionId: msg.sessionId,
    })
  }
}

/**
 * #5271 (Control Room Phase 2a): cancel a single in-flight activity node
 * (currently a Task subagent) in a session. Authority mirrors `interrupt` —
 * acting on your own session, NOT a privilege escalation — so resolveSession's
 * standard binding check is the only gate: a pairing-bound client may cancel
 * activity in its OWN bound session but not another's. Whole-turn interruption
 * stays on the `interrupt` message.
 *
 * The session does the work via `cancelActivity(activityId)`, which returns a
 * structured `{ ok, reason }` (never throws). On success the terminal
 * `activity_delta` is broadcast through the existing agent_completed → registry
 * path, so the tree updates live with no extra reply here. Only failures are
 * surfaced to the caller, as a `session_error` (the same envelope interrupt
 * uses for binding/stale-id problems).
 */
async function handleCancelActivity(ws, client, msg, ctx) {
  const entry = resolveSession(ctx, msg, client)
  if (!entry) {
    // Disambiguate a binding mismatch from a truly-missing session, exactly as
    // handleInterrupt/handleInput do (Copilot review #4979) — a bound client
    // aiming at another session must see SESSION_TOKEN_MISMATCH, not a stale-id
    // drop.
    if (msg.sessionId && client.boundSessionId && client.boundSessionId !== msg.sessionId) {
      log.info(`cancel_activity rejected: session-token mismatch sessionId=${msg.sessionId} boundSessionId=${client.boundSessionId} client=${client.id}`)
      ctx.transport.send(ws, {
        type: 'session_error',
        ...buildSessionTokenMismatchPayload({
          sessionManager: ctx.sessions.sessionManager,
          boundSessionId: client.boundSessionId,
        }),
      })
      return
    }
    const sid = msg.sessionId || client.activeSessionId
    if (!sid) {
      // No id at all to act on — emit the canonical "No active session"
      // envelope (mirrors handleInput) rather than a misleading
      // "Session not found: undefined" with a null attemptedSessionId.
      log.info(`cancel_activity dropped: no active session client=${client.id}`)
      sendSessionError(ws, ctx, 'No active session')
      return
    }
    log.info(`cancel_activity dropped: session not found sessionId=${sid} client=${client.id}`)
    ctx.transport.send(ws, {
      type: 'session_error',
      code: 'SESSION_NOT_FOUND',
      message: `Session not found: ${sid}`,
      attemptedSessionId: sid,
    })
    return
  }

  const session = entry.session
  if (typeof session.cancelActivity !== 'function') {
    // Defensive: every BaseSession defines it (defaulting to not-supported),
    // but guard so a provider that somehow lacks it can't crash the handler.
    ctx.transport.send(ws, {
      type: 'session_error',
      code: 'CANCEL_ACTIVITY_FAILED',
      message: 'This session does not support cancelling activity',
      reason: 'not-supported',
      activityId: msg.activityId,
      sessionId: msg.sessionId,
      requestId: msg.requestId,
    })
    return
  }

  const result = await session.cancelActivity(msg.activityId)
  if (!result || result.ok !== true) {
    const reason = (result && result.reason) || 'unknown'
    log.info(`cancel_activity ${msg.activityId} not actioned (${reason}) client=${client.id}`)
    ctx.transport.send(ws, {
      type: 'session_error',
      code: 'CANCEL_ACTIVITY_FAILED',
      message: `Could not cancel activity: ${reason}`,
      reason,
      activityId: msg.activityId,
      sessionId: msg.sessionId,
      requestId: msg.requestId,
    })
    return
  }
  // Success: the node's terminal activity_delta (via agent_completed → registry)
  // is still the substantive change, but #5277 also sends an explicit positive
  // ack echoing the activityId + requestId so the dashboard can correlate this
  // specific cancel click to its outcome — the delta alone is uncorrelated and
  // may lag or drop.
  log.info(`cancel_activity ${msg.activityId} actioned by ${client.id}`)
  ctx.transport.send(ws, {
    type: 'cancel_activity_ack',
    activityId: msg.activityId,
    sessionId: msg.sessionId,
    requestId: msg.requestId,
  })
}

function handleResumeBudget(ws, client, msg, ctx) {
  const budgetSessionId = msg.sessionId || client.activeSessionId
  if (!budgetSessionId || !resolveSession(ctx, msg, client)) {
    sendSessionError(ws, ctx, 'No valid session for budget resume')
    return
  }
  // #5752: only un-pause + broadcast `budget_resumed` (which injects a "session
  // resumed" chat note) when the session was actually paused. Always ack the
  // requesting client so the resume control is never a dead button — a click on
  // an already-resumed session (a second client in a shared session, or a stale
  // tap) resolves cleanly with wasPaused:false instead of silence.
  const wasPaused = ctx.sessions.sessionManager.isBudgetPaused(budgetSessionId)
  if (wasPaused) {
    ctx.sessions.sessionManager.resumeBudget(budgetSessionId)
    ctx.transport.broadcastToSession(budgetSessionId, { type: 'budget_resumed', sessionId: budgetSessionId })
    log.info(`Budget resumed for session ${budgetSessionId} by ${client.id}`)
  } else {
    log.info(`resume_budget no-op for session ${budgetSessionId} (not paused) by ${client.id}`)
  }
  ctx.transport.send(ws, {
    type: 'budget_resume_ack',
    sessionId: budgetSessionId,
    wasPaused,
    // Echo requestId for correlation. The inbound ResumeBudgetSchema caps it at
    // 128 (#5752), so the ack always satisfies ServerBudgetResumeAckSchema —
    // same single-enforcement-point pattern as cancel_activity_ack (#5277).
    ...(typeof msg.requestId === 'string' ? { requestId: msg.requestId } : {}),
  })
}

function handleRegisterPushToken(ws, client, msg, ctx) {
  if (!ctx.services.pushManager || typeof msg.token !== 'string') return

  // Pass the client's stable ID as the token owner so PushManager can
  // ref-count ownership for multi-connection scenarios (2026-04-11
  // audit blocker 6 + Copilot review on PR #2806): two clients that
  // register the same token must both be released before the token
  // is actually pruned from the registry. Without ref-counting, the
  // first disconnect would strip the token from the second client's
  // active session.
  const ok = ctx.services.pushManager.registerToken(msg.token, client.id)
  if (!ok) {
    ctx.transport.send(ws, {
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

  // #4587: bump lastSeenAt + platform on the matching per-device entry
  // (if one exists) so the per-device list UI reflects last-connect time
  // rather than last-pref-change time. NO-OPs on devices that have never
  // muted anything — touchDevice deliberately won't create empty entries.
  ctx.services.pushManager.touchDevice(msg.token, client.deviceInfo?.platform || null)
}

/**
 * Notification preferences handlers (#4541).
 *
 * Two message types: get the current prefs snapshot, patch + re-emit. The
 * server shallow-merges the patch over existing prefs (so the UI can send
 * one toggle at a time) and persists the result via PushManager.setPrefs,
 * which atomically writes ~/.chroxy/notification-prefs.json.
 *
 * After a successful set the snapshot is broadcast to every connected
 * client so additional dashboards / mobile sessions stay in lockstep —
 * mirrors the BYOK credentials handler pattern (#4052).
 *
 * Auth posture: any authenticated WS client can call these. chroxy isn't
 * multi-tenant — the user controls their own notification routing. The
 * existing WS auth gate is sufficient.
 */
function handleNotificationPrefsGet(ws, client, msg, ctx) {
  if (!ctx.services.pushManager) {
    sendError(ws, msg?.requestId, 'NOT_AVAILABLE', 'notification prefs unavailable (no push manager)', undefined, ctx)
    return
  }
  ctx.transport.send(ws, {
    type: 'notification_prefs',
    requestId: msg?.requestId,
    prefs: ctx.services.pushManager.getPrefs(),
  })
}

function handleNotificationPrefsSet(ws, client, msg, ctx) {
  if (!ctx.services.pushManager) {
    sendError(ws, msg?.requestId, 'NOT_AVAILABLE', 'notification prefs unavailable (no push manager)', undefined, ctx)
    return
  }
  const patch = msg?.prefs
  if (!patch || typeof patch !== 'object') {
    sendError(ws, msg?.requestId, 'INVALID_REQUEST', 'prefs object is required', undefined, ctx)
    return
  }
  // #4551 — validate every device-key against the same gate
  // register_push_token enforces (see PushManager.isValidPushTokenFormat
  // for the canonical rules). The Zod schema caps the devices map size
  // as a DoS guard but does not check key format, so without this an
  // authenticated client can stuff arbitrary strings into
  // ~/.chroxy/notification-prefs.json and have them re-served on every
  // notification_prefs_get. Reject the whole patch on the first bad key
  // (no partial-apply) so the on-disk state stays clean.
  if (patch.devices && typeof patch.devices === 'object') {
    // #4610 — `typeof [] === 'object'` so an array-typed `devices`
    // payload would otherwise reach the key-format loop and reject
    // with a misleading "Invalid device token format" error (true,
    // since '0'/'1'/... fail the 20-char gate, but it mis-describes
    // the real shape mismatch). Reject arrays explicitly with a
    // shape-specific message so misbehaving clients get a clear
    // signal that `devices` must be a map keyed by push token.
    if (Array.isArray(patch.devices)) {
      sendError(ws, msg?.requestId, 'INVALID_REQUEST', 'devices must be an object, not an array', undefined, ctx)
      return
    }
    for (const key of Object.keys(patch.devices)) {
      if (!PushManager.isValidPushTokenFormat(key)) {
        sendError(ws, msg?.requestId, 'INVALID_REQUEST', 'Invalid device token format in notification_prefs_set', undefined, ctx)
        return
      }
    }
  }
  let next
  try {
    // #4587: pass the auth-derived platform so new per-device entries get
    // tagged with ios/android/desktop/web without the client having to
    // include it in every patch. A patch-supplied `platform` (future
    // client carrying richer info) still wins inside setPrefs.
    next = ctx.services.pushManager.setPrefs(patch, { platform: client.deviceInfo?.platform || null })
  } catch (err) {
    log.warn(`notification_prefs_set persist failed: ${err?.message}`)
    sendError(ws, msg?.requestId, 'NOTIFICATION_PREFS_WRITE_FAILED', err?.message || 'write failed', undefined, ctx)
    return
  }
  // Reply to the originating client with the requestId so promise-style
  // callers can resolve.
  ctx.transport.send(ws, { type: 'notification_prefs', requestId: msg?.requestId, prefs: next })
  // Broadcast without requestId so other dashboards / clients update too.
  // Without this, a second dashboard would keep showing stale state until
  // the user re-opened Settings.
  if (typeof ctx.transport.broadcast === 'function') {
    ctx.transport.broadcast({ type: 'notification_prefs', prefs: next })
  }
}

function handleUserQuestionResponse(ws, client, msg, ctx) {
  // #5753 — route by toolUseId when one is supplied. `_registerQuestionRoute`
  // maps every question that has a toolUseId at DISPATCH time (before the
  // client can answer) and the entry is pruned the moment the question is
  // answered (below) or its session is destroyed (ws-server `_questionSessionMap`
  // sweep). So a toolUseId that is supplied but NO LONGER IN THE MAP means the
  // question is already gone — answered, expired-and-cleared, or a double
  // submit. Falling back to `client.activeSessionId` in that case (the old
  // behavior) would mis-deliver the late answer to whatever DIFFERENT question
  // that session is now waiting on — a deny meant for one tool landing on
  // another (Guardian's #5731 finding). Fail CLOSED: drop it.
  //
  // Gate on `.has()`, not value-truthiness: legacy-cli forwarding registers the
  // route with a NULL sessionId (single default session, `getSession(null)`
  // serves the default entry), so a mapped-but-null value is a VALID route, not
  // a drop. And use `typeof === 'string'` (not truthiness) so an empty-string
  // toolUseId — allowed by the wire schema — is treated as supplied (and thus
  // dropped when unmapped), never as "no toolUseId".
  //
  // Only fall back to the active session when NO toolUseId was supplied at all
  // (legacy single-session mode / clients that don't send one), where there is
  // a single question in flight and no cross-question mis-route risk.
  let questionSessionId
  if (typeof msg.toolUseId === 'string') {
    if (!ctx.permissions.questionSessionMap.has(msg.toolUseId)) {
      sessionLogger(client.activeSessionId || undefined).info(
        `user_question_response dropped: stale/unknown toolUseId=${msg.toolUseId} (question already resolved or its session is gone)`,
      )
      return
    }
    questionSessionId = ctx.permissions.questionSessionMap.get(msg.toolUseId)
  } else {
    questionSessionId = client.activeSessionId
  }

  // Enforce session binding before consuming the mapping — if the client
  // is bound to a different session, leave the mapping intact so the
  // correct client can still respond.
  if (client.boundSessionId && client.boundSessionId !== questionSessionId) return

  // #4788 (audit P0.2): for UNBOUND clients, require the questionSessionId
  // to match the client's active or subscribed sessions before routing the
  // answer. Without this, an unbound dashboard tab could submit an answer
  // for any session by replaying a known toolUseId — paired with the log
  // leak in #4787 this enables cross-session answer hijacking. Routes through
  // isSessionViewer (#6030) — the SAME predicate _broadcastToSession uses to
  // pick recipients (ws-broadcaster.js _matchesSession) — so the set of clients
  // permitted to ANSWER a question is provably the same set that could
  // legitimately have RECEIVED it, and the two can never drift. Leaves the
  // mapping intact so the legitimate subscribed client can still respond.
  if (!client.boundSessionId) {
    if (!isSessionViewer(client, questionSessionId)) return
  }

  if (msg.toolUseId) ctx.permissions.questionSessionMap.delete(msg.toolUseId)

  const entry = ctx.sessions.sessionManager.getSession(questionSessionId)
  if (entry && typeof entry.session.respondToQuestion === 'function' && typeof msg.answer === 'string') {
    // #4604: log the incoming response shape so a multi-question form
    // wedge is correlatable from chroxy.log alone (toolUseId + map-key
    // count distinguishes the SDK's per-question form from the TUI's
    // single-answer string).
    // #4651: log freeformText presence so the Other-path two-stage write
    // is greppable in chroxy.log without leaking the user's text.
    // Copilot review (#4753): explicit boolean — `&&` of a string yields
    // the string, not a boolean, which downstream conditionals can read
    // but is confusing in a `freeform=${...}` log template.
    const hasFreeform = typeof msg.freeformText === 'string' && msg.freeformText.length > 0
    // #4792: scope this entry to the question's session so the WsServer
    // log fan-out (#4787) routes it to the bound dashboard for that
    // session rather than dropping it for all bound clients. The line
    // carries toolUseId + freeform.length — useful for correlating
    // multi-question form wedges per-session in chroxy.log.
    //
    // Legacy single-session mode (ws-message-handlers.js createCliSessionAdapter)
    // serves `getSession(undefined)` from a synthetic default entry, so
    // `questionSessionId` can legitimately be falsy here. In that mode
    // there's exactly one session and no cross-session fan-out leak risk,
    // so fall back to the unscoped `log` instead of throwing — multi-session
    // deployments always have a real sessionId from the toolUseId map or
    // client.activeSessionId.
    const qlog = sessionLogger(questionSessionId)
    qlog.info(`user_question_response received: toolUseId=${msg.toolUseId || '?'} answer.length=${(msg.answer || '').length} answers.keys=${msg.answers ? Object.keys(msg.answers).length : 0} freeform=${hasFreeform ? msg.freeformText.length : 0}`)
    // #4668: forward msg.toolUseId so claude-tui-session can route the
    // answer to the right pending entry in its Map. Sessions that don't
    // care about toolUseId (cli-session, sdk-session via permission-
    // manager) ignore the extra argument — JS positional args make this
    // a safe addition. ByokSession's respondToQuestion forwards to
    // _permissions.respondToQuestion which similarly ignores trailing
    // args it doesn't read.
    // #4651: forward msg.freeformText as a final opts object — claude-tui-
    // session uses it to drive the two-stage Other-path write (digit →
    // text-input prompt → freeform text + Enter). Other providers ignore
    // the trailing arg.
    const opts = hasFreeform ? { freeformText: msg.freeformText } : undefined
    entry.session.respondToQuestion(msg.answer, msg.answers, msg.toolUseId, opts)
  }
}

// #5835 Phase 3: forward raw client keystrokes to the live claude-tui PTY — true
// remote control (the read-only mirror becomes interactive). Authority mirrors
// handleInput, deliberately reusing this file's gate primitives:
//   - resolveSession enforces the pairing-bound session binding (a bound token may
//     only drive its own session); a mismatch surfaces the canonical
//     SESSION_TOKEN_MISMATCH envelope (same disambiguation as handleInput/interrupt).
//   - The primary-ownership gate keeps a SINGLE driver: claimPrimary (NON-force)
//     claims an unclaimed session for this client, no-ops if already primary, and
//     REJECTS (input_conflict) if another client owns it. Unlike a chat send — which
//     force-adopts an idle session — a stray keystroke must NOT silently steal a live
//     TUI from its driver; taking over is the explicit claim_primary hand-off, and an
//     observer rides along on the read-only mirror.
// Only claude-tui sessions expose writeTerminalInput; other providers have no PTY,
// so the keystroke is silently dropped for them.
function handleTerminalInput(ws, client, msg, ctx) {
  const sid = msg.sessionId || client.activeSessionId
  const entry = resolveSession(ctx, msg, client)
  if (!entry) {
    // Disambiguate a binding mismatch from a truly-missing session (same as
    // handleInput/handleInterrupt) so a bound client aiming elsewhere sees the
    // canonical SESSION_TOKEN_MISMATCH rather than a silent drop. A truly-missing
    // session returns silently (no SESSION_NOT_FOUND envelope, unlike handleInput):
    // terminal_input is a high-frequency keystroke stream, so a per-key error toast
    // would be noise — the dashboard already clears stale ids off the chat path.
    if (msg.sessionId && client.boundSessionId && client.boundSessionId !== msg.sessionId) {
      log.info(`terminal_input rejected: session-token mismatch sessionId=${msg.sessionId} boundSessionId=${client.boundSessionId} client=${client.id}`)
      ctx.transport.send(ws, {
        type: 'session_error',
        ...buildSessionTokenMismatchPayload({
          sessionManager: ctx.sessions.sessionManager,
          boundSessionId: client.boundSessionId,
        }),
      })
    }
    return
  }
  if (typeof entry.session.writeTerminalInput !== 'function') return
  // #5985b (epic #5982): keystrokes into a user-shell PTY require the PRIMARY
  // token class (audit C1/C4) — a paired device must NEVER type into a root
  // shell. Silent return (parity with the viewer guard below); the create +
  // terminal_subscribe gates already prevent a non-primary client from becoming
  // a shell viewer, so this is defense-in-depth on the keystroke path.
  if (isUserShellSession(entry) && client.isPrimaryToken !== true) return
  // Must be VIEWING the session to drive its PTY (#5842 review) — parity with
  // terminal_resize/terminal_size (#5840): keystrokes are strictly more powerful
  // than a resize, so they require at least the same viewer precondition. A client
  // that merely knows an (even unclaimed) session id can't silently become its
  // driver without watching it. The normal flow (Output tab open → activeSessionId
  // === sid) passes; this only blocks blind cross-session poking.
  if (!isSessionViewer(client, sid)) return
  if (typeof msg.data !== 'string' || msg.data.length === 0) return
  // Single-driver gate: claim (or confirm) primary; reject an observer's keystroke.
  const res = ctx.transport.claimPrimary(sid, client.id)
  if (res?.rejected) {
    ctx.transport.send(ws, buildInputConflictError(
      sid,
      undefined,
      'Another device is driving this session. Take over from the session menu to type into the terminal.',
    ))
    return
  }
  entry.session.writeTerminalInput(msg.data)
}

export const inputHandlers = {
  input: handleInput,
  interrupt: handleInterrupt,
  cancel_queued: handleCancelQueued,
  terminal_input: handleTerminalInput,
  cancel_activity: handleCancelActivity,
  resume_budget: handleResumeBudget,
  register_push_token: handleRegisterPushToken,
  notification_prefs_get: handleNotificationPrefsGet,
  notification_prefs_set: handleNotificationPrefsSet,
  user_question_response: handleUserQuestionResponse,
}
