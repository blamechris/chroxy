import { performance } from 'node:perf_hooks'
import { toShortModelId } from './models.js'
import { createLogger } from './logger.js'
import { buildPermissionRequestMessage } from '@chroxy/protocol'

const log = createLogger('event-normalizer')

// #5555: caps on the delta coalescing buffer's un-flushed residency.
//   - MAX_DELTA_KEY_BYTES: per-stream ceiling. One message buffering more than
//     this between flushes forces an immediate flush of THAT key, preserving
//     order (it is flushed and re-buffered fresh on the next delta).
//   - MAX_DELTA_TOTAL_BYTES: aggregate ceiling across all streams. Crossing it
//     forces a full flush. Guards the many-small-streams case that no per-key
//     cap catches.
// Chosen so a normal stream (sub-second flush windows of a few KB) never trips
// them, while a runaway provider is bounded to ~2MB of residency instead of
// growing the heap until V8 OOMs. Forced flush, never truncation — no data loss.
const MAX_DELTA_KEY_BYTES = 256 * 1024 // 256 KB per stream
const MAX_DELTA_TOTAL_BYTES = 2 * 1024 * 1024 // 2 MB across all streams

// #5578: deflate-aware coalescing windows. The #5568 floors (8ms single / 16ms
// multi) are correct for LAN/loopback peers — deflate is stripped at upgrade,
// each tiny stream_delta is cheap, and a fast emitter producing ~125 frames/sec
// is fine. They are WRONG for deflate-negotiated (tunnel/cellular) peers: every
// stream_delta is ~40-75 bytes including serverTs, UNDER the permessage-deflate
// threshold:1024, so it ships UNCOMPRESSED. The 8ms floor then triples the
// small-packet count (~40 frames/sec at the old 25ms → ~125/sec at 8ms) on
// exactly the links where per-frame cost dominates (small-packet overhead,
// cellular radio wake-ups, tunnel framing). We re-coalesce a beat longer when
// any subscriber is on a deflate socket: ~16ms single / ~25ms multi. These are
// still fixed micro-batch windows below the client-side adaptive EWMA floor
// (store-core resolveDeltaFlushMs, 16-100ms), so they don't reintroduce the
// pre-#5562 server/client window stacking — they only halve the frame rate on
// the links that pay for each frame. LAN sessions keep the tight floors.
const DEFLATE_FLUSH_INTERVAL_MS = 25 // any deflate subscriber, multi-client
const DEFLATE_SINGLE_CLIENT_FLUSH_INTERVAL_MS = 16 // any deflate subscriber, single client

/**
 * Declarative event-to-WS-message mapping.
 *
 * Each entry in EVENT_MAP is:
 *   eventName: (data, ctx) => { messages, sideEffects, registrations }
 *
 * Where:
 *   messages       — Array of { msg, filter? } to broadcast
 *                    filter: optional (client) => boolean predicate
 *   sideEffects    — Array of { type, ... } descriptors executed by WsServer
 *   registrations  — Array of { map, key, value } to register in WsServer maps
 *
 * ctx shape:
 *   { sessionId, mode, getSessionEntry, listSessions, getSessionContext }
 *   mode: 'multi' | 'legacy-cli'
 */

/**
 * #5431 — project a session's outstanding-background-work snapshot into the
 * optional `claude_ready` wire fields. Returns null when the session type
 * doesn't expose a snapshot (only claude-tui implements
 * `getBackgroundTaskSnapshot()` today), the snapshot is unavailable
 * (degraded transcript parse), or there is simply nothing outstanding —
 * in all of those cases the wire message stays byte-identical to the
 * pre-#5431 plain ready, which is the no-regression contract.
 */
function backgroundTaskFields(ctx) {
  try {
    const snap = ctx?.getSessionEntry?.()?.session?.getBackgroundTaskSnapshot?.()
    if (!snap) return null
    // A computed snapshot is ALWAYS emitted, even when empty: clients treat a
    // present `backgroundTasks` (including `[]`) as authoritative and an
    // absent field as "no information — keep state". A task-notification that
    // lands mid-turn would otherwise strand a stale indicator: the turn-end
    // ready computes an empty snapshot, and the idle re-scan poll never arms
    // because nothing is outstanding.
    const tasks = Array.isArray(snap.backgroundTasks) ? snap.backgroundTasks : []
    const fields = { backgroundTasks: tasks }
    if (snap.scheduledWakeup) fields.scheduledWakeup = snap.scheduledWakeup
    return fields
  } catch (err) {
    log.debug?.(`backgroundTaskFields failed: ${err?.message} — emitting plain ready`)
    return null
  }
}

const EVENT_MAP = Object.create(null)
Object.assign(EVENT_MAP, {
  ready: (data, ctx) => {
    // #5431: attach outstanding background work (if any) so a respawn /
    // reconnect mid-orchestration doesn't present the session as fully idle.
    const bgFields = backgroundTaskFields(ctx)
    const messages = [{ msg: { type: 'claude_ready', ...(bgFields || {}) } }]
    const entry = ctx.getSessionEntry?.()
    if (entry) {
      // #3687: prefer the actual model the underlying CLI/SDK reports at
      // init (`data.model`) — that's the truth for the running session.
      // Then fall back to the user's explicit override (`entry.session.model`)
      // so a later `setModel()` call isn't masked by a stale `bootedModel`
      // (SdkSession's setModel doesn't restart the process, so its
      // bootedModel only refreshes on the next init). Finally fall back
      // to bootedModel for the case the original bug fixed: user didn't
      // specify a model AND we're past init AND data.model is missing
      // (e.g. legacy callers, replay paths).
      const reportedModel = data?.model || entry.session.model || entry.session.bootedModel
      messages.push({
        msg: {
          type: 'model_changed',
          model: reportedModel ? toShortModelId(reportedModel) : null,
        },
      })
      messages.push({
        msg: {
          type: 'permission_mode_changed',
          mode: entry.session.permissionMode || 'approve',
        },
      })
    }
    return { messages }
  },

  // #5431: claude-tui's idle transcript re-scan saw the outstanding-work set
  // change (a task-notification landed / a wakeup fired while no turn was
  // running). Re-emit `claude_ready` with the fresh snapshot — the session is
  // idle by definition when this fires, so the ready state is accurate, and
  // an explicit empty `backgroundTasks: []` is the client's signal to clear a
  // stale indicator (absence means "no information", per the schema contract).
  background_tasks_changed: (data) => {
    const tasks = Array.isArray(data?.backgroundTasks) ? data.backgroundTasks : []
    const msg = { type: 'claude_ready', backgroundTasks: tasks }
    if (data?.scheduledWakeup) msg.scheduledWakeup = data.scheduledWakeup
    return { messages: [{ msg }] }
  },

  conversation_id: (data, ctx) => {
    const messages = [
      { msg: { type: 'conversation_id', sessionId: ctx.sessionId, conversationId: data.conversationId } },
    ]
    return {
      messages,
      sideEffects: [{ type: 'session_list' }],
    }
  },

  stream_start: (data, ctx) => {
    // #6756 — a thinking stream_start opens a reasoning bubble on a distinct id.
    // Tag the wire message so the client routes it to a `type: 'thinking'`
    // bubble, and skip the agent_busy / session_list churn: the turn's busy
    // state is already owned by the response stream / the client's 'pending'
    // sentinel, so a per-thinking-block session_list refresh would be noise.
    if (data.thinking) {
      return {
        messages: [{ msg: { type: 'stream_start', messageId: data.messageId, thinking: true } }],
      }
    }
    const messages = [
      { msg: { type: 'stream_start', messageId: data.messageId } },
      { msg: { type: 'agent_busy' } },
    ]
    return {
      messages,
      sideEffects: [
        { type: 'log', message: `[ws] Broadcasting stream_start: ${data.messageId}${ctx.sessionId ? ` (session ${ctx.sessionId})` : ''}` },
        { type: 'session_list' },
      ],
    }
  },

  stream_delta: (data, _ctx) => {
    // #6756 — thinking deltas broadcast IMMEDIATELY (no coalescing). The delta
    // buffer keys only on sessionId:messageId and reconstructs a bare
    // {messageId, delta} on flush, so it can't carry the `thinking` flag; and a
    // thinking bubble uses a distinct messageId anyway, so it never shares a
    // buffer key with the response text. Returning no `buffer` flag sends it
    // straight through with the flag intact.
    if (data.thinking) {
      return {
        messages: [{ msg: { type: 'stream_delta', messageId: data.messageId, delta: data.delta, thinking: true } }],
      }
    }
    // Delta buffering is handled externally — normalizer returns the raw delta
    // and the caller decides whether to buffer or flush.
    return {
      messages: [{ msg: { type: 'stream_delta', messageId: data.messageId, delta: data.delta } }],
      buffer: true, // signal to caller to buffer this delta
    }
  },

  stream_end: (data, ctx) => {
    // #6756 — a thinking stream_end finalises the reasoning bubble's label. No
    // flush_deltas: thinking deltas were never buffered, and flushing here would
    // prematurely emit the response text buffer.
    if (data.thinking) {
      return {
        messages: [{ msg: { type: 'stream_end', messageId: data.messageId, thinking: true } }],
      }
    }
    return {
      messages: [{ msg: { type: 'stream_end', messageId: data.messageId } }],
      sideEffects: [
        { type: 'flush_deltas', sessionId: ctx.sessionId },
        { type: 'log', message: `[ws] Broadcasting stream_end: ${data.messageId}${ctx.sessionId ? ` (session ${ctx.sessionId})` : ''}` },
      ],
    }
  },

  message: (data, _ctx) => {
    const msg = {
      type: 'message',
      messageType: data.type,
      content: data.content,
      tool: data.tool,
      options: data.options,
      timestamp: data.timestamp,
    }
    return { messages: [{ msg }] }
  },

  tool_start: (data) => {
    const msg = { type: 'tool_start', messageId: data.messageId, toolUseId: data.toolUseId, tool: data.tool, input: data.input }
    if (data.serverName) msg.serverName = data.serverName
    return { messages: [{ msg }] }
  },

  // #4080: incremental partial-JSON chunk for a streaming tool_use
  // `input`. Emitted between tool_start and tool_result while the
  // SDK's input_json_delta chunks arrive. The wire shape mirrors the
  // chroxy event the session emits — clients concatenate partialJson
  // onto a per-toolUseId accumulator (see #4081 / PR #4239 for the
  // dashboard + mobile renderer that consumes this).
  tool_input_delta: (data) => ({
    messages: [{
      msg: {
        type: 'tool_input_delta',
        messageId: data.messageId,
        toolUseId: data.toolUseId,
        partialJson: data.partialJson,
      },
    }],
  }),

  tool_result: (data) => {
    const msg = { type: 'tool_result', toolUseId: data.toolUseId, result: data.result, truncated: data.truncated }
    if (data.images?.length) msg.images = data.images
    // #6712: forward the failed-tool flag onto the LIVE wire (this normalizer is
    // the serialization choke point for both backends). Without it a failed
    // codex mcpToolCall / orphan-sweep result would render plain live but
    // error-styled after a history replay (which sends the entry raw).
    if (typeof data.isError === 'boolean') msg.isError = data.isError
    return { messages: [{ msg }] }
  },

  agent_spawned: (data) => ({
    messages: [{
      msg: { type: 'agent_spawned', toolUseId: data.toolUseId, description: data.description, startedAt: data.startedAt },
    }],
  }),

  agent_completed: (data) => ({
    messages: [{
      msg: { type: 'agent_completed', toolUseId: data.toolUseId },
    }],
  }),

  // #5016: nested-sub-bubble support — a Task subagent's intermediate
  // wire event (tool_start / tool_result / tool_input_delta /
  // stream_delta) re-emitted by the parent under `agent_event` so the
  // dashboard renders it inside the parent's Task tool_call bubble.
  // `parentToolUseId` is the parent's tool_use id (same key used by
  // agent_spawned / agent_completed). `eventType` is the child's
  // original event name. `payload` is the verbatim child event payload.
  agent_event: (data, ctx) => {
    const out = {
      messages: [{
        msg: {
          type: 'agent_event',
          parentToolUseId: data.parentToolUseId,
          eventType: data.type,
          payload: data.payload ?? {},
        },
      }],
    }
    // #5056: a relayed Task-subagent permission_request must register its
    // requestId in permissionSessionMap (keyed to the PARENT session id,
    // ctx.sessionId) — exactly like a top-level permission_request does
    // (see the permission_request normalizer above). Two reasons:
    //   1. A pairing-BOUND dashboard client's Approve/Deny is rejected
    //      unless permissionSessionMap[requestId] === boundSessionId
    //      (handlePermissionResponse, settings-handlers.js ~line 309).
    //      The dashboard responds on the PARENT session (the only one it
    //      knows), so the map must point requestId → parent session.
    //   2. registerPermissionRoute auto-subscribes eligible clients to
    //      the session so the broadcast actually reaches them (#4798).
    // The in-process redirect to the child PermissionManager then happens
    // in ClaudeByokSession.respondToPermission via its routing table — so
    // the wire-level routing (parent session) and the in-process routing
    // (child manager) compose correctly. permission_resolved emits the
    // matching delete so the map is pruned on every resolution path.
    const payload = (data.payload && typeof data.payload === 'object') ? data.payload : {}
    if (data.type === 'permission_request' && payload.requestId) {
      out.registrations = [{ map: 'permission', key: payload.requestId, value: ctx?.sessionId }]
    } else if (data.type === 'permission_resolved' && payload.requestId) {
      out.registrations = [{ map: 'permission', key: payload.requestId, action: 'delete' }]
    }
    return out
  },

  // #4307: pending-background-shells snapshot changed for a session.
  // BaseSession emits this on both push (run_in_background tool_result
  // observed) and clear (BashOutput tool_use observed). Full snapshot
  // is on the wire so a client subscribed to this event but missing
  // earlier broadcasts (e.g. just-reconnected, late-listener) sees the
  // canonical state without needing a delta protocol. The
  // session_list snapshot carries the same field for the late-joining
  // path. Also pushes a session_list side effect so the SessionInfo
  // entry's `pendingBackgroundShells` slot refreshes for clients that
  // render off the list rather than subscribing to the event directly.
  background_work_changed: (data, ctx) => ({
    messages: [{
      msg: {
        type: 'background_work_changed',
        sessionId: ctx.sessionId,
        pending: Array.isArray(data?.pending) ? data.pending : [],
      },
    }],
    sideEffects: [{ type: 'session_list' }],
  }),

  // #5160: Control Room activity tree. The ActivityRegistry (owned by
  // BaseSession) maps the existing in-flight signals (tool_start /
  // agent_spawned / background_work_changed / permission_request / …) into
  // `ActivityEntry` records and emits these two events. We inject the
  // canonical `ctx.sessionId` (matching `background_work_changed`) so the
  // wire message carries the SessionManager key the dashboard routes on,
  // regardless of what internal id the session held. Both are transient —
  // not replayed from history; a reconnecting client gets the full tree from
  // the snapshot-on-subscribe in ws-history.sendSessionInfo.
  activity_delta: (data, ctx) => ({
    messages: [{
      msg: {
        type: 'activity_delta',
        sessionId: ctx.sessionId,
        schemaVersion: data.schemaVersion,
        op: data.op,
        entry: data.entry,
      },
    }],
  }),

  activity_snapshot: (data, ctx) => ({
    messages: [{
      msg: {
        type: 'activity_snapshot',
        sessionId: ctx.sessionId,
        schemaVersion: data.schemaVersion,
        entries: Array.isArray(data?.entries) ? data.entries : [],
      },
    }],
  }),

  mcp_servers: (data) => ({
    messages: [{
      msg: { type: 'mcp_servers', servers: data.servers },
    }],
  }),

  // #5936 (epic #5935): outgoing-message queue mirror. The session emits these
  // when a send-while-busy follow-up enters (`message_queued`) or leaves
  // (`message_dequeued`) the server-authoritative queue. We inject the canonical
  // `ctx.sessionId` (the SessionManager key the dashboard routes on) — exactly
  // like activity_delta / background_work_changed — regardless of any internal
  // id the session held. Both transient deltas: not replayed from history. A
  // server→client queue SNAPSHOT for reconnect rehydration is the store-core
  // follow-up (#5937); this slice ships only the live deltas.
  message_queued: (data, ctx) => ({
    messages: [{
      msg: {
        type: 'message_queued',
        sessionId: ctx.sessionId,
        ...(typeof data?.clientMessageId === 'string' ? { clientMessageId: data.clientMessageId } : {}),
        text: typeof data?.text === 'string' ? data.text : '',
        queueLength: typeof data?.queueLength === 'number' ? data.queueLength : 0,
      },
    }],
  }),

  message_dequeued: (data, ctx) => ({
    messages: [{
      msg: {
        type: 'message_dequeued',
        sessionId: ctx.sessionId,
        ...(typeof data?.clientMessageId === 'string' ? { clientMessageId: data.clientMessageId } : {}),
        queueLength: typeof data?.queueLength === 'number' ? data.queueLength : 0,
        // #5943: pass the per-item cancel reason through alongside the two
        // slice-① reasons; anything unrecognised collapses to 'flush' (the
        // benign default — the client transitions the bubble to sent).
        reason: data?.reason === 'interrupted' || data?.reason === 'cancelled' ? data.reason : 'flush',
      },
    }],
  }),

  // #3234: skill content-hash mismatch detected by SkillsTrustStore. Only the
  // 8-char hash prefixes go on the wire — the full SHA never leaves the
  // server, matching the sanitised log format from #3215. `mode` is the
  // active trust mode at the time of detection ('warn' or 'block') so a
  // dashboard can render distinct UX (warn = banner, block = the skill is
  // already filtered out so a stronger prompt is appropriate). The event
  // is transient — not replayed on reconnect, since the loader re-checks
  // hashes every time it scans skills.
  //
  // #3241: prefer the explicit `mode` carried by the loader payload over
  // deriving from `blocked`. The loader projects `trustStore.mode`
  // directly so the wire signal matches the operator-facing config rather
  // than a downstream consequence. Falls back to deriving from `blocked`
  // for older callers and stays defensive against unknown values.
  skill_changed: (data, ctx) => {
    const oldHash = typeof data?.oldHash === 'string' ? data.oldHash : ''
    const newHash = typeof data?.newHash === 'string' ? data.newHash : ''
    const explicitMode = data?.mode === 'block' || data?.mode === 'warn' ? data.mode : null
    const mode = explicitMode || (data?.blocked ? 'block' : 'warn')
    return {
      messages: [{
        msg: {
          type: 'skill_changed',
          skillName: data?.name || '',
          sessionId: ctx.sessionId || null,
          oldHashPrefix: oldHash.slice(0, 8),
          newHashPrefix: newHash.slice(0, 8),
          mode,
        },
      }],
    }
  },

  // #3297: community skill pending first-activation trust grant. Transient —
  // not replayed on reconnect. Fired when the loader discovers a community
  // skill for which no trust grant exists yet.
  skill_trust_request: (data, ctx) => ({
    messages: [{
      msg: {
        type: 'skill_trust_request',
        skillName: data?.name || '',
        author: data?.author || '',
        source: data?.source || 'global',
        description: data?.description || '',
        path: data?.path || '',
        sessionId: ctx.sessionId || null,
      },
    }],
  }),

  plan_started: () => ({
    messages: [{ msg: { type: 'plan_started' } }],
  }),

  plan_ready: (data) => ({
    messages: [{
      msg: { type: 'plan_ready', allowedPrompts: data.allowedPrompts },
    }],
  }),

  // #3899: soft inactivity warning. Session emits this after the soft
  // window of silence; we forward it as a transient WS message so the
  // dashboard / mobile app can render the check-in chip. Session stays
  // alive (no `agent_idle`, no `result`) so existing busy/pending state
  // is preserved. Push notification is dispatched by server-cli's own
  // listener — keep the WS path unmuted so an actively-watching client
  // still gets the chip even if push is suppressed.
  inactivity_warning: (data) => ({
    messages: [{
      msg: {
        type: 'inactivity_warning',
        messageId: data.messageId,
        idleMs: data.idleMs,
        prefab: data.prefab,
      },
    }],
  }),

  // #4653: chroxy-side multi-question AskUserQuestion deny — surfaces the
  // permission-hook's silent intervention (#4648) as a user-visible event.
  // Forwarded only to subscribers of THIS session: the counter is per-
  // session and a deny on session A shouldn't tick the chip on session B.
  multi_question_intervention: (data) => ({
    messages: [{
      msg: {
        type: 'multi_question_intervention',
        toolUseId: data.toolUseId,
        questionCount: data.questionCount,
        reason: data.reason,
        timestamp: data.timestamp,
      },
    }],
  }),

  result: (data, ctx) => {
    const messages = [
      { msg: { type: 'result', cost: data.cost, duration: data.duration, usage: data.usage, sessionId: data.sessionId } },
      { msg: { type: 'agent_idle' } },
    ]
    const sideEffects = [{ type: 'session_list' }]
    if (ctx.mode === 'multi') {
      sideEffects.push({ type: 'refresh_context', sessionId: ctx.sessionId })
    }
    return { messages, sideEffects }
  },

  cost_update: (data) => ({
    messages: [{ msg: { type: 'cost_update', sessionCost: data.sessionCost, totalCost: data.totalCost, budget: data.budget } }],
  }),

  // #4072: cumulative per-session usage + cost broadcast on every priced
  // result. Fires alongside cost_update — the two carry different shapes
  // (cost_update is budget-oriented; session_usage is the full token
  // breakdown for the dashboard / app badge). Subscription-only
  // providers (claude-tui) emit `result` without a numeric `cost` so
  // their session_usage never fires and `cumulativeUsage` stays zero.
  session_usage: (data) => ({
    messages: [{ msg: { type: 'session_usage', cumulativeUsage: data.cumulativeUsage } }],
  }),

  // #4075: soft per-session cost-threshold crossing. Distinct from
  // budget_warning (which is budget-cap-relative); this is the
  // "you've spent $X" notification that fires ONCE per session when
  // cumulativeUsage.costUsd crosses the configured threshold (default
  // $5). The dashboard + app render a dismissible banner.
  session_cost_threshold_crossed: (data) => ({
    messages: [{ msg: { type: 'session_cost_threshold_crossed', costUsd: data.costUsd, thresholdUsd: data.thresholdUsd } }],
  }),

  budget_warning: (data) => ({
    messages: [{ msg: { type: 'budget_warning', sessionCost: data.sessionCost, budget: data.budget, percent: data.percent, message: data.message } }],
  }),

  budget_exceeded: (data) => ({
    messages: [{ msg: { type: 'budget_exceeded', sessionCost: data.sessionCost, budget: data.budget, percent: data.percent, message: data.message } }],
  }),

  user_question: (data, ctx) => ({
    messages: [{
      msg: { type: 'user_question', toolUseId: data.toolUseId, questions: data.questions },
    }],
    registrations: [{ map: 'question', key: data.toolUseId, value: ctx.sessionId }],
  }),

  permission_request: (data, ctx) => ({
    messages: [{
      msg: buildPermissionRequestMessage({
        requestId: data.requestId,
        tool: data.tool,
        description: data.description,
        input: data.input,
        remainingMs: data.remainingMs,
      }),
    }],
    registrations: [{ map: 'permission', key: data.requestId, value: ctx.sessionId }],
    sideEffects: [{
      type: 'push',
      category: 'permission',
      title: 'Permission needed',
      body: `Claude wants to use: ${data.tool}`,
      data: { requestId: data.requestId, tool: data.tool },
      channelId: 'permission',
    }],
  }),

  permission_expired: (data, ctx) => ({
    messages: [{
      msg: {
        type: 'permission_expired',
        requestId: data.requestId,
        sessionId: ctx.sessionId,
        message: data.message,
      },
    }],
  }),

  // #3048: clear stale prompts on every connected client when a permission
  // resolves via any path (user response, timeout, abort signal, clearAll).
  // The SDK paths in settings-handlers.js (WS) and ws-permissions.js (HTTP)
  // were de-inlined to use this mapping, but the legacy non-SDK branches in
  // those files (no PermissionManager available) still broadcast inline.
  //
  // #3736: also emit a delete registration so the WsServer routing map
  // (permissionSessionMap or questionSessionMap) is pruned on every
  // resolution path — including the internal auto-resolve paths (timeout,
  // aborted, auto_mode, cleared) where no user response ever arrives to
  // trigger the message-handler-level delete. Without this, long-running
  // sessions accumulate stale entries (small leak, unbounded growth until
  // session destroy). The AskUserQuestion variant carries `toolUseId`
  // instead of `requestId` and uses a separate map.
  permission_resolved: (data, ctx) => {
    const out = { messages: [] }
    if (data.requestId) {
      // Permission-prompt variant — broadcast a permission_resolved message
      // matching the original permission_request and prune the routing-map
      // entry that ws-forwarding set when the request was first registered.
      out.messages.push({
        msg: {
          type: 'permission_resolved',
          requestId: data.requestId,
          decision: data.decision,
          sessionId: ctx.sessionId,
        },
      })
      out.registrations = [{ map: 'permission', key: data.requestId, action: 'delete' }]
    } else if (data.toolUseId) {
      // AskUserQuestion variant — there is no `permission_resolved` wire
      // contract for questions (clients dismiss the prompt via the
      // user_question_response round-trip, not via a broadcast), so don't
      // synthesise a bogus message with `requestId`/`decision` both
      // undefined. Only emit the cleanup registration so questionSessionMap
      // is pruned. Pre-#3736 the sdk-session re-emit was gated on
      // `requestId` and dropped the question variant entirely, so the
      // normalizer never saw it; widening the gate would now have emitted
      // a malformed broadcast if we kept the unconditional messages entry.
      out.registrations = [{ map: 'question', key: data.toolUseId, action: 'delete' }]
    }
    return out
  },

  error: (data) => {
    const msg = {
      type: 'message',
      messageType: 'error',
      content: data.message,
      timestamp: Date.now(),
    }
    if (data.code) msg.code = data.code
    // #4947: forward `attemptedResumeId` when CliSession's resume-failure
    // path tagged the error envelope (see cli-session.js
    // `_handleChildClose` — emits `error{code:'resume_unknown',
    // attemptedResumeId, message}` from server PR #4944). The dashboard
    // ResumeUnknownChip surfaces this id as subtext so operators can
    // correlate against `~/.chroxy/session-state.json.resumeConversationId`
    // without grepping logs.
    //
    // #4948: also forward on `resume_unknown_exhausted` — the terminal
    // escalation code emitted when the post-fallback retry ALSO matches the
    // unknown-resume pattern. Same operator-correlation rationale; the
    // dashboard renders a distinct "auto-recovery exhausted" affordance but
    // still wants to surface the attempted id as subtext.
    //
    // Hardening (from PR #4967 Copilot review):
    //   1. Gate strictly on the two resume-failure codes so a buggy producer
    //      can't sneak the field onto unrelated error envelopes.
    //   2. Trim whitespace and treat whitespace-only as missing — same UX
    //      guard the chip's render-time check already applies, but enforced
    //      at the wire boundary so downstream consumers (mobile app, future
    //      log/console viewers) see a consistent "present or absent, never
    //      present-but-empty" shape.
    //   3. Enforce the same 256-char cap the wire schema declares
    //      (`ServerMessageSchema.attemptedResumeId`). The server doesn't
    //      validate outgoing messages against ServerMessageSchema before
    //      send, so without this guard a misbehaving producer could ship a
    //      megabyte payload that the dashboard accepts (lax client parse)
    //      but trips Zod-validating consumers. Silently truncate rather
    //      than drop — the truncated id still helps operator triage.
    if (
      (data.code === 'resume_unknown' || data.code === 'resume_unknown_exhausted') &&
      typeof data.attemptedResumeId === 'string'
    ) {
      const trimmed = data.attemptedResumeId.trim()
      if (trimmed.length > 0) {
        msg.attemptedResumeId = trimmed.length > 256 ? trimmed.slice(0, 256) : trimmed
      }
    }
    // #5067: forward captured `stdout` / `stderr` on docker-byok
    // postCreateCommand failures so the operator can diagnose without
    // re-running the broken setup. The session layer
    // (docker-byok-session.js) already tail-caps each stream to
    // POST_CREATE_OUTPUT_CAP_BYTES (4 KiB) before emitting; we re-cap at
    // the wire boundary at 8 KiB per stream as a belt-and-suspenders
    // bound (matches ServerMessageSchema.{stdout,stderr}.max(8192)) so a
    // misbehaving producer can't ship a megabyte payload that the
    // dashboard accepts but trips Zod-validating consumers. Gated
    // strictly on the post-create-failure code so a buggy producer can't
    // sneak the fields onto unrelated error envelopes — same hardening
    // pattern as the resume_unknown gate above. Empty-string and
    // non-string both treated as "absent" so receivers see a consistent
    // "present or absent, never present-but-empty" shape.
    if (data.code === 'post_create_command_failed') {
      if (typeof data.stdout === 'string' && data.stdout.length > 0) {
        msg.stdout = data.stdout.length > 8192 ? data.stdout.slice(0, 8192) : data.stdout
      }
      if (typeof data.stderr === 'string' && data.stderr.length > 0) {
        msg.stderr = data.stderr.length > 8192 ? data.stderr.slice(0, 8192) : data.stderr
      }
    }
    return { messages: [{ msg }] }
  },

  // #4756: user-initiated Stop confirmation. CliSession emits `stopped`
  // when the child process exits cleanly after `interrupt()` set the
  // `_intentionalStop` flag (see cli-session.js `_handleChildClose`). This
  // pairs with `error` — `error` is the louder "crashed unexpectedly,
  // restarting" toast that the auto-respawn path triggers, while
  // `session_stopped` is the quiet "you asked, it stopped" confirmation.
  // Clients should treat it as informational, NOT an error condition.
  // `code` is the exit status from the child; typically 0 on clean SIGINT
  // exit but kept on the wire so clients can render the numeric code for
  // diagnostic purposes if non-zero (e.g. SIGTERM = 143). Gated on
  // `Number.isInteger` (not bare `typeof === 'number'`) so NaN / Infinity
  // / floats from a defensive provider can't reach the wire — the schema
  // is `z.number().int()`, so non-integers would fail client-side parsing.
  // `sessionId` is OMITTED on the legacy-cli path where ctx.sessionId is
  // null, matching the `claude_ready` / `error` legacy-cli convention so
  // receivers treat the message as "applies to the connected legacy CLI"
  // rather than seeing `sessionId: null`. On the multi-session path the
  // field is also injected by `_broadcastToSession`, so this guard
  // additionally protects against accidental `sessionId: null` if the
  // upstream ctx ever degrades.
  stopped: (data, ctx) => {
    const msg = { type: 'session_stopped' }
    if (typeof ctx.sessionId === 'string' && ctx.sessionId.length > 0) {
      msg.sessionId = ctx.sessionId
    }
    if (Number.isInteger(data?.code)) msg.code = data.code
    return { messages: [{ msg }] }
  },

  // #3544: surface the cumulative stdin_dropped totals on the wire so
  // dashboards and the mobile app can render a "X bytes lost over N drops"
  // banner / badge for sessions that are silently truncating input at the
  // SidecarProcess pre-dial cap. Transient — not replayed on reconnect,
  // but the cumulative counters are session-lifetime so the next drop
  // re-publishes the running total. The `escalated` flag mirrors the
  // server-side log level (true = first drop / threshold-cross / every-Nth)
  // so the UI can use a louder treatment for the loud-signal moments.
  stdin_dropped_totals: (data, ctx) => {
    const bytes = typeof data?.bytes === 'number' && Number.isFinite(data.bytes)
      ? Math.max(0, Math.trunc(data.bytes))
      : 0
    const count = typeof data?.count === 'number' && Number.isFinite(data.count)
      ? Math.max(0, Math.trunc(data.count))
      : 0
    const reason = typeof data?.reason === 'string' && data.reason.length > 0
      ? data.reason
      : 'unknown'
    const escalated = typeof data?.escalated === 'boolean' ? data.escalated : false
    return {
      messages: [{
        msg: {
          type: 'stdin_dropped_totals',
          sessionId: ctx.sessionId ?? null,
          bytes,
          count,
          reason,
          escalated,
        },
      }],
    }
  },

})

/**
 * EventNormalizer transforms session events into a uniform set of
 * WS messages, side effects, and registration actions.
 *
 * Owns delta buffering with configurable flush interval.
 */
export class EventNormalizer {
  /**
   * @param {object} [opts]
   * @param {number} [opts.flushIntervalMs=16] - #5562: default delta micro-batch
   *   window. This is NOT an adaptive throttle — it's a small fixed window that
   *   coalesces the burst of per-token deltas a provider emits into a single
   *   emit + broadcast, bounding per-token CPU/socket overhead. The ADAPTIVE
   *   throttle lives client-side (store-core resolveDeltaFlushMs, a 16-100ms
   *   EWMA keyed on render cost). Before #5562 the server window was 25/50ms,
   *   which STACKED on top of the client EWMA — up to ~150ms of pure buffering
   *   on a poor link, and a LAN client never got under the 25ms floor. Shrinking
   *   it to ~8-16ms leaves the client EWMA as the sole adaptive system while the
   *   server still amortizes the per-token broadcast cost.
   * @param {number} [opts.singleClientFlushIntervalMs=8] - #5562: tighter
   *   micro-batch window used when EXACTLY ONE client is subscribed to the
   *   session being buffered. With a single viewer there's no fan-out to
   *   amortize, so the window only needs to absorb the immediate per-token burst
   *   (the common phone-on-LAN / single-dashboard case). The subscriber-count
   *   distinction is kept because it bounds broadcast amplification — a wider
   *   window on multi-client sessions still batches the fan-out — but both
   *   values are now far below the client EWMA floor so they no longer dominate
   *   end-to-end latency.
   * @param {(sessionId: string|null) => (number|null)} [opts.getSubscriberCount]
   *   - returns how many clients are subscribed to `sessionId`, or null when
   *   unknown (e.g. legacy single-session mode). When the count is exactly 1 the
   *   single-client window is used; otherwise (0, ≥2, or null) the default.
   * @param {number} [opts.deflateFlushIntervalMs=25] - #5578: multi-client
   *   window used when ANY subscriber of the session is on a deflate-negotiated
   *   (tunnel/cellular) socket. Wider than the LAN default because each
   *   sub-threshold delta ships uncompressed; see DEFLATE_FLUSH_INTERVAL_MS.
   * @param {number} [opts.deflateSingleClientFlushIntervalMs=16] - #5578:
   *   single-client window when the sole subscriber is on a deflate socket.
   * @param {(sessionId: string|null) => boolean} [opts.getHasDeflateSubscriber]
   *   - returns true when ANY subscriber of `sessionId` is on a
   *   deflate-negotiated socket. Resolved O(subscribers) via the reverse index
   *   (#5575). When absent (legacy mode) the deflate-aware widening is disabled
   *   and the LAN floors apply.
   */
  constructor({ flushIntervalMs = 16, singleClientFlushIntervalMs = 8, getSubscriberCount = null, getHasDeflateSubscriber = null, deflateFlushIntervalMs = DEFLATE_FLUSH_INTERVAL_MS, deflateSingleClientFlushIntervalMs = DEFLATE_SINGLE_CLIENT_FLUSH_INTERVAL_MS, maxKeyBytes = MAX_DELTA_KEY_BYTES, maxTotalBytes = MAX_DELTA_TOTAL_BYTES } = {}) {
    this._flushIntervalMs = flushIntervalMs
    this._singleClientFlushIntervalMs = singleClientFlushIntervalMs
    this._deflateFlushIntervalMs = deflateFlushIntervalMs
    this._deflateSingleClientFlushIntervalMs = deflateSingleClientFlushIntervalMs
    this._getSubscriberCount = typeof getSubscriberCount === 'function' ? getSubscriberCount : null
    this._getHasDeflateSubscriber = typeof getHasDeflateSubscriber === 'function' ? getHasDeflateSubscriber : null
    // #5555: residency caps for the coalescing buffer. A runaway provider (huge
    // tool output, model repetition loop) can grow this Map between flushes
    // faster than ws-broadcaster's socket backpressure can react — the data
    // hasn't reached a socket yet, so backpressure never trips and V8 OOMs the
    // daemon. We bound RESIDENCY (not content): exceeding a cap forces an
    // immediate ordered flush of the affected key / whole buffer. No truncation,
    // no data loss — the cap just shortens how long bytes live un-flushed.
    this._maxKeyBytes = maxKeyBytes
    this._maxTotalBytes = maxTotalBytes
    // Byte sizes tracked incrementally (UTF-8) so the hot path never
    // re-serializes the buffer to measure it.
    this._deltaKeyBytes = new Map() // key -> byte length of its accumulated text
    this._deltaTotalBytes = 0 // sum of _deltaKeyBytes values
    // Delta buffer: key -> accumulated text
    // In multi-session mode key = `${sessionId}:${messageId}`, otherwise just messageId
    this._deltaBuffer = new Map()
    // #5515 (epic #5514): key -> monotonic ms of the FIRST delta buffered into
    // the current (un-flushed) window. Lets ws-forwarding measure the time the
    // oldest token in a flush spent inside the server (coalescing + forwarding)
    // — a true monotonic duration, same process both ends.
    this._deltaEmitMono = new Map()
    this._deltaFlushTimer = null
    // #5516: monotonic deadline (performance.now ms) the pending flush timer is
    // scheduled to fire at. Lets a later single-client buffer SHORTEN an
    // already-scheduled default-window timer instead of waiting it out.
    this._deltaFlushDeadline = 0
    this._onFlush = null // callback: (entries) => void, where entries = [{ key, sessionId, messageId, delta, emitMonoMs }]
  }

  /**
   * #5516/#5562/#5578: resolve the fixed micro-batch window for the session
   * currently being buffered. Two axes:
   *   - subscriber COUNT: exactly 1 → tighter single-client window; else (0, 2+,
   *     unknown) → the multi-client window.
   *   - deflate LOCALITY: any subscriber on a deflate-negotiated (tunnel/
   *     cellular) socket → widen to the deflate window for the resolved count.
   *     #5578 — on those links each sub-1024B stream_delta ships uncompressed,
   *     so the LAN floors (8/16ms) triple the small-packet count where per-frame
   *     cost dominates. All-LAN sessions keep the tight floors.
   * No subscriber-count resolver wired (legacy mode) → always the default LAN
   * window. This is a fixed window, not an adaptive throttle — the adaptive part
   * lives in the client's resolveDeltaFlushMs EWMA (store-core).
   * @param {string|null} sessionId
   * @returns {number} flush interval in ms
   */
  _resolveFlushIntervalMs(sessionId) {
    if (!this._getSubscriberCount) return this._flushIntervalMs
    const count = this._getSubscriberCount(sessionId)
    const single = count === 1
    // #5578: prefer the deflate window when any subscriber sits on a deflate
    // socket. The predicate is O(subscribers) and short-circuits on the first
    // match (ws-broadcaster._hasDeflateSubscriber) — no O(all-clients) scan.
    if (this._getHasDeflateSubscriber && this._getHasDeflateSubscriber(sessionId)) {
      return single ? this._deflateSingleClientFlushIntervalMs : this._deflateFlushIntervalMs
    }
    return single ? this._singleClientFlushIntervalMs : this._flushIntervalMs
  }

  /**
   * Register a custom event type handler at runtime.
   * Allows provider plugins to extend the normalizer without modifying EVENT_MAP.
   *
   * @param {string} name - Event name (e.g. 'my_provider_event')
   * @param {Function} handler - (data, ctx) => { messages, sideEffects?, registrations? }
   * @throws {Error} if name is not a non-empty string or handler is not a function
   */
  registerEventType(name, handler) {
    if (typeof name !== 'string' || !name) {
      throw new Error('registerEventType: name must be a non-empty string')
    }
    if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
      throw new Error(`registerEventType: reserved key '${name}' is not allowed`)
    }
    if (typeof handler !== 'function') {
      throw new Error('registerEventType: handler must be a function')
    }
    EVENT_MAP[name] = handler
  }

  /**
   * Set the flush callback. Called with buffered deltas when the timer fires.
   * @param {Function} cb - (entries: Array<{ key, sessionId, messageId, delta }>) => void
   */
  set onFlush(cb) {
    this._onFlush = cb
  }

  /**
   * Normalize a session event into WS actions.
   *
   * @param {string} event - Event name (e.g., 'stream_start', 'message')
   * @param {object} data - Event data from the session
   * @param {object} ctx - Context: { sessionId, mode, getSessionEntry, listSessions, getSessionContext }
   * @returns {{ messages?: Array, sideEffects?: Array, registrations?: Array, buffer?: boolean } | null}
   */
  normalize(event, data, ctx) {
    const handler = EVENT_MAP[event]
    if (!handler) return null
    return handler(data, ctx)
  }

  /**
   * Buffer a stream_delta for coalesced delivery.
   * @param {string} sessionId - Session ID (may be null for legacy mode)
   * @param {string} messageId - Stream message ID
   * @param {string} delta - Text delta to buffer
   * @param {number} [emitMonoMs] - #5515: monotonic ms the provider emitted this
   *   delta. First-write-wins per flush window so the flushed entry reports how
   *   long the OLDEST coalesced token waited inside the server.
   */
  bufferDelta(sessionId, messageId, delta, emitMonoMs) {
    const key = sessionId ? `${sessionId}:${messageId}` : messageId
    // #5555: coerce a non-string delta to its string form ONCE and use that for
    // both the buffer concat AND the byte count. A bare `existing + delta` would
    // string-coerce a non-string into the buffer (real residency) while a
    // `typeof delta === 'string'` byte guard scored it as 0 — the caps would
    // under-count actual residency and could miss the OOM ceiling this fix
    // exists to enforce. Coercing once keeps the accounting equal to what's
    // stored. (Providers always emit strings; this is purely defensive.)
    const text = typeof delta === 'string' ? delta : String(delta ?? '')
    const existing = this._deltaBuffer.get(key) || ''
    this._deltaBuffer.set(key, existing + text)
    if (typeof emitMonoMs === 'number' && !this._deltaEmitMono.has(key)) {
      this._deltaEmitMono.set(key, emitMonoMs)
    }
    // #5555: maintain byte-size counters incrementally (UTF-8) — no
    // re-serialization on the hot path. `text` is the only new content, so its
    // byte length is the per-call growth for both the key total and the global
    // total, and it matches exactly what was concatenated above.
    const addedBytes = Buffer.byteLength(text)
    const keyBytes = (this._deltaKeyBytes.get(key) || 0) + addedBytes
    this._deltaKeyBytes.set(key, keyBytes)
    this._deltaTotalBytes += addedBytes

    // #5555: residency caps. Order matters — flush the over-cap KEY first
    // (bounded, targeted), then re-check the global total. A forced flush
    // emits via the same onFlush path the timer uses, so coalescing order is
    // preserved: the over-cap key goes out now, fresh deltas re-buffer behind
    // it. We flush BEFORE arming/keeping the timer below so a tripped cap
    // doesn't also leave a redundant timer pointing at an empty key.
    if (keyBytes >= this._maxKeyBytes) {
      this._forceFlushKey(key)
    }
    if (this._deltaTotalBytes >= this._maxTotalBytes) {
      this._flushDeltas()
    }
    if (this._deltaBuffer.size === 0) {
      // Everything just got force-flushed — no timer needed.
      if (this._deltaFlushTimer) {
        clearTimeout(this._deltaFlushTimer)
        this._deltaFlushTimer = null
        this._deltaFlushDeadline = 0
      }
      return
    }
    // #5516/#5562/#5578: fixed micro-batch window (NOT an adaptive coalescing
    // window) — tighter (8ms) when this session has a single LAN subscriber,
    // default (16ms) for multi/LAN, and WIDER (16/25ms) when any subscriber is
    // on a deflate (tunnel/cellular) socket where each sub-threshold frame ships
    // uncompressed. Its only job is to absorb the per-token burst into one
    // emit/broadcast and bound that overhead; the ADAPTIVE throttle lives
    // client-side in store-core resolveDeltaFlushMs (16-100ms EWMA). The flush
    // timer is shared across all buffered sessions, so a single-client session
    // buffered AFTER a default-window timer was already armed must be able to
    // pull the deadline IN (reschedule to the sooner target) rather than wait
    // out the wider window. We never push a deadline out.
    const intervalMs = this._resolveFlushIntervalMs(sessionId)
    const now = performance.now()
    const wantDeadline = now + intervalMs
    if (!this._deltaFlushTimer) {
      this._deltaFlushDeadline = wantDeadline
      this._deltaFlushTimer = setTimeout(() => this._flushDeltas(), intervalMs)
    } else if (wantDeadline < this._deltaFlushDeadline) {
      clearTimeout(this._deltaFlushTimer)
      this._deltaFlushDeadline = wantDeadline
      this._deltaFlushTimer = setTimeout(() => this._flushDeltas(), Math.max(0, wantDeadline - now))
    }
  }

  /**
   * #5555: force an immediate flush of a SINGLE over-cap key via the onFlush
   * path, preserving coalescing order. The key is removed from all buffer maps;
   * subsequent deltas for it re-buffer fresh behind whatever just went out.
   * No-op (but still drops the key's accounting) when no onFlush is wired.
   * @param {string} key
   */
  _forceFlushKey(key) {
    if (!this._deltaBuffer.has(key)) return
    const delta = this._deltaBuffer.get(key)
    const emitMonoMs = this._deltaEmitMono.get(key)
    this._deltaBuffer.delete(key)
    this._deltaEmitMono.delete(key)
    this._deltaTotalBytes -= this._deltaKeyBytes.get(key) || 0
    this._deltaKeyBytes.delete(key)
    if (this._deltaTotalBytes < 0) this._deltaTotalBytes = 0
    if (this._onFlush) {
      const sepIdx = key.indexOf(':')
      const entry = sepIdx !== -1
        ? { key, sessionId: key.slice(0, sepIdx), messageId: key.slice(sepIdx + 1), delta, emitMonoMs }
        : { key, sessionId: null, messageId: key, delta, emitMonoMs }
      // Mirror _flushDeltas' containment: a throwing broadcast must not escape
      // the buffer hot path (which runs under the provider's event emit).
      try {
        this._onFlush([entry])
      } catch (err) {
        const message = err?.message || String(err)
        log.error(`Delta force-flush onFlush callback threw: ${message}${err?.stack ? '\n' + err.stack : ''}`)
      }
    }
  }

  /**
   * Flush all buffered deltas for a specific session (called before stream_end).
   * Returns the flushed entries so the caller can broadcast them.
   * @param {string|null} sessionId - Session to flush (null = flush all)
   * @returns {Array<{ key, sessionId, messageId, delta, emitMonoMs }>}
   */
  flushSession(sessionId) {
    const entries = []
    if (sessionId) {
      const prefix = `${sessionId}:`
      for (const [key, delta] of this._deltaBuffer) {
        if (key.startsWith(prefix)) {
          const messageId = key.slice(prefix.length)
          entries.push({ key, sessionId, messageId, delta, emitMonoMs: this._deltaEmitMono.get(key) })
          this._deltaBuffer.delete(key)
          this._deltaEmitMono.delete(key)
          // #5555: keep residency counters in sync as keys leave the buffer.
          this._deltaTotalBytes -= this._deltaKeyBytes.get(key) || 0
          this._deltaKeyBytes.delete(key)
        }
      }
      if (this._deltaTotalBytes < 0) this._deltaTotalBytes = 0
    } else {
      // Legacy mode: flush everything
      for (const [key, delta] of this._deltaBuffer) {
        entries.push({ key, sessionId: null, messageId: key, delta, emitMonoMs: this._deltaEmitMono.get(key) })
      }
      this._deltaBuffer.clear()
      this._deltaEmitMono.clear()
      this._deltaKeyBytes.clear()
      this._deltaTotalBytes = 0
    }
    // If buffer is now empty, cancel the pending timer
    if (this._deltaBuffer.size === 0 && this._deltaFlushTimer) {
      clearTimeout(this._deltaFlushTimer)
      this._deltaFlushTimer = null
      this._deltaFlushDeadline = 0
    }
    return entries
  }

  /**
   * Internal: flush all deltas via the onFlush callback.
   */
  _flushDeltas() {
    this._deltaFlushTimer = null
    this._deltaFlushDeadline = 0
    if (this._deltaBuffer.size === 0) return
    if (this._onFlush) {
      const entries = []
      for (const [key, delta] of this._deltaBuffer) {
        const emitMonoMs = this._deltaEmitMono.get(key)
        const sepIdx = key.indexOf(':')
        if (sepIdx !== -1) {
          entries.push({ key, sessionId: key.slice(0, sepIdx), messageId: key.slice(sepIdx + 1), delta, emitMonoMs })
        } else {
          entries.push({ key, sessionId: null, messageId: key, delta, emitMonoMs })
        }
      }
      // #5313 (WP-1.3): _onFlush is a broadcast callback invoked from a
      // setTimeout. A throw here escapes the timer → uncaughtException →
      // process.exit(1), crashing the whole daemon over one bad flush.
      // Contain it: log and swallow. The buffer is cleared in the finally
      // below regardless, so a throwing flush can't wedge the delta buffer
      // and stall every subsequent stream.
      try {
        this._onFlush(entries)
      } catch (err) {
        const message = err?.message || String(err)
        log.error(`Delta flush onFlush callback threw: ${message}${err?.stack ? '\n' + err.stack : ''}`)
      } finally {
        this._deltaBuffer.clear()
        this._deltaEmitMono.clear()
        this._deltaKeyBytes.clear()
        this._deltaTotalBytes = 0
      }
      return
    }
    this._deltaBuffer.clear()
    this._deltaEmitMono.clear()
    this._deltaKeyBytes.clear()
    this._deltaTotalBytes = 0
  }

  /**
   * Clean up timers.
   */
  destroy() {
    if (this._deltaFlushTimer) {
      clearTimeout(this._deltaFlushTimer)
      this._deltaFlushTimer = null
    }
    this._deltaFlushDeadline = 0
    this._deltaBuffer.clear()
    this._deltaEmitMono.clear()
    this._deltaKeyBytes.clear()
    this._deltaTotalBytes = 0
  }
}

// Export EVENT_MAP for testing
export { EVENT_MAP }
