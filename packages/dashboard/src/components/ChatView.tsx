/**
 * ChatView — scrollable message list with auto-scroll and thinking indicator.
 *
 * Ports auto-scroll logic from dashboard-app.js (lines 449-460):
 * - Detects user scroll-up, pauses auto-scroll
 * - Shows scroll-to-bottom button when scrolled up
 * - Deduplicates messages by id for reconnect replay
 */
import { memo, useRef, useState, useCallback, useEffect, useMemo, type ReactNode, type CSSProperties } from 'react'
import { bumpRenderCount } from '@chroxy/store-core'
import { ThinkingDots } from './ThinkingDots'
import { renderMarkdown } from '../lib/markdown'

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
}

export interface ChatViewProps {
  messages: ChatViewMessage[]
  isStreaming: boolean
  /** Show thinking indicator during pre-streaming busy state */
  isBusy?: boolean
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
}

const TYPE_CLASS: Record<string, string> = {
  response: 'assistant',
  user_input: 'user',
  system: 'system',
  error: 'error',
  thinking: 'thinking',
  tool_use: 'tool',
}

const SCROLL_THRESHOLD = 60

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

const DefaultMessageRow = memo(function DefaultMessageRow({
  id,
  type,
  content,
  timestamp,
  isStreaming,
}: {
  id: string
  type: ChatViewMessage['type']
  content: string
  timestamp: number
  isStreaming?: boolean
}) {
  // Dev-only render tally — proves (in the memoization test + ad-hoc
  // profiling) non-tail rows don't re-render on a delta flush. Never read on
  // the hot path.
  if (IS_DEV) bumpRenderCount(`ChatMessageRow:${id}`)

  // Derive icon + row class from `type` INSIDE the memo. Computing them in the
  // parent map would hand the memo a fresh `icon` JSX element identity every
  // render and defeat the skip — every prop must be a stable scalar.
  const icon = senderIconFor(type)
  const rowClass = rowClassFor(type, icon !== null)

  const body =
    type === 'response' || type === 'tool_use'
      ? <div dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
      : content

  return (
    <div data-testid={`msg-${id}`} className={rowClass}>
      {type !== 'user_input' && icon}
      <div className={`msg ${TYPE_CLASS[type] || 'assistant'}${isStreaming ? ' streaming' : ''}`}>
        {body}
        {timestamp > 0 && <span className="msg-timestamp">{formatTime(timestamp)}</span>}
      </div>
      {type === 'user_input' && icon}
    </div>
  )
})

function ChatViewImpl({ messages, isStreaming, isBusy, renderMessage }: ChatViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [userScrolledUp, setUserScrolledUp] = useState(false)
  const programmaticScrollRef = useRef(false)

  // Deduplicate by id — keep first occurrence
  const dedupedMessages = useMemo(() => {
    const seen = new Set<string>()
    return messages.filter(m => {
      if (seen.has(m.id)) return false
      seen.add(m.id)
      return true
    })
  }, [messages])

  const handleScroll = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THRESHOLD
    // During programmatic scrolls, only update if we're at bottom (don't falsely set scrolledUp)
    if (programmaticScrollRef.current && atBottom) return
    setUserScrolledUp(!atBottom)
  }, [])

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    programmaticScrollRef.current = true
    el.scrollTop = el.scrollHeight
    setUserScrolledUp(false)
    requestAnimationFrame(() => { programmaticScrollRef.current = false })
  }, [])

  // Scroll to the bottom on initial mount so switching back to the chat
  // tab always lands on the most-recent message above the input bar.
  // Empty dep array — fires once per mount; React unmounts/remounts the
  // ChatView when the parent toggles viewMode away and back, so this
  // effect re-runs naturally on every tab return.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    programmaticScrollRef.current = true
    el.scrollTop = el.scrollHeight
    requestAnimationFrame(() => { programmaticScrollRef.current = false })
  }, [])

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
      requestAnimationFrame(() => {
        const el = containerRef.current
        if (el) {
          programmaticScrollRef.current = true
          el.scrollTop = el.scrollHeight
          requestAnimationFrame(() => { programmaticScrollRef.current = false })
        }
      })
    }
  }, [dedupedMessages.length, userScrolledUp, isBusy])

  // During streaming, continuously scroll to bottom via RAF
  useEffect(() => {
    if (!isStreaming || userScrolledUp) return
    let rafId: number
    const tick = () => {
      const el = containerRef.current
      if (el) {
        programmaticScrollRef.current = true
        el.scrollTop = el.scrollHeight
        programmaticScrollRef.current = false
      }
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [isStreaming, userScrolledUp])

  return (
    <div className="chat-view" data-testid="chat-view">
      <div
        ref={containerRef}
        className="chat-messages"
        data-testid="chat-messages"
        onScroll={handleScroll}
      >
        {dedupedMessages.map(msg => {
          const icon = senderIconFor(msg.type)
          const rowClass = msg.type === 'user_input' ? 'msg-row msg-row-user'
            : msg.type === 'system' ? 'msg-row msg-row-system'
            : icon ? 'msg-row' : ''
          const custom = renderMessage?.(msg)
          if (custom !== undefined && custom !== null) {
            return (
              <div
                key={msg.id}
                data-testid={`msg-${msg.id}`}
                className={rowClass}
              >
                {msg.type !== 'user_input' && icon}
                <div style={{ display: 'contents' }}>{custom}</div>
                {msg.type === 'user_input' && icon}
              </div>
            )
          }
          return (
            <DefaultMessageRow
              key={msg.id}
              id={msg.id}
              type={msg.type}
              content={msg.content}
              timestamp={msg.timestamp}
              isStreaming={msg.isStreaming}
            />
          )
        })}
        {(isStreaming || isBusy) && <ThinkingDots />}
      </div>

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

