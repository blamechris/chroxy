/**
 * #8231 — the first-run "Nothing here yet" hint must never tell the user a
 * session with history is empty. `messages` stays [] for the whole replay that
 * follows `session_switched`, so the hint waits for (a) no replay window open
 * AND (b) a settle window since the session/phase last changed.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { reconcileReplayStart, reconcileReplayEnd, resetReplayReconcile } from '@chroxy/store-core'
import { ChatView, EMPTY_HINT_SETTLE_MS, type ChatViewMessage } from './ChatView'
import { useReplayInProgress } from '../hooks/useReplayInProgress'

const msg = (id: string): ChatViewMessage => ({ id, type: 'user_input', content: id, timestamp: 1 })

function Harness({ sid, messages, phase = 'connected' }: { sid: string; messages: ChatViewMessage[]; phase?: string }) {
  const replaying = useReplayInProgress(sid)
  return (
    <ChatView
      messages={messages}
      isStreaming={false}
      loading={phase !== 'connected'}
      replaying={replaying}
      settleKey={`${sid}|${phase}`}
    />
  )
}

const hint = () => screen.queryByTestId('chat-empty-hint')
const settle = () => act(() => { vi.advanceTimersByTime(EMPTY_HINT_SETTLE_MS + 1) })

beforeEach(() => { vi.useFakeTimers(); resetReplayReconcile({ clearCursors: true }) })
afterEach(() => { cleanup(); resetReplayReconcile({ clearCursors: true }); vi.useRealTimers() })

describe('first-run hint gating (#8231)', () => {
  it('an empty session with no replay frames shows the hint only after the settle window', () => {
    render(<Harness sid="s1" messages={[]} />)
    expect(hint()).toBeNull()
    act(() => { vi.advanceTimersByTime(EMPTY_HINT_SETTLE_MS - 10) })
    expect(hint()).toBeNull()
    settle()
    expect(hint()!.textContent).toContain('Type a message below to start')
  })

  it('an uncached switch: the hint is never shown between replay start and the messages landing', () => {
    const { rerender } = render(<Harness sid="s1" messages={[msg('a')]} />)
    settle()
    // switch to s2: replay opens before the settle window ends, frames take a while
    rerender(<Harness sid="s2" messages={[]} />)
    act(() => { reconcileReplayStart('s2', true, [], 0) })
    expect(hint()).toBeNull()
    settle() // settle window passes while the replay is still streaming
    expect(hint()).toBeNull()
    act(() => { reconcileReplayEnd('s2', [msg('x')], 1) })
    rerender(<Harness sid="s2" messages={[msg('x')]} />)
    expect(hint()).toBeNull()
  })

  it('the hint hides as soon as a replay starts', () => {
    render(<Harness sid="s1" messages={[]} />)
    settle()
    expect(hint()).not.toBeNull()
    act(() => { reconcileReplayStart('s1', true, [], 0) })
    expect(hint()).toBeNull()
  })

  it('an abandoned replay (disconnect reset) releases the gate', () => {
    render(<Harness sid="s1" messages={[]} />)
    act(() => { reconcileReplayStart('s1', true, [], 0) })
    settle()
    expect(hint()).toBeNull()
    act(() => { resetReplayReconcile() })
    expect(hint()).not.toBeNull()
  })

  it('is hidden while the connection is not settled, and restarts the window on a phase change', () => {
    const { rerender } = render(<Harness sid="s1" messages={[]} />)
    settle()
    expect(hint()).not.toBeNull()
    rerender(<Harness sid="s1" messages={[]} phase="reconnecting" />)
    settle()
    expect(hint()).toBeNull()
    rerender(<Harness sid="s1" messages={[]} />)
    expect(hint()).toBeNull() // window restarted
    settle()
    expect(hint()).not.toBeNull()
  })

  it('hides once any message exists', () => {
    const { rerender } = render(<Harness sid="s1" messages={[]} />)
    settle()
    expect(hint()).not.toBeNull()
    rerender(<Harness sid="s1" messages={[msg('a')]} />)
    expect(hint()).toBeNull()
  })

  it('a key change shows no hint in the very render it happens (no stale settled frame)', () => {
    const seen: boolean[] = []
    function Probe({ k }: { k: string }) {
      // Records what ChatView committed for this render pass via a layout-time DOM read.
      return (
        <div ref={(el) => { if (el) seen.push(el.querySelector('[data-testid="chat-empty-hint"]') !== null) }}>
          <ChatView messages={[]} isStreaming={false} settleKey={k} />
        </div>
      )
    }
    const { rerender } = render(<Probe k="A" />)
    settle()
    expect(hint()).not.toBeNull()
    seen.length = 0
    // Not wrapped in act's effect flush: rerender is, but the ref callback sees
    // the FIRST committed DOM of the new key before effects run.
    rerender(<Probe k="B" />)
    expect(seen[0]).toBe(false)
    expect(hint()).toBeNull()
    settle()
    expect(hint()).not.toBeNull()
  })
})
