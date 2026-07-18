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
import { useState, useEffect, useRef, useContext } from 'react'
import type { ChatMessage } from '@chroxy/store-core'
import {
  summarizeToolCounts,
  formatToolBreakdown,
  formatToolName,
  tryParseCompleteJson,
  getInputSummary,
  shouldSuppressRawToolInput,
} from '@chroxy/store-core'
import { ChildAgentEventList } from './ChildAgentEventList'
import { ImageLightbox } from './ImageLightbox'
import { ChatExpandContext, useInitialExpanded } from './chatExpandRegistry'

export interface ToolGroupProps {
  messages: ChatMessage[]
  isActive: boolean
  // #4305 — when true, the group is the last item in the chat list and has
  // no follow-up assistant text summarizing it. Skips the on-completion
  // auto-collapse so trailing tool runs stay visible (matching the Output
  // tab's chronology) until the user explicitly collapses them.
  isTail?: boolean
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
    // #4282: the outer .tool-group container is no longer interactive
    // (the header button is the only toggle target), so a click on the
    // Thinking row has nothing to bubble into and the previous
    // stopPropagation swallow is redundant. Render the row as a plain
    // non-interactive label.
    return (
      <div
        className="tool-group-entry tool-group-entry--thinking"
        data-testid={`tool-group-entry-${message.id}`}
      >
        <span className="tool-group-entry-name">Thinking</span>
      </div>
    )
  }
  const toolName = formatToolName(message.tool ?? 'Tool', message.serverName)
  // #4667 / #5770 — internal-shape tools (currently AskUserQuestion) must
  // never surface raw `tool_input` in the chat surface; a dedicated
  // structured card (QuestionPrompt, driven by the parallel `user_question`
  // event) owns the display. ToolBubble already gates this; the grouped-entry
  // path must too, or the raw `{"questions":[...` JSON streamed via
  // `tool_input_delta` leaks into the expanded detail panel beside the card
  // (the #5770 claude-tui leak — an AskUserQuestion sharing a turn with
  // another tool takes the ToolGroup path, not the singleton ToolBubble).
  // Shared suppress set lives in @chroxy/store-core so the two paths can't
  // drift.
  const suppressRawInput = shouldSuppressRawToolInput(message.tool)
  const summary = suppressRawInput ? '' : getInputSummary(message.toolInput)
  // `toolResult` is set to the server's result string by handleToolResult,
  // including the empty string when the tool produced no output. A bare
  // truthiness check (`!!toolResult`) wrongly classifies an empty result
  // as pending; presence-check covers all non-pending shapes (#3794 review).
  const hasResult =
    message.toolResult !== undefined ||
    (message.toolResultImages?.length ?? 0) > 0
  // #6712: a failed tool_result (codex mcpToolCall / orphan sweep) gets an error
  // marker + entry class so the renderer can tint it distinctly from a success.
  const resultIsError = hasResult && message.toolResultIsError === true
  const markerState = resultIsError ? 'error' : hasResult ? 'complete' : 'pending'
  const markerClass = `tool-group-entry-marker tool-group-entry-marker--${markerState}`

  // #4279 / #4282: the parent group's toggle now lives on a dedicated
  // header <button> that is a SIBLING of the entry list — not an ancestor
  // — so DOM bubbling from a row click can never reach it. We keep
  // stopPropagation as defensive insulation against any future ancestor
  // adding a click/keydown handler that would otherwise see entry events,
  // but it is no longer load-bearing for the per-entry expand flow.
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

  // #4667 / #5770 — suppressed tools skip BOTH the structured and the
  // streaming partial detail so the expanded panel shows "(no input)"
  // instead of leaking the raw JSON. The QuestionPrompt card is the
  // canonical render path.
  const structuredInputDetail = suppressRawInput ? '' : formatInputForDetail(message.toolInput)
  // #4341: fall through to the streaming `toolInputPartial` accumulator
  // when the structured `toolInput` is empty. Pre-fix the expanded panel
  // showed "(no input)" for in-flight Agent/Task tools even though
  // `tool_input_delta` chunks were piling into `toolInputPartial` —
  // ToolBubble had already closed this gap for the collapsed summary
  // (#4081), so the expanded view now mirrors the same fallback.
  // `isStreamingInput` flags the panel as still arriving so styling can
  // hint at the in-flight state (data-streaming="true").
  const partialInputDetail = (structuredInputDetail || suppressRawInput)
    ? ''
    : formatPartialForDetail(message.toolInputPartial)
  const inputDetail = structuredInputDetail || partialInputDetail
  const isStreamingInput = !structuredInputDetail && partialInputDetail !== ''
  const resultDetail = message.toolResult ?? ''
  // Distinguish "tool finished with empty output" from "tool still running".
  // hasResult covers both toolResult presence and image results.
  const resultPlaceholder = hasResult ? '(no result)' : '(no result yet)'
  // #6755 — images-only tool results (computer-use screenshots, browser
  // tools returning base64 PNGs) previously rendered "Result: (no result)"
  // in this panel because `resultDetail` was empty and there was nowhere
  // else for the image data to go. `hasImages` drives a dedicated Images
  // section below; `showResultText` suppresses the now-redundant "(no
  // result)" placeholder specifically for the images-only case (pending
  // and text-bearing results still show the Result section as before).
  const hasImages = (message.toolResultImages?.length ?? 0) > 0
  const hasTextResult = message.toolResult !== undefined && message.toolResult !== ''
  const showResultText = !hasResult || hasTextResult || !hasImages
  // #6755 — full-resolution click-to-zoom, same pattern as ToolBubble:
  // store the INDEX (not the data URI) so the lightbox label can read
  // "Image N of M".
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const lightboxImage = lightboxIndex != null ? message.toolResultImages?.[lightboxIndex] : undefined
  const lightboxUri = lightboxImage ? `data:${lightboxImage.mediaType};base64,${lightboxImage.data}` : null
  const lightboxLabel =
    message.toolResultImages && message.toolResultImages.length > 1 && lightboxIndex != null
      ? `Image ${lightboxIndex + 1} of ${message.toolResultImages.length}`
      : 'Image'

  return (
    <div
      className={`tool-group-entry${expanded ? ' tool-group-entry--expanded' : ''}${resultIsError ? ' tool-group-entry--error' : ''}`}
      data-testid={`tool-group-entry-${message.id}`}
      data-error={resultIsError ? 'true' : undefined}
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
          {resultIsError ? '✕' : hasResult ? '✓' : '›'}
        </span>
        {/* #6712: the marker is aria-hidden, so surface the failure to AT. */}
        {resultIsError && <span className="sr-only">tool failed</span>}
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
          {showResultText && (
            <div className="tool-group-entry-detail-section">
              <div className="tool-group-entry-detail-label">Result</div>
              <pre className="tool-group-entry-detail-content">
                {resultDetail || resultPlaceholder}
              </pre>
            </div>
          )}
          {/* #6755 — images-only tool results (computer-use screenshots,
              browser tools returning base64 PNGs) render a thumbnail grid
              here instead of the "Result: (no result)" placeholder above
              (suppressed via `showResultText`). Click a thumbnail to open
              the full-resolution lightbox. */}
          {hasImages && (
            <div className="tool-group-entry-detail-section">
              <div className="tool-group-entry-detail-label">
                {message.toolResultImages!.length === 1 ? 'Image' : `Images (${message.toolResultImages!.length})`}
              </div>
              <div className="tool-result-images" data-testid={`tool-group-entry-images-${message.id}`}>
                {message.toolResultImages!.map((img, i) => (
                  <button
                    key={i}
                    type="button"
                    className="tool-result-image-btn"
                    data-testid={`tool-group-entry-image-${message.id}-${i}`}
                    onClick={() => setLightboxIndex(i)}
                    aria-haspopup="dialog"
                    aria-label={
                      message.toolResultImages!.length > 1
                        ? `View image ${i + 1} of ${message.toolResultImages!.length}`
                        : 'View image'
                    }
                  >
                    <img
                      src={`data:${img.mediaType};base64,${img.data}`}
                      alt=""
                      className="tool-result-image-thumb"
                      loading="lazy"
                      decoding="async"
                    />
                  </button>
                ))}
              </div>
            </div>
          )}
          {/* #5016 — Task subagent nested progress in grouped-entry view.
              When this entry is a Task tool_use whose subagent emitted
              intermediate events, surface them here so the user sees the
              same nested rendering as the singleton-bubble path. */}
          {message.childAgentEvents && message.childAgentEvents.length > 0 && message.toolUseId && (
            <div className="tool-group-entry-detail-section">
              <div className="tool-group-entry-detail-label">Subagent</div>
              <ChildAgentEventList
                events={message.childAgentEvents}
                parentToolUseId={message.toolUseId}
              />
            </div>
          )}
        </div>
      )}
      <ImageLightbox uri={lightboxUri} onClose={() => setLightboxIndex(null)} label={lightboxLabel} />
    </div>
  )
}

export function ToolGroup({ messages, isActive, isTail = false }: ToolGroupProps) {
  // #5561 — id-keyed expand registry (mobile #5534 parity). The group is keyed
  // by its first message id; under ChatView virtualization the whole group can
  // unmount when scrolled out, so the group-level toggle AND each entry's
  // toggle persist here and re-seed on remount. Outside a provider the registry
  // is a no-op (pre-#5561 behaviour).
  const groupKey = `group:${messages[0]?.id ?? 'empty'}`
  const expandRegistry = useContext(ChatExpandContext)
  // Auto-collapse on completion: expand while active, collapse when the
  // run ends. Subsequent expand state lives in component state so a user
  // who toggled stays toggled until the run lifecycle flips again.
  // #4305 — tail groups (no follow-up summary) start expanded and skip
  // the on-completion collapse, so trailing tools remain visible.
  // #5561 — seed from the registry first so a recycled group reopens to the
  // user's last choice; fall back to the lifecycle default the first time the
  // group is ever seen.
  const { initial: initialExpanded, persist: persistGroupExpanded } = useInitialExpanded(
    groupKey,
    isActive || isTail,
  )
  const [expanded, setExpanded] = useState(initialExpanded)
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
    // #5561 — mirror lifecycle-driven group expand flips into the registry so a
    // remount during the same run re-seeds the correct (current) state, not the
    // first-seen default.
    if (wasActiveRef.current && !isActive) {
      if (!wasTailRef.current) { setExpanded(false); persistGroupExpanded(false) }
    }
    if (!wasActiveRef.current && isActive) { setExpanded(true); persistGroupExpanded(true) }
    wasActiveRef.current = isActive
    // persistGroupExpanded is now genuinely stable (memoized in
    // useInitialExpanded on the registry ref + key), so it can be listed
    // honestly — its identity never changes for this group, so adding it does
    // not re-fire the effect. isActive remains the real trigger.
  }, [isActive, persistGroupExpanded])

  // #4279: per-entry expansion state lives here so multiple entries can be
  // open simultaneously and the parent group's expand/collapse logic doesn't
  // touch entry state. We track open entries in a Set keyed by message id —
  // toggling an entry flips its membership.
  // #5561 — seed the open-entry set from the registry on mount so a recycled
  // group reopens the same entries the user had open. Entry flags are
  // namespaced `entry:<id>` so they never collide with a sibling row's own id.
  const [expandedEntryIds, setExpandedEntryIds] = useState<Set<string>>(() => {
    const seeded = new Set<string>()
    for (const m of messages) {
      if (expandRegistry.get(`entry:${m.id}`)) seeded.add(m.id)
    }
    return seeded
  })
  const toggleEntry = (id: string) => {
    setExpandedEntryIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) { next.delete(id); expandRegistry.set(`entry:${id}`, false) }
      else { next.add(id); expandRegistry.set(`entry:${id}`, true) }
      return next
    })
  }

  const toolCount = messages.filter((m) => m.type === 'tool_use').length
  const breakdown = formatToolBreakdown(summarizeToolCounts(messages))
  const baseSummary = isActive
    ? `Working... (${toolCount} tool${toolCount !== 1 ? 's' : ''})`
    : `${toolCount} tool${toolCount !== 1 ? 's' : ''} used`
  const summary = breakdown ? `${baseSummary} — ${breakdown}` : baseSummary

  const toggle = () => setExpanded((prev) => {
    const next = !prev
    persistGroupExpanded(next)
    return next
  })

  // #4282: the outer container is a plain non-interactive <div>. The
  // group's expand/collapse toggle lives on a real <button> header, and
  // the entry rows are interactive siblings of that button — no more
  // nested interactive roles, no more <button>-inside-<button> ARIA
  // violation, and no more click bubbling from a row into a parent
  // toggle (so the stopPropagation calls in ToolGroupEntry become
  // defensive insulation rather than load-bearing). data-testid +
  // aria-expanded remain on the root so existing tests / a11y tooling
  // that inspect the group as a whole still see the state, and
  // aria-expanded is mirrored on the header button so AT also hears the
  // state when focus lands on the toggle itself. Keyboard activation
  // (Enter/Space) is handled natively by the <button> — no custom
  // onKeyDown is required.
  return (
    <div
      className={`tool-group${expanded ? ' expanded' : ''}${isActive ? ' active' : ''}`}
      data-testid="tool-group"
      aria-expanded={expanded}
    >
      <button
        type="button"
        className="tool-group-header"
        data-testid="tool-group-header"
        aria-expanded={expanded}
        onClick={toggle}
      >
        {isActive && <span className="tool-group-pulse" aria-hidden="true" />}
        <span className="tool-group-summary">{summary}</span>
        <span className="tool-group-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      </button>
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
