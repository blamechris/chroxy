import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  deriveChatActivity,
  type SessionChatActivity,
  type ChatActivityState,
} from './chat-activity'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('deriveChatActivity', () => {
  it('returns idle for a default (idle) session', () => {
    expect(
      deriveChatActivity({ isIdle: true, streamingMessageId: null, isPlanPending: false }).state,
    ).toBe('idle')
  })

  it('returns thinking when streaming is active', () => {
    expect(
      deriveChatActivity({ isIdle: false, streamingMessageId: 'msg-1', isPlanPending: false }).state,
    ).toBe('thinking')
  })

  it('returns waiting when a plan is pending', () => {
    expect(
      deriveChatActivity({ isIdle: false, streamingMessageId: null, isPlanPending: true }).state,
    ).toBe('waiting')
  })

  it('returns waiting when permission is pending', () => {
    expect(
      deriveChatActivity({
        isIdle: false,
        streamingMessageId: null,
        isPlanPending: false,
        pendingPermission: true,
      }).state,
    ).toBe('waiting')
  })

  it('returns busy when not idle and not streaming', () => {
    expect(
      deriveChatActivity({ isIdle: false, streamingMessageId: null, isPlanPending: false }).state,
    ).toBe('busy')
  })

  it('returns error when hasError, overriding everything else', () => {
    expect(
      deriveChatActivity({
        isIdle: false,
        streamingMessageId: 'msg-1',
        isPlanPending: true,
        pendingPermission: true,
        hasError: true,
      }).state,
    ).toBe('error')
  })

  it('prefers waiting over thinking when both plan-pending and streaming', () => {
    expect(
      deriveChatActivity({ isIdle: false, streamingMessageId: 'msg-1', isPlanPending: true }).state,
    ).toBe('waiting')
  })

  it('stamps startedAt with the current time on a fresh derive', () => {
    const mockNow = 1700000000000
    vi.spyOn(Date, 'now').mockReturnValue(mockNow)
    const a = deriveChatActivity({ isIdle: false, streamingMessageId: 'msg-1', isPlanPending: false })
    expect(a.startedAt).toBe(mockNow)
  })

  it('preserves startedAt while the state is unchanged', () => {
    const previous: SessionChatActivity = { state: 'thinking', startedAt: 1000 }
    const a = deriveChatActivity(
      { isIdle: false, streamingMessageId: 'msg-1', isPlanPending: false },
      previous,
    )
    expect(a.state).toBe('thinking')
    expect(a.startedAt).toBe(1000)
  })

  it('resets startedAt when the state changes', () => {
    const mockNow = 1700000000000
    vi.spyOn(Date, 'now').mockReturnValue(mockNow)
    const previous: SessionChatActivity = { state: 'thinking', startedAt: 1000 }
    const a = deriveChatActivity(
      { isIdle: true, streamingMessageId: null, isPlanPending: false },
      previous,
    )
    expect(a.state).toBe('idle')
    expect(a.startedAt).toBe(mockNow)
  })

  it('covers the full ChatActivityState union', () => {
    const states: ChatActivityState[] = ['idle', 'thinking', 'busy', 'waiting', 'error']
    expect(states).toHaveLength(5)
  })
})
