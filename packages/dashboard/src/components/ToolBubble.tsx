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
import {
  formatToolName,
  getInputSummary,
  getPartialSummary,
  tryParseCompleteJson,
} from '@chroxy/store-core'
import type { ToolResultImage } from '@chroxy/store-core'
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
  /**
   * #4318: MCP server name from the wire message (`storeMsg.serverName`).
   * Forwarded to the shared `formatToolName` so MCP tools render with the
   * server prefix preserved — same source-of-truth used by the
   * ActivityIndicator chip and ToolGroup header.
   */
  serverName?: string
  /**
   * #4313 — when true, this bubble is the last item in the chat list
   * (a trailing singleton tool_use, not a multi-tool group). Mounted
   * expanded to match #4309 tail-group behavior. Initial-state only;
   * later flips do not retroactively re-collapse. See ToolGroup.tsx:181-187.
   */
  isTail?: boolean
  /**
   * #4317: tools can resolve with images-only (e.g. computer-use
   * screenshots, browser tools returning base64 PNGs) and leave
   * `result === undefined`. The pulse marker must treat that as
   * resolved — mirror the `hasResult` predicate used by ToolGroup
   * (#3794) and ActivityIndicator (#4311) so all three surfaces agree.
   */
  resultImages?: ToolResultImage[]
}

// #4243: `getInputSummary` and `getPartialSummary` now live in
// `@chroxy/store-core` so the mobile ToolBubble can derive the same
// collapsed-preview from the same field-priority extraction
// (`command` → `file_path` → `path` → `description`).
// #4242: `getPartialSummary` routes its parse through
// `tryParseCompleteJson` internally to amortise N-1 throws across a
// streaming `tool_input_delta` accumulator.
// #4318: `formatToolName` is the shared store-core helper too —
// previously this file had a local copy that ignored `serverName`, so
// MCP-tool headers could disagree with the ActivityIndicator chip.

// #4667 — AskUserQuestion's tool_input shape is internal: the dashboard
// already renders the structured question via the `user_question` event
// (QuestionPrompt card). Surfacing the raw `{"questions":[...` JSON tail
// in the collapsed summary or the expanded preview while the tool is
// streaming exposes implementation detail and gets visually reconciled
// against the proper card that lands moments later (two bubbles for the
// same prompt). Suppress both the summary and the partial-preview block
// for this tool — the bubble becomes a quiet placeholder with just the
// tool name + pulse marker until the structured card takes over. Matches
// option 1 in #4667 ("suppress tool_input_delta rendering for
// AskUserQuestion") and aligns with the precedent of other internal
// tools whose canonical render path is a dedicated card.
//
// Add a tool here only when BOTH conditions hold: (a) the dashboard
// already has a dedicated structured renderer for it (driven by a
// parallel event, the way `user_question` drives QuestionPrompt) AND
// (b) the tool_input shape carries no user-meaningful text on its own.
// "This shape looks ugly when rendered raw" is NOT sufficient — that's
// what #4655's generic key:value fallback in `tool-summary.ts` is for.
const SUPPRESS_RAW_INPUT_TOOLS = new Set(['AskUserQuestion'])

export function ToolBubble({ toolName, toolUseId, input, inputPartial, result, serverName, isTail = false, resultImages }: ToolBubbleProps) {
  // #4313 — tail bubbles mount expanded so the singleton trailing-tool
  // case matches the #4309 tail-group behavior. Initial-state only via
  // the lazy `useState` initializer.
  const [expanded, setExpanded] = useState(isTail)
  // #4317: a tool that resolved with images-only (no text) still leaves
  // `result === undefined`. Treat that as resolved so the pulse marker
  // hides — same shape as ToolGroup's `hasResult` and
  // ActivityIndicator's in-flight predicate. Without this the header
  // pulses forever for computer-use / screenshot tools.
  const hasResult = result !== undefined || (resultImages?.length ?? 0) > 0
  // #4667 — internal-shape tools (currently AskUserQuestion) must never
  // surface raw `tool_input` JSON in the chat surface; the structured
  // render path owns the display. Gate computed once so both the
  // collapsed summary and the expanded partial-preview branches stay
  // in sync.
  const suppressRawInput = SUPPRESS_RAW_INPUT_TOOLS.has(toolName)
  // #4081: prefer the structured `input` summary when present (server
  // gave us the full final input, e.g. via legacy non-streaming
  // providers or after `tool_result` lands). Otherwise fall back to the
  // streaming `inputPartial` accumulator: try a parse, and if that
  // fails (mid-stream partial JSON), show the raw tail so users still
  // see the field forming. The collapsed-state preview is what surfaces
  // Bash early-abort UX (#4063).
  // #4667 — short-circuit to '' for suppressed tools so the bubble
  // header carries just the tool name. The structured QuestionPrompt
  // card is the canonical render path.
  const summary = useMemo(() => {
    if (suppressRawInput) return ''
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
  }, [input, inputPartial, suppressRawInput])
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
  // #4667 — suppressed tools also skip the expanded partial-preview
  // block. The structured QuestionPrompt card carries the question
  // text + options; rendering raw JSON beside it produces the
  // double-bubble reconciliation problem this fix addresses.
  // #4667 (Copilot review) — gate on `hasResult`, not `result`, so a
  // tool that resolved with `result === ''` (resolved-with-no-output,
  // #4308) or images-only (#4317) is treated as done — matches the
  // pulse / ActivityIndicator predicate. Pre-fix this branch could
  // render the streaming preview for a tool that had already resolved.
  const partialPreview = useMemo(() => {
    if (!expanded || hasResult || !inputPartial || suppressRawInput) return null
    const parsed = tryParseCompleteJson(inputPartial)
    if (parsed !== undefined) {
      return { text: JSON.stringify(parsed, null, 2), parsed: true }
    }
    return { text: inputPartial, parsed: false }
  }, [expanded, hasResult, inputPartial, suppressRawInput])

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
      {/* #4308 — running marker: a pulse dot in the header when the tool
          has no result yet. Distinguishes an in-flight tool from a
          completed one at a glance; pre-fix the collapsed header looked
          identical in both states. Tested with `result === undefined`
          (not `!result`) so an empty-string result — a tool that
          finished with no output — does not render as in-flight.
          #4317 — also treat images-only resolutions as done so the
          pulse hides for computer-use / screenshot tools that return
          base64 PNGs and no text. */}
      {!hasResult && (
        <span
          className="tool-bubble-pulse"
          data-testid={`tool-bubble-pulse-${toolUseId}`}
          aria-hidden="true"
        />
      )}
      <span className="tool-name">{formatToolName(toolName, serverName)}</span>
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
          standard result view above.
          #4667 (Copilot review) — gate on `hasResult` rather than
          `result`, so a tool that resolved with empty-string result
          (#4308) or images-only (#4317) hides the streaming preview.
          `partialPreview` itself also gates on hasResult; this JSX
          gate is the belt-and-braces match. */}
      {expanded && !hasResult && partialPreview && (
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
