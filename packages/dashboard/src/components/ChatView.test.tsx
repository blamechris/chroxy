/**
 * ChatView + ThinkingDots tests (#1156)
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react'
import { ChatView, type ChatViewMessage } from './ChatView'
import { ThinkingDots } from './ThinkingDots'
import { writeText } from '../utils/clipboard'
import * as fs from 'fs'
import * as path from 'path'

vi.mock('../utils/clipboard', () => ({ writeText: vi.fn() }))
const mockWriteText = vi.mocked(writeText)

const componentsCss = fs.readFileSync(path.resolve(__dirname, '../theme/components.css'), 'utf-8')

afterEach(() => {
  cleanup()
  mockWriteText.mockReset()
})

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

  it('shows the copy control only on finished, non-empty response bubbles (#6631)', () => {
    const messages: ChatViewMessage[] = [
      { id: 'r-done', type: 'response', content: 'finished answer', timestamp: 1 },
      { id: 'r-stream', type: 'response', content: 'partial…', timestamp: 2, isStreaming: true },
      { id: 'r-empty', type: 'response', content: '   ', timestamp: 3 },
      { id: 'tool', type: 'tool_use', content: 'tool text', timestamp: 4 },
      { id: 'sys', type: 'system', content: 'system note', timestamp: 5 },
      { id: 'usr', type: 'user_input', content: 'my question', timestamp: 6 },
    ]
    render(<ChatView messages={messages} isStreaming={false} />)
    // Exactly one — the finished, non-empty response. A regression that dropped
    // the `!isStreaming` / `type === 'response'` / non-empty gate would fail here.
    expect(screen.queryAllByTestId('msg-copy-button')).toHaveLength(1)
  })

  describe('per-code-block copy button (#6793)', () => {
    it('renders one copy button per fenced code block, independent of the whole-message copy control', () => {
      const messages: ChatViewMessage[] = [
        {
          id: 'r1',
          type: 'response',
          content: 'here are two snippets\n\n```js\nconst a = 1\n```\n\nand\n\n```py\ndef b(): pass\n```',
          timestamp: 1,
        },
      ]
      render(<ChatView messages={messages} isStreaming={false} />)
      expect(screen.getAllByTestId('code-copy-button')).toHaveLength(2)
      // The whole-message CopyButton still renders alongside them.
      expect(screen.getAllByTestId('msg-copy-button')).toHaveLength(1)
    })

    it('clicking a code block\'s copy button copies ONLY that block\'s text, not the whole message', async () => {
      mockWriteText.mockResolvedValue(true)
      const messages: ChatViewMessage[] = [
        {
          id: 'r1',
          type: 'response',
          content: 'intro text\n\n```js\nconst first = 1\n```\n\nmiddle text\n\n```js\nconst second = 2\n```',
          timestamp: 1,
        },
      ]
      render(<ChatView messages={messages} isStreaming={false} />)
      const buttons = screen.getAllByTestId('code-copy-button')
      expect(buttons).toHaveLength(2)
      fireEvent.click(buttons[1]!)
      await waitFor(() => expect(mockWriteText).toHaveBeenCalledTimes(1))
      expect(mockWriteText).toHaveBeenCalledWith('const second = 2\n')
      // Never called with the raw markdown source or the other block's text.
      expect(mockWriteText).not.toHaveBeenCalledWith(messages[0]!.content)
      expect(mockWriteText).not.toHaveBeenCalledWith('const first = 1\n')
    })

    it('shows a transient copied indicator on the clicked button without affecting the others', async () => {
      mockWriteText.mockResolvedValue(true)
      const messages: ChatViewMessage[] = [
        { id: 'r1', type: 'response', content: '```\nblock one\n```\n\n```\nblock two\n```', timestamp: 1 },
      ]
      render(<ChatView messages={messages} isStreaming={false} />)
      const codeCopyButtons = screen.getAllByTestId('code-copy-button')
      const first = codeCopyButtons[0]!
      const second = codeCopyButtons[1]!
      fireEvent.click(first)
      await waitFor(() => expect(first).toHaveAttribute('data-copied', 'true'))
      expect(second).not.toHaveAttribute('data-copied')
    })

    it('clicking the copy button does not trigger the #6625 markdown link-click handler on the same container', () => {
      // A code block sits in the same dangerouslySetInnerHTML container as any
      // rendered links; the copy click must not fall through to link handling.
      mockWriteText.mockResolvedValue(true)
      const messages: ChatViewMessage[] = [
        { id: 'r1', type: 'response', content: 'see https://example.com\n\n```\nsnippet\n```', timestamp: 1 },
      ]
      render(<ChatView messages={messages} isStreaming={false} />)
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
      fireEvent.click(screen.getByTestId('code-copy-button'), { metaKey: true })
      expect(openSpy).not.toHaveBeenCalled()
      openSpy.mockRestore()
    })
  })

  it('previews image + document attachments on a sent user message (#6632)', () => {
    const messages: ChatViewMessage[] = [
      {
        id: 'u1',
        type: 'user_input',
        content: 'here you go',
        timestamp: 1,
        attachments: [
          { id: 'img-1', type: 'image', uri: 'data:image/png;base64,abc', name: 'shot.png', mediaType: 'image/png', size: 10 },
          { id: 'doc-1', type: 'document', uri: 'blob:x', name: 'notes.pdf', mediaType: 'application/pdf', size: 20 },
          // #6632: a resumed-session image whose data: URI was stripped by
          // persistence → renders a filename chip, NOT a broken <img>.
          { id: 'img-stripped', type: 'image', uri: '[data stripped]', name: 'old.png', mediaType: 'image/png', size: 0 },
        ],
      },
    ]
    render(<ChatView messages={messages} isStreaming={false} />)
    const img = screen.getByTestId('msg-attachment-image-img-1')
    expect(img).toHaveAttribute('src', 'data:image/png;base64,abc')
    expect(img).toHaveAttribute('alt', 'shot.png')
    expect(screen.getByTestId('msg-attachment-doc-doc-1')).toHaveTextContent('notes.pdf')
    // stripped image → chip fallback (filename shown), no broken <img>
    expect(screen.queryByTestId('msg-attachment-image-img-stripped')).not.toBeInTheDocument()
    expect(screen.getByTestId('msg-attachment-doc-img-stripped')).toHaveTextContent('old.png')
  })

  it('renders no attachment container on a message without attachments (#6632)', () => {
    render(<ChatView messages={[{ id: 'u2', type: 'user_input', content: 'plain', timestamp: 1 }]} isStreaming={false} />)
    expect(screen.queryByTestId('msg-attachments-u2')).not.toBeInTheDocument()
  })

  it('renders thinking as a collapsed disclosure (chat redesign #6391)', () => {
    const messages: ChatViewMessage[] = [
      { id: 't1', type: 'thinking', content: 'deep-secret-reasoning', timestamp: Date.now() },
    ]
    render(<ChatView messages={messages} isStreaming={false} />)
    const toggle = screen.getByTestId('thinking-toggle')
    expect(toggle).toHaveTextContent('Thought')
    // collapsed by default — the full reasoning is hidden
    expect(screen.queryByText('deep-secret-reasoning')).not.toBeInTheDocument()
    fireEvent.click(toggle)
    expect(screen.getByText('deep-secret-reasoning')).toBeInTheDocument()
  })

  // #6756 — real streamed reasoning content feeds ThinkingBody, with the
  // "Thinking…" vs "Thought" label driven by the `thinkingStreaming` flag
  // (distinct from the response `isStreaming`).
  it('labels ThinkingBody "Thinking…" while thinkingStreaming and reveals real content (#6756)', () => {
    const messages: ChatViewMessage[] = [
      { id: 'msg-1-thinking-0', type: 'thinking', content: 'weighing the options', thinkingStreaming: true, timestamp: Date.now() },
    ]
    render(<ChatView messages={messages} isStreaming={false} />)
    const toggle = screen.getByTestId('thinking-toggle')
    expect(toggle).toHaveTextContent('Thinking…')
    fireEvent.click(toggle)
    expect(screen.getByText('weighing the options')).toBeInTheDocument()
  })

  it('flips ThinkingBody to "Thought" once thinkingStreaming is false (#6756)', () => {
    const messages: ChatViewMessage[] = [
      { id: 'msg-1-thinking-0', type: 'thinking', content: 'settled reasoning', thinkingStreaming: false, timestamp: Date.now() },
    ]
    render(<ChatView messages={messages} isStreaming={false} />)
    expect(screen.getByTestId('thinking-toggle')).toHaveTextContent('Thought')
  })

  // #6391 footer-stat — a finished thinking bubble carrying a measured duration
  // (+ token count) renders the compact `thought for Xs · N tokens` footer in
  // place of the bare "Thought" label.
  it('renders the footer-stat "thought for Xs · N tokens" when duration + tokens are present (#6391)', () => {
    const messages: ChatViewMessage[] = [
      { id: 't1', type: 'thinking', content: 'reasoning', thinkingStreaming: false, thinkingDurationMs: 4200, thinkingTokens: 128, timestamp: Date.now() },
    ]
    render(<ChatView messages={messages} isStreaming={false} />)
    expect(screen.getByTestId('thinking-toggle')).toHaveTextContent('thought for 4.2s · 128 tokens')
  })

  it('renders the footer-stat with duration alone when tokens are absent (claude SDK/BYOK) (#6391)', () => {
    const messages: ChatViewMessage[] = [
      { id: 't1', type: 'thinking', content: 'reasoning', thinkingStreaming: false, thinkingDurationMs: 19000, timestamp: Date.now() },
    ]
    render(<ChatView messages={messages} isStreaming={false} />)
    const toggle = screen.getByTestId('thinking-toggle')
    expect(toggle).toHaveTextContent('thought for 19s')
    expect(toggle).not.toHaveTextContent('tokens')
  })

  it('degrades to a bare "Thought" when no footer-stat is present (old sessions) (#6391)', () => {
    const messages: ChatViewMessage[] = [
      { id: 't1', type: 'thinking', content: 'reasoning', thinkingStreaming: false, timestamp: Date.now() },
    ]
    render(<ChatView messages={messages} isStreaming={false} />)
    const toggle = screen.getByTestId('thinking-toggle')
    expect(toggle).toHaveTextContent('Thought')
    expect(toggle).not.toHaveTextContent('thought for')
  })

  it('shows "Thinking…" (not the footer) while streaming even if a stale duration is set (#6391)', () => {
    const messages: ChatViewMessage[] = [
      { id: 't1', type: 'thinking', content: 'reasoning', thinkingStreaming: true, thinkingDurationMs: 4200, timestamp: Date.now() },
    ]
    render(<ChatView messages={messages} isStreaming={false} />)
    const toggle = screen.getByTestId('thinking-toggle')
    expect(toggle).toHaveTextContent('Thinking…')
    expect(toggle).not.toHaveTextContent('thought for')
  })

  it('surfaces a "[thinking truncated]" marker when the content hit the size cap (#6756)', () => {
    const messages: ChatViewMessage[] = [
      { id: 'msg-1-thinking-0', type: 'thinking', content: 'capped reasoning', thinkingStreaming: false, thinkingTruncated: true, timestamp: Date.now() },
    ]
    render(<ChatView messages={messages} isStreaming={false} />)
    fireEvent.click(screen.getByTestId('thinking-toggle'))
    expect(screen.getByTestId('thinking-truncated')).toHaveTextContent('[thinking truncated]')
    // …and no marker without the flag.
    cleanup()
    render(
      <ChatView
        messages={[{ id: 't2', type: 'thinking', content: 'full reasoning', thinkingStreaming: false, timestamp: Date.now() }]}
        isStreaming={false}
      />,
    )
    fireEvent.click(screen.getByTestId('thinking-toggle'))
    expect(screen.queryByTestId('thinking-truncated')).not.toBeInTheDocument()
  })

  it('renders empty state when no messages', () => {
    render(<ChatView messages={[]} isStreaming={false} />)
    expect(screen.getByTestId('chat-view')).toBeInTheDocument()
  })

  it('renders the presence rail reflecting the chat-activity state (chat redesign #6392)', () => {
    render(<ChatView messages={makeMessages(2)} isStreaming={false} chatActivityState="thinking" />)
    const rail = screen.getByTestId('presence-rail')
    expect(rail).toHaveAttribute('data-activity-state', 'thinking')
    // ambient decoration — hidden from assistive tech
    expect(rail).toHaveAttribute('aria-hidden', 'true')
  })

  it('defaults the presence rail to idle when no activity state is given (chat redesign #6392)', () => {
    render(<ChatView messages={makeMessages(1)} isStreaming={false} />)
    expect(screen.getByTestId('presence-rail')).toHaveAttribute('data-activity-state', 'idle')
  })

  it('paints the presence rail with the in-flight tool colour via --rail-color (chat redesign #6392)', () => {
    const { rerender } = render(
      <ChatView messages={makeMessages(2)} isStreaming={false} chatActivityState="busy" inFlightToolColor="var(--accent-blue)" />,
    )
    const rail = screen.getByTestId('presence-rail')
    // Inline --rail-color wins the cascade so the busy rule paints the tool colour.
    expect(rail.style.getPropertyValue('--rail-color')).toBe('var(--accent-blue)')
    // No tool in flight → no override; the rail keeps its activity-state colour.
    rerender(<ChatView messages={makeMessages(2)} isStreaming={false} chatActivityState="busy" />)
    expect(screen.getByTestId('presence-rail').style.getPropertyValue('--rail-color')).toBe('')
  })

  it('the busy + thinking rail rules consume --rail-color (tool colour overrides); waiting/error stay fixed (chat redesign #6392)', () => {
    expect(componentsCss).toMatch(/presence-rail\[data-activity-state="busy"\]\s*\{[^}]*background:\s*var\(--rail-color,\s*var\(--accent-purple\)\)/)
    expect(componentsCss).toMatch(/presence-rail\[data-activity-state="thinking"\]\s*\{[^}]*background:\s*var\(--rail-color,\s*var\(--accent-blue\)\)/)
    // waiting + error keep their fixed signal colours — they must NOT read --rail-color.
    expect(componentsCss).not.toMatch(/presence-rail\[data-activity-state="waiting"\]\s*\{[^}]*--rail-color/)
    expect(componentsCss).not.toMatch(/presence-rail\[data-activity-state="error"\]\s*\{[^}]*--rail-color/)
  })

  it('numbers queued follow-ups by send order when more than one is queued (chat redesign #6392)', () => {
    render(
      <ChatView
        messages={makeMessages(3)}
        isStreaming={false}
        queuedIds={new Set(['msg-1', 'msg-2'])}
        onCancelQueued={() => {}}
      />,
    )
    expect(screen.getByTestId('msg-queued-position-msg-1')).toHaveTextContent('#1')
    expect(screen.getByTestId('msg-queued-position-msg-2')).toHaveTextContent('#2')
  })

  it('omits the position for a single queued follow-up (chat redesign #6392)', () => {
    render(
      <ChatView
        messages={makeMessages(2)}
        isStreaming={false}
        queuedIds={new Set(['msg-1'])}
        onCancelQueued={() => {}}
      />,
    )
    // Still flagged as queued, just no redundant "#1".
    expect(screen.getByTestId('msg-queued-msg-1')).toBeInTheDocument()
    expect(screen.queryByTestId('msg-queued-position-msg-1')).not.toBeInTheDocument()
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

  // #5953 — the streaming tail shows the labelled WorkingIndicator.
  it('shows the working indicator with the generic default label when streaming', () => {
    render(<ChatView messages={makeMessages(1)} isStreaming />)
    expect(screen.getByTestId('working-indicator')).toBeInTheDocument()
    expect(screen.getByTestId('working-label')).toHaveTextContent('Claude is working…')
  })

  it('surfaces the in-flight activity via workingLabel', () => {
    render(<ChatView messages={makeMessages(1)} isStreaming workingLabel="Running Bash…" />)
    expect(screen.getByTestId('working-label')).toHaveTextContent('Running Bash…')
  })

  it('hides the working indicator when idle', () => {
    render(<ChatView messages={makeMessages(1)} isStreaming={false} isBusy={false} workingLabel="Running Bash…" />)
    expect(screen.queryByTestId('working-indicator')).not.toBeInTheDocument()
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

  // #5939 (epic #5935 ④): queued send-while-busy follow-ups render a "Queued"
  // badge + cancel affordance on the matching user_input bubble.
  describe('queued-message badge (#5939)', () => {
    const userMsg: ChatViewMessage = { id: 'uin-1', type: 'user_input', content: 'follow-up', timestamp: Date.now() }

    it('renders a Queued badge on a user bubble whose id is in queuedIds', () => {
      render(<ChatView messages={[userMsg]} isStreaming queuedIds={new Set(['uin-1'])} />)
      expect(screen.getByTestId('msg-queued-uin-1')).toBeInTheDocument()
      expect(screen.getByText('Queued')).toBeInTheDocument()
    })

    it('does NOT render a badge when the id is not queued', () => {
      render(<ChatView messages={[userMsg]} isStreaming={false} queuedIds={new Set()} />)
      expect(screen.queryByTestId('msg-queued-uin-1')).not.toBeInTheDocument()
    })

    it('renders a cancel button that calls onCancelQueued with the message id', () => {
      const onCancelQueued = vi.fn()
      render(<ChatView messages={[userMsg]} isStreaming queuedIds={new Set(['uin-1'])} onCancelQueued={onCancelQueued} />)
      fireEvent.click(screen.getByTestId('msg-queued-cancel-uin-1'))
      expect(onCancelQueued).toHaveBeenCalledTimes(1)
      expect(onCancelQueued).toHaveBeenCalledWith('uin-1')
    })

    it('omits the cancel button when no onCancelQueued is supplied', () => {
      render(<ChatView messages={[userMsg]} isStreaming queuedIds={new Set(['uin-1'])} />)
      expect(screen.getByTestId('msg-queued-uin-1')).toBeInTheDocument()
      expect(screen.queryByTestId('msg-queued-cancel-uin-1')).not.toBeInTheDocument()
    })

    // #6628 — edit a still-queued follow-up: reopen its text in the composer and
    // cancel the queued entry.
    it('renders an edit button that calls onEditQueued with the id and message text', () => {
      const onEditQueued = vi.fn()
      render(<ChatView messages={[userMsg]} isStreaming queuedIds={new Set(['uin-1'])} onEditQueued={onEditQueued} />)
      fireEvent.click(screen.getByTestId('msg-queued-edit-uin-1'))
      expect(onEditQueued).toHaveBeenCalledTimes(1)
      expect(onEditQueued).toHaveBeenCalledWith('uin-1', 'follow-up')
    })

    it('omits the edit button when no onEditQueued is supplied', () => {
      render(<ChatView messages={[userMsg]} isStreaming queuedIds={new Set(['uin-1'])} onCancelQueued={() => {}} />)
      expect(screen.getByTestId('msg-queued-cancel-uin-1')).toBeInTheDocument()
      expect(screen.queryByTestId('msg-queued-edit-uin-1')).not.toBeInTheDocument()
    })
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

  // #5954 — behavior guard: the streaming RAF keeps re-pinning to the growing
  // bottom, and an at-bottom self-induced scroll does not surface the
  // scroll-to-bottom button. NOTE: this is a happy-path guard, not a regression
  // test for the deferred-flag-clear fix specifically — the exact
  // synchronous-vs-next-frame `programmaticScrollRef` timing depends on the
  // browser's async scroll-event dispatch ordering, which jsdom doesn't model,
  // so it would also pass on the pre-fix code. The suppression fix is verified
  // by reasoning + on-device confirmation (#5954 stays open for the live check).
  it('keeps following the bottom while streaming as content grows (#5954)', async () => {
    vi.useFakeTimers()
    render(<ChatView messages={makeMessages(3)} isStreaming />)
    const container = screen.getByTestId('chat-messages')
    Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(container, 'scrollTop', { value: 0, writable: true, configurable: true })
    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true })

    // Streaming RAF pins to the current bottom.
    await act(() => { vi.advanceTimersByTime(50) })
    expect(container.scrollTop).toBe(1000)

    // Content grows (a stream_delta) — the RAF re-pins to the NEW bottom.
    Object.defineProperty(container, 'scrollHeight', { value: 1500, configurable: true })
    await act(() => { vi.advanceTimersByTime(50) })
    expect(container.scrollTop).toBe(1500)

    // The self-induced scroll event (flag still held) must NOT surface the
    // scroll-to-bottom button — i.e. it isn't misread as a user scroll-up.
    await act(() => { fireEvent.scroll(container) })
    expect(screen.queryByTestId('scroll-to-bottom')).not.toBeInTheDocument()
    vi.useRealTimers()
  })

  // #5954 (occlusion) — when the input area grows (multi-line textarea,
  // attachments, the activity / check-in chips appearing) the `.chat-messages`
  // viewport shrinks, which fires the container's ResizeObserver. While the user
  // is following the tail, the observer must re-pin to the bottom so the newest
  // lines stay ABOVE the input bar instead of sliding below the now-shorter
  // fold. jsdom has no ResizeObserver, so install a controllable one (the same
  // pattern as the virtualization test) and fire the container's callback by
  // hand after shrinking `clientHeight`.
  // NOTE: this positive case is tautological in isolation — `userScrolledUp`
  // defaults to false, so it would pass even if the `userScrolledUpRef` gate were
  // broken. The scrolled-up negative test directly below is the load-bearing one
  // (it proves the ref gate actually suppresses the re-pin); keep both.
  it('re-pins to the bottom when the input area grows while following (#5954)', async () => {
    type Entry = { el: HTMLElement; cb: ResizeObserverCallback }
    const observers: Entry[] = []
    class MockRO {
      cb: ResizeObserverCallback
      constructor(cb: ResizeObserverCallback) { this.cb = cb }
      observe(el: Element) { observers.push({ el: el as HTMLElement, cb: this.cb }) }
      unobserve() {}
      disconnect() {}
    }
    const origRO = globalThis.ResizeObserver
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
      MockRO as unknown as typeof ResizeObserver
    try {
      render(<ChatView messages={makeMessages(3)} isStreaming={false} />)
      const container = screen.getByTestId('chat-messages')
      // Following the tail: at bottom, user has not scrolled up.
      Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true })
      Object.defineProperty(container, 'scrollTop', { value: 1000, writable: true, configurable: true })
      Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true })

      // The input area grows → the viewport shrinks and the browser leaves the
      // tail below the new fold (scrollTop now short of the new bottom).
      container.scrollTop = 600
      Object.defineProperty(container, 'clientHeight', { value: 250, configurable: true })

      // Fire the container's ResizeObserver (the real reflow path). The observer
      // re-pins to the bottom because the user is still following.
      const containerRO = observers.find(o => o.el === container)
      expect(containerRO).toBeTruthy()
      await act(async () => { containerRO!.cb([], containerRO as unknown as ResizeObserver) })
      expect(container.scrollTop).toBe(1000)
    } finally {
      ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = origRO
    }
  })

  it('does NOT re-pin on resize when the user has scrolled up (#5954 / #4652)', async () => {
    type Entry = { el: HTMLElement; cb: ResizeObserverCallback }
    const observers: Entry[] = []
    class MockRO {
      cb: ResizeObserverCallback
      constructor(cb: ResizeObserverCallback) { this.cb = cb }
      observe(el: Element) { observers.push({ el: el as HTMLElement, cb: this.cb }) }
      unobserve() {}
      disconnect() {}
    }
    const origRO = globalThis.ResizeObserver
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
      MockRO as unknown as typeof ResizeObserver
    try {
      render(<ChatView messages={makeMessages(3)} isStreaming={false} />)
      const container = screen.getByTestId('chat-messages')
      Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true })
      Object.defineProperty(container, 'scrollTop', { value: 100, writable: true, configurable: true })
      Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true })
      // User deliberately scrolled up to read history.
      await act(async () => { fireEvent.scroll(container) })
      expect(screen.getByTestId('scroll-to-bottom')).toBeInTheDocument()

      // The input area grows; the observer must leave the reading position alone.
      Object.defineProperty(container, 'clientHeight', { value: 250, configurable: true })
      const containerRO = observers.find(o => o.el === container)
      expect(containerRO).toBeTruthy()
      await act(async () => { containerRO!.cb([], containerRO as unknown as ResizeObserver) })
      expect(container.scrollTop).toBe(100)
    } finally {
      ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = origRO
    }
  })

  it('snaps to bottom when scrollToBottomSignal bumps, even if scrolled up (#5780)', async () => {
    vi.useFakeTimers()
    const messages = makeMessages(3)
    const { rerender } = render(
      <ChatView messages={messages} isStreaming={false} scrollToBottomSignal={0} />,
    )
    const container = screen.getByTestId('chat-messages')

    Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(container, 'scrollTop', { value: 1000, writable: true, configurable: true })
    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true })
    await act(() => { vi.advanceTimersByTime(50) })

    // User scrolls up to read history — the scroll-to-bottom button appears
    // and the count-change auto-follow would now leave them in place.
    container.scrollTop = 100
    await act(() => { fireEvent.scroll(container) })
    expect(screen.getByTestId('scroll-to-bottom')).toBeInTheDocument()

    // User sends a message: the parent bumps the signal. Even though they were
    // scrolled up, the explicit action snaps the view back to the bottom and
    // clears the scrolled-up flag (button disappears).
    rerender(<ChatView messages={makeMessages(4)} isStreaming={false} scrollToBottomSignal={1} />)
    await act(() => { vi.advanceTimersByTime(50) })
    expect(container.scrollTop).toBe(1000)
    expect(screen.queryByTestId('scroll-to-bottom')).not.toBeInTheDocument()
    vi.useRealTimers()
  })

  it('does not scroll on the initial scrollToBottomSignal value (#5780)', async () => {
    vi.useFakeTimers()
    const messages = makeMessages(3)
    render(<ChatView messages={messages} isStreaming={false} scrollToBottomSignal={7} />)
    const container = screen.getByTestId('chat-messages')

    Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(container, 'scrollTop', { value: 1000, writable: true, configurable: true })
    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true })
    await act(() => { vi.advanceTimersByTime(50) })

    // Scroll up; the initial signal value must NOT pull the view back down
    // (only a genuine change to the nonce triggers the jump).
    container.scrollTop = 100
    await act(() => { fireEvent.scroll(container) })
    await act(() => { vi.advanceTimersByTime(50) })
    expect(container.scrollTop).toBe(100)
    expect(screen.getByTestId('scroll-to-bottom')).toBeInTheDocument()
    vi.useRealTimers()
  })

  it('does not snap to bottom when scrollToBottomSignal is unchanged across a rerender (#5786)', async () => {
    // After the #5786 DRY refactor the signal effect routes through the shared
    // scrollToBottomNow() helper. This guards the lastScrollSignalRef compare on
    // a *live* rerender (distinct from the initial-value test): a prop churn that
    // re-renders ChatView without bumping the nonce must NOT force-scroll a user
    // who has scrolled up to read history.
    vi.useFakeTimers()
    const messages = makeMessages(3)
    const { rerender } = render(
      <ChatView messages={messages} isStreaming={false} scrollToBottomSignal={2} />,
    )
    const container = screen.getByTestId('chat-messages')

    Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(container, 'scrollTop', { value: 1000, writable: true, configurable: true })
    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true })
    await act(() => { vi.advanceTimersByTime(50) })

    // User scrolls up to read history.
    container.scrollTop = 100
    await act(() => { fireEvent.scroll(container) })
    expect(screen.getByTestId('scroll-to-bottom')).toBeInTheDocument()

    // Rerender with the SAME signal value (a no-op prop churn, e.g. a new
    // renderMessage identity). The view must stay put.
    rerender(<ChatView messages={messages} isStreaming={false} scrollToBottomSignal={2} />)
    await act(() => { vi.advanceTimersByTime(50) })
    expect(container.scrollTop).toBe(100)
    expect(screen.getByTestId('scroll-to-bottom')).toBeInTheDocument()
    vi.useRealTimers()
  })

  it('snaps to bottom via the shared helper when scrollToBottomSignal bumps after refactor (#5786)', async () => {
    // Companion to the #5780 bump test: confirms the extracted scrollToBottomNow()
    // path still snaps to bottom (programmaticScrollRef + scrollTop = scrollHeight
    // + RAF reset) when the nonce changes across two distinct, non-initial values.
    vi.useFakeTimers()
    const messages = makeMessages(3)
    const { rerender } = render(
      <ChatView messages={messages} isStreaming={false} scrollToBottomSignal={5} />,
    )
    const container = screen.getByTestId('chat-messages')

    Object.defineProperty(container, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(container, 'scrollTop', { value: 1000, writable: true, configurable: true })
    Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true })
    await act(() => { vi.advanceTimersByTime(50) })

    container.scrollTop = 100
    await act(() => { fireEvent.scroll(container) })
    expect(screen.getByTestId('scroll-to-bottom')).toBeInTheDocument()

    // Approve/answer-style bump (the App-level wiring increments the same nonce).
    rerender(<ChatView messages={messages} isStreaming={false} scrollToBottomSignal={6} />)
    await act(() => { vi.advanceTimersByTime(50) })
    expect(container.scrollTop).toBe(1000)
    expect(screen.queryByTestId('scroll-to-bottom')).not.toBeInTheDocument()
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
