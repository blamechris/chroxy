/**
 * TranscriptViewer tests (#6863, epic #6765).
 *
 * Covers the loading/empty/error/ready states, the structural read-only
 * guarantee (no composer/input rendered anywhere), and that a fetched
 * transcript renders through the shared ChatView renderer.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { TranscriptViewer } from './TranscriptViewer'
import type { ChatMessage } from '@chroxy/store-core'

afterEach(cleanup)

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    type: 'response',
    content: 'Hello from the transcript',
    timestamp: Date.parse('2026-03-01T12:00:00Z'),
    ...overrides,
  }
}

describe('TranscriptViewer (#6863)', () => {
  it('shows a loading indicator while status is loading', () => {
    render(
      <TranscriptViewer
        conversationId="conv-1"
        status="loading"
        messages={[]}
        error={null}
        onClose={vi.fn()}
        onRetry={vi.fn()}
      />,
    )
    expect(screen.getByTestId('transcript-viewer-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('transcript-viewer-error')).not.toBeInTheDocument()
    expect(screen.queryByTestId('transcript-viewer-empty')).not.toBeInTheDocument()
  })

  it('shows an empty state when the transcript has no messages', () => {
    render(
      <TranscriptViewer
        conversationId="conv-1"
        status="ready"
        messages={[]}
        error={null}
        onClose={vi.fn()}
        onRetry={vi.fn()}
      />,
    )
    expect(screen.getByTestId('transcript-viewer-empty')).toBeInTheDocument()
    expect(screen.queryByTestId('chat-view')).not.toBeInTheDocument()
  })

  it('shows a clear error state without crashing, and offers Retry', () => {
    render(
      <TranscriptViewer
        conversationId="conv-1"
        status="error"
        messages={[]}
        error="Conversation not found: conv-1"
        onClose={vi.fn()}
        onRetry={vi.fn()}
      />,
    )
    const errorEl = screen.getByTestId('transcript-viewer-error')
    expect(errorEl).toHaveTextContent('Conversation not found: conv-1')
    expect(screen.getByTestId('transcript-viewer-retry')).toBeInTheDocument()
  })

  it('falls back to a generic error message when none is provided', () => {
    render(
      <TranscriptViewer
        conversationId="conv-1"
        status="error"
        messages={[]}
        error={null}
        onClose={vi.fn()}
        onRetry={vi.fn()}
      />,
    )
    expect(screen.getByTestId('transcript-viewer-error')).toHaveTextContent('Failed to load transcript.')
  })

  it('clicking Retry calls onRetry', () => {
    const onRetry = vi.fn()
    render(
      <TranscriptViewer
        conversationId="conv-1"
        status="error"
        messages={[]}
        error="boom"
        onClose={vi.fn()}
        onRetry={onRetry}
      />,
    )
    fireEvent.click(screen.getByTestId('transcript-viewer-retry'))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('renders a fetched transcript using the shared chat renderer', () => {
    render(
      <TranscriptViewer
        conversationId="conv-1"
        status="ready"
        messages={[
          makeMessage({ id: 'u1', type: 'user_input', content: 'What does this function do?' }),
          makeMessage({ id: 'r1', type: 'response', content: 'It reads a file.' }),
        ]}
        error={null}
        onClose={vi.fn()}
        onRetry={vi.fn()}
      />,
    )
    expect(screen.getByTestId('chat-view')).toBeInTheDocument()
    expect(screen.getByText('What does this function do?')).toBeInTheDocument()
    expect(screen.getByText('It reads a file.')).toBeInTheDocument()
  })

  it('clicking Close calls onClose', () => {
    const onClose = vi.fn()
    render(
      <TranscriptViewer
        conversationId="conv-1"
        status="ready"
        messages={[]}
        error={null}
        onClose={onClose}
        onRetry={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('transcript-viewer-close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('carries the conversationId onto the transcript body for correlation', () => {
    render(
      <TranscriptViewer
        conversationId="conv-abc-123"
        status="ready"
        messages={[]}
        error={null}
        onClose={vi.fn()}
        onRetry={vi.fn()}
      />,
    )
    expect(screen.getByTestId('transcript-viewer-body')).toHaveAttribute('data-conversation-id', 'conv-abc-123')
  })

  // Structural read-only guarantee: NO composer/input control anywhere in
  // this component's tree, in any status — not just "the button is hidden".
  describe('read-only structural guarantee', () => {
    const statuses: Array<{ status: 'loading' | 'ready' | 'error'; messages: ChatMessage[]; error: string | null }> = [
      { status: 'loading', messages: [], error: null },
      { status: 'ready', messages: [makeMessage()], error: null },
      { status: 'error', messages: [], error: 'boom' },
    ]

    for (const { status, messages, error } of statuses) {
      it(`renders no composer/input-bar or textarea while status is ${status}`, () => {
        render(
          <TranscriptViewer
            conversationId="conv-1"
            status={status}
            messages={messages}
            error={error}
            onClose={vi.fn()}
            onRetry={vi.fn()}
          />,
        )
        expect(screen.queryByTestId('input-bar')).not.toBeInTheDocument()
        expect(document.querySelector('textarea')).toBeNull()
      })
    }

    it('renders no permission/question prompt approve-or-answer controls for an unresolved prompt entry', () => {
      // A permission-request-shaped entry (requestId + expiresAt + unanswered)
      // — in the live view this would render the INTERACTIVE PermissionPrompt
      // with an onRespond wired to a real decision. The transcript viewer must
      // never wire that; it's expected to fall back to a plain read-only bubble.
      render(
        <TranscriptViewer
          conversationId="conv-1"
          status="ready"
          messages={[
            makeMessage({
              id: 'p1',
              type: 'prompt',
              content: 'Bash: rm -rf /tmp/scratch',
              requestId: 'req-1',
              tool: 'Bash',
            }),
          ]}
          error={null}
          onClose={vi.fn()}
          onRetry={vi.fn()}
        />,
      )
      // No approve/deny/allow control of any kind should be present.
      expect(screen.queryByRole('button', { name: /allow/i })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /deny/i })).not.toBeInTheDocument()
    })
  })
})
