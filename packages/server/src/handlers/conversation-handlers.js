/**
 * Conversation, history, and cost summary handlers.
 *
 * Handles: list_conversations, search_conversations, resume_conversation,
 *          request_conversation_transcript, request_full_history,
 *          request_session_context, request_cost_summary
 */
import { realpathSync } from 'fs'
import { scanConversations as defaultScanConversations } from '../conversation-scanner.js'
import { searchConversations as defaultSearchConversations } from '../conversation-search.js'
import { resolveJsonlPath, readConversationHistoryWithMetaAsync as defaultReadConversationTranscript } from '../jsonl-reader.js'
import { validateCwdAllowed, broadcastFocusChanged, resolveSession, autoSubscribeOtherClients, buildSessionTokenMismatchPayload, sendSessionError } from '../handler-utils.js'
import { scopeConversationsToClient } from '../conversation-scope.js'
import { sendChunkedWithBackpressure, sendHistoryEntry } from '../ws-history.js'
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
 *
 * `history_replay_start` carries `truncated` for the slice actually sent (#7501),
 * from the same meta reader `getFullHistoryAsync` uses — this path is subject to
 * jsonl-reader's `MAX_MESSAGES` / `MAX_TRANSCRIPT_BYTES` caps exactly as the
 * full-history path is, and used to omit the field entirely.
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
    // Defense-in-depth: validateCwdAllowed already resolved + vetted the realpath
    // but discarded it. Canonicalize ONCE here and reuse the resolved path for
    // BOTH the scope check and the on-disk read, so a symlinked hint can't point
    // the scope check at one directory and the file read at another.
    try {
      cwd = realpathSync(msg.cwd)
    } catch {
      sendSessionError(ws, ctx, `Cannot resolve path: ${msg.cwd}`)
      return
    }
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
  //
  // #7501 — through the META reader, not the array-returning sibling one line
  // away. This path is subject to jsonl-reader's OWN two caps (the 500
  // most-recent `MAX_MESSAGES` window and the `MAX_TRANSCRIPT_BYTES` tail read),
  // and the array alone cannot express either: 500 entries back is equally the
  // shape of a complete 500-message conversation. This is the SAME reader
  // `getFullHistoryAsync` uses for the full-history path (#7484) rather than a
  // second meta implementation, so both replays report the same caps from one
  // place and cannot drift apart.
  const readTranscript = ctx.readConversationTranscript || defaultReadConversationTranscript
  let messages = []
  let truncated = false
  try {
    const read = await readTranscript(resolveJsonlPath(cwd, conversationId))
    if (Array.isArray(read)) {
      // The pre-#7501 reader shape. `ctx.readConversationTranscript` is a
      // TEST-ONLY injection seam — nothing in production injects it, so this
      // branch is unreachable outside the suite — and a legacy fixture still
      // supplies a bare array, accepted and reported as untruncated rather than
      // throwing on a shape that used to work. `false` over omitting the field:
      // omitting it puts the frame back into the exact absent-vs-false ambiguity
      // #7501 removes, and gives the wire two shapes to pin instead of one. Same
      // posture handleRequestFullHistory takes toward a descriptor-less legacy
      // manager.
      messages = read
    } else if (read && Array.isArray(read.messages)) {
      messages = read.messages
      // Strict boolean, matching how both clients read this family of field.
      truncated = read.truncated === true
    }
  } catch (err) {
    // A read error is graceful — surface an empty transcript rather than a crash.
    log.warn(`Failed to read transcript for ${conversationId}: ${err.message}`)
    messages = []
    // And unreadable is NOT truncated: nothing was dropped from a slice that
    // does not exist, and claiming otherwise would put a permanent "history
    // incomplete" banner in front of every conversation whose file has gone.
    // jsonl-reader takes the same position on its own catch.
    truncated = false
  }

  // Stream back using the SAME wire shape as request_full_history so existing
  // renderers light up. `sessionId` carries the conversationId (read-only; no
  // live session exists for a closed conversation).
  //
  // Route through ctx.transport so a method-style sender keeps its receiver;
  // the shared loop only ever needs a (ws, payload) callable.
  const send = (target, payload) => ctx.transport.send(target, payload)

  // #7501 — `truncated` describes the collection ACTUALLY SENT, and is emitted
  // unconditionally: absence reads to a client exactly like `truncated: false`,
  // which is what let this path hand the viewer the last 500 messages of a
  // 5,000-message conversation with nothing on the wire saying so.
  send(ws, { type: 'history_replay_start', sessionId: conversationId, truncated, fullHistory: true, conversationId })

  // #7480 — the THIRD path through the #4833 chunk-and-drain loop, and the
  // second one that had no `bufferedAmount` check at all: it pushed the whole
  // transcript onto the socket in one turn of the event loop.
  // `MAX_TRANSCRIPT_BYTES` caps the transcript, not how much of it is buffered
  // on the socket at once, so a large transcript on a slow link could still
  // sail past the 1MB EVICT_THRESHOLD in ws-client-sender.js — which CLOSES
  // the client. Measured on the pre-fix code, a 30-entry fat transcript peaked
  // at 6,148,308 bytes buffered: 5.9x the eviction line.
  sendChunkedWithBackpressure(ws, messages, {
    emit: (entry) => {
      send(ws, {
        type: 'message',
        messageType: entry.type,
        content: entry.content,
        tool: entry.tool,
        timestamp: entry.timestamp,
        sessionId: conversationId,
      })
    },
    onDone: () => {
      send(ws, { type: 'history_replay_end', sessionId: conversationId })
      // #7340: defence-in-depth. The dashboard normally DIVERTS this frame — it
      // routes `history_replay_start`/`message`/`history_replay_end` for a pending
      // transcript id into the transcript viewer, which never touches
      // `sessionStates`, so no wipe happens — and the mobile app has no transcript
      // surface at all. This covers the fail-safe branch where the diversion is not
      // armed (a raw client, or a frame that arrives without a pending request), in
      // which case the client wipes its ACTIVE session's badge list because
      // `conversationId` is a closed transcript with no live session behind it.
      // Idempotent either way: both clients dedupe `agent_spawned` by `toolUseId`.
      //
      // The re-seed is CONDITIONAL, so it stays inside onDone rather than being
      // hoisted out of the now-asynchronous loop: hoisting it would fire it
      // before the replay frames it repairs, which is exactly the ordering the
      // #7340 fix exists to establish.
      if (client?.activeSessionId) {
        ctx.transport.reseedActiveAgents(ws, client.activeSessionId)
      }
    },
  })
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
  const sessionManager = ctx.sessions.sessionManager
  const history = await sessionManager.getFullHistoryAsync(targetId)
  // #7484 — `getFullHistoryAsync` returns a descriptor: WHICH source it read
  // (the on-disk JSONL transcript or the ring buffer) alongside the entries and
  // that source's own truncation. Both decisions below turn on it, and neither
  // can be recovered from the entries: a JSONL slice and a ring slice are the
  // same shape of array.
  //
  // A bare array is the pre-#7484 shape. Accepted, and read as the ring buffer
  // it always was, so a legacy ctx fixture keeps replaying rather than throwing
  // — the same posture as the `typeof === 'function'` probes below. The REAL
  // manager's shape is pinned at the producer
  // (tests/session-manager-full-history-source.test.js), because every test on
  // this side stubs the manager and so cannot witness it.
  const hasDescriptor = !!history && !Array.isArray(history) && Array.isArray(history.entries)
  const fullHistory = hasDescriptor ? history.entries : (Array.isArray(history) ? history : [])
  const source = hasDescriptor && history.source === 'jsonl' ? 'jsonl' : 'ring'
  // Route through ctx.transport so a method-style sender keeps its receiver;
  // the shared loop only ever needs a (ws, payload) callable.
  const send = (target, payload) => ctx.transport.send(target, payload)

  // #7460 — frame parity with replayHistory. `truncated` is how a client learns
  // history was dropped on this replay.
  //
  // #7484 — and it must describe the collection ACTUALLY SENT. `isHistoryTruncated`
  // reports the RING BUFFER's overflow, while this handler usually sends the JSONL
  // transcript, which has its own entirely separate caps (500 most-recent
  // messages / a 25MB tail read, jsonl-reader.js). So `truncated: false` could
  // accompany a slice that silently dropped everything before the last 500.
  // Sourced from the descriptor it follows the slice; the probe survives only for
  // the legacy array shape, where the ring IS the slice.
  const truncated = hasDescriptor && typeof history.truncated === 'boolean'
    ? history.truncated
    : (typeof sessionManager.isHistoryTruncated === 'function'
      ? sessionManager.isHistoryTruncated(targetId)
      : false)
  // `latestSeq` must describe what THIS replay actually DELIVERS, not what the
  // ring buffer happens to hold. `getFullHistoryAsync` PREFERS the JSONL
  // transcript whenever `resumeSessionId` is set, and jsonl-reader.js emits only
  // user_input/response/tool_use — none of which carry `_seq`. Sourcing the
  // counter from the buffer there advertises a cursor the client never received:
  // `reconcileReplayEnd` hands it to `recordHistorySeq`, so the NEXT reconnect
  // resolves as already-current and replays NOTHING, stranding the client on the
  // lossy JSONL rebuild. Derived from the entries themselves this is unchanged on
  // the ring-buffer path — that slice is the whole buffer, so its max `_seq` IS
  // `getLatestHistorySeq()` — and correctly advertises nothing on the JSONL path.
  let latestSeq
  for (const entry of fullHistory) {
    if (entry && typeof entry._seq === 'number' && (latestSeq === undefined || entry._seq > latestSeq)) {
      latestSeq = entry._seq
    }
  }
  // Omitted, never zeroed: absence means "this replay carried no cursor", while
  // `latestSeq: 0` is a real seq the client would happily record.
  const seqFrame = latestSeq === undefined ? {} : { latestSeq }

  send(ws, { type: 'history_replay_start', sessionId: targetId, truncated, fullHistory: true, ...seqFrame })

  // #7460 — the SAME chunk + bufferedAmount loop replayHistory uses, from the
  // one implementation of it. Sending a 1000-entry ring buffer synchronously
  // could push the socket past the 1MB EVICT_THRESHOLD in ws-client-sender.js
  // and CLOSE the client: "Sync Full History" — the button a user presses
  // BECAUSE the view looks wrong — was the action that could drop the
  // connection.
  sendChunkedWithBackpressure(ws, fullHistory, {
    emit: (entry) => {
      if (entry.type === 'user_input' || entry.type === 'response' || entry.type === 'tool_use') {
        send(ws, {
          type: 'message',
          messageType: entry.type,
          content: entry.content,
          tool: entry.tool,
          timestamp: entry.timestamp,
          sessionId: targetId,
        })
      } else {
        // This is the SECOND replay path, and both per-entry duties — the
        // `_seq` → `historySeq` map (#7454) and the `result` → `agent_idle`
        // synthesis (#7459 / #4628) — come from ws-history.js's shared emitter
        // rather than a copy that can drift away from it again.
        sendHistoryEntry(send, ws, targetId, entry)
      }
    },
    onDone: () => {
      // #7484 — the JSONL path's heal. `sendHistoryEntry` synthesizes
      // `agent_idle` from a replayed `result`, and a JSONL slice has none:
      // jsonl-reader.js emits user_input/response/tool_use only. Since
      // `getFullHistoryAsync` PREFERS that transcript for any session with a
      // `resumeSessionId` — the normal state of a live claude-family session —
      // the #4628 heal could not fire on the source almost every "Sync Full
      // History" press actually reads.
      //
      // The stale chip is CLIENT-side state: a live `tool_start` whose
      // `tool_result` never arrived (a dropped PostToolUse hook).
      // `history_replay_start` deliberately PRESERVES that set (#4466) and
      // nothing in a JSONL slice can clear it — those entries rebuild as
      // `message` frames, which touch no tool state. `agent_idle` is the only
      // frame that clears it and is not replay-gated.
      //
      // ONE heal, at the end, rather than a per-entry synthesis: JSONL rows
      // carry no dependable turn boundary to hang one on, and landing after the
      // last entry is what makes it unable to wipe an activeTools set
      // MID-replay. Before `history_replay_end`, so it stays inside the window
      // where the #4466 reasoning holds.
      //
      // NOT while `isSessionBusy` reports the session LIVE. `agent_idle` sets
      // isIdle, clears streamingMessageId (hiding the stop button) and clears
      // activeTools — all true after a finished turn, and no `agent_busy` is
      // coming to undo it before the next turn starts.
      //
      // #7507 — "live" here is deliberately WIDER than mid-turn, and the comment
      // this replaced described only the narrow half. `isSessionBusy` is
      // `entry.session.isRunning`, which BaseSession defines as
      // `_isBusy || _backgroundShellTracker.size > 0`: a session whose turn has
      // ENDED but which still holds an un-polled `Bash(run_in_background: true)`
      // shell reads busy (#4307; the 60s advisory sweep must not flip liveness,
      // #5247, so release comes only from BashOutput / destroy / the 4h hard
      // quiesce). Do NOT "simplify" this to `_isBusy`.
      //
      // The reason is CONSISTENCY WITH THE SERVER'S SINGLE BUSY AUTHORITY, not
      // mid-turn correctness. `listSessions()` publishes that same `isRunning` as
      // each entry's `isBusy`, and the dashboard re-derives `isIdle` from it on
      // every `session_list` and `session_activity` (#4639). A narrower `_isBusy`
      // guard would emit an `agent_idle` that the very next broadcast reverts —
      // a flicker, not a heal. Pinned by behaviour in
      // tests/conversation-full-history-replay.test.js (a real SessionManager +
      // BaseSession) and at the producer in
      // tests/session-manager-full-history-source.test.js.
      //
      // Two consequences, recorded rather than hidden:
      //   - On MOBILE the suppression is a pure false negative. The app has no
      //     `session_activity` case and never derives `isIdle` from `isBusy`, so
      //     nothing there would revert a narrower heal — and this synthesized
      //     `agent_idle` is the ONLY thing that can clear a stale chip on that
      //     client (#7479 N2). Fixing it belongs on the app side (give it the
      //     #4639 resync), not by forking this guard per client: tracked in #7518.
      //   - The LIVE path is LESS conservative than this. event-normalizer.js
      //     appends `agent_idle` to every `result` unconditionally, without
      //     consulting `isRunning`; the replay heal mirrors that fan-out
      //     (ws-history.js) everywhere except this state.
      //
      // A manager that cannot answer is treated as idle: "cannot tell" must not
      // silently become "never heal", which is the defect this fixes.
      const busy = typeof sessionManager.isSessionBusy === 'function'
        ? sessionManager.isSessionBusy(targetId)
        : false
      if (source === 'jsonl' && !busy) {
        send(ws, { type: 'agent_idle', sessionId: targetId })
      }
      send(ws, { type: 'history_replay_end', sessionId: targetId, ...seqFrame })
      // #7340: same wipe, same repair — `request_full_history` targets a LIVE
      // session, so its confirmed-backgrounded subagents must be re-asserted
      // after the replay that cleared them.
      ctx.transport.reseedActiveAgents(ws, targetId)
      // #7457: same sweep, same repair. This end frame runs the client's
      // unanswered-prompt sweep exactly as `replayHistory`'s does, so "Sync
      // Full History" — the button a user presses BECAUSE the view looks
      // wrong — would otherwise resolve the very question they are blocked on.
      // The sibling `request_conversation_transcript` replay is exempt: its
      // frames carry a conversationId in `sessionId`, which is never a live
      // session id, so both clients' `updateSession` no-ops and the sweep
      // touches nothing.
      ctx.transport.resendPendingQuestions(ws, targetId)
    },
  })
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
