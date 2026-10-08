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

  // #7365 review (S2) — integration coverage the reviewer found missing: the
  // reviewer mutated `summary.requestIds[0]` to the LAST index at this
  // component's own call site (TranscriptViewer.tsx) and every existing test
  // stayed green, because nothing here exercised the real splice-then-render
  // path for a `permission-expired-summary` row.
  describe('end-of-turn permission-expired summary (#7365)', () => {
    it('renders the summary for a closed conversation, jump link targeting the FIRST expired prompt', () => {
      const past = Date.now() - 1000
      render(
        <TranscriptViewer
          conversationId="conv-1"
          status="ready"
          messages={[
            makeMessage({ id: 'u1', type: 'user_input', content: 'do the thing' }),
            makeMessage({ id: 'p1', type: 'prompt', content: 'Bash: rm -rf /tmp/scratch', requestId: 'req-1', tool: 'Bash', expiresAt: past }),
            makeMessage({ id: 'p2', type: 'prompt', content: 'Write: scratch.txt', requestId: 'req-2', tool: 'Write', expiresAt: past }),
          ]}
          error={null}
          onClose={vi.fn()}
          onRetry={vi.fn()}
        />,
      )
      const summaryEl = screen.getByTestId('permission-expired-summary')
      expect(summaryEl).toHaveTextContent('2 permissions expired without a response')
      const link = screen.getByTestId('permission-expired-summary-jump')
      expect(link).toHaveAttribute('href', '#perm-desc-req-1')
      expect(link).not.toHaveAttribute('href', '#perm-desc-req-2')
    })

    it('renders no summary when every permission in the transcript was answered', () => {
      render(
        <TranscriptViewer
          conversationId="conv-1"
          status="ready"
          messages={[
            makeMessage({ id: 'u1', type: 'user_input', content: 'do the thing' }),
            makeMessage({ id: 'p1', type: 'prompt', content: 'Bash: ls', requestId: 'req-1', tool: 'Bash', answered: 'allow' }),
          ]}
          error={null}
          onClose={vi.fn()}
          onRetry={vi.fn()}
        />,
      )
      expect(screen.queryByTestId('permission-expired-summary')).not.toBeInTheDocument()
    })

    // #7365 review round 3 (Critical #1) — a closed conversation has no
    // `result` entry to mark a `turnBoundary` on at all (the JSONL transcript
    // this component's data comes from never carries one), so it must use
    // `user_input` position instead — verified end-to-end here rather than
    // just at the pure-aggregator level, since the bug was "the whole
    // conversation collapses into one card".
    it('a closed conversation with an expired permission in EACH of 2 turns renders 2 separate cards', () => {
      const past = Date.now() - 1000
      render(
        <TranscriptViewer
          conversationId="conv-1"
          status="ready"
          messages={[
            makeMessage({ id: 'u1', type: 'user_input', content: 'first thing' }),
            makeMessage({ id: 'p1', type: 'prompt', content: 'Bash: ls', requestId: 'req-1', tool: 'Bash', expiresAt: past }),
            makeMessage({ id: 'r1', type: 'response', content: 'done with the first thing' }),
            makeMessage({ id: 'u2', type: 'user_input', content: 'second thing' }),
            makeMessage({ id: 'p2', type: 'prompt', content: 'Write: out.txt', requestId: 'req-2', tool: 'Write', expiresAt: past }),
            makeMessage({ id: 'r2', type: 'response', content: 'done with the second thing' }),
          ]}
          error={null}
          onClose={vi.fn()}
          onRetry={vi.fn()}
        />,
      )
      const summaryEls = screen.getAllByTestId('permission-expired-summary')
      expect(summaryEls).toHaveLength(2)
      expect(summaryEls[0]).toHaveTextContent('1 permission expired without a response')
      expect(summaryEls[1]).toHaveTextContent('1 permission expired without a response')
      const links = screen.getAllByTestId('permission-expired-summary-jump')
      expect(links[0]).toHaveAttribute('href', '#perm-desc-req-1')
      expect(links[1]).toHaveAttribute('href', '#perm-desc-req-2')
    })
  })

  // #6894 -- the live chat folds a run of identical resolved permission prompts
  // into one counted row. A closed conversation has no group payloads to draw it
  // from, so it must keep every prompt as its own line rather than a blank row.
  describe('resolved permission prompts are not grouped in a closed transcript (#6894)', () => {
    it('renders each of two identical answered prompts, with no group row', () => {
      render(
        <TranscriptViewer
          conversationId="conv-1"
          status="ready"
          messages={[
            makeMessage({ id: 'p1', type: 'prompt', content: 'Bash: ls /tmp/unique-marker', requestId: 'req-1', tool: 'Bash', answered: 'allow' }),
            makeMessage({ id: 'p2', type: 'prompt', content: 'Bash: ls /tmp/unique-marker', requestId: 'req-2', tool: 'Bash', answered: 'allow' }),
          ]}
          error={null}
          onClose={vi.fn()}
          onRetry={vi.fn()}
        />,
      )
      expect(screen.queryByTestId('perm-group')).not.toBeInTheDocument()
      expect(screen.getAllByText(/unique-marker/)).toHaveLength(2)
    })
  })
})
