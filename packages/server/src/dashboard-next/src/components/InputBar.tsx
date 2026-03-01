/**
 * InputBar — auto-expanding textarea with send/interrupt.
 *
 * Enter for newline, Cmd/Ctrl+Enter to send, Escape to interrupt.
 */
import { useState, useId, useRef, useCallback, type KeyboardEvent, type ChangeEvent } from 'react'

export interface InputBarProps {
  onSend: (text: string) => void
  onInterrupt: () => void
  disabled?: boolean
  isStreaming?: boolean
  placeholder?: string
}

export function InputBar({ onSend, onInterrupt, disabled, isStreaming, placeholder }: InputBarProps) {
  const [value, setValue] = useState('')
  const shortcutsId = useId()
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const send = useCallback(() => {
    const trimmed = value.trim()
    if (!trimmed) return
    onSend(trimmed)
    setValue('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [value, onSend])

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      send()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onInterrupt()
    }
  }, [send, onInterrupt])

  const handleChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value)
    // Auto-expand
    const el = e.target
    el.style.height = 'auto'
    const lineHeight = 20
    const maxLines = 5
    el.style.height = Math.min(el.scrollHeight, lineHeight * maxLines) + 'px'
  }, [])

  return (
    <div className="input-bar" data-testid="input-bar">
      <span id={shortcutsId} className="sr-only">
        Press Cmd/Ctrl+Enter to send, Escape to interrupt
      </span>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        placeholder={placeholder}
        aria-label="Message input"
        aria-describedby={shortcutsId}
        rows={1}
      />
      {isStreaming ? (
        <button
          data-testid="interrupt-button"
          className="btn-interrupt"
          onClick={onInterrupt}
          type="button"
          aria-label="Stop generation"
        >
          Stop
        </button>
      ) : (
        <button
          data-testid="send-button"
          className="btn-send"
          onClick={send}
          disabled={disabled}
          type="button"
          aria-label="Send message"
        >
          Send
        </button>
      )}
    </div>
  )
}
