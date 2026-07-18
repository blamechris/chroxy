/**
 * ChatView — scrollable message list with auto-scroll and thinking indicator.
 *
 * Ports auto-scroll logic from dashboard-app.js (lines 449-460):
 * - Detects user scroll-up, pauses auto-scroll
 * - Shows scroll-to-bottom button when scrolled up
 * - Deduplicates messages by id for reconnect replay
 *
 * #5561 — the message list is windowed (virtualized) above a row-count
 * threshold. Long sessions previously mapped the ENTIRE deduped array to the
 * DOM (the responsiveness wall the issue names); now only the rows intersecting
 * the viewport (plus a small overscan) mount, with top/bottom spacer divs
 * preserving scroll geometry. Below the threshold every row renders exactly as
 * before — no behaviour change for short histories. Mirrors the mobile #5534
 * patterns: pinned-to-bottom while streaming, scroll position preserved when
 * scrolled up, and an id-keyed expand registry so tool-bubble expand state
 * survives a row scrolling out of and back into the window.
 */
import { memo, useRef, useState, useCallback, useEffect, useLayoutEffect, useMemo, type ReactNode, type CSSProperties } from 'react'
import { bumpRenderCount, type ChatActivityState, type MessageAttachment } from '@chroxy/store-core'
import { WorkingIndicator } from './WorkingIndicator'
import { renderMarkdown } from '../lib/markdown'
import { handleMarkdownBodyClick } from '../lib/codeCopy'
import { CopyButton } from './CopyButton'
import { isRenderableImageUri } from '../utils/attachment-preview'
import { MessageRowShell } from './MeasuredRow'
import { ChatExpandContext, type ChatExpandRegistry } from './chatExpandRegistry'
import { useWindowedRange } from './useWindowedRange'

/* ---- Sender Icons ---- */

const iconCircle: CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: '50%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  fontSize: 13,
  lineHeight: 1,
}

/** Sparkle icon for assistant messages */
function AssistantIcon() {
  return (
    <span
      className="sender-icon sender-icon-assistant"
      style={{ ...iconCircle, background: 'var(--accent-blue-subtle, rgba(96, 165, 250, 0.15))', color: 'var(--accent-blue, #60a5fa)' }}
      aria-hidden="true"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2L14.09 8.26L20 9.27L15.55 13.97L16.91 20L12 16.9L7.09 20L8.45 13.97L4 9.27L9.91 8.26L12 2Z" />
      </svg>
    </span>
  )
}

/** User silhouette icon for user messages */
function UserIcon() {
  return (
    <span
      className="sender-icon sender-icon-user"
      style={{ ...iconCircle, background: 'var(--accent-green-subtle, rgba(74, 222, 128, 0.15))', color: 'var(--accent-green, #4ade80)' }}
      aria-hidden="true"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z" />
      </svg>
    </span>
  )
}

/** Gear icon for system messages */
function SystemIcon() {
  return (
    <span
      className="sender-icon sender-icon-system"
      style={{ ...iconCircle, background: 'var(--bg-secondary, rgba(148, 163, 184, 0.15))', color: 'var(--text-dim, #94a3b8)' }}
      aria-hidden="true"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
        <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 00-.48-.41h-3.84a.48.48 0 00-.48.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 00-.59.22L2.74 8.87a.48.48 0 00.12.61l2.03 1.58c-.05.3-.07.63-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.26.41.48.41h3.84c.24 0 .44-.17.48-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1112 8.4a3.6 3.6 0 010 7.2z" />
      </svg>
    </span>
  )
}

/** Returns the appropriate icon for a message type, or null if none needed */
function senderIconFor(type: string): ReactNode | null {
  switch (type) {
    case 'response': return <AssistantIcon />
    case 'user_input': return <UserIcon />
    case 'system': return <SystemIcon />
    default: return null
  }
}

export interface ChatViewMessage {
  id: string
  /**
   * Discriminator for rendering. `tool_group` (#3747) is a synthetic type
   * emitted by the App.tsx grouping pass — it has no store-side equivalent
   * and is always rendered through the `renderMessage` callback.
   */
  type: 'response' | 'user_input' | 'system' | 'error' | 'thinking' | 'tool_use' | 'tool_group'
  content: string
  timestamp: number
  isStreaming?: boolean
  /**
   * #4476: structured error code mirrored from the store ChatMessage.
   * Renderers may switch on this to surface a distinct variant for known
   * error categories (e.g. `'stream_stall'` → chip + retry). Undefined
   * for legacy errors without a structured code.
   */
  code?: string
  /** #6632: attachments on a user_input message, for transcript previews. */
  attachments?: MessageAttachment[]
}

export interface ChatViewProps {
  messages: ChatViewMessage[]
  isStreaming: boolean
  /** Show thinking indicator during pre-streaming busy state */
  isBusy?: boolean
  /**
   * Chat redesign #6392 (presence rail): the canonical chat-activity state
   * ('idle'|'thinking'|'busy'|'waiting'|'error') from store-core's
   * `deriveChatActivity`. Drives the colour + motion of the left-edge presence
   * rail via a `data-activity-state` attribute — the same wiring the Phase 1
   * composer hairline uses. Undefined → the rail stays idle (neutral).
   */
  chatActivityState?: ChatActivityState
  /** #6392 — a `var(--token)` colour (from the shared tool-presentation registry)
   *  for the presence rail when a tool is mid-flight, so the rail reflects WHICH
   *  tool is running. undefined → the rail keeps its activity-state colour. */
  inFlightToolColor?: string
  /** Optional custom renderer. Return a node to override default rendering, or null to fall back. */
  renderMessage?: (msg: ChatViewMessage) => ReactNode | null
  /**
   * #4398 — when true, the ChatView is mounted but hidden via a parent
   * `display:none` wrapper (sibling-tab kept-alive pattern from #4305).
   * The memo wrapper below uses this flag to skip re-renders entirely
   * while hidden: parent prop changes from store updates won't trigger
   * markdown re-parsing or renderMessage invocations. On the first render
   * after `hidden` flips back to false, React applies the latest props
   * in a single batch, so user-visible state is up-to-date instantly.
   *
   * Hook-local state (`userScrolledUp`, scroll position, child
   * `ToolGroup`/`ToolBubble` expand state) is preserved across the
   * hidden window because the component instance never unmounts.
   */
  hidden?: boolean
  /**
   * #5780 — monotonically-increasing nonce the parent bumps when the user
   * performs an explicit "jump to the latest" action. Today that is sending a
   * message; wiring approve/answer flows is tracked in #5786. Unlike the
   * count-change auto-follow — which deliberately leaves a scrolled-up reader in place —
   * a bump here ALWAYS snaps the view to the bottom and clears
   * `userScrolledUp`, because the user just acted on the conversation and
   * expects to see their input plus the incoming response. A nonce (rather
   * than an imperative ref handle) keeps ChatView's memo wrapper intact and
   * is robust to rapid sends: each distinct value fires the effect exactly
   * once. The initial value is ignored (the mount effect already lands at
   * the bottom); only changes trigger a scroll.
   */
  scrollToBottomSignal?: number
  /**
   * #5939 (epic #5935 ④): ids of `user_input` messages currently held in the
   * server's outgoing queue (send-while-busy). A row whose id is in this set
   * renders a "Queued" badge + a cancel affordance instead of a plain sent
   * bubble; the badge clears when the id leaves the set (flush / cancel /
   * interrupt). A `Set` of scalars keeps the per-row prop a stable boolean so
   * the row memo still skips unaffected rows.
   */
  queuedIds?: ReadonlySet<string>
  /** #5939: cancel a single queued follow-up by its message id (cancel_queued). */
  onCancelQueued?: (id: string) => void
  /**
   * #5953 (epic #5951): label for the in-chat "Claude is working" indicator
   * shown at the streaming tail. The parent derives it from the active session's
   * in-flight tool ("Running Bash…") or passes nothing for the generic default
   * ("Claude is working…"). A stable string so it doesn't churn per token.
   */
  workingLabel?: string
}

const TYPE_CLASS: Record<string, string> = {
  response: 'assistant',
  user_input: 'user',
  system: 'system',
  error: 'error',
  thinking: 'thinking',
  tool_use: 'tool',
}

/**
 * #5780 — "near the bottom" tolerance (px). A new incoming message/tool result
 * auto-follows ONLY when the viewport is within this distance of the bottom, so
 * a user who has scrolled up to read history keeps their position. Widened from
 * 60 to 100 to match the standard chat affordance (a small manual nudge off the
 * very bottom still counts as "following the conversation").
 */
const SCROLL_THRESHOLD = 100

/**
 * #5561 — fallback `gap` between rows in `.chat-messages` (theme/components.css).
 * Folded into the windowing height math so the spacer heights match the real
 * scroll geometry. The live value is read from `getComputedStyle().rowGap` at
 * runtime (it drops to 8px under the narrow-viewport media query in
 * components.css), so this constant is only the fallback used when computed
 * style is unavailable (jsdom) or unparseable. Keep in sync with the CSS base
 * rule (`.chat-messages { gap: 12px }`).
 */
const CHAT_MESSAGES_ROW_GAP = 12

/**
 * Read the live row gap (px) from the scroll container's computed style so the
 * windowing math tracks the responsive `.chat-messages` gap (12px desktop / 8px
 * narrow). Falls back to {@link CHAT_MESSAGES_ROW_GAP} when computed style is
 * unavailable (jsdom returns `''`) or yields a non-finite value.
 */
function readRowGap(el: HTMLElement | null): number {
  if (!el || typeof getComputedStyle !== 'function') return CHAT_MESSAGES_ROW_GAP
  const raw = getComputedStyle(el).rowGap
  const parsed = parseFloat(raw)
  return Number.isFinite(parsed) ? parsed : CHAT_MESSAGES_ROW_GAP
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  let h = d.getHours()
  const m = d.getMinutes().toString().padStart(2, '0')
  const ampm = h >= 12 ? 'PM' : 'AM'
  h = h % 12 || 12
  return `${h}:${m} ${ampm}`
}

const IS_DEV = typeof import.meta !== 'undefined' && Boolean(import.meta.env?.DEV)

/**
 * #5516 (epic #5514): the default (non-renderMessage) message row, extracted
 * into a memoized component so a streaming delta flush only re-runs the
 * markdown parse (`renderMarkdown`) for the ONE message whose content changed.
 *
 * Before #5516 every store update re-ran the whole `dedupedMessages.map`,
 * calling `renderMarkdown(msg.content)` inline for EVERY response/tool_use row
 * — an O(conversation) markdown re-parse ~10×/sec while streaming. By keying
 * the memo on the render-affecting scalars (id/type/content/timestamp), only
 * the tail bubble (whose content is appended each flush) re-parses; the rest of
 * the transcript is skipped entirely. The store hands each row a fresh object
 * per render, so a shallow scalar compare — not reference equality — is what
 * makes the skip fire.
 */
/** Row container class for a message type (was computed inline in the map). */
function rowClassFor(type: string, hasIcon: boolean): string {
  if (type === 'user_input') return 'msg-row msg-row-user'
  if (type === 'system') return 'msg-row msg-row-system'
  return hasIcon ? 'msg-row' : ''
}

/**
 * Chat redesign #6391 (slice 6): thinking renders as a quiet, collapsed
 * disclosure instead of a standing wall of reasoning text — "▸ Thinking…" while
 * it streams, "▸ Thought" once done; click reveals the full reasoning. (The
 * "thought for Ns" duration/token stat is deferred — it needs a thinking
 * start/end the client doesn't carry yet.) The row's MeasuredRow ResizeObserver
 * re-measures on toggle, so the virtualized list stays correct.
 */
function ThinkingBody({ content, streaming }: { content: string; streaming: boolean }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="thinking-body">
      <button
        type="button"
        className="thinking-toggle"
        data-testid="thinking-toggle"
        aria-expanded={expanded}
        onClick={(e) => {
          e.stopPropagation()
          setExpanded(v => !v)
        }}
      >
        {expanded ? '▾' : '▸'} {streaming ? 'Thinking…' : 'Thought'}
      </button>
      {expanded && <div className="thinking-full">{content}</div>}
    </div>
  )
}

const DefaultMessageRow = memo(function DefaultMessageRow({
  id,
  type,
  content,
  timestamp,
  isStreaming,
  attachments,
  queued,
  onCancelQueued,
  queuePosition,
}: {
  id: string
  type: ChatViewMessage['type']
  content: string
  timestamp: number
  isStreaming?: boolean
  /** #6632: user-message attachments (images/documents) to preview. */
  attachments?: ChatViewMessage['attachments']
  /** #5939: this user_input is held in the server's outgoing queue. */
  queued?: boolean
  /** #5939: cancel this queued follow-up (stable callback from ChatView). */
  onCancelQueued?: (id: string) => void
  /** #6392: 1-based send position among queued follow-ups, shown only when more
   *  than one is queued (so a lone queued message stays a plain "Queued"). */
  queuePosition?: number
}) {
  // Dev-only render tally — proves (in the memoization test + ad-hoc
  // profiling) non-tail rows don't re-render on a delta flush. Never read on
  // the hot path.
  if (IS_DEV) bumpRenderCount(`ChatMessageRow:${id}`)

  // Derive icon from `type` INSIDE the memo. Computing it in the parent map
  // would hand the memo a fresh `icon` JSX element identity every render and
  // defeat the skip — every prop must be a stable scalar. The outer `.msg-row`
  // container (class + data-testid) is now rendered by ChatView's row shell
  // (`MessageRowShell`, #5561) so the measurement ResizeObserver can attach to
  // the same element that carries the flex layout; this memo renders only the
  // inner content.
  const icon = senderIconFor(type)

  const body =
    type === 'response' || type === 'tool_use'
      // #6625: modifier-click opens a rendered link; plain click keeps selection.
      // #6793: same container also owns the per-code-block copy button click.
      ? <div onClick={handleMarkdownBodyClick} dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
      : type === 'thinking'
        ? <ThinkingBody content={content} streaming={!!isStreaming} />
        : content

  return (
    <>
      {type !== 'user_input' && icon}
      <div className={`msg ${TYPE_CLASS[type] || 'assistant'}${isStreaming ? ' streaming' : ''}${queued ? ' queued' : ''}`}>
        {/* #6631: a subtle copy control on assistant responses (not while still
            streaming — copy the finished text). Room for future per-response
            actions alongside it. */}
        {type === 'response' && !isStreaming && content.trim() !== '' && <CopyButton content={content} />}
        {body}
        {/* #6632: preview what the user attached — image thumbnails (only for a
            renderable, safe image URI), otherwise a filename chip. A resumed
            session's stripped `data:` URI, or a non-image document, falls back to
            the chip so the user still sees WHAT was attached. */}
        {type === 'user_input' && attachments && attachments.length > 0 && (
          <div className="msg-attachments" data-testid={`msg-attachments-${id}`}>
            {attachments.map((att) =>
              att.type === 'image' && isRenderableImageUri(att.uri) ? (
                <img
                  key={att.id}
                  className="msg-attachment-image"
                  src={att.uri}
                  alt={att.name}
                  title={att.name}
                  loading="lazy"
                  decoding="async"
                  data-testid={`msg-attachment-image-${att.id}`}
                />
              ) : (
                <span key={att.id} className="msg-attachment-doc" title={att.name} data-testid={`msg-attachment-doc-${att.id}`}>
                  <span aria-hidden="true">{att.type === 'image' ? '🖼' : '📄'}</span> {att.name}
                </span>
              ),
            )}
          </div>
        )}
        {queued && (
          <span className="msg-queued" data-testid={`msg-queued-${id}`}>
            <span className="msg-queued-label">Queued</span>
            {queuePosition != null && (
              <span className="msg-queued-position" data-testid={`msg-queued-position-${id}`}>#{queuePosition}</span>
            )}
            {onCancelQueued && (
              <button
                type="button"
                className="msg-queued-cancel"
                aria-label="Cancel queued message"
                title="Cancel queued message"
                data-testid={`msg-queued-cancel-${id}`}
                onClick={() => onCancelQueued(id)}
              >
                ✕
              </button>
            )}
          </span>
        )}
        {timestamp > 0 && <span className="msg-timestamp">{formatTime(timestamp)}</span>}
      </div>
      {type === 'user_input' && icon}
    </>
  )
})

function ChatViewImpl({ messages, isStreaming, isBusy, chatActivityState, inFlightToolColor, renderMessage, scrollToBottomSignal, queuedIds, onCancelQueued, workingLabel }: ChatViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  // #6392 — 1-based send position for each queued follow-up, derived from the
  // ordered `messages` (queuedIds is an unordered Set). Only built when 2+ are
  // queued, so a single queued message stays a plain "Queued" (no "#1").
  const queuePositions = useMemo(() => {
    if (!queuedIds || queuedIds.size < 2) return null
    const positions = new Map<string, number>()
    let n = 0
    for (const m of messages) {
      if (queuedIds.has(m.id)) positions.set(m.id, ++n)
    }
    return positions
  }, [messages, queuedIds])

  const [userScrolledUp, setUserScrolledUp] = useState(false)
  const programmaticScrollRef = useRef(false)
  // #5954 — a ref mirror of `userScrolledUp` so the ResizeObserver callback can
  // read the live follow-state without re-subscribing the observer every time
  // the user crosses the bottom threshold. Kept in sync by the effect below.
  const userScrolledUpRef = useRef(false)

  // #5561 — scroll-anchor compensation state. WKWebView (the Tauri desktop's
  // engine, and the dashboard's PRIMARY consumer) does NOT implement default
  // CSS scroll anchoring (no `overflow-anchor` support), so when a height-cache
  // correction changes the height of content ABOVE the viewport, the browser
  // does NOT keep the visible rows pinned the way Blink/Gecko would — the
  // content visibly jumps. We compensate by hand: track the windowing anchor
  // (the first visible row + its content-space top offset) and, when that
  // offset shifts for the SAME anchor row, add the delta back to `scrollTop`
  // before paint (useLayoutEffect). See the compensation effect below.
  const anchorRef = useRef<{ index: number; offset: number } | null>(null)
  // The scrollTop value we just wrote during compensation. The resulting
  // `scroll` event must NOT be treated as a user scroll (it would otherwise
  // re-seed `scrollTop` state with a value the next render's anchor math has
  // already accounted for, and could flip `userScrolledUp`). The handler clears
  // this once it sees the matching offset — an expected-scrollTop guard against
  // a compensation→scroll→recompute feedback loop.
  const expectedScrollTopRef = useRef<number | null>(null)

  // #5561 — scroll/viewport geometry that drives the windowing hook. Kept in
  // state (not just the DOM) so a scroll or resize recomputes the visible
  // range. Seeded to 0 and synced on mount + every scroll/resize.
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  // #5561 — live row gap from the container's computed style, re-read on resize
  // (the same geometry sync that tracks viewport height) so the windowing math
  // follows the responsive `.chat-messages` gap instead of a hard-coded 12px.
  const [rowGap, setRowGap] = useState(CHAT_MESSAGES_ROW_GAP)

  // Deduplicate by id — keep first occurrence
  const dedupedMessages = useMemo(() => {
    const seen = new Set<string>()
    return messages.filter(m => {
      if (seen.has(m.id)) return false
      seen.add(m.id)
      return true
    })
  }, [messages])

  // #5561 — id-keyed expand-state registry (mirror of mobile #5534). Lives in a
  // ref so a tool bubble persisting its expand flag never re-renders ChatView;
  // a row that scrolled out and back re-reads its flag on remount via
  // `useInitialExpanded`. The Provider value is memoized so the context
  // identity is stable across renders.
  const expandedStateRef = useRef<Map<string, boolean>>(new Map())
  const expandRegistry = useMemo<ChatExpandRegistry>(
    () => ({
      get: (key) => expandedStateRef.current.get(key),
      set: (key, expanded) => {
        if (expanded) expandedStateRef.current.set(key, true)
        else expandedStateRef.current.delete(key)
      },
    }),
    [],
  )

  // #5561 — stable per-row key lookup for the height cache. Rows key by message
  // id (the dedup pass already guarantees uniqueness), matching the React
  // `key` used in the map so a row's measured height tracks the row, not its
  // index, across windowing churn.
  const keyAt = useCallback(
    (index: number) => dedupedMessages[index]?.id ?? `__row_${index}`,
    [dedupedMessages],
  )

  const range = useWindowedRange({
    itemCount: dedupedMessages.length,
    scrollTop,
    viewportHeight,
    // Live `.chat-messages` row gap (12px desktop / 8px narrow), re-read on
    // resize via syncGeometry, so the windowing spacers reserve the same total
    // height the real responsive flex column occupies (rows + inter-row gaps).
    rowGap,
    keyAt,
  })

  const syncGeometry = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    // Functional updates that bail when unchanged — a no-op sync (e.g. the
    // mount sync in jsdom where scrollTop/clientHeight are both 0) must not
    // schedule a spurious re-render. This keeps the #4398 hidden-memoization
    // contract (renderMessage invoked exactly once on first mount) intact.
    setScrollTop(prev => (prev === el.scrollTop ? prev : el.scrollTop))
    setViewportHeight(prev => (prev === el.clientHeight ? prev : el.clientHeight))
    // Re-read the responsive row gap from computed style — a viewport resize can
    // cross the narrow-viewport media query and flip 12px↔8px. Same bail-when-
    // unchanged pattern so a no-op sync doesn't churn a re-render.
    const liveGap = readRowGap(el)
    setRowGap(prev => (prev === liveGap ? prev : liveGap))
  }, [])

  const handleScroll = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    // #5561 — ignore the synthetic `scroll` event our own compensation write
    // produced. `el.scrollTop` already equals the value the layout effect set,
    // and the anchor math that produced it is consistent with the current
    // `scrollTop` state, so re-seeding state (or re-evaluating `userScrolledUp`)
    // here would either be a no-op churn or, worse, feed the delta back in.
    if (expectedScrollTopRef.current !== null && Math.abs(el.scrollTop - expectedScrollTopRef.current) < 1) {
      expectedScrollTopRef.current = null
      return
    }
    // A real user scroll invalidates any pending expected value.
    expectedScrollTopRef.current = null
    // #5561 — feed the windowing hook the live scroll offset so the visible
    // slice tracks the viewport. clientHeight is stable per scroll but cheap
    // to read here, keeping the range correct if a scroll coincides with a
    // layout change.
    setScrollTop(el.scrollTop)
    setViewportHeight(el.clientHeight)
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THRESHOLD
    // During programmatic scrolls, only update if we're at bottom (don't falsely set scrolledUp)
    if (programmaticScrollRef.current && atBottom) return
    setUserScrolledUp(!atBottom)
  }, [])

  // The bare "snap to bottom" primitive shared by the mount, count-follow, and
  // scrollToBottomSignal effects: flag the write as programmatic (so the
  // resulting synthetic scroll event isn't misread as a user scroll-up), write
  // scrollTop to scrollHeight, then clear the flag on the next frame. Reads the
  // container ref itself and no-ops when unmounted, so callers don't repeat the
  // null guard. Does NOT touch userScrolledUp — that's the caller's contract
  // (the signal effect clears it; the count-follow effect only runs when already
  // at bottom). Keeping the suppression contract in one place is the #5786 DRY
  // ask — do not change its behavior.
  const scrollToBottomNow = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    programmaticScrollRef.current = true
    el.scrollTop = el.scrollHeight
    requestAnimationFrame(() => { programmaticScrollRef.current = false })
  }, [])

  const scrollToBottom = useCallback(() => {
    scrollToBottomNow()
    setUserScrolledUp(false)
  }, [scrollToBottomNow])

  // Scroll to the bottom on initial mount so switching back to the chat
  // tab always lands on the most-recent message above the input bar.
  // Empty dep array — fires once per mount; React unmounts/remounts the
  // ChatView when the parent toggles viewMode away and back, so this
  // effect re-runs naturally on every tab return.
  useEffect(() => {
    if (!containerRef.current) return
    scrollToBottomNow()
    // #5561 — seed the windowing geometry from the real container size on mount
    // so the first render after layout has an accurate viewport height.
    syncGeometry()
  }, [syncGeometry, scrollToBottomNow])

  // #5954 — mirror `userScrolledUp` into a ref so the ResizeObserver callback
  // (which we don't want to re-subscribe on every threshold crossing) reads the
  // current follow-state.
  useEffect(() => {
    userScrolledUpRef.current = userScrolledUp
  }, [userScrolledUp])

  // #5561 — keep the windowed range correct when the container resizes (panel
  // split drag, window resize, sidebar toggle) without a scroll event firing.
  //
  // #5954 — also re-pin to the tail on a container resize. The motivating case
  // is a SHRINK because the input area grew (a multi-line textarea, attachments,
  // or the activity / check-in chips appearing all push `.chat-messages`
  // shorter), which slides a previously bottom-pinned tail below the now-shorter
  // fold so it renders *behind* the input bar. ResizeObserver also fires on
  // width changes (split-pane drag, sidebar toggle) and on grow — re-pinning
  // there while following is harmless-to-helpful (it keeps the tail in view on
  // any geometry change), so we don't try to distinguish the trigger. What this
  // observer does NOT see is streamed content growth: that changes `scrollHeight`,
  // not the container's own box size, so it never fires here — the streaming RAF
  // owns that path (no double-pin). Gated on following (`!userScrolledUpRef`) so
  // a user reading history is never yanked down (#4652 / AC3). `scrollToBottomNow`
  // keeps the programmatic-scroll suppression contract (#5957) intact, and only
  // ever runs when the #5561 anchor compensation is dormant (it bails unless
  // `userScrolledUp`), so the two never fight.
  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      syncGeometry()
      if (!userScrolledUpRef.current) scrollToBottomNow()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [syncGeometry, scrollToBottomNow])

  // #5561 — engine-independent scroll-position compensation.
  //
  // WHY: Browsers with CSS scroll anchoring (Blink/Gecko) automatically keep
  // the visible content fixed when above-viewport content changes height — the
  // approve rationale for #5561 relied on that. But the Tauri desktop, the
  // dashboard's PRIMARY consumer, renders in WKWebView (Safari's engine), which
  // ships NO default scroll anchoring and does not honour `overflow-anchor`.
  // There, scrolling UP through history — where freshly-mounted top rows
  // re-measure away from their estimated heights and the top spacer is
  // recalculated — would visibly jump/jitter. We restore the missing behaviour
  // by hand for ALL engines (cheap and idempotent where anchoring already
  // works, since the offset delta is 0 once heights are correct).
  //
  // HOW: each render we remember the first-visible row (`firstVisibleIndex`) and
  // its content-space top offset (`firstVisibleOffset`). On the NEXT render we
  // re-read that SAME row's offset via `range.offsetAt(prevIndex)` — anchoring on
  // the fixed row identity, not on "whatever is first-visible now", because a
  // remeasure above the viewport shifts which row is first-visible at a fixed
  // scrollTop. The change in that fixed row's offset is exactly how far the
  // content under the viewport moved; we add it to `scrollTop` synchronously
  // (useLayoutEffect → before paint) so the anchor row stays under the same
  // pixel. The pinned-to-bottom path is left alone — the streaming /
  // count-change effects already force it to the bottom, and compensating there
  // would fight them.
  useLayoutEffect(() => {
    const el = containerRef.current
    const prev = anchorRef.current
    // The anchor we remember for NEXT render is the current first-visible row.
    const next = { index: range.firstVisibleIndex, offset: range.firstVisibleOffset }

    if (!el || !range.virtualized) {
      anchorRef.current = next
      return
    }
    // Only compensate while the user is reading history. When pinned to bottom
    // (and especially while streaming) the dedicated effects own scrollTop.
    if (!userScrolledUp || programmaticScrollRef.current || !prev) {
      anchorRef.current = next
      return
    }

    // KEY POINT: a re-measure of a row ABOVE the viewport shifts which row is
    // first-visible *at a fixed scrollTop* (more content above the same pixel),
    // so we must NOT compare first-visible-row to first-visible-row. Instead we
    // re-read the offset of the SAME anchor row we recorded last render (its
    // index is stable — the row did not move in the array). If that fixed row's
    // content-space top edge moved, the delta is exactly how far the content
    // under the viewport shifted, and we add it back to scrollTop so the anchor
    // stays under the same pixel. WKWebView (the Tauri desktop's engine) has no
    // native scroll anchoring, so without this the content visibly jumps.
    const prevAnchorNowOffset = range.offsetAt(prev.index)
    const delta = prevAnchorNowOffset - prev.offset
    if (delta === 0) {
      anchorRef.current = next
      return
    }
    const target = el.scrollTop + delta
    // Record the value we're about to write so the synthetic scroll event the
    // assignment fires is recognised and ignored (feedback-loop guard).
    expectedScrollTopRef.current = target
    el.scrollTop = target
    // Keep `scrollTop` state consistent with the DOM so the next windowing
    // recompute starts from the compensated position rather than re-deriving the
    // pre-shift one (which would re-introduce the jump on the following render).
    // The settling render restores the original anchor row as first-visible at
    // its new offset, so store THAT as the anchor for the next round.
    anchorRef.current = { index: prev.index, offset: prevAnchorNowOffset }
    setScrollTop(target)
  }, [range, userScrolledUp])

  // #4652: previously a separate streaming-end effect reset
  // `userScrolledUp` to false — that snapped the user back to the
  // bottom the moment an AskUserQuestion arrived (the question flips
  // `isStreaming` from true to false), making it impossible to read
  // history while a prompt was visible. The reset is no longer needed:
  // the count-change effect below handles the "follow latest" path
  // when the user is at the bottom, and the scroll-to-bottom button
  // gives a one-click return when they're scrolled up.

  // #4652: auto-scroll on new messages (stable count-based trigger) only
  // when the user is at the bottom. Previously we unconditionally snapped
  // to bottom on every count change, which made scrolling up through
  // history while an AskUserQuestion form was open impossible — any
  // downstream tool_use / tool_result event would yank the viewport back
  // down. The scroll-to-bottom button (already rendered when
  // `userScrolledUp`) is the user's one-click escape hatch.
  const prevCountRef = useRef(dedupedMessages.length)
  useEffect(() => {
    const countChanged = dedupedMessages.length !== prevCountRef.current
    prevCountRef.current = dedupedMessages.length
    if (countChanged && !userScrolledUp) {
      requestAnimationFrame(() => { scrollToBottomNow() })
    }
  }, [dedupedMessages.length, userScrolledUp, isBusy, scrollToBottomNow])

  // #5780 / #5786 — explicit "jump to latest" on a user action: send, approving
  // a permission/plan, or answering an AskUserQuestion (the parent bumps the
  // nonce for all three). Watches the parent's `scrollToBottomSignal` nonce:
  // whenever it changes we force the view to the bottom and clear
  // `userScrolledUp`, even if the user had scrolled up to read history. This is
  // the deliberate exception to the count-change auto-follow above — those
  // actions are the user asking to see the resulting response, so we always
  // follow. Seeded
  // with the initial value so the first render (and mount) is a no-op; only a
  // genuine bump scrolls. Robust to rapid sends: each distinct nonce fires
  // once, and the RAF defers the write until after the new row has laid out so
  // `scrollHeight` already includes it.
  const lastScrollSignalRef = useRef(scrollToBottomSignal)
  useEffect(() => {
    if (scrollToBottomSignal === lastScrollSignalRef.current) return
    lastScrollSignalRef.current = scrollToBottomSignal
    setUserScrolledUp(false)
    requestAnimationFrame(() => { scrollToBottomNow() })
  }, [scrollToBottomSignal, scrollToBottomNow])

  // During streaming, continuously re-pin to the bottom via RAF so the growing
  // tail stays in view. #5954: reuse `scrollToBottomNow()` rather than an inline
  // `scrollTop = scrollHeight` with a SYNCHRONOUS `programmaticScrollRef` clear.
  // The synchronous clear violated the suppression contract (the flag was
  // already false by the time the write's async `scroll` event reached
  // `handleScroll`), so a streaming scroll event landing in a transient
  // not-quite-at-bottom window (windowing churn / content growth between the
  // write and the event) was misread as a user scroll-up — which flipped
  // `userScrolledUp` and KILLED the auto-follow effect, dropping the live tail
  // below the fold ("doesn't consistently stay at the bottom"). `scrollToBottomNow`
  // holds the flag until the next frame, so `handleScroll`'s
  // `programmaticScrollRef.current && atBottom` guard reliably ignores the
  // self-induced events while a genuine user scroll-up (atBottom false) is still
  // honored.
  useEffect(() => {
    if (!isStreaming || userScrolledUp) return
    let rafId: number
    const tick = () => {
      scrollToBottomNow()
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [isStreaming, userScrolledUp, scrollToBottomNow])

  // #5561 — the windowed slice. Only rows in [startIndex, endIndex) mount; the
  // top/bottom spacers reserve the height of the skipped rows so the scrollbar
  // geometry (and therefore scroll position when content appends above the
  // viewport) is preserved. Below the threshold `range` covers the whole list
  // and both spacers are 0, so short conversations render exactly as before.
  const visible = dedupedMessages.slice(range.startIndex, range.endIndex)

  return (
    <div className="chat-view" data-testid="chat-view">
      {/*
        Chat redesign #6392 (presence rail): ONE left-edge spine per pane,
        absolutely positioned against this non-scrolling .chat-view parent — NOT
        inside the virtualized .chat-messages scroller — so it's continuous and
        independent of the windowed row slice and the WKWebView scroll-anchor
        math. Colour + motion come from data-activity-state (the same pattern as
        the Phase 1 composer hairline). aria-hidden: ambient decoration, not
        content. Motion choreography is intentionally restrained pending design
        tuning (see the .presence-rail CSS).
      */}
      <div
        className="presence-rail"
        data-activity-state={chatActivityState ?? 'idle'}
        style={inFlightToolColor ? ({ '--rail-color': inFlightToolColor } as CSSProperties) : undefined}
        data-testid="presence-rail"
        aria-hidden="true"
      />
      <ChatExpandContext.Provider value={expandRegistry}>
        <div
          ref={containerRef}
          className="chat-messages"
          data-testid="chat-messages"
          onScroll={handleScroll}
        >
          {/* Top spacer — reserves the height of windowed-out leading rows. The
              `flex: 0 0 auto` style keeps it from being squeezed by the flex
              column the way a normal flex child would be. */}
          {range.topSpacer > 0 && (
            <div
              aria-hidden="true"
              data-testid="chat-window-top-spacer"
              style={{ flex: '0 0 auto', height: range.topSpacer }}
            />
          )}
          {visible.map(msg => {
            const icon = senderIconFor(msg.type)
            const rowClass = rowClassFor(msg.type, icon !== null)
            const custom = renderMessage?.(msg)
            if (custom !== undefined && custom !== null) {
              return (
                <MessageRowShell
                  key={msg.id}
                  rowKey={msg.id}
                  measureRow={range.measureRow}
                  className={rowClass}
                  testId={`msg-${msg.id}`}
                >
                  {msg.type !== 'user_input' && icon}
                  <div style={{ display: 'contents' }}>{custom}</div>
                  {msg.type === 'user_input' && icon}
                </MessageRowShell>
              )
            }
            return (
              <MessageRowShell
                key={msg.id}
                rowKey={msg.id}
                measureRow={range.measureRow}
                className={rowClass}
                testId={`msg-${msg.id}`}
              >
                <DefaultMessageRow
                  id={msg.id}
                  type={msg.type}
                  content={msg.content}
                  timestamp={msg.timestamp}
                  isStreaming={msg.isStreaming}
                  attachments={msg.attachments}
                  queued={queuedIds?.has(msg.id) ?? false}
                  queuePosition={queuePositions?.get(msg.id)}
                  onCancelQueued={onCancelQueued}
                />
              </MessageRowShell>
            )
          })}
          {/* Bottom spacer — reserves the height of windowed-out trailing rows. */}
          {range.bottomSpacer > 0 && (
            <div
              aria-hidden="true"
              data-testid="chat-window-bottom-spacer"
              style={{ flex: '0 0 auto', height: range.bottomSpacer }}
            />
          )}
          {(isStreaming || isBusy) && <WorkingIndicator label={workingLabel} />}
        </div>
      </ChatExpandContext.Provider>

      {userScrolledUp && (
        <button
          className="scroll-to-bottom"
          data-testid="scroll-to-bottom"
          onClick={scrollToBottom}
          type="button"
          aria-label="Scroll to bottom"
        >
          ↓
        </button>
      )}
    </div>
  )
}

/**
 * #4398 — skip re-rendering while the parent has hidden us. After #4305
 * (Bug B) we stay mounted across tab switches so user-set expand state
 * survives the round-trip, but the trade-off was that every store
 * update still flowed in and re-rendered the off-screen ChatView. On
 * long sessions that doubled the per-update render cost (markdown
 * re-parse, dedup pass, renderMessage callbacks for every tool group)
 * for work nobody could see.
 *
 * This comparator returns `true` (skip re-render) only when we were
 * hidden AND we're still hidden. The first render where `hidden` flips
 * to `false` always proceeds — at that point React has already
 * committed the latest props, so the user sees an up-to-date view in
 * the very same frame they switched tabs. Going from visible → hidden
 * still renders once so the wrapper transition completes cleanly.
 *
 * Note: a parent that wants the hidden ChatView to skip work MUST pass
 * `hidden={true}`. Without the prop (e.g. SplitPane path), every render
 * proceeds — the optimization is opt-in.
 */
export const ChatView = memo(ChatViewImpl, (prev, next) => {
  return Boolean(prev.hidden) && Boolean(next.hidden)
})

