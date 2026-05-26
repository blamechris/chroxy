/**
 * ToolGroup — collapsible block summarising a contiguous run of tool calls
 * (#3747). Mirrors the mobile app's ActivityGroup so both clients render
 * the same shape: a one-line header with total + tool-type breakdown
 * (e.g. "12 tools used — 10 Bash, 2 Read"), expanding to a list of
 * individual entries.
 *
 * Default state: collapsed when the run is done, expanded while it is
 * still active so users see progress as tools fire.
 */
import { useState, useEffect, useRef } from 'react'
import type { ChatMessage } from '@chroxy/store-core'
import {
  summarizeToolCounts,
  formatToolBreakdown,
  formatToolName,
  tryParseCompleteJson,
} from '@chroxy/store-core'

export interface ToolGroupProps {
  messages: ChatMessage[]
  isActive: boolean
  // #4305 — when true, the group is the last item in the chat list and has
  // no follow-up assistant text summarizing it. Skips the on-completion
  // auto-collapse so trailing tool runs stay visible (matching the Output
  // tab's chronology) until the user explicitly collapses them.
  isTail?: boolean
}

function getInputSummary(input: ChatMessage['toolInput']): string {
  if (!input) return ''
  if (typeof input === 'string') return String(input).slice(0, 100)
  const summary =
    (input.command as string) ||
    (input.file_path as string) ||
    (input.path as string) ||
    (input.description as string) ||
    ''
  if (typeof summary !== 'string') return JSON.stringify(summary).slice(0, 100)
  return summary.slice(0, 100)
}

function formatInputForDetail(input: ChatMessage['toolInput']): string {
  if (input === undefined || input === null) return ''
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    // Cyclic structures or non-serializable values fall back to best-effort
    // String() so the user still sees something instead of an empty panel.
    return String(input)
  }
}

/**
 * #4341: format the streaming `toolInputPartial` accumulator for the
 * expanded detail panel. Mirrors `ToolBubble`'s partial-preview path
 * (#4081): if the buffer happens to be a complete JSON document, pretty-
 * print it via `tryParseCompleteJson` (cheap gate avoids the N-1 throws
 * #4242 amortised); otherwise render verbatim so the user sees the
 * field assembling. Returns '' for empty/whitespace input so the caller
 * can preserve the "(no input)" placeholder for truly inputless tools.
 */
function formatPartialForDetail(partial: string | undefined): string {
  if (!partial) return ''
  const parsed = tryParseCompleteJson(partial)
  if (parsed !== undefined) return JSON.stringify(parsed, null, 2)
  return partial
}

function ToolGroupEntry({
  message,
  expanded,
  onToggle,
}: {
  message: ChatMessage
  expanded: boolean
  onToggle: (id: string) => void
}) {
  // Thinking entries are not interactive — they carry no toolInput/toolResult,
  // so an expand affordance would be a lie. We still stop click propagation
  // so a misclick on a Thinking row doesn't collapse the parent group, but
  // we never set onToggle — the row has no expanded state.
  if (message.type === 'thinking') {
    // The div is non-interactive (no role/tabIndex), so keyboard focus
    // never lands here — only the click handler is reachable. We swallow
    // clicks so a misclick on a Thinking row doesn't collapse the parent
    // group.
    const swallow = (e: React.MouseEvent) => e.stopPropagation()
    return (
      <div
        className="tool-group-entry tool-group-entry--thinking"
        data-testid={`tool-group-entry-${message.id}`}
        onClick={swallow}
      >
        <span className="tool-group-entry-name">Thinking</span>
      </div>
    )
  }
  const toolName = formatToolName(message.tool ?? 'Tool', message.serverName)
  const summary = getInputSummary(message.toolInput)
  // `toolResult` is set to the server's result string by handleToolResult,
  // including the empty string when the tool produced no output. A bare
  // truthiness check (`!!toolResult`) wrongly classifies an empty result
  // as pending; presence-check covers all non-pending shapes (#3794 review).
  const hasResult =
    message.toolResult !== undefined ||
    (message.toolResultImages?.length ?? 0) > 0
  const markerClass = `tool-group-entry-marker tool-group-entry-marker--${hasResult ? 'complete' : 'pending'}`

  // #4279: clicks must not bubble to the parent group's onClick={toggle}
  // (otherwise expanding an entry collapses the whole list). Same goes for
  // keyboard activation — Enter/Space have to stop propagation before the
  // group's handler swallows them.
  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    onToggle(message.id)
  }
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || (e.key === ' ' && !e.repeat)) {
      e.preventDefault()
      e.stopPropagation()
      onToggle(message.id)
    }
  }

  const structuredInputDetail = formatInputForDetail(message.toolInput)
  // #4341: fall through to the streaming `toolInputPartial` accumulator
  // when the structured `toolInput` is empty. Pre-fix the expanded panel
  // showed "(no input)" for in-flight Agent/Task tools even though
  // `tool_input_delta` chunks were piling into `toolInputPartial` —
  // ToolBubble had already closed this gap for the collapsed summary
  // (#4081), so the expanded view now mirrors the same fallback.
  // `isStreamingInput` flags the panel as still arriving so styling can
  // hint at the in-flight state (data-streaming="true").
  const partialInputDetail = structuredInputDetail
    ? ''
    : formatPartialForDetail(message.toolInputPartial)
  const inputDetail = structuredInputDetail || partialInputDetail
  const isStreamingInput = !structuredInputDetail && partialInputDetail !== ''
  const resultDetail = message.toolResult ?? ''
  // Distinguish "tool finished with empty output" from "tool still running".
  // hasResult covers both toolResult presence and image results.
  const resultPlaceholder = hasResult ? '(no result)' : '(no result yet)'

  return (
    <div
      className={`tool-group-entry${expanded ? ' tool-group-entry--expanded' : ''}`}
      data-testid={`tool-group-entry-${message.id}`}
    >
      {/*
        #4281: the click target is the ROW, not the outer entry container.
        Otherwise clicks inside the expanded detail panel (e.g. selecting
        `<pre>` text to copy a Bash output) bubble to the entry's onClick
        and collapse it — same shape of bug as the top-level #4279 one
        level deeper. Keeping the role="button" and the keyboard handler
        on the row also avoids nesting interactive roles inside the entry
        container, which the previous shape did.
      */}
      <div
        className="tool-group-entry-row"
        data-testid={`tool-group-entry-row-${message.id}`}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
      >
        <span className={markerClass} aria-hidden="true">
          {hasResult ? '✓' : '›'}
        </span>
        <span className="tool-group-entry-name">{toolName}</span>
        {summary && <span className="tool-group-entry-input">{summary}</span>}
        <span className="tool-group-entry-toggle" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
      </div>
      {expanded && (
        <div
          className="tool-group-entry-detail"
          data-testid={`tool-group-entry-detail-${message.id}`}
          // #4341: surfaces the in-flight state to styling so a CSS
          // hook can hint "still arriving" (e.g. subtle pulse on the
          // Input section). Only set when the panel is rendering the
          // streaming partial buffer rather than the final structured
          // input.
          data-streaming={isStreamingInput ? 'true' : undefined}
          // Detail clicks must not bubble to the outer group's
          // onClick={toggle} — otherwise selecting/copying `<pre>` text
          // collapses the entire group. The row already handles its own
          // toggle clicks; the detail panel is purely a presentation area.
          onClick={(e) => e.stopPropagation()}
        >
          <div className="tool-group-entry-detail-section">
            <div className="tool-group-entry-detail-label">Input</div>
            <pre className="tool-group-entry-detail-content">
              {inputDetail || '(no input)'}
            </pre>
          </div>
          <div className="tool-group-entry-detail-section">
            <div className="tool-group-entry-detail-label">Result</div>
            <pre className="tool-group-entry-detail-content">
              {resultDetail || resultPlaceholder}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}

export function ToolGroup({ messages, isActive, isTail = false }: ToolGroupProps) {
  // Auto-collapse on completion: expand while active, collapse when the
  // run ends. Subsequent expand state lives in component state so a user
  // who toggled stays toggled until the run lifecycle flips again.
  // #4305 — tail groups (no follow-up summary) start expanded and skip
  // the on-completion collapse, so trailing tools remain visible.
  const [expanded, setExpanded] = useState(isActive || isTail)
  const wasActiveRef = useRef(isActive)
  // Latch isTail while the group is still active so the on-completion
  // collapse path reads the *pre-flip* tail status. #4314 — if a single
  // render flips both isActive: true -> false AND isTail: true -> false
  // (response message arrives in the same batched store update as
  // stream_end), an effect-updated ref would already reflect the new
  // isTail=false by the time the [isActive] effect runs (effects fire in
  // declaration order on the same commit), and the trailing group would
  // collapse immediately — the same symptom #4309 fixed. Updating inline
  // during render guarantees the latch only advances while the group is
  // observably the tail of an active run.
  const wasTailRef = useRef(isTail)
  if (isActive) wasTailRef.current = isTail
  useEffect(() => {
    if (wasActiveRef.current && !isActive) {
      if (!wasTailRef.current) setExpanded(false)
    }
    if (!wasActiveRef.current && isActive) setExpanded(true)
    wasActiveRef.current = isActive
  }, [isActive])

  // #4279: per-entry expansion state lives here so multiple entries can be
  // open simultaneously and the parent group's expand/collapse logic doesn't
  // touch entry state. We track open entries in a Set keyed by message id —
  // toggling an entry flips its membership.
  const [expandedEntryIds, setExpandedEntryIds] = useState<Set<string>>(() => new Set())
  const toggleEntry = (id: string) => {
    setExpandedEntryIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toolCount = messages.filter((m) => m.type === 'tool_use').length
  const breakdown = formatToolBreakdown(summarizeToolCounts(messages))
  const baseSummary = isActive
    ? `Working... (${toolCount} tool${toolCount !== 1 ? 's' : ''})`
    : `${toolCount} tool${toolCount !== 1 ? 's' : ''} used`
  const summary = breakdown ? `${baseSummary} — ${breakdown}` : baseSummary

  const toggle = () => setExpanded((prev) => !prev)
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || (e.key === ' ' && !e.repeat)) {
      e.preventDefault()
      toggle()
    }
  }

  return (
    <div
      className={`tool-group${expanded ? ' expanded' : ''}${isActive ? ' active' : ''}`}
      data-testid="tool-group"
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={toggle}
      onKeyDown={handleKeyDown}
    >
      <div className="tool-group-header">
        {isActive && <span className="tool-group-pulse" aria-hidden="true" />}
        <span className="tool-group-summary">{summary}</span>
        <span className="tool-group-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      </div>
      {expanded && (
        <div className="tool-group-list" data-testid="tool-group-list">
          {messages.map((m) => (
            <ToolGroupEntry
              key={m.id}
              message={m}
              expanded={expandedEntryIds.has(m.id)}
              onToggle={toggleEntry}
            />
          ))}
        </div>
      )}
    </div>
  )
}
