/**
 * ChatView + ThinkingDots tests (#1156)
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
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

  it('shows thinking dots when busy but not streaming', () => {
    render(<ChatView messages={makeMessages(1)} isStreaming={false} isBusy />)
    expect(screen.getByTestId('thinking-dots')).toBeInTheDocument()
  })

  it('hides thinking dots when not busy and not streaming', () => {
    render(<ChatView messages={makeMessages(1)} isStreaming={false} isBusy={false} />)
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

  it('skips auto-scroll on idle rerender with same message count (#1180)', async () => {
    vi.useFakeTimers()
    const messages = makeMessages(3)
    const { rerender } = render(<ChatView messages={messages} isStreaming={false} />)
    const container = screen.getByTestId('chat-messages')

    // Setup: make scrollTop writable and simulate being at bottom
    Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(container, 'scrollTop', { value: 1000, writable: true, configurable: true })
    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true })

    // Let initial RAF settle
    await act(() => { vi.advanceTimersByTime(50) })

    // Simulate user scrolling up — set scrollTop away from bottom and fire scroll
    container.scrollTop = 200
    await act(() => { fireEvent.scroll(container) })

    // Rerender with same message count when not streaming — no scroll (user scrolled up)
    const sameCountMessages = makeMessages(3)
    rerender(<ChatView messages={sameCountMessages} isStreaming={false} />)
    await act(() => { vi.advanceTimersByTime(50) })
    expect(container.scrollTop).toBe(200)

    // #4652 — even when a new message arrives, a user who is actively
    // scrolled up should NOT be snapped back to the bottom. They keep
    // their reading position and can click the scroll-to-bottom button
    // (which appears) when they're ready. Previously the count-change
    // effect unconditionally reset `userScrolledUp` and scrolled — that
    // made history unreachable while an AskUserQuestion form was open
    // and downstream tool_use events kept arriving.
    const moreMessages = makeMessages(4)
    rerender(<ChatView messages={moreMessages} isStreaming={false} />)
    await act(() => { vi.advanceTimersByTime(50) })
    expect(container.scrollTop).toBe(200)
    expect(screen.getByTestId('scroll-to-bottom')).toBeInTheDocument()
    vi.useRealTimers()
  })

  it('auto-scrolls on new message when user is at bottom (#4652)', async () => {
    vi.useFakeTimers()
    const messages = makeMessages(3)
    const { rerender } = render(<ChatView messages={messages} isStreaming={false} />)
    const container = screen.getByTestId('chat-messages')

    // Setup: at bottom; user has not scrolled up
    Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(container, 'scrollTop', { value: 1000, writable: true, configurable: true })
    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true })
    await act(() => { vi.advanceTimersByTime(50) })

    // New message arrives — should snap to bottom (user is at bottom, so no
    // disruption).
    const moreMessages = makeMessages(4)
    rerender(<ChatView messages={moreMessages} isStreaming={false} />)
    await act(() => { vi.advanceTimersByTime(50) })
    expect(container.scrollTop).toBe(1000)
    vi.useRealTimers()
  })

  it('preserves scrolled-up position when streaming ends mid-history-read (#4652)', async () => {
    // Repro for the AskUserQuestion scenario: streaming flips to false
    // when the question arrives. Previously, the streaming-end effect
    // unconditionally reset `userScrolledUp` to false — snapping the
    // user back to the bottom while they were reading history.
    vi.useFakeTimers()
    const messages = makeMessages(3)
    const { rerender } = render(<ChatView messages={messages} isStreaming />)
    const container = screen.getByTestId('chat-messages')

    Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(container, 'scrollTop', { value: 1000, writable: true, configurable: true })
    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true })
    await act(() => { vi.advanceTimersByTime(50) })

    // User scrolls up while assistant is still streaming
    container.scrollTop = 100
    await act(() => { fireEvent.scroll(container) })
    expect(screen.getByTestId('scroll-to-bottom')).toBeInTheDocument()

    // Streaming ends (AskUserQuestion arrived); user is still scrolled up
    rerender(<ChatView messages={messages} isStreaming={false} />)
    await act(() => { vi.advanceTimersByTime(50) })
    expect(container.scrollTop).toBe(100)
    expect(screen.getByTestId('scroll-to-bottom')).toBeInTheDocument()
    vi.useRealTimers()
  })

  it('auto-scrolls during streaming even with same message count (#1180)', async () => {
    vi.useFakeTimers()
    const messages = makeMessages(3)
    const { rerender } = render(<ChatView messages={messages} isStreaming />)
    const container = screen.getByTestId('chat-messages')

    Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(container, 'scrollTop', { value: 1000, writable: true, configurable: true })
    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true })

    container.scrollTop = 500

    // Rerender with new content (same count) during streaming — SHOULD scroll via RAF loop
    const updatedMessages = makeMessages(3)
    rerender(<ChatView messages={updatedMessages} isStreaming />)
    await act(() => { vi.advanceTimersByTime(50) })
    expect(container.scrollTop).toBe(1000)
    vi.useRealTimers()
  })

  it('scrolls to the bottom on initial mount (tab-switch UX)', async () => {
    // Force the container to have overflow content so scrollTop is meaningful.
    Object.defineProperty(HTMLDivElement.prototype, 'scrollHeight', {
      configurable: true,
      get() { return 1000 },
    })
    Object.defineProperty(HTMLDivElement.prototype, 'clientHeight', {
      configurable: true,
      get() { return 200 },
    })
    try {
      const messages: ChatViewMessage[] = Array.from({ length: 20 }, (_, i) => ({
        id: `m-${i}`, type: 'response', content: `msg ${i}`, timestamp: Date.now() + i,
      }))
      render(<ChatView messages={messages} isStreaming={false} />)
      const container = screen.getByTestId('chat-messages')
      // Wait one RAF tick — the mount effect uses requestAnimationFrame.
      await new Promise(resolve => requestAnimationFrame(() => resolve(null)))
      // After mount, the container should have been scrolled to scrollHeight
      // (jsdom doesn't actually paint, but our effect sets scrollTop = scrollHeight).
      expect(container.scrollTop).toBe(1000)
    } finally {
      // @ts-expect-error — restore by deleting the override
      delete HTMLDivElement.prototype.scrollHeight
      // @ts-expect-error — restore by deleting the override
      delete HTMLDivElement.prototype.clientHeight
    }
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

  // #4398 — when the parent passes `hidden`, ChatView is memoized so a
  // stream of prop changes (new messages, fresh renderMessage callback,
  // etc.) does NOT re-render the hidden component. The first render
  // where `hidden` flips back to `false` always proceeds with the
  // latest props, so the user sees the up-to-date view immediately on
  // tab switch.
  describe('hidden memoization (#4398)', () => {
    it('skips renderMessage invocations while hidden=true on subsequent renders', () => {
      const renderMessage = vi.fn(() => null)
      const initial: ChatViewMessage[] = [
        { id: 'msg-1', type: 'response', content: 'First', timestamp: 1 },
      ]
      const { rerender } = render(
        <ChatView messages={initial} isStreaming={false} hidden renderMessage={renderMessage} />
      )
      // First mount renders once — establishes the baseline.
      expect(renderMessage).toHaveBeenCalledTimes(1)
      renderMessage.mockClear()

      // Re-render with new messages while still hidden — memo comparator
      // returns true, so renderMessage is NOT invoked.
      const updated: ChatViewMessage[] = [
        ...initial,
        { id: 'msg-2', type: 'response', content: 'Second', timestamp: 2 },
      ]
      rerender(
        <ChatView messages={updated} isStreaming={false} hidden renderMessage={renderMessage} />
      )
      expect(renderMessage).not.toHaveBeenCalled()
    })

    it('re-renders with latest props when hidden flips false', () => {
      const renderMessage = vi.fn((m: ChatViewMessage) => <span>{`custom:${m.content}`}</span>)
      const initial: ChatViewMessage[] = [
        { id: 'msg-1', type: 'response', content: 'First', timestamp: 1 },
      ]
      const { rerender } = render(
        <ChatView messages={initial} isStreaming={false} hidden renderMessage={renderMessage} />
      )
      renderMessage.mockClear()

      // Accumulate updates while hidden — none should reach the render tree.
      const updated: ChatViewMessage[] = [
        ...initial,
        { id: 'msg-2', type: 'response', content: 'Second', timestamp: 2 },
      ]
      rerender(
        <ChatView messages={updated} isStreaming={false} hidden renderMessage={renderMessage} />
      )
      expect(renderMessage).not.toHaveBeenCalled()
      expect(screen.queryByText('custom:Second')).not.toBeInTheDocument()

      // Flip hidden=false — memo lets the render through with latest props.
      rerender(
        <ChatView messages={updated} isStreaming={false} hidden={false} renderMessage={renderMessage} />
      )
      expect(renderMessage).toHaveBeenCalled()
      expect(screen.getByText('custom:Second')).toBeInTheDocument()
    })

    it('renders normally when hidden is omitted (default visible)', () => {
      const renderMessage = vi.fn(() => null)
      const initial: ChatViewMessage[] = [
        { id: 'msg-1', type: 'response', content: 'First', timestamp: 1 },
      ]
      const { rerender } = render(
        <ChatView messages={initial} isStreaming={false} renderMessage={renderMessage} />
      )
      renderMessage.mockClear()

      const updated: ChatViewMessage[] = [
        ...initial,
        { id: 'msg-2', type: 'response', content: 'Second', timestamp: 2 },
      ]
      rerender(
        <ChatView messages={updated} isStreaming={false} renderMessage={renderMessage} />
      )
      // Without `hidden`, memo comparator returns false → normal re-render.
      expect(renderMessage).toHaveBeenCalled()
    })

    it('does not skip render on the visible→hidden transition (so display:none takes effect)', () => {
      const renderMessage = vi.fn(() => null)
      const initial: ChatViewMessage[] = [
        { id: 'msg-1', type: 'response', content: 'First', timestamp: 1 },
      ]
      const { rerender } = render(
        <ChatView messages={initial} isStreaming={false} hidden={false} renderMessage={renderMessage} />
      )
      renderMessage.mockClear()

      // visible → hidden — comparator's `prev.hidden && next.hidden`
      // is false (prev.hidden=false), so this render proceeds. That
      // matters because the parent's display:none wrapper takes effect
      // in the same commit, and we want the latest props applied right
      // before we go dark.
      rerender(
        <ChatView messages={initial} isStreaming={false} hidden renderMessage={renderMessage} />
      )
      expect(renderMessage).toHaveBeenCalled()
    })
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
