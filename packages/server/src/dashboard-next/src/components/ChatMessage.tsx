/**
 * ChatMessage component — renders a single chat message.
 *
 * Supports message types: response, user_input, system, error, thinking, tool_use.
 * Assistant/response messages are rendered with markdown; others use plain text.
 */
import { useMemo } from 'react'
import { renderMarkdown } from '../lib/markdown'

export interface ChatMessageProps {
  id: string
  type: 'response' | 'user_input' | 'system' | 'error' | 'thinking' | 'tool_use'
  content: string
  timestamp: number
  isStreaming?: boolean
}

function getClassName(type: string, isStreaming?: boolean): string {
  const base = 'msg'
  const typeClass =
    type === 'response' ? 'assistant' :
    type === 'user_input' ? 'user' :
    type
  const classes = [base, typeClass]
  if (isStreaming) classes.push('streaming')
  return classes.join(' ')
}

export function ChatMessage({ id, type, content, isStreaming }: ChatMessageProps) {
  const className = getClassName(type, isStreaming)

  const html = useMemo(() => {
    if (type === 'response' || type === 'tool_use') {
      return renderMarkdown(content)
    }
    return null
  }, [type, content])

  if (type === 'thinking' && !content.trim()) return null

  return (
    <div
      className={className}
      data-testid={`chat-message-${id}`}
      data-msg-id={id}
      data-muted={type === 'system' ? 'true' : undefined}
    >
      {html !== null ? (
        <div dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        content
      )}
    </div>
  )
}
