/**
 * Shared stateless handlers for agent-tracking messages (agent_spawned /
 * agent_completed / agent_event).
 *
 * Extracted from the handlers barrel (audit P2-3) — pure move, no logic
 * change. Re-exported from ./index so the public surface is unchanged. These
 * return builder shapes whose new activeAgents array depends on the existing
 * one (dedup-by-toolUseId / filter); the caller invokes applyTo with the
 * looked-up array. See ./index.ts for the stateless-handler contract.
 */

import type { AgentInfo, ChatMessage } from '../types'
import { parseRawStringField, resolveSessionId } from './_shared'

// ---------------------------------------------------------------------------
// agent_spawned / agent_completed
//
// Both handlers are stateful in the same way as dev_preview: the new
// activeAgents array depends on the existing array (dedup-by-toolUseId for
// `agent_spawned`, filter for `agent_completed`). They return a builder
// shape — `sessionId` resolved as usual, plus an `applyTo(current)` function
// the call site invokes with the looked-up array. This mirrors
// `DevPreviewBuilder` but operates on `AgentInfo[]`.
// ---------------------------------------------------------------------------

/** Builder result for handlers whose `activeAgents` patch depends on existing state. */
export interface AgentInfoBuilder {
  /** Session ID the patch targets (may be null if no session context). */
  sessionId: string | null
  /** Apply the builder to the session's current activeAgents list. */
  applyTo: (current: AgentInfo[]) => AgentInfo[]
}

/**
 * Resolve target session and produce a builder that appends a new active
 * agent entry. Both clients dedupe by `toolUseId`: when the incoming
 * `toolUseId` already exists in the list, the existing array is returned
 * unchanged (same reference) and no append happens.
 *
 * Behaviour-preserving:
 * - `toolUseId` is cast verbatim (`as string`) by the prior inline code; the
 *   builder treats missing/non-string as a no-op (returns same reference) so
 *   nothing is appended with a non-string id.
 * - `description` defaults to `'Background task'` when missing/empty (matches
 *   `(msg.description as string) || 'Background task'`).
 * - `startedAt` defaults to `Date.now()` when missing/zero/falsy (matches
 *   `(msg.startedAt as number) || Date.now()`).
 *
 * Note on session resolution: this uses `resolveSessionId` (the shared trim +
 * fallback helper), matching every other migrated handler. The prior inline
 * code was `(msg.sessionId as string) || activeSessionId`. The two paths
 * differ only for whitespace-only `sessionId` values (e.g. `'   '`):
 * `resolveSessionId` trims and falls back to `activeSessionId`, while the
 * prior code would have used the whitespace string verbatim and then
 * harmlessly missed the `sessionStates[id]` lookup. Server-emitted
 * `agent_spawned` messages do not include `sessionId` in the message body
 * (it is injected by `broadcastToSession` for SDK mode and absent for
 * legacy CLI mode), so the divergence is theoretical only.
 */
export function handleAgentSpawned(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): AgentInfoBuilder {
  const toolUseId = parseRawStringField(msg, 'toolUseId')
  const rawDescription = typeof msg.description === 'string' ? msg.description : ''
  const description = rawDescription || 'Background task'
  const rawStartedAt = typeof msg.startedAt === 'number' ? msg.startedAt : 0
  return {
    sessionId: resolveSessionId(msg, activeSessionId),
    applyTo: (current) => {
      if (!toolUseId) return current
      if (current.some((a) => a.toolUseId === toolUseId)) return current
      return [
        ...current,
        {
          toolUseId,
          description,
          startedAt: rawStartedAt || Date.now(),
        },
      ]
    },
  }
}

/**
 * Resolve target session and produce a builder that removes the active-agent
 * entry whose `toolUseId` matches the incoming message. If no entry matches,
 * the existing array is returned unchanged (same reference). Missing or
 * non-string `toolUseId` is treated as a no-op for the same reason.
 */
export function handleAgentCompleted(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): AgentInfoBuilder {
  const toolUseId = parseRawStringField(msg, 'toolUseId')
  return {
    sessionId: resolveSessionId(msg, activeSessionId),
    applyTo: (current) => {
      if (!toolUseId) return current
      const filtered = current.filter((a) => a.toolUseId !== toolUseId)
      if (filtered.length === current.length) return current
      return filtered
    },
  }
}

// ---------------------------------------------------------------------------
// #5016 — agent_event (Task subagent nested progress)
//
// Server forwards each child wire event (tool_start / tool_result /
// tool_input_delta / stream_delta) as `agent_event{parentToolUseId,
// eventType, payload}`. This handler resolves the target session and
// returns a builder that appends the event to the parent Task `tool_use`
// bubble's `childAgentEvents[]`. Renderers iterate the list to surface
// nested sub-bubbles inside the Task tool_call.
//
// Coalescing: `stream_delta` events are appended verbatim — the
// renderer concatenates contiguous deltas per messageId. We don't
// coalesce in the handler because the child's stream may carry
// multiple distinct `messageId`s across rounds within one Task, and
// the renderer is the source of truth for grouping by id.
// ---------------------------------------------------------------------------

/** Builder result for `agent_event` — patch depends on the existing message list. */
export interface AgentEventBuilder {
  sessionId: string | null
  /**
   * Apply the builder to the session's current chat-message list.
   * Returns the same reference when no matching parent bubble is
   * present (event arrives before the Task tool_use is registered —
   * extremely rare given the server's ordering guarantee that
   * tool_start fires before any nested agent_event, but defended
   * for robustness against test stubs and replay paths).
   */
  applyTo: (current: ChatMessage[]) => ChatMessage[]
}

/**
 * Resolve target session and produce a builder that appends one nested
 * child wire event to the parent Task tool_use bubble's
 * `childAgentEvents[]`.
 *
 * Missing / non-string `parentToolUseId` is a no-op (returns same
 * reference). Missing / non-string `eventType` is also a no-op — the
 * downstream renderer keys on `type`, and a bubble with `type: ''`
 * would render nothing useful while still bloating state.
 *
 * `payload` is normalised to `{}` when missing / non-object so the
 * `ChildAgentEvent.payload` field stays a stable plain object shape.
 * Arrays and primitives are rejected (treated as `{}`) — payloads
 * from the server are always objects.
 *
 * No-op when the parent bubble is absent: the event is dropped on the
 * floor. We deliberately do NOT buffer pending events for a parent
 * that hasn't arrived yet — the server's ordering guarantees that the
 * parent's `tool_start` (which creates the bubble) fires before any
 * nested `agent_event` carrying its `toolUseId`. If that invariant
 * breaks in future, the symptom is a missing sub-bubble (visible to
 * users), not data corruption.
 */
export function handleAgentEvent(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): AgentEventBuilder {
  const parentToolUseId = parseRawStringField(msg, 'parentToolUseId')
  const eventType = typeof msg.eventType === 'string' && msg.eventType
    ? msg.eventType
    : null
  const rawPayload = msg.payload
  const payload: Record<string, unknown> =
    rawPayload !== null
    && typeof rawPayload === 'object'
    && !Array.isArray(rawPayload)
      ? (rawPayload as Record<string, unknown>)
      : {}
  return {
    sessionId: resolveSessionId(msg, activeSessionId),
    applyTo: (current) => {
      if (!parentToolUseId || !eventType) return current
      let mutated = false
      const next = current.map((m) => {
        if (m.type !== 'tool_use' || m.toolUseId !== parentToolUseId) return m
        mutated = true
        const nextEvents = [...(m.childAgentEvents || []), { type: eventType, payload }]
        return { ...m, childAgentEvents: nextEvents }
      })
      return mutated ? next : current
    },
  }
}
