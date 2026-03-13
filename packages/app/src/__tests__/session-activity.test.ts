import { deriveActivityState, type SessionActivity, type ActivityState } from '../store/session-activity'

describe('deriveActivityState', () => {
  it('returns idle for default session state', () => {
    const activity = deriveActivityState({
      isIdle: true,
      streamingMessageId: null,
      isPlanPending: false,
    })
    expect(activity.state).toBe('idle')
  })

  it('returns thinking when streaming is active', () => {
    const activity = deriveActivityState({
      isIdle: false,
      streamingMessageId: 'msg-123',
      isPlanPending: false,
    })
    expect(activity.state).toBe('thinking')
  })

  it('returns waiting when plan is pending', () => {
    const activity = deriveActivityState({
      isIdle: false,
      streamingMessageId: null,
      isPlanPending: true,
    })
    expect(activity.state).toBe('waiting')
  })

  it('returns busy when not idle and not streaming', () => {
    const activity = deriveActivityState({
      isIdle: false,
      streamingMessageId: null,
      isPlanPending: false,
    })
    expect(activity.state).toBe('busy')
  })

  it('returns waiting with detail when permission context provided', () => {
    const activity = deriveActivityState({
      isIdle: false,
      streamingMessageId: null,
      isPlanPending: false,
      pendingPermission: true,
    })
    expect(activity.state).toBe('waiting')
  })

  it('includes startedAt timestamp', () => {
    const now = Date.now()
    const activity = deriveActivityState({
      isIdle: false,
      streamingMessageId: 'msg-1',
      isPlanPending: false,
    })
    expect(activity.startedAt).toBeGreaterThanOrEqual(now - 100)
    expect(activity.startedAt).toBeLessThanOrEqual(now + 100)
  })

  it('preserves startedAt from previous activity when state unchanged', () => {
    const previous: SessionActivity = {
      state: 'thinking',
      startedAt: 1000,
    }
    const activity = deriveActivityState({
      isIdle: false,
      streamingMessageId: 'msg-1',
      isPlanPending: false,
    }, previous)
    expect(activity.startedAt).toBe(1000)
  })

  it('resets startedAt when state changes', () => {
    const previous: SessionActivity = {
      state: 'thinking',
      startedAt: 1000,
    }
    const now = Date.now()
    const activity = deriveActivityState({
      isIdle: true,
      streamingMessageId: null,
      isPlanPending: false,
    }, previous)
    expect(activity.state).toBe('idle')
    expect(activity.startedAt).toBeGreaterThanOrEqual(now - 100)
  })

  it('exports ActivityState type with all expected values', () => {
    const states: ActivityState[] = ['idle', 'thinking', 'busy', 'waiting', 'error']
    expect(states).toHaveLength(5)
  })
})
