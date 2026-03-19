/**
 * ChatView — scrollable message list with auto-scroll and thinking indicator.
 *
 * Ports auto-scroll logic from dashboard-app.js (lines 449-460):
 * - Detects user scroll-up, pauses auto-scroll
 * - Shows scroll-to-bottom button when scrolled up
 * - Deduplicates messages by id for reconnect replay
 */
import { useRef, useState, useCallback, useEffect, useMemo, type ReactNode, type CSSProperties } from 'react'
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
  type: 'response' | 'user_input' | 'system' | 'error' | 'thinking' | 'tool_use'
  content: string
  timestamp: number
  isStreaming?: boolean
}

export interface ChatViewProps {
  messages: ChatViewMessage[]
  isStreaming: boolean
  /** Show thinking indicator during pre-streaming busy state */
  isBusy?: boolean
  /** Optional custom renderer. Return a node to override default rendering, or null to fall back. */
  renderMessage?: (msg: ChatViewMessage) => ReactNode | null
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

export function ChatView({ messages, isStreaming, isBusy, renderMessage }: ChatViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [userScrolledUp, setUserScrolledUp] = useState(false)

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
    setUserScrolledUp(!atBottom)
  }, [])

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    setUserScrolledUp(false)
  }, [])

  // Auto-scroll: on new messages (count change), during streaming (content growth),
  // or when busy state changes (ThinkingDots appear/disappear).
  // When streaming, include messages reference so content growth triggers scroll.
  // When idle, only message count changes matter (avoids needless DOM writes).
  const scrollTrigger = isStreaming ? messages : dedupedMessages.length
  useEffect(() => {
    if (!userScrolledUp) {
      const el = containerRef.current
      if (el) el.scrollTop = el.scrollHeight
    }
  }, [scrollTrigger, userScrolledUp, isBusy])

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
            <div
              key={msg.id}
              data-testid={`msg-${msg.id}`}
              className={rowClass}
            >
              {msg.type !== 'user_input' && icon}
              <div
                className={`msg ${TYPE_CLASS[msg.type] || 'assistant'}${msg.isStreaming ? ' streaming' : ''}`}
              >
                {(msg.type === 'response' || msg.type === 'tool_use') ? (
                  <div dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />
                ) : (
                  msg.content
                )}
                {msg.timestamp > 0 && (
                  <span className="msg-timestamp">{formatTime(msg.timestamp)}</span>
                )}
              </div>
              {msg.type === 'user_input' && icon}
            </div>
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

