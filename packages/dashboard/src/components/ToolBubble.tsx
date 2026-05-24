/**
 * ToolBubble component — collapsible tool use card.
 *
 * Shows tool name + input summary. Clicking expands to show full result.
 *
 * #4139: TodoWrite results are surfaced as a structured checklist rather
 * than raw text. The TodoList component parses the executor's
 * `[ ] / [~] / [x] ... (id)` format back into items; on parse failure
 * (unknown format / future schema change) we fall back to the original
 * `<pre>` treatment so nothing is lost.
 *
 * #4081: `inputPartial` carries the running accumulator of every
 * `tool_input_delta` chunk for this tool_use. While streaming (no
 * `result` yet) we render it as a live code-block preview so long
 * inputs like Bash `command` are visible as they assemble — Bash early-
 * abort (#4063) needs this to surface `rm -rf` BEFORE the round
 * finishes. Once `result` arrives the bubble switches to the standard
 * result view; the partial buffer becomes informational only.
 *
 * Partial JSON mid-stream is inherently unparseable; we render
 * verbatim rather than throwing or rendering an error. When the chunk
 * happens to parse (e.g. final delta completes the JSON or the input
 * is one short chunk), we pretty-print it for legibility.
 */
import { useState, useMemo } from 'react'
import { getInputSummary, getPartialSummary } from '@chroxy/store-core'
import { TodoList, parseTodoList } from './TodoList'

export interface ToolBubbleProps {
  toolName: string
  toolUseId: string
  input?: Record<string, unknown> | string
  /**
   * #4081: running accumulator of `tool_input_delta` chunks for this
   * tool_use. May be unparseable JSON mid-stream — the renderer falls
   * back to verbatim text when JSON.parse throws.
   */
  inputPartial?: string
  result?: string
}

// #4243: `getInputSummary` and `getPartialSummary` now live in
// `@chroxy/store-core` so the mobile ToolBubble can derive the same
// collapsed-preview from the same field-priority extraction
// (`command` → `file_path` → `path` → `description`).
// #4242: `getPartialSummary` routes its parse through
// `tryParseCompleteJson` internally to amortise N-1 throws across a
// streaming `tool_input_delta` accumulator.

const capitalize = (word: string) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : '')

function formatToolName(name: string): string {
  const MCP_PREFIX = 'mcp__'
  if (name.startsWith(MCP_PREFIX)) {
    const withoutPrefix = name.slice(MCP_PREFIX.length)
    const sep = withoutPrefix.indexOf('__')
    if (sep > 0) {
      const server = withoutPrefix.slice(0, sep).split('_').filter(Boolean).map(capitalize).join(' ')
      const tool = withoutPrefix.slice(sep + 2).split('_').filter(Boolean).map(capitalize).join(' ')
      return tool ? `${server}: ${tool}` : server
    }
  }
  return name.split('_').filter(Boolean).map(capitalize).join(' ')
}

export function ToolBubble({ toolName, toolUseId, input, inputPartial, result }: ToolBubbleProps) {
  const [expanded, setExpanded] = useState(false)
  // #4081: prefer the structured `input` summary when present (server
  // gave us the full final input, e.g. via legacy non-streaming
  // providers or after `tool_result` lands). Otherwise fall back to the
  // streaming `inputPartial` accumulator: try a parse, and if that
  // fails (mid-stream partial JSON), show the raw tail so users still
  // see the field forming. The collapsed-state preview is what surfaces
  // Bash early-abort UX (#4063).
  const summary = useMemo(() => {
    const fromInput = getInputSummary(input)
    if (fromInput) return fromInput
    if (!inputPartial) return ''
    const parsed = getPartialSummary(inputPartial)
    if (parsed) return parsed
    // Mid-stream: render the verbatim head (first 100 chars) so the
    // user sees the JSON assembling from the start. Capped to keep the
    // collapsed bubble compact like the structured-summary path. We
    // show the head rather than the tail so the buffer's prefix
    // (\`{"command":"\` …) is always visible — the structurally-meaningful
    // start of the JSON document, not its still-arriving end.
    return inputPartial.slice(0, 100)
  }, [input, inputPartial])
  const resultId = `tool-result-${toolUseId}`
  // #4139: parse the TodoWrite result once and pass the result down,
  // rather than re-parsing inside TodoList (Copilot review on #4179).
  // Non-TodoWrite tools skip the parse entirely.
  const todoParsed = expanded && result && toolName === 'TodoWrite'
    ? parseTodoList(result)
    : null
  // #4081: streaming preview — render the accumulator as a code block
  // while the result hasn't arrived. Best-effort pretty-print: try
  // JSON.parse first (the final delta often completes the JSON), fall
  // back to verbatim text on parse failure. Only shown when expanded
  // AND we have no result yet — once `result` arrives the standard
  // result panel takes over.
  //
  // #4242: gate the parse behind `tryParseCompleteJson` — a chunk
  // whose tail isn't `}` or `]` can't be a complete document, so we
  // skip the parse + throw entirely on the N-1 mid-stream deltas.
  const partialPreview = useMemo(() => {
    if (!expanded || result || !inputPartial) return null
    const parsed = tryParseCompleteJson(inputPartial)
    if (parsed !== undefined) {
      return { text: JSON.stringify(parsed, null, 2), parsed: true }
    }
    return { text: inputPartial, parsed: false }
  }, [expanded, result, inputPartial])

  const toggle = () => setExpanded(prev => !prev)

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      toggle()
    } else if (e.key === ' ' && !e.repeat) {
      e.preventDefault()
      toggle()
    }
  }

  return (
    <div
      className={`tool-bubble${expanded ? ' expanded' : ''}`}
      data-testid={`tool-bubble-${toolUseId}`}
      data-tool-id={toolUseId}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      aria-controls={expanded && result ? resultId : undefined}
      onClick={toggle}
      onKeyDown={handleKeyDown}
    >
      <span className="tool-name">{formatToolName(toolName)}</span>
      {summary && (
        <span className="tool-input" data-testid="tool-input-summary" style={{ color: '#666' }}>
          {summary}
        </span>
      )}
      {expanded && result && (
        // #4139: click inside the result area must not bubble up to the
        // outer onClick that collapses the bubble — otherwise selecting
        // text or interacting with the checklist accidentally re-toggles.
        <div
          className="tool-result"
          id={resultId}
          onClick={(e) => e.stopPropagation()}
        >
          {todoParsed ? (
            <TodoList parsed={todoParsed} />
          ) : (
            <pre>{result}</pre>
          )}
        </div>
      )}
      {/* #4081: streaming preview — shown only while expanded AND no
          result yet. The `tool_input_delta` accumulator renders as a
          code block; unparseable mid-stream JSON renders verbatim
          (NOT as an error). Result arrival flips the bubble to the
          standard result view above. */}
      {expanded && !result && partialPreview && (
        <div
          className="tool-input-partial"
          data-testid={`tool-input-partial-${toolUseId}`}
          data-parsed={partialPreview.parsed ? 'true' : 'false'}
          onClick={(e) => e.stopPropagation()}
        >
          <pre>{partialPreview.text}</pre>
        </div>
      )}
    </div>
  )
}
