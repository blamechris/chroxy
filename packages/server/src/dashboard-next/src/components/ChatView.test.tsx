/**
 * ChatView + ThinkingDots tests (#1156)
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ChatView, type ChatViewMessage } from './ChatView'
import { ThinkingDots } from './ThinkingDots'

afterEach(cleanup)

function makeMessages(count: number): ChatViewMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `msg-${i}`,
    type: 'response' as const,
    content: `Message ${i}`,
    timestamp: Date.now() - (count - i) * 1000,
  }))
}

describe('ChatView', () => {
  it('renders messages', () => {
    const messages = makeMessages(3)
    render(<ChatView messages={messages} isStreaming={false} />)
    expect(screen.getByText('Message 0')).toBeInTheDocument()
    expect(screen.getByText('Message 1')).toBeInTheDocument()
    expect(screen.getByText('Message 2')).toBeInTheDocument()
  })

  it('renders empty state when no messages', () => {
    render(<ChatView messages={[]} isStreaming={false} />)
    expect(screen.getByTestId('chat-view')).toBeInTheDocument()
  })

  it('shows thinking dots when streaming', () => {
    render(<ChatView messages={makeMessages(1)} isStreaming />)
    expect(screen.getByTestId('thinking-dots')).toBeInTheDocument()
  })

  it('hides thinking dots when not streaming', () => {
    render(<ChatView messages={makeMessages(1)} isStreaming={false} />)
    expect(screen.queryByTestId('thinking-dots')).not.toBeInTheDocument()
  })

  it('shows scroll-to-bottom button when scrolled up', () => {
    const messages = makeMessages(3)
    render(<ChatView messages={messages} isStreaming={false} />)
    const container = screen.getByTestId('chat-messages')

    // Simulate scroll event with user scrolled up
    Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(container, 'scrollTop', { value: 0, configurable: true })
    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true })
    fireEvent.scroll(container)

    expect(screen.getByTestId('scroll-to-bottom')).toBeInTheDocument()
  })

  it('hides scroll-to-bottom when at bottom', () => {
    const messages = makeMessages(3)
    render(<ChatView messages={messages} isStreaming={false} />)
    const container = screen.getByTestId('chat-messages')

    // At bottom (scrollHeight - scrollTop - clientHeight < threshold)
    Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(container, 'scrollTop', { value: 560, configurable: true })
    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true })
    fireEvent.scroll(container)

    expect(screen.queryByTestId('scroll-to-bottom')).not.toBeInTheDocument()
  })

  it('scrolls to bottom when button clicked', () => {
    const messages = makeMessages(3)
    render(<ChatView messages={messages} isStreaming={false} />)
    const container = screen.getByTestId('chat-messages')

    // Simulate scrolled up
    Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(container, 'scrollTop', { value: 0, writable: true, configurable: true })
    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true })
    fireEvent.scroll(container)

    fireEvent.click(screen.getByTestId('scroll-to-bottom'))
    expect(container.scrollTop).toBe(1000)
  })

  it('renders user_input messages', () => {
    const messages: ChatViewMessage[] = [
      { id: '1', type: 'user_input', content: 'Hello Claude', timestamp: Date.now() },
    ]
    render(<ChatView messages={messages} isStreaming={false} />)
    expect(screen.getByText('Hello Claude')).toBeInTheDocument()
  })

  it('deduplicates messages by id', () => {
    const messages: ChatViewMessage[] = [
      { id: 'dup', type: 'response', content: 'First', timestamp: Date.now() },
      { id: 'dup', type: 'response', content: 'Duplicate', timestamp: Date.now() },
    ]
    render(<ChatView messages={messages} isStreaming={false} />)
    // Should only render first occurrence
    const items = screen.getAllByText(/First|Duplicate/)
    expect(items.length).toBe(1)
  })

  it('uses renderMessage when provided and returns a node', () => {
    const messages: ChatViewMessage[] = [
      { id: 'custom-1', type: 'response', content: 'Default', timestamp: Date.now() },
    ]
    render(
      <ChatView
        messages={messages}
        isStreaming={false}
        renderMessage={() => <span>Custom render</span>}
      />
    )
    expect(screen.getByText('Custom render')).toBeInTheDocument()
    expect(screen.queryByText('Default')).not.toBeInTheDocument()
  })

  it('falls back to default when renderMessage returns null', () => {
    const messages: ChatViewMessage[] = [
      { id: 'fallback-1', type: 'response', content: 'Fallback content', timestamp: Date.now() },
    ]
    render(
      <ChatView
        messages={messages}
        isStreaming={false}
        renderMessage={() => null}
      />
    )
    expect(screen.getByText('Fallback content')).toBeInTheDocument()
  })
})

describe('ThinkingDots', () => {
  it('renders dots', () => {
    render(<ThinkingDots />)
    expect(screen.getByTestId('thinking-dots')).toBeInTheDocument()
  })

  it('has 3 dots', () => {
    render(<ThinkingDots />)
    const dots = screen.getByTestId('thinking-dots').querySelectorAll('.thinking-dot')
    expect(dots.length).toBe(3)
  })
})
