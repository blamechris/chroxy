/**
 * ChildAgentEventList — #5016
 *
 * Renders the nested per-event timeline inside a Task tool_call bubble
 * when the dispatched subagent has emitted intermediate progress
 * (`tool_start` / `tool_result` / `tool_input_delta` / `stream_delta`)
 * via the server's `agent_event` re-emit path.
 *
 * Design:
 *   - One row per `tool_start` / `tool_result` pair, keyed by the
 *     child's `toolUseId`. `tool_input_delta` chunks accumulate onto
 *     the row's `inputPartial`; `tool_result` resolves the row.
 *   - `stream_delta` chunks are concatenated into a single text block;
 *     contiguous deltas inside the same `messageId` merge directly,
 *     while a `messageId` transition inserts a blank line so multi-
 *     round child output doesn't fuse unrelated paragraphs.
 *   - The collapsing rules mirror the top-level `ToolBubble`'s: a row
 *     opens collapsed and expands on click. The default starting state
 *     is "all collapsed" so a Task with many child tools doesn't
 *     explode the layout the first time it's expanded.
 *   - Unknown event types are silently ignored by the reducer (they
 *     don't appear in the rendered list). This is intentional: today
 *     the only possible non-recognised types are forward-compat
 *     payloads (e.g. a future `permission_request` re-emit). A
 *     surfaced "unknown event" row would confuse users in v2; if a
 *     new event kind ships, add an explicit branch to the reducer
 *     and a styled row at the same time.
 *
 * Why a flat list and not a recursive `ToolBubble`:
 *   The child's tool_use events are not first-class `ChatMessage`s on
 *   the parent's `messages` array — they live on
 *   `ChatMessage.childAgentEvents[]`. A recursive `ToolBubble` would
 *   need a `ChatMessage[]`-shaped projection; the cost is a duplicate
 *   render path with subtle drift risk. The flat list keeps the
 *   reducer trivial (append) and lets us style nested rows distinctly
 *   ("this is sub-tool progress, not top-level work").
 *
 * What this does NOT render in v2:
 *   - `permission_request` from the child (the server gates these on
 *     the parent's permission manager today; deferred until the child
 *     gets its own per-launch permission_mode override surface).
 *   - Errors from the child are surfaced via the parent's Task
 *     tool_result `is_error: true` content (the byok-session.js
 *     fold), so a child error renders in the parent bubble's normal
 *     result section — no special chip here.
 */

import { useMemo, useState } from 'react'
import type { ChildAgentEvent } from '@chroxy/store-core'
import { formatToolName, getInputSummary, getPartialSummary } from '@chroxy/store-core'

interface ChildAgentEventListProps {
  events: ChildAgentEvent[]
  /** Parent Task tool_use id — used to scope testIDs so nested rows from sibling Tasks don't collide. */
  parentToolUseId: string
}

/**
 * One row in the nested list — a tool_use from the child agent, with
 * its accumulated input + final result text (when present).
 */
interface ChildToolRow {
  /** Child's toolUseId — used as the React key + collapse-state key. */
  toolUseId: string
  /** Child's tool name (`Read`, `Bash`, `Grep`, etc.). */
  toolName: string
  /** Final input from `tool_start`, when present. */
  input?: Record<string, unknown> | string
  /** Accumulated `tool_input_delta` partialJson chunks (best-effort JSON). */
  inputPartial?: string
  /** Resolved result text from `tool_result`. */
  result?: string
  /** MCP server name if the child invoked an MCP tool. */
  serverName?: string
  /** Whether this row has a resolved tool_result. */
  hasResult: boolean
}

/**
 * Reduce the flat `agent_event` log into a structured per-tool list +
 * one concatenated assistant-text block (or null when the child
 * produced no streaming text). Pure — recomputed via `useMemo` when
 * `events` changes.
 *
 * The reducer is forgiving:
 *   - `tool_input_delta` for an unknown `toolUseId` is ignored (no
 *     matching row to attach to — pre-tool_start, shouldn't happen
 *     given server ordering but defended).
 *   - `tool_result` for an unknown `toolUseId` synthesises a row
 *     (defensive: a race in the child where `tool_result` arrives
 *     before `tool_start` would otherwise drop the result silently).
 *   - `stream_delta` chunks without a string `delta` are skipped.
 */
function reduceEvents(events: ChildAgentEvent[]): {
  tools: ChildToolRow[]
  assistantText: string
} {
  const tools: ChildToolRow[] = []
  const byId = new Map<string, ChildToolRow>()
  let assistantText = ''
  // Track the messageId of the last stream_delta we appended so we can
  // insert a blank-line boundary on transition. Without this, multi-
  // round Tasks (multiple child messageIds within one parent dispatch)
  // would fuse two unrelated paragraphs of assistant text together.
  let lastStreamMessageId: string | null = null
  for (const ev of events) {
    const p = ev.payload || {}
    if (ev.type === 'tool_start') {
      const toolUseId = typeof p.toolUseId === 'string' ? p.toolUseId : null
      if (!toolUseId) continue
      const toolName = typeof p.tool === 'string' ? p.tool : 'tool'
      const serverName = typeof p.serverName === 'string' ? p.serverName : undefined
      const input = (p.input && typeof p.input === 'object') || typeof p.input === 'string'
        ? (p.input as Record<string, unknown> | string)
        : undefined
      const existing = byId.get(toolUseId)
      if (existing) {
        // Idempotent — a replayed `tool_start` overwrites name/input
        // but preserves the resolved state.
        existing.toolName = toolName
        existing.input = input ?? existing.input
        existing.serverName = serverName ?? existing.serverName
        continue
      }
      const row: ChildToolRow = {
        toolUseId,
        toolName,
        input,
        serverName,
        hasResult: false,
      }
      byId.set(toolUseId, row)
      tools.push(row)
    } else if (ev.type === 'tool_input_delta') {
      const toolUseId = typeof p.toolUseId === 'string' ? p.toolUseId : null
      const partialJson = typeof p.partialJson === 'string' ? p.partialJson : null
      if (!toolUseId || partialJson === null) continue
      const row = byId.get(toolUseId)
      if (!row) continue
      row.inputPartial = (row.inputPartial || '') + partialJson
    } else if (ev.type === 'tool_result') {
      const toolUseId = typeof p.toolUseId === 'string' ? p.toolUseId : null
      const result = typeof p.result === 'string' ? p.result : ''
      if (!toolUseId) continue
      let row = byId.get(toolUseId)
      if (!row) {
        // Defensive: tool_result arrived without a preceding
        // tool_start. Synthesise a row so the result is visible.
        row = { toolUseId, toolName: 'tool', hasResult: false }
        byId.set(toolUseId, row)
        tools.push(row)
      }
      row.result = result
      row.hasResult = true
    } else if (ev.type === 'stream_delta') {
      const delta = typeof p.delta === 'string' ? p.delta : null
      if (delta) {
        const messageId = typeof p.messageId === 'string' ? p.messageId : null
        // On a messageId transition (and only if we have any prior
        // text), insert a blank-line boundary so the previous round's
        // paragraph is visually separated from the new round.
        if (
          messageId
          && lastStreamMessageId
          && messageId !== lastStreamMessageId
          && assistantText.length > 0
        ) {
          assistantText += '\n\n'
        }
        assistantText += delta
        if (messageId) lastStreamMessageId = messageId
      }
    }
    // Unknown types fall through silently and are NOT rendered.
    // Adding a new surface (e.g. nested permission_request rows) means
    // adding an explicit branch above AND a styled row in the JSX —
    // a generic "unknown event" line would just be noise to users.
  }
  return { tools, assistantText }
}

export function ChildAgentEventList({ events, parentToolUseId }: ChildAgentEventListProps) {
  const reduced = useMemo(() => reduceEvents(events), [events])
  // Collapse-state map keyed by toolUseId. Default = collapsed (false).
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const toggle = (id: string) => setExpanded((s) => ({ ...s, [id]: !s[id] }))

  if (reduced.tools.length === 0 && !reduced.assistantText) {
    // Render nothing — the parent ToolBubble only mounts us when
    // there is at least one event, so this branch is the
    // safety-net for an all-`stream_delta`-empty payload.
    return null
  }
  return (
    <div
      className="child-agent-event-list"
      data-testid={`child-agent-events-${parentToolUseId}`}
    >
      <div className="child-agent-event-list-header" data-testid="child-agent-events-header">
        Subagent progress
      </div>
      {reduced.tools.map((row) => {
        const isExpanded = !!expanded[row.toolUseId]
        const summary = getInputSummary(row.input)
          || (row.inputPartial ? getPartialSummary(row.inputPartial) : '')
          || (row.inputPartial ? row.inputPartial.slice(0, 100) : '')
        return (
          <div
            key={row.toolUseId}
            className={`child-agent-tool${isExpanded ? ' expanded' : ''}`}
            data-testid={`child-agent-tool-${row.toolUseId}`}
            role="button"
            tabIndex={0}
            aria-expanded={isExpanded}
            onClick={(e) => {
              e.stopPropagation()
              toggle(row.toolUseId)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                toggle(row.toolUseId)
              }
            }}
          >
            {!row.hasResult && (
              <span
                className="child-agent-tool-pulse"
                data-testid={`child-agent-tool-pulse-${row.toolUseId}`}
                aria-hidden="true"
              />
            )}
            <span className="child-agent-tool-name">{formatToolName(row.toolName, row.serverName)}</span>
            {summary && (
              <span
                className="child-agent-tool-input"
                data-testid={`child-agent-tool-input-${row.toolUseId}`}
                style={{ color: '#666' }}
              >
                {summary}
              </span>
            )}
            {isExpanded && row.result !== undefined && (
              <div
                className="child-agent-tool-result"
                data-testid={`child-agent-tool-result-${row.toolUseId}`}
                onClick={(e) => e.stopPropagation()}
              >
                <pre>{row.result}</pre>
              </div>
            )}
          </div>
        )
      })}
      {reduced.assistantText && (
        <div
          className="child-agent-stream-text"
          data-testid={`child-agent-stream-text-${parentToolUseId}`}
          onClick={(e) => e.stopPropagation()}
        >
          {reduced.assistantText}
        </div>
      )}
    </div>
  )
}

// Exported for unit-test reach into the reducer without rendering React.
export { reduceEvents as __reduceEventsForTest }
