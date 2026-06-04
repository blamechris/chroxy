/**
 * Intervention notifications read/unread tracking (#4890)
 *
 * Slack-style notifications widget — verifies the store-side mechanics:
 *   - new alerts arrive unread (`readAt` absent)
 *   - `markSessionNotificationRead(id)` stamps `readAt`
 *   - `markAllSessionNotificationsRead()` stamps every currently-unread alert
 *   - re-reading is idempotent (does NOT overwrite the first read timestamp)
 *   - `switchSession(sessionId)` marks corresponding alerts as read (replaces
 *     the pre-#4890 "filter them out" behaviour so the widget can keep a
 *     persistent history of acknowledged interventions)
 *   - `dismissSessionNotification(id)` still removes outright (explicit
 *     dismissal is distinct from "viewed")
 *
 * Scope is in-memory only — `sessionNotifications` is transient and resets
 * on reload/reconnect (see types.ts:SessionNotification.readAt JSDoc).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SessionNotification } from './types'

function makeNotification(overrides: Partial<SessionNotification> = {}): SessionNotification {
  return {
    id: 'n-1',
    sessionId: 'sess-1',
    sessionName: 'My Session',
    eventType: 'permission',
    message: 'Write to /tmp/test.txt',
    timestamp: Date.now(),
    requestId: 'req-abc',
    ...overrides,
  }
}

describe('SessionNotification read/unread tracking (#4890)', () => {
  beforeEach(async () => {
    const { useConnectionStore } = await import('./connection')
    useConnectionStore.setState({
      sessionNotifications: [],
      activeSessionId: null,
      sessions: [],
      sessionStates: {},
    })
  })

  it('markSessionNotificationRead stamps readAt on the matching notification', async () => {
    const { useConnectionStore } = await import('./connection')
    useConnectionStore.setState({
      sessionNotifications: [
        makeNotification({ id: 'n-1' }),
        makeNotification({ id: 'n-2', requestId: 'req-def' }),
      ],
    })

    const before = Date.now()
    useConnectionStore.getState().markSessionNotificationRead('n-1')
    const after = Date.now()

    const list = useConnectionStore.getState().sessionNotifications
    const n1 = list.find(n => n.id === 'n-1')!
    const n2 = list.find(n => n.id === 'n-2')!
    expect(n1.readAt).toBeTypeOf('number')
    expect(n1.readAt!).toBeGreaterThanOrEqual(before)
    expect(n1.readAt!).toBeLessThanOrEqual(after)
    // sibling notification untouched
    expect(n2.readAt).toBeUndefined()
  })

  it('markSessionNotificationRead is idempotent — second call preserves the first readAt', async () => {
    const { useConnectionStore } = await import('./connection')
    useConnectionStore.setState({
      sessionNotifications: [makeNotification({ id: 'n-1' })],
    })

    // Deterministic Date.now() so we can prove the second call would have
    // observed a distinct value if the action weren't idempotent — without
    // depending on real-time setTimeout (which could land in the same ms
    // on fast machines and miss a regression).
    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValueOnce(1_700_000_000_000) // first mark-read
    useConnectionStore.getState().markSessionNotificationRead('n-1')
    const firstReadAt = useConnectionStore.getState().sessionNotifications[0]!.readAt
    expect(firstReadAt).toBe(1_700_000_000_000)

    nowSpy.mockReturnValueOnce(1_700_000_000_999) // second mark-read — would clobber if non-idempotent
    useConnectionStore.getState().markSessionNotificationRead('n-1')
    const secondReadAt = useConnectionStore.getState().sessionNotifications[0]!.readAt
    expect(secondReadAt).toBe(firstReadAt)
    nowSpy.mockRestore()
  })

  it('markSessionNotificationRead is a no-op for unknown id', async () => {
    const { useConnectionStore } = await import('./connection')
    useConnectionStore.setState({
      sessionNotifications: [makeNotification({ id: 'n-1' })],
    })

    useConnectionStore.getState().markSessionNotificationRead('does-not-exist')
    const list = useConnectionStore.getState().sessionNotifications
    expect(list).toHaveLength(1)
    expect(list[0]!.readAt).toBeUndefined()
  })

  it('markAllSessionNotificationsRead stamps every currently-unread notification', async () => {
    const { useConnectionStore } = await import('./connection')
    const alreadyRead = 1000
    useConnectionStore.setState({
      sessionNotifications: [
        makeNotification({ id: 'n-1' }),
        makeNotification({ id: 'n-2', requestId: 'req-def' }),
        makeNotification({ id: 'n-3', readAt: alreadyRead }),
      ],
    })

    useConnectionStore.getState().markAllSessionNotificationsRead()
    const list = useConnectionStore.getState().sessionNotifications

    expect(list.find(n => n.id === 'n-1')!.readAt).toBeTypeOf('number')
    expect(list.find(n => n.id === 'n-2')!.readAt).toBeTypeOf('number')
    // Already-read entry must not have its readAt clobbered (preserves the
    // original acknowledge timestamp so a "Mark all read" doesn't masquerade
    // as a fresh acknowledge for items already seen).
    expect(list.find(n => n.id === 'n-3')!.readAt).toBe(alreadyRead)
  })

  it('dismissSessionNotification still removes outright (distinct from "viewed")', async () => {
    const { useConnectionStore } = await import('./connection')
    useConnectionStore.setState({
      sessionNotifications: [
        makeNotification({ id: 'n-1' }),
        makeNotification({ id: 'n-2', requestId: 'req-def' }),
      ],
    })

    useConnectionStore.getState().dismissSessionNotification('n-1')
    const list = useConnectionStore.getState().sessionNotifications
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toBe('n-2')
  })
})

describe('switchSession marks notifications as read instead of removing (#4890)', () => {
  it('marks notifications for the target session as read without dropping them', async () => {
    const { useConnectionStore } = await import('./connection')
    const makeSession = (id: string) => ({
      sessionId: id, name: id, cwd: '/tmp', type: 'cli' as const,
      hasTerminal: false, model: null, permissionMode: null, isBusy: false,
      createdAt: 0, conversationId: null,
    })
    useConnectionStore.setState({
      sessions: [makeSession('sess-a'), makeSession('sess-b')],
      activeSessionId: 'sess-a',
      sessionStates: {},
      sessionNotifications: [
        makeNotification({ id: 'n-b-1', sessionId: 'sess-b' }),
        makeNotification({ id: 'n-b-2', sessionId: 'sess-b', requestId: 'req-def' }),
        makeNotification({ id: 'n-c-1', sessionId: 'sess-c' }),
      ],
    })

    useConnectionStore.getState().switchSession('sess-b')

    const list = useConnectionStore.getState().sessionNotifications
    // All three entries are preserved — switching no longer wipes history.
    expect(list).toHaveLength(3)
    // The two entries for sess-b are now flagged as read.
    expect(list.find(n => n.id === 'n-b-1')!.readAt).toBeTypeOf('number')
    expect(list.find(n => n.id === 'n-b-2')!.readAt).toBeTypeOf('number')
    // The unrelated sess-c entry remains unread.
    expect(list.find(n => n.id === 'n-c-1')!.readAt).toBeUndefined()
  })
})
