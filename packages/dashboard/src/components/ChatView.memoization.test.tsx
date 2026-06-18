/**
 * ChatView memoization — #5516 (epic #5514, "smooth streaming")
 *
 * Proves the `DefaultMessageRow` memo extracted in #5516 stops non-tail chat
 * rows from re-rendering — and re-running `renderMarkdown` — on a streaming
 * delta flush.
 *
 * Before #5516 the inline `dedupedMessages.map` re-parsed markdown for EVERY
 * response row on every store update (~10×/sec while streaming). Now only the
 * row whose content changed re-renders. Render counts come from the shared
 * dev-only counter in @chroxy/store-core (keyed `ChatMessageRow:<id>`).
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { getRenderCount, resetRenderCounts } from '@chroxy/store-core'
import { ChatView, type ChatViewMessage } from './ChatView'

afterEach(cleanup)
beforeEach(() => resetRenderCounts())

function response(id: string, content: string): ChatViewMessage {
  return { id, type: 'response', content, timestamp: 1000 }
}

describe('ChatView memoization (#5516)', () => {
  it('only the streamed row re-renders (re-parses markdown) on a delta flush', () => {
    const nonTail = response('m-1', 'Earlier finished message')
    const tailV1 = response('m-2', 'Streaming so far')

    const { rerender } = render(
      <ChatView messages={[nonTail, tailV1]} isStreaming />,
    )

    expect(getRenderCount('ChatMessageRow:m-1')).toBe(1)
    expect(getRenderCount('ChatMessageRow:m-2')).toBe(1)

    // Simulate the store's delta flush: it hands ChatView a brand-new array
    // with fresh objects, but only the tail's CONTENT changed. The non-tail
    // row's scalar props are identical → memo skips it.
    const tailV2 = response('m-2', 'Streaming so far …and more tokens')
    act(() => {
      rerender(<ChatView messages={[response('m-1', 'Earlier finished message'), tailV2]} isStreaming />)
    })

    // Non-tail row must NOT re-render (no markdown re-parse).
    expect(getRenderCount('ChatMessageRow:m-1')).toBe(1)
    // Tail row re-rendered once to show the appended tokens.
    expect(getRenderCount('ChatMessageRow:m-2')).toBe(2)
  })

  it('re-renders a row when its content actually changes', () => {
    const msg = response('only', 'v1')
    const { rerender } = render(<ChatView messages={[msg]} isStreaming={false} />)
    expect(getRenderCount('ChatMessageRow:only')).toBe(1)

    act(() => {
      rerender(<ChatView messages={[response('only', 'v2')]} isStreaming={false} />)
    })
    expect(getRenderCount('ChatMessageRow:only')).toBe(2)
  })
})
