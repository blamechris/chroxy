/**
 * Shared stateless handlers for the message / tool / stream rendering family
 * (message, tool_start / tool_result / tool_input_delta, stream_start /
 * stream_end, result_usage, raw_output, plus the sharedStreamDelta routing
 * core and its PendingDelta / StreamDeltaContext types).
 *
 * Extracted from the handlers barrel (audit P2-3) — pure move, no logic
 * change. Re-exported from ./index so the public surface is unchanged. This
 * is the live-chat wire path: it parses streamed deltas into ChatMessages and
 * ActiveTool entries. See ./index.ts for the stateless-handler contract.
 */

import type { ActiveTool, ChatMessage, ContextOccupancy, ContextUsage, ToolResultImage } from '../types'
import { nextMessageId } from '../utils'
import { isReplayDuplicate } from '../replay-dedup'
import { resolveStreamId } from '../stream-id'
import { isRateLimitMessage } from '@chroxy/protocol'
import { parseRawStringField } from './_shared'

// ---------------------------------------------------------------------------
// message
//
// Generic forwarded message. The shared handler resolves the message type,
// applies the user_input live-echo gate, applies replay-dedup, and builds
// the ChatMessage. The caller dispatches to the session (preserving the
// thinking-placeholder filter) and shows the platform-specific rate-limit
// alert when `isRateLimitError` is true.
// ---------------------------------------------------------------------------

/**
 * Result of {@link handleMessage} — a discriminated union on `shouldDispatch`
 * so callers can use `chatMessage` without a non-null assertion (#3150).
 *
 * `sessionId` was dropped from the payload (#3149): both call sites re-derive
 * it locally via `resolveSessionId(msg, get().activeSessionId)` to pick the
 * right cache for replay-dedup, so the field on the payload was unused.
 */
export type MessagePayload =
  | {
      /** Caller should NOT dispatch a chat message. */
      shouldDispatch: false
    }
  | {
      /** Caller should dispatch the chat message. */
      shouldDispatch: true
      /** Pre-built ChatMessage to dispatch. Always present in this branch. */
      chatMessage: ChatMessage
      /** True when the error message contains rate-limit / quota / overloaded text. */
      isRateLimitError: boolean
      /**
       * Original error content when `isRateLimitError` is true (so caller can
       * surface it via `Alert.alert('Usage Limit', errorContent)`). Null otherwise.
       */
      errorContent: string | null
    }

/**
 * Validate, gate, and normalize a generic forwarded `message` event.
 *
 * - Resolves `msgType = msg.messageType || msg.type` and rejects payloads
 *   where `msgType` / `content` / `timestamp` fail their runtime type checks
 *   (`shouldDispatch: false`). The resulting `ChatMessage` declares
 *   `content: string` and `timestamp: number` as required; rejecting
 *   structurally invalid messages here keeps malformed WS payloads from
 *   crashing render paths.
 * - Returns `shouldDispatch: false` when `msgType === 'user_input'` outside
 *   replay (live echoes are handled by `handleUserInput`).
 * - Returns `shouldDispatch: false` during replay when `isReplayDuplicate`
 *   matches an entry already in `cachedMessages`.
 * - Builds a ChatMessage with `id = stableMessageId || nextMessageId(msgType)`
 *   for ALL message types (canonical #2902 behaviour — adopt dashboard's
 *   semantics across both clients; this is a fix for the app).
 * - Detects rate-limit / quota / overloaded errors via the shared
 *   `isRateLimitMessage` helper (`@chroxy/protocol`); returns
 *   `isRateLimitError: true` and `errorContent` so the caller can surface a
 *   platform-specific alert.
 *
 * `_activeSessionId` is preserved as a reserved parameter for signature
 * compatibility — both call sites re-derive their own session id locally
 * (#3149 dropped the unused `sessionId` from the payload).
 *
 * The caller still owns the thinking-placeholder filter and the
 * `addMessage` vs `updateSession` choice — this helper returns the built
 * ChatMessage rather than driving the dispatch itself.
 */
export function handleMessage(
  msg: Record<string, unknown>,
  _activeSessionId: string | null,
  receivingHistoryReplay: boolean,
  cachedMessages: readonly ChatMessage[],
): MessagePayload {
  const empty: MessagePayload = { shouldDispatch: false }

  // Runtime validation: this function accepts raw WS payloads
  // (`Record<string, unknown>`) and the resulting `ChatMessage` declares
  // `content: string` and `timestamp: number` as required. Reject
  // structurally invalid messages here rather than letting them propagate
  // and crash render paths.
  const rawType = msg.messageType ?? msg.type
  if (typeof rawType !== 'string' || rawType.length === 0) return empty
  const msgType = rawType
  if (typeof msg.content !== 'string') return empty
  if (typeof msg.timestamp !== 'number') return empty

  // Live user_input echoes from other clients arrive as top-level
  // `type: 'user_input'` and are handled by `handleUserInput`. Anything that
  // reaches here with `messageType === 'user_input'` outside replay should
  // be dropped to avoid double-rendering.
  if (msgType === 'user_input' && !receivingHistoryReplay) return empty

  const stableMessageId = typeof msg.messageId === 'string' ? msg.messageId : undefined

  // Replay dedup: skip if an equivalent entry already exists in cache.
  if (receivingHistoryReplay) {
    if (
      isReplayDuplicate(cachedMessages, {
        messageType: msgType,
        messageId: stableMessageId,
        content: msg.content,
        timestamp: msg.timestamp,
        tool: typeof msg.tool === 'string' ? msg.tool : undefined,
        options: msg.options as ChatMessage['options'],
      })
    ) {
      return empty
    }
  }

  const chatMessage: ChatMessage = {
    // Canonical: preserve server-stamped messageId for ALL types (#2902).
    id: stableMessageId || nextMessageId(msgType),
    type: msgType as ChatMessage['type'],
    content: msg.content,
    tool: typeof msg.tool === 'string' ? msg.tool : undefined,
    options: msg.options as ChatMessage['options'],
    timestamp: msg.timestamp,
    // #4476: preserve the structured error code so renderers can switch
    // on it (e.g. `stream_stall` → chip + retry, default → generic
    // bubble). Only forwarded when typed string; non-string `msg.code`
    // (defensive against malformed payloads) is dropped to keep junk off
    // the store.
    ...(typeof msg.code === 'string' ? { code: msg.code } : {}),
    // #4947: preserve `attemptedResumeId` for `error{code:'resume_unknown'}`
    // bubbles (server PR #4944). The dashboard ResumeUnknownChip surfaces
    // it as subtext for operator correlation against the persisted state
    // file. Pre-#4944 servers omit the field entirely and the ChatMessage
    // simply stays `attemptedResumeId: undefined`.
    //
    // #5006: also accept the terminal-escalation code
    // `resume_unknown_exhausted` (server PR #5004). When the post-fallback
    // retry ALSO matches the unknown-resume pattern, the server stops
    // auto-respawning and emits this distinct code so the chip can switch
    // to an "auto-recovery exhausted, start a fresh session manually"
    // affordance. event-normalizer.js already forwards `attemptedResumeId`
    // for the new code; without widening this gate the field would be
    // silently stripped at the store boundary and the chip would degrade
    // to "headline only" — defeating the operator-correlation feature.
    //
    // Hardening (from PR #4967 Copilot review):
    //   1. Gate strictly on `msgType === 'error'` AND one of the two
    //      resume-failure codes — the field is documented as only valid on
    //      those envelopes, so a buggy producer attaching it to other types
    //      (or other error codes) shouldn't pollute the store with
    //      out-of-contract data.
    //   2. Trim whitespace and treat whitespace-only as missing — matches
    //      the chip's render-time guard so the store and the renderer
    //      agree.
    //   3. Enforce the same 256-char cap the wire schema declares
    //      (`ServerMessageSchema.attemptedResumeId`). Defense in depth
    //      against a malformed wire-bypassing path (e.g. localStorage
    //      replay of a corrupted message) — silently truncate rather than
    //      drop so the truncated id still helps operator triage.
    ...(msgType === 'error' &&
    typeof msg.code === 'string' &&
    (msg.code === 'resume_unknown' || msg.code === 'resume_unknown_exhausted') &&
    typeof msg.attemptedResumeId === 'string'
      ? (() => {
          const trimmed = msg.attemptedResumeId.trim()
          if (trimmed.length === 0) return {}
          return { attemptedResumeId: trimmed.length > 256 ? trimmed.slice(0, 256) : trimmed }
        })()
      : {}),
  }

  // Surface rate-limit / usage-limit / quota / overloaded errors prominently (#616).
  // #3183: isRateLimitMessage now lowercases internally — pass raw content.
  let isRateLimitError = false
  let errorContent: string | null = null
  if (msgType === 'error') {
    if (isRateLimitMessage(msg.content)) {
      isRateLimitError = true
      errorContent = msg.content
    }
  }

  return {
    shouldDispatch: true,
    chatMessage,
    isRateLimitError,
    errorContent,
  }
}

// ---------------------------------------------------------------------------
// tool_start
// ---------------------------------------------------------------------------

/** Result returned from {@link handleToolStart}. */
export interface ToolStartPayload {
  /** Whether the caller should dispatch the chat message. */
  shouldDispatch: boolean
  /** Resolved target session, or null when no session context exists. */
  sessionId: string | null
  /** Pre-built ChatMessage when `shouldDispatch` is true, else null. */
  chatMessage: ChatMessage | null
  /**
   * Resolved tool name (`(msg.tool as string) || 'tool'`), exposed for the
   * dashboard's terminal-data side-effect at the call site. Always a string.
   */
  toolName: string
  /**
   * #4308 — ActiveTool entry the caller should push onto the target session's
   * `activeTools[]` array. `null` when the message would not produce a fresh
   * tool_use bubble (replay dedup, missing toolUseId), so the caller can skip
   * the push in lockstep with the `shouldDispatch` check.
   *
   * `applyTo` dedupes by `toolUseId`: if a matching entry is already present
   * (e.g. duplicate tool_start broadcasts), the same array reference is
   * returned and no new entry is pushed.
   */
  activeTool: ActiveTool | null
  /**
   * #4308 — apply the new ActiveTool to a session's `activeTools[]`. Dedupes
   * by `toolUseId`. Returns the same array reference (no-op) when
   * `activeTool === null` or when the entry already exists, so callers can
   * skip the state write in lockstep with the rest of this payload.
   */
  applyToActiveTools: (current: ActiveTool[]) => ActiveTool[]
}

/**
 * Validate, dedup, and normalize a `tool_start` message.
 *
 * - Resolves `sessionId` from `msg.sessionId` (string-typed) falling back to
 *   `activeSessionId`. Non-string `msg.sessionId` is ignored.
 * - Resolves `toolId` from `msg.messageId` (string-typed) falling back to
 *   `nextMessageId('tool')`. The server's stable messageId enables per-id
 *   dedup across the live path and history replay (#2901).
 * - During `receivingHistoryReplay`, returns `shouldDispatch: false` when an
 *   entry with the same `id` is already present in `cachedMessages`. The
 *   legacy blanket `messages.length > 0` guard was removed (#2901): with
 *   multi-session state the legacy flat array is empty, so the guard never
 *   fired and reconnect replay duplicated tool_use entries that the client
 *   already had. Per-id dedup is the correct check on both replay paths.
 * - Builds a `tool_use` ChatMessage. `content` falls through input → tool
 *   name → empty string.
 * - Exposes `toolName` (string-validated `msg.tool` or `'tool'` fallback) so
 *   the dashboard can write it to terminal data at the call site without
 *   re-parsing.
 *
 * Per-field validation uses `typeof === 'string'` guards rather than
 * `as string` casts so non-string runtime values are coerced to safe defaults
 * (matches the pattern used in `handleHistoryReplayStart` / `handleMcpServers`
 * elsewhere in this file). `ChatMessage.id`, `tool`, `toolUseId`, `serverName`,
 * and `ToolStartPayload.toolName` are guaranteed string-typed at the type
 * level.
 *
 * Side-effects (terminal-data write, message dispatch) stay at the call site;
 * this helper only returns the data needed to perform them.
 */
export function handleToolStart(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
  receivingHistoryReplay: boolean,
  cachedMessages: readonly ChatMessage[],
): ToolStartPayload {
  const msgSessionId = parseRawStringField(msg, 'sessionId')
  const sessionId = msgSessionId || activeSessionId
  const tool = typeof msg.tool === 'string' ? msg.tool : undefined
  const toolName = tool || 'tool'
  const messageId = parseRawStringField(msg, 'messageId')
  const toolId = messageId || nextMessageId('tool')
  const toolUseId = typeof msg.toolUseId === 'string' ? msg.toolUseId : undefined
  const serverName = typeof msg.serverName === 'string' ? msg.serverName : undefined

  // #4308 — noop applyTo for the early-return paths so the call site can
  // unconditionally invoke `applyToActiveTools` without a presence check.
  const noopApply = (current: ActiveTool[]) => current

  if (receivingHistoryReplay) {
    if (cachedMessages.some((m) => m.id === toolId)) {
      return {
        shouldDispatch: false,
        sessionId,
        chatMessage: null,
        toolName,
        activeTool: null,
        applyToActiveTools: noopApply,
      }
    }
  }

  // #4607 — honour the wire `timestamp` field when present (number). The
  // server's history ring buffer stamps `timestamp: Date.now()` at append
  // time (session-message-history.js:208-216) and forwards it on every
  // replay. Pre-#4607 we always overwrote with `Date.now()`, which:
  //   1) made the rebuilt `chatMessage.timestamp` jump to the replay moment,
  //      so any UI that reads `tool_use.timestamp` (e.g.
  //      ActivityIndicator.findInFlightToolUse fallback) sees a fresh time
  //      instead of when the tool actually started.
  //   2) made the rebuilt `ActiveTool.startedAt` jump to the replay moment
  //      whenever `activeTools` was empty at history_replay_start time
  //      (toolUseId-dedup in applyToActiveTools only preserves the original
  //      `startedAt` when an entry with the same id already exists). The
  //      "Running <tool> · Ns" pill restarted at ~1s on tab-switch for any
  //      session whose activeTools had been swept by a prior handleAgentIdle
  //      / live `result` / etc.
  // The fallback to `Date.now()` covers live (non-replay) tool_start
  // broadcasts, which never carry `msg.timestamp` on the wire.
  const wireTimestamp =
    typeof msg.timestamp === 'number' && Number.isFinite(msg.timestamp)
      ? msg.timestamp
      : Date.now()
  const chatMessage: ChatMessage = {
    id: toolId,
    type: 'tool_use',
    content: msg.input ? JSON.stringify(msg.input) : tool || '',
    tool,
    toolUseId,
    serverName,
    timestamp: wireTimestamp,
  }

  // #4308 — build the ActiveTool entry. Skip when `toolUseId` is missing
  // (non-string / absent): the wire schema requires it (#121 server.ts),
  // but be defensive — without a stable id we can't dedup or remove the
  // entry on tool_result.
  const activeTool: ActiveTool | null = toolUseId
    ? {
        toolUseId,
        tool: toolName,
        ...(serverName !== undefined ? { serverName } : {}),
        ...(msg.input !== undefined ? { input: msg.input } : {}),
        startedAt: chatMessage.timestamp,
      }
    : null

  const applyToActiveTools = (current: ActiveTool[]): ActiveTool[] => {
    if (!activeTool) return current
    // Dedup by toolUseId — duplicate tool_start broadcasts (history replay
    // landing alongside a live event, server retry, etc.) must not create
    // ghost entries the activity indicator would surface forever.
    if (current.some((t) => t.toolUseId === activeTool.toolUseId)) return current
    return [...current, activeTool]
  }

  return {
    shouldDispatch: true,
    sessionId,
    chatMessage,
    toolName,
    activeTool,
    applyToActiveTools,
  }
}

// ---------------------------------------------------------------------------
// tool_result
// ---------------------------------------------------------------------------

/** Result returned from {@link handleToolResult} when the message is well-formed. */
export interface ToolResultPayload {
  /** Resolved target session, or null when no session context exists. */
  sessionId: string | null
  /** The `toolUseId` that was matched against the tool_use entry. */
  toolUseId: string
  /** Patch to merge onto the matching tool_use ChatMessage. */
  patch: Partial<ChatMessage>
  /**
   * Raw result text (`(msg.result as string) || ''`), exposed for the
   * dashboard's terminal-data preview write at the call site. The caller
   * slices to ~500 chars before writing.
   */
  resultText: string
  /**
   * Apply the patch to a session's `messages` array. Returns a new array with
   * the patch merged onto the matching `tool_use` entry, or the same array
   * reference when no match was found (caller treats same-reference as a
   * no-op).
   */
  applyTo: (messages: ChatMessage[]) => ChatMessage[]
  /**
   * #4308 — remove the matching entry (by `toolUseId`) from a session's
   * `activeTools[]`. Returns the same array reference (no-op) when no
   * matching entry is present, so callers can skip the state write when
   * nothing changed. Mirrors the no-match no-op contract used by
   * {@link applyTo} for `messages`.
   */
  applyToActiveTools: (current: ActiveTool[]) => ActiveTool[]
}

/**
 * Validate and build a patch for a `tool_result` message.
 *
 * Returns `null` when `toolUseId` is missing or non-string (skip behaviour
 * matches both clients' prior inline `if (!toolUseId) return` guard).
 *
 * Otherwise returns a payload with:
 * - `sessionId`: resolved from string-typed `msg.sessionId` falling back to
 *   `activeSessionId`. Non-string values are ignored.
 * - `patch`: `{ toolResult, toolResultTruncated, toolResultIsError }`, plus
 *   `toolResultImages` only when `msg.images` is a non-empty array.
 * - `resultText`: the raw result string (string-validated) for the caller's
 *   terminal preview.
 * - `applyTo(messages)`: locates the matching `tool_use` entry by
 *   `toolUseId`, returns a new array with the patch merged at that index.
 *   When no match is found the same array reference is returned so callers
 *   can detect the no-op (used to skip pointless state writes).
 *
 * Per-field validation uses `typeof === 'string'` / `=== 'boolean'` guards
 * rather than `as string` casts so non-string runtime values are coerced to
 * safe defaults; `ChatMessage.toolResult` and `ToolResultPayload.resultText`
 * are guaranteed string-typed at the type level.
 */
export function handleToolResult(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): ToolResultPayload | null {
  if (typeof msg.toolUseId !== 'string' || !msg.toolUseId) return null
  const toolUseId = msg.toolUseId
  const msgSessionId = parseRawStringField(msg, 'sessionId')
  const sessionId = msgSessionId || activeSessionId
  const resultText = typeof msg.result === 'string' ? msg.result : ''
  const truncated = typeof msg.truncated === 'boolean' ? msg.truncated : false
  const isError = typeof msg.isError === 'boolean' ? msg.isError : false
  const images = Array.isArray(msg.images)
    ? (msg.images as ToolResultImage[])
    : undefined

  const patch: Partial<ChatMessage> = {
    toolResult: resultText,
    toolResultTruncated: truncated,
    toolResultIsError: isError,
  }
  if (images?.length) patch.toolResultImages = images

  return {
    sessionId,
    toolUseId,
    patch,
    resultText,
    applyTo: (messages) => {
      const idx = messages.findIndex(
        (m) => m.type === 'tool_use' && m.toolUseId === toolUseId,
      )
      if (idx === -1) return messages
      const updated = [...messages]
      updated[idx] = { ...updated[idx]!, ...patch }
      return updated
    },
    // #4308 — remove the in-flight ActiveTool entry by toolUseId.
    applyToActiveTools: (current) => {
      const filtered = current.filter((t) => t.toolUseId !== toolUseId)
      return filtered.length === current.length ? current : filtered
    },
  }
}

// ---------------------------------------------------------------------------
// tool_input_delta
// ---------------------------------------------------------------------------

/**
 * Upper bound on the size of `toolInputPartial` after concatenation,
 * measured in JavaScript `String.length` units (UTF-16 code units, NOT
 * bytes — a non-BMP character costs two code units). Defence-in-depth
 * backstop against an adversarial or runaway server `tool_input_delta`
 * stream ballooning client `messages` state — the wire schema
 * (`ServerToolInputDeltaSchema.partialJson`) declares no max length.
 * 1 MiB code units is well above any realistic Anthropic SDK tool
 * input (typically tens of KB at most) while small enough to bound
 * per-bubble memory.
 *
 * On truncation the stored buffer is capped at exactly this many code
 * units; the terminal state is signalled by the
 * `toolInputPartialTruncated` boolean on the `ChatMessage` (#4263, see
 * issue #4241 for the original cap). No suffix marker is appended to
 * the buffer itself.
 */
export const MAX_TOOL_INPUT_PARTIAL_LEN = 1024 * 1024

/**
 * Legacy in-band marker historically appended to `toolInputPartial`
 * exactly once when the cap was hit. Retained ONLY for backwards-
 * compatible terminal-state detection on rehydrated state (#4263) — if
 * an older client wrote a persisted `toolInputPartial` ending with this
 * literal, treat the bubble as already-truncated and drop further
 * deltas idempotently. New truncations no longer append this marker;
 * the canonical signal is `toolInputPartialTruncated: true`.
 */
const TOOL_INPUT_PARTIAL_TRUNCATED_MARKER = '...[truncated]'

/** Result returned from {@link handleToolInputDelta} when the message is well-formed. */
export interface ToolInputDeltaPayload {
  /** Resolved target session, or null when no session context exists. */
  sessionId: string | null
  /** The `toolUseId` whose tool_use bubble should accumulate the partial. */
  toolUseId: string
  /** The new partial JSON chunk to append to `toolInputPartial`. */
  partialJson: string
  /**
   * Apply the delta to a session's `messages` array. Locates the matching
   * `tool_use` entry by `toolUseId`, concatenates `partialJson` onto the
   * existing `toolInputPartial` (treating undefined as ''), and returns a
   * new array with the updated entry. Returns the same reference (no-op)
   * when no matching tool_use is found — callers treat same-reference as
   * "drop this delta, the bubble isn't here." This mirrors the
   * applyTo-on-no-match pattern used by `handleToolResult`.
   */
  applyTo: (messages: ChatMessage[]) => ChatMessage[]
}

/**
 * Validate and build an accumulator for a `tool_input_delta` message
 * (server-side wire-up in #4080; UI in #4081). The server emits
 * `{ messageId, toolUseId, partialJson }` as the Anthropic SDK streams
 * `input_json_delta` chunks for a tool_use block — long inputs (e.g.
 * Bash `command`) take many SDK chunks to assemble. Pre-#4080 those
 * chunks were silently dropped so the tool-call bubble saw nothing
 * until `finalMessage()` resolved.
 *
 * Returns `null` when `toolUseId` is missing/non-string or when
 * `partialJson` is missing/non-string — both are required by the wire
 * shape; malformed payloads are dropped silently rather than thrown so
 * a buggy server can't crash the client.
 *
 * The accumulator concatenates onto the bubble's `toolInputPartial`
 * (initialised to `''` for the first delta). Renderers parse it
 * best-effort: partial JSON is inherently unparseable mid-stream, so
 * unparseable chunks render verbatim as a code block — NOT as an
 * error. Once `tool_result` arrives, the bubble's render switches to
 * the standard result view; `toolInputPartial` is kept for
 * history/replay but no longer drives the active display.
 *
 * The concatenated buffer is capped at {@link MAX_TOOL_INPUT_PARTIAL_LEN}
 * code units (defence-in-depth — see #4241). When a chunk would push
 * past the cap, the buffer is sliced to the cap and the bubble's
 * `toolInputPartialTruncated` boolean is set to `true` (#4263);
 * subsequent deltas land on a bubble already flagged as truncated and
 * are dropped silently. The legacy in-band `...[truncated]` suffix is
 * still recognised on the existing buffer for backwards compatibility
 * with state rehydrated from older clients.
 */
export function handleToolInputDelta(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): ToolInputDeltaPayload | null {
  if (typeof msg.toolUseId !== 'string' || !msg.toolUseId) return null
  if (typeof msg.partialJson !== 'string') return null
  const toolUseId = msg.toolUseId
  const partialJson = msg.partialJson
  const msgSessionId = parseRawStringField(msg, 'sessionId')
  const sessionId = msgSessionId || activeSessionId

  return {
    sessionId,
    toolUseId,
    partialJson,
    applyTo: (messages) => {
      const idx = messages.findIndex(
        (m) => m.type === 'tool_use' && m.toolUseId === toolUseId,
      )
      if (idx === -1) return messages
      const existing = messages[idx]!
      const prev = existing.toolInputPartial || ''
      // Idempotent terminal state: once truncated, further deltas are
      // dropped silently (matches the "silent drop on bad input" pattern
      // already used by the malformed-payload guards above). Checked
      // before cloning so post-truncation deltas stay O(1) and allocation
      // free — no spread of `messages`, no message-object copy.
      //
      // Prefer the canonical boolean (#4263). The
      // `prev.endsWith(...[truncated])` check is a backwards-compat
      // fallback for state rehydrated from a pre-#4263 client that wrote
      // the legacy in-band marker into the buffer without the flag.
      if (
        existing.toolInputPartialTruncated ||
        prev.endsWith(TOOL_INPUT_PARTIAL_TRUNCATED_MARKER)
      ) {
        return messages
      }
      // Length-first check avoids briefly allocating a giant string for
      // the worst-case adversarial input (e.g. a single 100 MB chunk).
      let next: string
      let truncated = false
      if (prev.length + partialJson.length > MAX_TOOL_INPUT_PARTIAL_LEN) {
        // `Math.max(0, headroom)` defends against a `prev` that is
        // already at or above the cap (e.g. rehydrated from persisted
        // state under an older schema where the cap differed) — a
        // negative slice index would otherwise take from the end of
        // `partialJson` and silently corrupt the buffer.
        const headroom = MAX_TOOL_INPUT_PARTIAL_LEN - prev.length
        next = prev + partialJson.slice(0, Math.max(0, headroom))
        truncated = true
      } else {
        next = prev + partialJson
      }
      const updated = [...messages]
      updated[idx] = {
        ...existing,
        toolInputPartial: next,
        ...(truncated ? { toolInputPartialTruncated: true } : null),
      }
      return updated
    },
  }
}

// ---------------------------------------------------------------------------
// stream_start
// ---------------------------------------------------------------------------

/** Result returned from {@link handleStreamStart}. */
export interface StreamStartPayload {
  /**
   * Resolved target session, falling back to activeSessionId. May be null when
   * neither the message nor the active session provides one.
   */
  sessionId: string | null
  /** ID to set as `streamingMessageId` (resolved against any collision). */
  streamingMessageId: string
  /**
   * Whether the caller should append a new response message to the session
   * messages array. When false, the call site's existing response message is
   * being reused (reconnect replay dedup) and only the streamingMessageId
   * needs to be updated.
   */
  isNewMessage: boolean
  /** Pre-built ChatMessage when `isNewMessage` is true, else null. */
  newMessage: ChatMessage | null
  /**
   * Stream-id remap directive when an existing non-response message (e.g.
   * tool_use) collides with the incoming stream id. Caller registers this in
   * its module-local `_deltaIdRemaps` Map so future stream_delta messages
   * route to the suffixed response id.
   */
  remap: { from: string; to: string } | null
}

/**
 * Validate and resolve a `stream_start` message into a session patch.
 *
 * - Resolves `sessionId` from `msg.sessionId` (validated as `string`), falling
 *   back to `activeSessionId` when the field is missing or not a string.
 * - Resolves `streamingMessageId` via {@link resolveStreamId} against the
 *   existing session messages. When `msg.messageId` is missing or not a
 *   string, falls back to a freshly generated id (`nextMessageId('msg')`) so
 *   the resolved id is always a real string. When the stream id collides
 *   with an existing non-response message, returns a suffixed id and a
 *   `remap` directive so the caller can register it in its module-local
 *   `_deltaIdRemaps`.
 * - When the existing message is already a `response` (reconnect replay
 *   dedup), returns `isNewMessage: false` and `newMessage: null` so the
 *   caller only updates `streamingMessageId`.
 * - Otherwise builds a fresh `{ type: 'response', content: '', timestamp: now
 *   }` ChatMessage at the resolved id.
 *
 * Module-local state mutations (`_deltaIdRemaps.set`) and side-effects (the
 * `filterThinking(messages)` array transform that drops the thinking
 * placeholder before appending) stay at the call site — this helper just
 * computes the patch shape.
 *
 * Mirrors the `typeof === 'string'` guard pattern used in {@link
 * handleToolStart} so the returned `ChatMessage.id` and `sessionId` are
 * always honest strings, matching the protocol schema (`messageId:
 * z.string()` in `ServerStreamStartSchema`).
 */
export function handleStreamStart(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
  existingMessages: readonly ChatMessage[],
): StreamStartPayload {
  const streamId = typeof msg.messageId === 'string' ? msg.messageId : nextMessageId('msg')
  const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : activeSessionId
  const existing = existingMessages.find((m) => m.id === streamId)
  const { resolvedId, remap } = resolveStreamId(existing, streamId)

  if (existing && existing.type === 'response') {
    // Reuse existing response message (reconnect replay dedup) — caller only
    // updates streamingMessageId.
    return {
      sessionId,
      streamingMessageId: resolvedId,
      isNewMessage: false,
      newMessage: null,
      remap: null,
    }
  }

  const newMessage: ChatMessage = {
    id: resolvedId,
    type: 'response',
    content: '',
    timestamp: Date.now(),
  }

  return {
    sessionId,
    streamingMessageId: resolvedId,
    isNewMessage: true,
    newMessage,
    remap: remap ?? null,
  }
}

// ---------------------------------------------------------------------------
// stream_delta — #4981
//
// The post-tool continuation-split (#4889), #4297 defensive reorder, single-
// hop `_deltaIdRemaps` remap, mid-sentence gate (#4999/#5014), and mid-word
// peel (#4975) logic was previously duplicated verbatim between the dashboard
// (`handleStreamDelta`) and the app (`case 'stream_delta'`). Both maintain the
// same module-local state (`pendingDeltas`, `deltaIdRemaps`,
// `postPermissionSplits`, `replayingSessions`, the 100ms flush timer).
//
// `sharedStreamDelta` owns the platform-NEUTRAL algorithm. Platform-specific
// side-effects stay at the call site, surfaced through `StreamDeltaContext`
// callbacks:
//   - dashboard's terminal-data write (`appendTerminalDelta`)
//   - dashboard's #4297 empty-response-slot reorder + flat-messages fallbacks
//     (the app has neither — it only ever operates on `sessionStates`)
//
// The two originals were NOT byte-identical: the dashboard additionally ran
// the #4297 reorder pre-step and carried flat-`messages` fallbacks in the
// defensive-remap and continuation-split branches. To preserve BOTH behaviours
// exactly (pure refactor, no behaviour change), those divergent pieces are
// supplied by the call site:
//   - `appendTerminalDelta` — dashboard writes, app no-op
//   - `reorderEmptyResponseSlot` — dashboard performs the #4297 shift, app no-op
//   - `getSessionMessages` / `getFlatMessages` / `appendResponseSlot` /
//     `peelSlotContent` — each resolves the effective target (session-state vs
//     flat) the way that platform does, so the dashboard keeps its flat
//     fallback and the app stays session-only.
// ---------------------------------------------------------------------------

/**
 * A buffered (not-yet-flushed) delta entry. Mirrors the `pendingDeltas` value
 * shape used by both call sites.
 */
export interface PendingDelta {
  sessionId: string | null
  delta: string
}

/**
 * Platform surface for {@link sharedStreamDelta}. The shared function reads and
 * mutates the four module-local collections directly (they are identical on
 * both platforms) and delegates every store-touching or platform-divergent
 * operation to a callback.
 */
export interface StreamDeltaContext {
  /** The store's current active session id (`get().activeSessionId`). */
  activeSessionId: string | null
  /**
   * Resolve the messages array for a target session. Returns the session's
   * `sessionStates[id].messages` when present, else `null` so the shared
   * function knows to fall through to the flat-messages path. Pass `null`/an
   * unknown id to force the flat fallback.
   */
  getSessionMessages: (sessionId: string | null) => readonly ChatMessage[] | null
  /**
   * The flat (legacy / pre-session-bootstrap) `messages` array. The dashboard
   * supplies the real array; the app — which has no flat fallback in this
   * handler — returns an empty array so the flat branches are inert.
   */
  getFlatMessages: () => readonly ChatMessage[]
  /** `pendingDeltas` buffer (shared, identical on both platforms). */
  pendingDeltas: Map<string, PendingDelta>
  /** Single-hop `_deltaIdRemaps` map (shared). */
  deltaIdRemaps: Map<string, string>
  /** `_postPermissionSplits` set (shared). */
  postPermissionSplits: Set<string>
  /** Per-session replay guard set (shared). */
  replayingSessions: Set<string>
  /**
   * Forward the raw delta text to the terminal view. Dashboard-only side
   * effect; the app passes a no-op. Called once at the top of the handler,
   * before any remap resolution, exactly as the dashboard did inline.
   */
  appendTerminalDelta: (delta: string) => void
  /**
   * #4297 — move an empty (`content === ''`) response slot at `deltaId` to the
   * end of the messages array on its first delta, so a turn-final summary
   * renders below the tool groups it summarised. Dashboard implements the
   * session-state + flat shift; the app passes a no-op (it never reordered).
   */
  reorderEmptyResponseSlot: (deltaId: string, capturedSessionId: string | null) => void
  /**
   * Append a fresh response slot (used by the `-post-` permission split, the
   * defensive `-response` suffix, and the `-cont-` continuation split) and set
   * `streamingMessageId` to its id. `onlyIfAbsent` mirrors the defensive
   * branch's "lazy-create only when not already present" guard. A `null`
   * `targetSessionId` selects the flat-messages path (dashboard only).
   */
  appendResponseSlot: (
    targetSessionId: string | null,
    slot: ChatMessage,
    opts?: { onlyIfAbsent?: boolean },
  ) => void
  /**
   * Peel `count` trailing characters off the flushed `content` of the response
   * slot at `deltaId` in the resolved target. Used by the #4975 mid-word peel
   * when the partial word lives in already-flushed content. A `null`
   * `targetSessionId` selects the flat-messages path (dashboard only).
   */
  peelSlotContent: (
    targetSessionId: string | null,
    deltaId: string,
    count: number,
  ) => void
  /**
   * Schedule the 100ms `flushPendingDeltas` timer if one isn't already armed.
   * The timer handle lives at the call site (module-local), so scheduling is
   * delegated.
   */
  scheduleFlush: () => void
}

/**
 * The decision (`sharedStreamDelta`'s first responsibility, #6036) for which
 * response slot an incoming delta belongs to, surfaced as data so the
 * mutating caller stays separate from the routing logic. One of:
 *
 *   - `permission-split` — the id was flagged for a post-permission split, so a
 *     fresh `<deltaId>-post-<now>` bubble is created and the old id remaps to it.
 *   - `remap` — a single-hop remap already exists for the id; follow it.
 *   - `suffix` — the id resolves to a NON-response bubble (a tool_use slot the
 *     server reused), so route to a lazily-created `<deltaId>-response` bubble.
 *   - `passthrough` — the id already targets the right response slot; no change.
 */
export type StreamDeltaTarget =
  | { kind: 'permission-split'; deltaId: string; newId: string }
  | { kind: 'remap'; deltaId: string }
  | {
      kind: 'suffix'
      deltaId: string
      /** The ORIGINAL (pre-suffix) id the caller must key the remap on. */
      remapKey: string
      suffixedId: string
      targetForSuffix: string | null
      needsAppend: boolean
    }
  | { kind: 'passthrough'; deltaId: string }

/**
 * Resolve which response slot an incoming `stream_delta` targets (#6036 — the
 * first responsibility carved out of {@link sharedStreamDelta}). This is the
 * pure decision half of the bubble-merge / stream_start-id reuse (#5697/#2546)
 * logic: given the current id and the live state (the post-permission-split
 * set, the remap map, and the resolved messages array), it returns the final
 * `deltaId` plus a {@link StreamDeltaTarget} verdict describing the side
 * effects the caller must apply. It performs NO mutation — the caller deletes
 * from `postPermissionSplits`, writes `deltaIdRemaps`, and appends slots — so
 * behaviour is byte-identical to the previous inline branch while being unit
 * testable in isolation.
 *
 * @param incomingId The currently-resolved delta id (post original capture).
 * @param state Membership + resolver snapshots from {@link StreamDeltaContext}.
 * @param nowFn Clock thunk for the post-permission split's `-post-<now>` id,
 *   read LAZILY (only on the split path) so a plain delta never pays a
 *   `Date.now()` call. Injected for deterministic tests; production passes
 *   `Date.now`.
 */
export function resolveStreamDeltaTarget(
  incomingId: string,
  state: {
    postPermissionSplits: Set<string>
    deltaIdRemaps: Map<string, string>
    /**
     * Resolve the effective messages array + session id the SAME way the
     * defensive branch did: prefer the captured session's state, else the
     * active session's, else the flat fallback (dashboard) — supplied as a
     * thunk so the caller owns the platform-divergent resolution.
     */
    resolveMessages: () => {
      resolvedMessages: readonly ChatMessage[]
      targetForSuffix: string | null
    }
  },
  nowFn: () => number,
): StreamDeltaTarget {
  // Permission boundary split: first delta after a split creates a new message.
  if (state.postPermissionSplits.has(incomingId)) {
    // Read the clock lazily — only this (rare) split path needs it, so a plain
    // delta on the hot path pays no Date.now() call (matches the pre-refactor
    // inline behavior where the timestamp was only read inside this branch).
    const newId = `${incomingId}-post-${nowFn()}`
    return { kind: 'permission-split', deltaId: incomingId, newId }
  }
  if (state.deltaIdRemaps.has(incomingId)) {
    return { kind: 'remap', deltaId: state.deltaIdRemaps.get(incomingId)! }
  }
  // Defensive: server reuses messageId for tool_start and the post-tool
  // stream_start. If stream_start was dropped or hasn't registered the remap
  // yet, the delta would otherwise concatenate onto the tool_use bubble.
  // Detect that here and route to a suffixed response id, lazy-creating the
  // bubble.
  const { resolvedMessages, targetForSuffix } = state.resolveMessages()
  const existing = resolvedMessages.find((m) => m.id === incomingId)
  if (existing && existing.type !== 'response') {
    const suffixedId = `${incomingId}-response`
    const needsAppend = !resolvedMessages.some((m) => m.id === suffixedId)
    return {
      kind: 'suffix',
      deltaId: suffixedId,
      remapKey: incomingId,
      suffixedId,
      targetForSuffix,
      needsAppend,
    }
  }
  return { kind: 'passthrough', deltaId: incomingId }
}

/**
 * Shared `stream_delta` handler (#4981). Owns the platform-neutral hot path:
 * the #4297 reorder dispatch, post-permission split, single-hop defensive
 * remap, post-tool continuation split (#4889) with the mid-sentence gate
 * (#4999/#5014) and mid-word peel (#4975), and the buffered append + 100ms
 * flush scheduling. All store writes and platform-divergent fallbacks go
 * through {@link StreamDeltaContext}.
 */
export function sharedStreamDelta(
  msg: Record<string, unknown>,
  ctx: StreamDeltaContext,
): void {
  // #5130 — runtime guards against malformed/spoofed payloads. The wire schema
  // (`ServerStreamDeltaSchema`) declares both `messageId` and `delta` as
  // required `z.string()`, so a well-formed message always satisfies these
  // guards and behaves EXACTLY as before. The guards only catch genuinely
  // malformed payloads that bypassed Zod parse (e.g. a buggy producer or a
  // dispatcher that skipped validation):
  //
  //   - non-string `messageId` would otherwise become a non-string key in
  //     `deltaIdRemaps` / `pendingDeltas` / `postPermissionSplits`, poisoning
  //     those collections. Early-return so no state is touched.
  //   - non-string `delta` would otherwise stringify to the literal
  //     `"undefined"` (or `"null"`, `"[object Object]"`, etc.) and append that
  //     to a response slot's content. Early-return so nothing is buffered.
  if (typeof msg.messageId !== 'string') return
  if (typeof msg.delta !== 'string') return

  // Capture the ORIGINAL incoming messageId before any remap resolution.
  // The post-tool continuation split (#4889) writes its remap entry against
  // this id (not against the resolved `deltaId`) so successive splits
  // overwrite a single map entry instead of forming a chain — keeps
  // `deltaIdRemaps` bounded and eliminates the need for chained lookup.
  const originalMessageId = msg.messageId
  let deltaId = originalMessageId
  // `sessionId` is an optional routing tag (not part of ServerStreamDeltaSchema)
  // added at the broadcast layer. Guard it consistently with `handleStreamEnd`
  // / `handleToolStart`: a non-string value falls back to the active session
  // rather than coercing onto a Map key. `|| ctx.activeSessionId` also folds an
  // empty string into the fallback, preserving the prior `(as string) ||` shape.
  const capturedSessionId = parseRawStringField(msg, 'sessionId') || ctx.activeSessionId

  // Forward delta text to terminal view (dashboard-only; app no-op).
  if (msg.delta.length > 0) {
    ctx.appendTerminalDelta(msg.delta)
  }

  // #4297 — empty-response-slot reorder pre-step. Dashboard performs the shift;
  // the app passes a no-op. Gated identically to the dashboard's inline guard.
  if (typeof deltaId === 'string'
      && !ctx.postPermissionSplits.has(deltaId)
      && !ctx.deltaIdRemaps.has(deltaId)
      && !ctx.pendingDeltas.has(deltaId)) {
    ctx.reorderEmptyResponseSlot(deltaId, capturedSessionId)
  }

  // audit P2-7 / #5556 — the captured→active session-resolution chain is needed
  // by BOTH the defensive `-response` suffix branch and the post-tool split
  // block below. It was previously copy-pasted with renamed locals (captured*
  // vs split*); a missed copy silently misroutes deltas to the wrong session/
  // slot, so it lives in one closure. Re-invoked (NOT cached) at each site: the
  // suffix branch's appendResponseSlot mutates the message array before the
  // split block reads it, so each call must re-read getSessionMessages fresh.
  // Each site keeps its own `?? getFlatMessages()` + target derivation because
  // they run at different times (the split's getFlatMessages stays gated behind
  // the !isReplaying check).
  const resolveSession = (): {
    sessionMessages: readonly ChatMessage[] | null
    effectiveSessionId: string | null
  } => {
    const capturedMessages = capturedSessionId ? ctx.getSessionMessages(capturedSessionId) : null
    const sessionMessages =
      capturedMessages ||
      (ctx.activeSessionId ? ctx.getSessionMessages(ctx.activeSessionId) : null) ||
      null
    const effectiveSessionId = capturedMessages ? capturedSessionId : ctx.activeSessionId
    return { sessionMessages, effectiveSessionId }
  }

  // #6036 — the target/reuse DECISION (permission split vs single-hop remap vs
  // defensive `-response` suffix vs passthrough) lives in the pure
  // `resolveStreamDeltaTarget`; this block only APPLIES the verdict's side
  // effects, keeping the routing logic separately testable. The resolver re-
  // reads `resolveSession()` itself (the defensive branch needs the captured→
  // active→flat chain), so the `now` for the `-post-` id is captured up front
  // exactly as the inline `${deltaId}-post-${Date.now()}` did. `newMsg`'s
  // `timestamp` keeps its own `Date.now()` call, identical to before.
  const target = resolveStreamDeltaTarget(
    deltaId,
    {
      postPermissionSplits: ctx.postPermissionSplits,
      deltaIdRemaps: ctx.deltaIdRemaps,
      resolveMessages: () => {
        const { sessionMessages, effectiveSessionId } = resolveSession()
        return {
          resolvedMessages: sessionMessages ?? ctx.getFlatMessages(),
          targetForSuffix: sessionMessages ? effectiveSessionId : null,
        }
      },
    },
    Date.now,
  )
  if (target.kind === 'permission-split') {
    // Permission boundary split: first delta after a split creates a new message.
    ctx.postPermissionSplits.delete(target.deltaId)
    ctx.deltaIdRemaps.set(target.deltaId, target.newId)
    const newMsg: ChatMessage = {
      id: target.newId,
      type: 'response',
      content: '',
      timestamp: Date.now(),
    }
    // The two originals resolved the permission-split target DIFFERENTLY, so
    // `appendResponseSlot` receives the raw captured id and each platform's
    // callback applies its own resolution:
    //   - dashboard: captured session when it has state, ELSE the flat
    //     `messages` array (NO active-session fallback).
    //   - app: captured session when it has state, ELSE the active session;
    //     session-only (no flat fallback).
    ctx.appendResponseSlot(capturedSessionId, newMsg)
    deltaId = target.newId
  } else if (target.kind === 'remap') {
    deltaId = target.deltaId
  } else if (target.kind === 'suffix') {
    // Defensive: server reuses messageId for tool_start and the post-tool
    // stream_start. If stream_start was dropped or hasn't registered the
    // remap yet (e.g., session not in store at the time), the delta would
    // otherwise concatenate onto the tool_use bubble. Detect that here and
    // route to a suffixed response id, lazy-creating the bubble. The remap
    // is keyed on the ORIGINAL (pre-suffix) id the resolver carried back.
    ctx.deltaIdRemaps.set(target.remapKey, target.suffixedId)
    if (target.needsAppend) {
      ctx.appendResponseSlot(
        target.targetForSuffix,
        { id: target.suffixedId, type: 'response', content: '', timestamp: Date.now() },
        { onlyIfAbsent: true },
      )
    }
    deltaId = target.deltaId
  }

  // #4889 — post-tool continuation split. The server reuses ONE messageId for
  // an entire assistant turn even when text → tool → text → tool → text. The
  // earlier branches only fire on the first delta / non-response slot;
  // subsequent text chunks would otherwise concatenate into the same
  // response.content with no separator — producing `…filing.Filing now.` and
  // losing paragraph breaks.
  //
  // Detect the boundary by checking whether a tool_use was appended AFTER the
  // currently-resolved response slot. If so, materialize a fresh continuation
  // slot at the end (`<deltaId>-cont-<ts>`) and remap the ORIGINAL incoming
  // messageId directly to the new slot (single-hop, never chained). Skipped
  // while the session is replaying — replayed history is reassembled
  // server-side and must not be re-split on the client.
  {
    const { sessionMessages: splitSessionMessages, effectiveSessionId: splitEffectiveId } = resolveSession()
    const isReplaying = splitEffectiveId ? ctx.replayingSessions.has(splitEffectiveId) : false
    if (!isReplaying) {
      const splitMessages = splitSessionMessages ?? ctx.getFlatMessages()
      // The continuation split writes through `appendResponseSlot`/
      // `peelSlotContent`; pass the session id only when session state backs
      // the resolved messages (else the flat path, mirroring both originals).
      const splitTarget = splitSessionMessages ? splitEffectiveId : null
      const slotIdx = splitMessages.findIndex((m) => m.id === deltaId)
      if (slotIdx >= 0) {
        const slot = splitMessages[slotIdx]!
        // Buffered (not-yet-flushed) text counts as content for the split
        // decision — otherwise a chunk that hasn't hit the 100ms flush yet
        // would look empty and we'd append onto it.
        const bufferedContent = ctx.pendingDeltas.get(deltaId)?.delta || ''
        const hasContent = slot.type === 'response'
          && (slot.content.length > 0 || bufferedContent.length > 0)
        // Index-based scan instead of slice().some() — avoids allocating a
        // tail array on every delta. This handler runs many times per turn and
        // sessions can carry long histories, so this stays on the hot path
        // lean.
        let toolAfter = false
        if (hasContent) {
          for (let i = slotIdx + 1; i < splitMessages.length; i++) {
            if (splitMessages[i]!.type === 'tool_use') {
              toolAfter = true
              break
            }
          }
        }
        // #4999 — mid-sentence fragmentation gate. The post-#4889 split only
        // makes sense when the prior bubble's text reached a sentence boundary
        // (the LLM finished a thought before invoking the tool); otherwise the
        // tool interrupted mid-sentence and the post-tool delta is the same
        // sentence continuing. Treat the prior slot as "sentence-complete"
        // only when its trailing non-whitespace character is a sentence
        // terminator (`.`, `!`, `?`) or a hard line break (`\n`). A bubble
        // that ends with a word char, open paren, comma, colon, dash, etc.
        // is mid-sentence — route the delta back to the existing slot so the
        // sentence renders as one contiguous bubble (followed by the tool).
        if (toolAfter) {
          const priorFullForGate = slot.type === 'response' ? slot.content + bufferedContent : ''
          // Trim trailing whitespace before inspecting the last char so e.g.
          // `"...sentence.   "` still reads as sentence-complete.
          const lastNonWs = priorFullForGate.replace(/\s+$/, '')
          // Strip trailing closing punctuation/quotes that commonly follow a
          // sentence terminator (`.")`, `."`, `!'`, `?)`, etc.) so the gate
          // looks at the terminator itself, not the wrapper. #5014 — also
          // strip CJK closing brackets (`」』）`) so a fullwidth-terminated
          // sentence wrapped in CJK quotes still reads as sentence-complete.
          const stripped = lastNonWs.replace(/[)\]}"'’”»›」』）]+$/, '')
          const lastChar = stripped.charAt(stripped.length - 1)
          // #5014 — recognize CJK fullwidth sentence terminators
          // (`．` U+FF0E, `！` U+FF01, `？` U+FF1F) and the ideographic
          // full stop (`。` U+3002) alongside ASCII.
          const endsSentence =
            lastChar === '.' ||
            lastChar === '!' ||
            lastChar === '?' ||
            lastChar === '．' ||
            lastChar === '！' ||
            lastChar === '？' ||
            lastChar === '。'
          const endsHardBreak = /\n\s*$/.test(priorFullForGate)
          if (!endsSentence && !endsHardBreak) {
            toolAfter = false
          }
        }
        if (toolAfter) {
          // #4975 — mid-word peel. The LLM sometimes interrupts a text content
          // block to call a tool, splitting a word across the boundary (e.g.
          // `"...PR #3.Del"` → tool → `"egating..."`). The post-#4889 split
          // would otherwise show "Del" in one bubble and "egating..." in
          // another with the tool between. Detect the mid-word case (last char
          // of the prior slot's full content is a word char AND the FIRST char
          // of the incoming post-tool delta is also a word char — both sides
          // of the boundary must be in a word, else the LLM emitted a normal
          // word boundary and the peel would wrongly move a complete trailing
          // word across the tool bubble) and peel the trailing partial word off
          // the prior slot, seeding the continuation buffer with it. Result:
          // the word reassembles in the continuation bubble.
          const priorFull = slot.type === 'response' ? slot.content + bufferedContent : ''
          const incomingDelta = msg.delta
          const incomingStartsMidWord = /^[A-Za-z0-9_]/.test(incomingDelta)
          const midWordMatch = incomingStartsMidWord ? priorFull.match(/[A-Za-z0-9_]+$/) : null
          let priorTail = ''
          if (midWordMatch && midWordMatch[0].length > 0) {
            priorTail = midWordMatch[0]
            // Peel the partial word off the prior slot. It may live in
            // already-flushed `slot.content` and/or in the still-buffered
            // `pendingDeltas[deltaId].delta` — strip from buffered first (it
            // lives at the tail), then from flushed content if needed.
            let remaining = priorTail.length
            if (bufferedContent.length > 0) {
              const peelFromBuf = Math.min(remaining, bufferedContent.length)
              const newBuf = bufferedContent.slice(0, bufferedContent.length - peelFromBuf)
              if (newBuf.length > 0) {
                ctx.pendingDeltas.set(deltaId, {
                  sessionId: capturedSessionId,
                  delta: newBuf,
                })
              } else {
                ctx.pendingDeltas.delete(deltaId)
              }
              remaining -= peelFromBuf
            }
            if (remaining > 0 && slot.type === 'response' && slot.content.length > 0) {
              ctx.peelSlotContent(splitTarget, deltaId, remaining)
            }
          }
          const contId = `${deltaId}-cont-${Date.now()}`
          // Single-hop remap: write against the ORIGINAL incoming messageId so
          // successive continuation splits overwrite this entry rather than
          // building a chain. Keeps `deltaIdRemaps` size bounded by the count
          // of distinct in-flight turn ids, and lets `stream_end`'s
          // `deltaIdRemaps.delete(out.messageId)` clean up completely.
          ctx.deltaIdRemaps.set(originalMessageId, contId)
          const contMsg: ChatMessage = {
            id: contId,
            type: 'response',
            content: '',
            timestamp: Date.now(),
          }
          ctx.appendResponseSlot(splitTarget, contMsg)
          deltaId = contId
          // Seed the new continuation buffer with the peeled word so the first
          // delta on `contId` carries the partial word as its prefix. The
          // normal append below sees the existing buffer and concatenates
          // correctly.
          if (priorTail.length > 0) {
            ctx.pendingDeltas.set(contId, {
              sessionId: capturedSessionId,
              delta: priorTail,
            })
          }
        }
      }
    }
  }

  const existingDelta = ctx.pendingDeltas.get(deltaId)
  ctx.pendingDeltas.set(deltaId, {
    sessionId: capturedSessionId,
    delta: (existingDelta?.delta || '') + msg.delta,
  })
  ctx.scheduleFlush()
}

// ---------------------------------------------------------------------------
// stream_end
// ---------------------------------------------------------------------------

/** Result returned from {@link handleStreamEnd}. */
export interface StreamEndPayload {
  /** Resolved target session, or null when no session context exists. */
  sessionId: string | null
  /**
   * The messageId from the stream_end message. Used by the caller to clean
   * up `_deltaIdRemaps` and `_postPermissionSplits` entries. Returns `null`
   * when the incoming `msg.messageId` is missing or not a string — the
   * caller-side `Map.delete(null)` / `Set.delete(null)` is a safe no-op.
   *
   * The protocol schema (`ServerStreamEndSchema.messageId: z.string()`)
   * guarantees this is a string for well-formed payloads; the `null` arm
   * exists only so malformed payloads cannot poison the call-site Maps with
   * non-string keys.
   */
  messageId: string | null
}

/**
 * Resolve session + message ids for a `stream_end` message.
 *
 * Side-effects (flushing pending deltas, terminal data writes, clearing
 * streamingMessageId, forcing a new messages array reference, deleting
 * `_deltaIdRemaps` / `_postPermissionSplits` entries) all stay at the call
 * site — they touch module-local state and platform-specific store APIs.
 * This helper only resolves the two ids the caller needs.
 *
 * Mirrors the `typeof === 'string'` guard pattern used in {@link
 * handleToolStart} so the returned `messageId` and `sessionId` are honest
 * strings (or `null`), matching the protocol schema.
 */
export function handleStreamEnd(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): StreamEndPayload {
  const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : activeSessionId
  const messageId = parseRawStringField(msg, 'messageId')
  return { sessionId, messageId }
}

// ---------------------------------------------------------------------------
// thinking stream (#6756)
//
// Extended-thinking / reasoning content forwarded by the providers that
// produce it (claude SDK, BYOK) arrives on the SAME wire messages as the
// visible response text (stream_start / stream_delta / stream_end) but tagged
// with `thinking: true` and a DISTINCT `messageId` (`<turnId>-thinking-<n>`).
// The caller diverts those to these handlers BEFORE the response-stream
// machinery (pendingDeltas / continuation-split / etc.), so the two streams
// never share the buffered-append hot path. A thinking message is a plain
// `type: 'thinking'` ChatMessage whose `content` accumulates the reasoning
// text — feeding the dashboard's ThinkingBody disclosure and the mobile
// content-capable thinking view. Its id is distinct from the ephemeral
// placeholder id `'thinking'`, so `filterThinking` still strips only the
// placeholder.
// ---------------------------------------------------------------------------

/**
 * Upper bound (UTF-16 code units, matching {@link MAX_TOOL_INPUT_PARTIAL_LEN})
 * on a thinking bubble's accumulated `content`. Reasoning can be long; this is
 * the same defence-in-depth ceiling the streaming tool-input accumulator uses
 * so a runaway/adversarial thinking stream can't balloon client `messages`
 * state. On truncation the buffer is sliced to exactly this length and the
 * `thinkingTruncated` boolean is set; further deltas drop idempotently.
 */
export const MAX_THINKING_CONTENT_LEN = MAX_TOOL_INPUT_PARTIAL_LEN

/** Result returned from {@link handleThinkingStreamStart}. */
export interface ThinkingStreamStartPayload {
  /** Resolved target session, or null when no session context exists. */
  sessionId: string | null
  /** Stable id of the thinking bubble (the server-stamped `messageId`). */
  thinkingMessageId: string
  /**
   * Whether the caller should append a new thinking message. False when a
   * thinking bubble with this id already exists (duplicate/replayed start) —
   * the caller then leaves the messages array untouched.
   */
  isNewMessage: boolean
  /** Pre-built `type: 'thinking'` ChatMessage when `isNewMessage` is true. */
  newMessage: ChatMessage | null
}

/**
 * Resolve a thinking `stream_start` (a `stream_start` with `thinking: true`).
 *
 * Builds a fresh `{ type: 'thinking', content: '', thinkingStreaming: true }`
 * bubble at the server-stamped id unless one already exists (dedup on
 * reconnect/replay). The caller drops the ephemeral `'thinking'` placeholder
 * via `filterThinking` and appends `newMessage`. Does NOT touch
 * `streamingMessageId` — the turn's `'pending'` sentinel (set at send) keeps
 * the busy/stop state correct across the whole turn; the thinking label is
 * driven by the bubble's own `thinkingStreaming` field.
 */
export function handleThinkingStreamStart(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
  existingMessages: readonly ChatMessage[],
): ThinkingStreamStartPayload {
  const thinkingMessageId =
    typeof msg.messageId === 'string' && msg.messageId
      ? msg.messageId
      : nextMessageId('thinking')
  const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : activeSessionId
  // Type-guarded like the sibling handlers (handleThinkingDelta / -StreamEnd):
  // only an existing THINKING bubble dedups; a non-thinking message that
  // somehow occupies the id must not silently swallow the start.
  const existing = existingMessages.find(
    (m) => m.id === thinkingMessageId && m.type === 'thinking',
  )
  if (existing) {
    return { sessionId, thinkingMessageId, isNewMessage: false, newMessage: null }
  }
  const newMessage: ChatMessage = {
    id: thinkingMessageId,
    type: 'thinking',
    content: '',
    thinkingStreaming: true,
    timestamp: Date.now(),
  }
  return { sessionId, thinkingMessageId, isNewMessage: true, newMessage }
}

/** Result returned from {@link handleThinkingDelta} when the message is well-formed. */
export interface ThinkingDeltaPayload {
  /** Resolved target session, or null when no session context exists. */
  sessionId: string | null
  /** The thinking bubble id the delta accumulates onto. */
  thinkingMessageId: string
  /**
   * Apply the delta to a session's `messages` array: locate the `thinking`
   * bubble by id and append `delta` to its `content` (bounded at
   * {@link MAX_THINKING_CONTENT_LEN}). If no bubble exists yet (a delta beat
   * its `stream_start`, or the provider emits deltas only), one is lazily
   * created — the ephemeral `'thinking'` placeholder is dropped in that case.
   * Returns the same reference (no-op) only when the bubble is already
   * truncated.
   */
  applyTo: (messages: ChatMessage[]) => ChatMessage[]
}

/**
 * Validate and build an accumulator for a thinking `stream_delta` (a
 * `stream_delta` with `thinking: true`). Returns `null` when `messageId` or
 * `delta` is missing/non-string — both required by the wire shape; malformed
 * payloads drop silently rather than throw.
 */
export function handleThinkingDelta(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): ThinkingDeltaPayload | null {
  if (typeof msg.messageId !== 'string' || !msg.messageId) return null
  if (typeof msg.delta !== 'string') return null
  const thinkingMessageId = msg.messageId
  const delta = msg.delta
  const sessionId = parseRawStringField(msg, 'sessionId') || activeSessionId

  return {
    sessionId,
    thinkingMessageId,
    applyTo: (messages) => {
      const idx = messages.findIndex(
        (m) => m.id === thinkingMessageId && m.type === 'thinking',
      )
      if (idx === -1) {
        // Lazy-create: a delta arrived before (or without) its stream_start.
        // Drop the ephemeral placeholder and seed a fresh thinking bubble.
        let seed = delta
        let truncated = false
        if (seed.length > MAX_THINKING_CONTENT_LEN) {
          seed = seed.slice(0, MAX_THINKING_CONTENT_LEN)
          truncated = true
        }
        const created: ChatMessage = {
          id: thinkingMessageId,
          type: 'thinking',
          content: seed,
          thinkingStreaming: true,
          ...(truncated ? { thinkingTruncated: true } : null),
          timestamp: Date.now(),
        }
        return [...messages.filter((m) => m.id !== 'thinking'), created]
      }
      const existing = messages[idx]!
      // Idempotent terminal state: once truncated, drop further deltas.
      if (existing.thinkingTruncated) return messages
      const prev = existing.content || ''
      let next: string
      let truncated = false
      if (prev.length + delta.length > MAX_THINKING_CONTENT_LEN) {
        const headroom = MAX_THINKING_CONTENT_LEN - prev.length
        next = prev + delta.slice(0, Math.max(0, headroom))
        truncated = true
      } else {
        next = prev + delta
      }
      const updated = [...messages]
      updated[idx] = {
        ...existing,
        content: next,
        thinkingStreaming: true,
        ...(truncated ? { thinkingTruncated: true } : null),
      }
      return updated
    },
  }
}

/**
 * #6756 — orphan sweep: finalise any thinking bubble still marked streaming.
 *
 * A thinking bubble normally finalises on its own `stream_end` (the block's
 * `content_block_stop`), but if that message is dropped (server crash, missed
 * broadcast) the bubble would be stuck on "Thinking…" forever. The turn
 * boundary is a guaranteed backstop: callers run this on the RESPONSE stream's
 * `stream_end` and on `result` — by then every thinking block of the turn is
 * over. Returns the same array reference when nothing was streaming (no-op),
 * so callers can compose it with their force-new-reference spread without an
 * extra clone in the common case. Mirrors the #4308 activeTools orphan sweep.
 */
export function finalizeThinkingStreams(messages: ChatMessage[]): ChatMessage[] {
  if (!messages.some((m) => m.type === 'thinking' && m.thinkingStreaming === true)) {
    return messages
  }
  return messages.map((m) =>
    m.type === 'thinking' && m.thinkingStreaming === true
      ? { ...m, thinkingStreaming: false }
      : m,
  )
}

/** Result returned from {@link handleThinkingStreamEnd}. */
export interface ThinkingStreamEndPayload {
  /** Resolved target session, or null when no session context exists. */
  sessionId: string | null
  /** The thinking bubble id whose streaming label should finalise. */
  thinkingMessageId: string | null
  /**
   * Apply the finalisation to a session's `messages` array: flip the matching
   * `thinking` bubble's `thinkingStreaming` to `false` (label → "Thought").
   * Returns the same reference (no-op) when no matching bubble is present, so
   * callers can skip the state write.
   */
  applyTo: (messages: ChatMessage[]) => ChatMessage[]
}

/**
 * #6391 — parse a footer-stat numeric field (thinkingDurationMs / thinkingTokens)
 * off the raw wire message. Defensive re-guard mirroring the protocol schema:
 * a finite non-negative integer, or `undefined` when absent/malformed. Floors
 * so a stray float can never leak a fractional ms/token onto the bubble.
 */
function parseFiniteNonNegIntField(msg: Record<string, unknown>, key: string): number | undefined {
  const v = msg[key]
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined
}

/**
 * Resolve a thinking `stream_end` (a `stream_end` with `thinking: true`).
 * Finalises the bubble's streaming label without touching `streamingMessageId`,
 * and — for the #6391 footer-stat — threads the server-measured
 * `thinkingDurationMs` (+ `thinkingTokens` when a provider reports it) onto the
 * bubble so renderers show `thought for Xs · N tokens`. Both stats are optional:
 * a stream_end without them (old server, token-less provider) just flips the
 * label, and the footer degrades to a bare "Thought".
 */
export function handleThinkingStreamEnd(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): ThinkingStreamEndPayload {
  const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : activeSessionId
  const thinkingMessageId = parseRawStringField(msg, 'messageId')
  const thinkingDurationMs = parseFiniteNonNegIntField(msg, 'thinkingDurationMs')
  const thinkingTokens = parseFiniteNonNegIntField(msg, 'thinkingTokens')
  return {
    sessionId,
    thinkingMessageId,
    applyTo: (messages) => {
      if (!thinkingMessageId) return messages
      const idx = messages.findIndex(
        (m) => m.id === thinkingMessageId && m.type === 'thinking',
      )
      if (idx === -1) return messages
      const existing = messages[idx]!
      // Attach only stats that differ from what's already on the bubble, so a
      // replayed / orphan-swept stream_end that carries the same numbers stays
      // a same-reference no-op (React skip). Finalising the label is its own
      // reason to write, independent of the stats.
      const nextDuration =
        thinkingDurationMs !== undefined && existing.thinkingDurationMs !== thinkingDurationMs
          ? thinkingDurationMs
          : undefined
      const nextTokens =
        thinkingTokens !== undefined && existing.thinkingTokens !== thinkingTokens
          ? thinkingTokens
          : undefined
      const needsFinalize = existing.thinkingStreaming === true
      if (!needsFinalize && nextDuration === undefined && nextTokens === undefined) {
        return messages
      }
      const updated = [...messages]
      updated[idx] = {
        ...existing,
        thinkingStreaming: false,
        ...(nextDuration !== undefined ? { thinkingDurationMs: nextDuration } : null),
        ...(nextTokens !== undefined ? { thinkingTokens: nextTokens } : null),
      }
      return updated
    },
  }
}

// ---------------------------------------------------------------------------
// result — payload-normalization parts only
//
// Streaming-state cleanup (`flushPendingDeltas`, `clearTimeout(deltaFlushTimer)`,
// `_postPermissionSplits.clear()`, `_deltaIdRemaps.clear()`) and side-effects
// (Codex/Gemini cost fallback via dashboard's `calculateCost`, app's
// `hapticSuccess()`, `pushSessionNotification`, force-array-ref) all stay at
// the call site. This helper extracts only the pure payload normalization:
// session resolution, `usage` → `ContextUsage`, and `cost`/`duration` type
// guards.
// ---------------------------------------------------------------------------

/** Result returned from {@link handleResultUsage}. */
export interface ResultUsagePayload {
  /** Resolved target session, or null when no session context exists. */
  sessionId: string | null
  /** Normalized usage counts, or null when the message had no `usage` object. */
  contextUsage: ContextUsage | null
  /**
   * #6769: occupancy snapshot parsed from the message's optional
   * `contextOccupancy` wire field, or null when absent/malformed. Callers must
   * treat null as "no new snapshot" (keep the previous per-session value),
   * NOT as "clear the meter" — providers emit the field on every result, so
   * a missing field means either an older server or a no-occupancy provider.
   */
  contextOccupancy: ContextOccupancy | null
  /** Numeric `cost` from the message, or null when missing/non-numeric. */
  lastResultCost: number | null
  /** Numeric `duration` from the message, or null when missing/non-numeric. */
  lastResultDuration: number | null
}

/**
 * Normalize the payload-pure parts of a `result` message.
 *
 * - `sessionId`: resolved via `typeof msg.sessionId === 'string' ? msg.sessionId : activeSessionId`,
 *   then `|| activeSessionId` to preserve the legacy "empty-string falls back"
 *   behaviour. Matches the guarded-raw-string pattern used by
 *   `handleMcpServers` / `handleCostUpdate`: a whitespace-only string is
 *   preserved verbatim (so downstream `sessionStates[id]` lookups miss rather
 *   than silently falling back to the active session), but non-string runtime
 *   values (numbers, booleans, objects) are rejected — keeping the declared
 *   `string | null` return type honest.
 * - `contextUsage`: built from `msg.usage` when it's a plain object. Each
 *   numeric field is coerced via `typeof === 'number' && Number.isFinite(...)`,
 *   defaulting to `0` for missing, non-number, or `NaN` inputs. Returns `null`
 *   when `usage` is missing or not a plain object (defensive: rejects strings,
 *   numbers, arrays, null). This is the per-turn BILLING aggregate — never
 *   feed it to the context meter (#6769).
 * - `contextOccupancy` (#6769): parsed from `msg.contextOccupancy` (the wire
 *   occupancy snapshot). Null when the field is absent or lacks a finite
 *   `totalTokens` — callers keep the previous per-session snapshot in that
 *   case rather than clearing the meter.
 * - `lastResultCost`: `typeof msg.cost === 'number' ? msg.cost : null`. The
 *   dashboard's Codex/Gemini fallback (`calculateCost(...)`) stays inline at
 *   the call site and overrides this when the helper returned null but usage
 *   was present.
 * - `lastResultDuration`: `typeof msg.duration === 'number' ? msg.duration : null`.
 */
export function handleResultUsage(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): ResultUsagePayload {
  const rawUsage = msg.usage
  const usage =
    rawUsage !== null &&
    typeof rawUsage === 'object' &&
    !Array.isArray(rawUsage)
      ? (rawUsage as Record<string, unknown>)
      : null
  const numField = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : 0
  const contextUsage: ContextUsage | null = usage
    ? {
        inputTokens: numField(usage.input_tokens),
        outputTokens: numField(usage.output_tokens),
        cacheCreation: numField(usage.cache_creation_input_tokens),
        cacheRead: numField(usage.cache_read_input_tokens),
      }
    : null
  // #6769: occupancy snapshot from the optional `contextOccupancy` wire
  // field (named distinctly from the billing `usage`/client `contextUsage`
  // pair — the #6816 review's naming-trap note). Strict on `totalTokens` (a
  // snapshot without a finite total is useless — reject the whole object
  // rather than fabricate a 0-token meter); lenient per-field on the optional
  // metadata. See ServerContextOccupancySnapshotSchema in @chroxy/protocol
  // for the wire contract and per-provider sources.
  const rawOccupancy = msg.contextOccupancy
  const occ =
    rawOccupancy !== null &&
    typeof rawOccupancy === 'object' &&
    !Array.isArray(rawOccupancy)
      ? (rawOccupancy as Record<string, unknown>)
      : null
  let contextOccupancy: ContextOccupancy | null = null
  if (occ && typeof occ.totalTokens === 'number' && Number.isFinite(occ.totalTokens) && occ.totalTokens >= 0) {
    const posOrNull = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
    contextOccupancy = {
      totalTokens: occ.totalTokens,
      maxTokens: posOrNull(occ.maxTokens),
      autoCompactThreshold: posOrNull(occ.autoCompactThreshold),
      isAutoCompactEnabled:
        typeof occ.isAutoCompactEnabled === 'boolean' ? occ.isAutoCompactEnabled : null,
      source:
        occ.source === 'context-usage-api' || occ.source === 'final-round-prompt'
          ? occ.source
          : null,
    }
  }
  const lastResultCost =
    typeof msg.cost === 'number' ? msg.cost : null
  const lastResultDuration =
    typeof msg.duration === 'number' ? msg.duration : null
  const rawSessionId = parseRawStringField(msg, 'sessionId')
  return {
    sessionId: rawSessionId || activeSessionId,
    contextUsage,
    contextOccupancy,
    lastResultCost,
    lastResultDuration,
  }
}

// ---------------------------------------------------------------------------
// raw / raw_background (#5454)
//
// Note on `pong`: it carries no payload and its only effect is module-level
// heartbeat bookkeeping (`_onPong()` timer reset) on each client, so there is
// nothing to extract — it intentionally has no shared handler.
// ---------------------------------------------------------------------------

/**
 * Extract the terminal data chunk from a `raw` / `raw_background` message.
 *
 * Non-string / missing `data` falls back to `''` so the declared return type
 * is honest. Both clients previously did `appendTerminalData(msg.data as
 * string)` inline — a typed lie that let `undefined` flow into the
 * dashboard's `stripAnsi(data)` (which throws on non-strings). The server's
 * `raw` / `raw_background` payload is always a PTY string, so the fallback is
 * unreachable from a well-behaved producer; for a malformed one, appending
 * nothing beats crashing the message handler. Same tightening class as the
 * other non-string fallbacks in this migration (#5454).
 */
export function handleRawOutput(msg: Record<string, unknown>): { data: string } {
  return { data: typeof msg.data === 'string' ? msg.data : '' }
}
