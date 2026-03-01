/**
 * ChatView — scrollable message list with auto-scroll and thinking indicator.
 *
 * Ports auto-scroll logic from dashboard-app.js (lines 449-460):
 * - Detects user scroll-up, pauses auto-scroll
 * - Shows scroll-to-bottom button when scrolled up
 * - Deduplicates messages by id for reconnect replay
 */
import { useRef, useState, useCallback, useEffect, useMemo, type ReactNode } from 'react'
import { ThinkingDots } from './ThinkingDots'

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

export function ChatView({ messages, isStreaming, renderMessage }: ChatViewProps) {
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

  // Auto-scroll on new messages when not scrolled up
  useEffect(() => {
    if (!userScrolledUp) {
      const el = containerRef.current
      if (el) el.scrollTop = el.scrollHeight
    }
  }, [dedupedMessages.length, userScrolledUp])

  return (
    <div className="chat-view" data-testid="chat-view">
      <div
        ref={containerRef}
        className="chat-messages"
        data-testid="chat-messages"
        onScroll={handleScroll}
      >
        {dedupedMessages.map(msg => {
          const custom = renderMessage?.(msg)
          if (custom !== undefined && custom !== null) {
            return (
              <div
                key={msg.id}
                data-testid={`msg-${msg.id}`}
                style={{ display: 'contents' }}
              >
                {custom}
              </div>
            )
          }
          return (
            <div
              key={msg.id}
              className={`msg ${TYPE_CLASS[msg.type] || 'assistant'}${msg.isStreaming ? ' streaming' : ''}`}
              data-testid={`msg-${msg.id}`}
            >
              {msg.content}
            </div>
          )
        })}
        {isStreaming && <ThinkingDots />}
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

