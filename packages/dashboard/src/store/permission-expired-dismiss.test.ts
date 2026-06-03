/**
 * Tests that permission_expired messages drain the matching banner stack
 * while preserving the notifications widget's durable history (#1580 + #5008).
 *
 * #5008 — pre-#5008 the handler called `.filter(...)` to remove the entry
 * outright, which silently drained every resolved/expired alert from the
 * notifications widget. The widget's framing ("see read+unread history of
 * every intervention") demands we keep the row and just stamp `readAt`
 * instead so banners (which filter unread) drop the entry while the widget
 * (which renders all) retains it. The tests below are pinned to that
 * "mark-read-and-keep" contract — any future refactor that drops history is
 * a regression.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setStore, handleMessage, setConnectionContext } from './message-handler'
import type { ConnectionState, SessionNotification } from './types'

// Minimal mock store
function createMockStore(initialState: Partial<ConnectionState>) {
  let state = initialState as ConnectionState
  return {
    getState: () => state,
    setState: (updater: Partial<ConnectionState> | ((s: ConnectionState) => Partial<ConnectionState>)) => {
      if (typeof updater === 'function') {
        state = { ...state, ...updater(state) }
      } else {
        state = { ...state, ...updater }
      }
    },
  }
}

const mockCtx = {
  url: 'wss://test',
  token: 'test-token',
  isReconnect: false,
  silent: false,
  socket: {} as WebSocket,
}

function makeNotification(overrides: Partial<SessionNotification> = {}): SessionNotification {
  return {
    id: 'n-1',
    sessionId: 'sess-1',
    sessionName: 'Test Session',
    eventType: 'permission',
    message: 'Write to /tmp/test.txt',
    timestamp: Date.now(),
    requestId: 'req-abc',
    ...overrides,
  }
}

describe('permission_expired drains banners while preserving widget history (#1580 + #5008)', () => {
  let store: ReturnType<typeof createMockStore>

  beforeEach(() => {
    store = createMockStore({
      activeSessionId: 'sess-1',
      sessionNotifications: [
        makeNotification({ id: 'n-1', requestId: 'req-abc' }),
        makeNotification({ id: 'n-2', requestId: 'req-def', message: 'Read /etc/hosts' }),
      ],
      sessionStates: {
        'sess-1': {
          messages: [
            { type: 'prompt', content: 'Allow write?', requestId: 'req-abc', options: ['allow', 'deny'] },
          ],
        },
      } as unknown as ConnectionState['sessionStates'],
    })
    setStore(store)
    setConnectionContext(mockCtx)
  })

  it('stamps readAt on the matching notification but keeps it in the list (#5008)', () => {
    const before = Date.now()
    handleMessage({
      type: 'permission_expired',
      requestId: 'req-abc',
      message: 'Permission timed out',
    }, mockCtx)
    const after = Date.now()

    const remaining = store.getState().sessionNotifications
    // #5008 — both entries preserved; the matching one is just stamped read.
    expect(remaining).toHaveLength(2)
    const matched = remaining.find(n => n.requestId === 'req-abc')!
    expect(matched.readAt).toBeTypeOf('number')
    expect(matched.readAt!).toBeGreaterThanOrEqual(before)
    expect(matched.readAt!).toBeLessThanOrEqual(after)
  })

  it('leaves other notifications untouched (still unread)', () => {
    handleMessage({
      type: 'permission_expired',
      requestId: 'req-abc',
      message: 'Permission timed out',
    }, mockCtx)

    const remaining = store.getState().sessionNotifications
    const other = remaining.find(n => n.requestId === 'req-def')!
    expect(other.id).toBe('n-2')
    expect(other.message).toBe('Read /etc/hosts')
    expect(other.readAt).toBeUndefined()
  })

  it('does nothing when requestId does not match any notification', () => {
    handleMessage({
      type: 'permission_expired',
      requestId: 'req-unknown',
      message: 'Permission timed out',
    }, mockCtx)

    const remaining = store.getState().sessionNotifications
    expect(remaining).toHaveLength(2)
    // Nothing stamped — both still unread.
    expect(remaining.every(n => n.readAt === undefined)).toBe(true)
  })

  it('does not overwrite a previously-set readAt (idempotent mark-read) (#5008)', () => {
    // Operator already acked the alert via the widget — expiry must not
    // clobber the original ack timestamp, otherwise the history loses the
    // "when did I first see this?" signal.
    const ackedAt = 1_700_000_000_000
    store = createMockStore({
      activeSessionId: 'sess-1',
      sessionNotifications: [
        makeNotification({ id: 'n-1', requestId: 'req-abc', readAt: ackedAt }),
      ],
      sessionStates: {
        'sess-1': { messages: [] },
      } as unknown as ConnectionState['sessionStates'],
    })
    setStore(store)

    handleMessage({
      type: 'permission_expired',
      requestId: 'req-abc',
      message: 'Permission timed out',
    }, mockCtx)

    const list = store.getState().sessionNotifications
    expect(list).toHaveLength(1)
    expect(list[0]!.readAt).toBe(ackedAt)
  })
})

// ---------------------------------------------------------------------------
// #2839: surface an info toast when permission_expired arrives for a
// requestId that the user already resolved locally (race condition with
// server-side expiry).
// ---------------------------------------------------------------------------
describe('permission_expired info toast for resolved requests (#2839)', () => {
  it('fires addInfoNotification when the requestId is in resolvedPermissions', () => {
    const addInfoNotification = vi.fn()
    const store = createMockStore({
      activeSessionId: 'sess-1',
      sessionNotifications: [],
      resolvedPermissions: { 'req-abc': 'allow' },
      addInfoNotification,
      sessionStates: {
        'sess-1': { messages: [] },
      } as unknown as ConnectionState['sessionStates'],
    })
    setStore(store)
    setConnectionContext(mockCtx)

    handleMessage({
      type: 'permission_expired',
      requestId: 'req-abc',
      message: 'Permission timed out',
    }, mockCtx)

    expect(addInfoNotification).toHaveBeenCalledTimes(1)
    expect(addInfoNotification.mock.calls[0]![0]).toMatch(/already answered/i)
  })

  it('does NOT fire the info toast for unresolved requestIds', () => {
    const addInfoNotification = vi.fn()
    const store = createMockStore({
      activeSessionId: 'sess-1',
      sessionNotifications: [],
      resolvedPermissions: {},
      addInfoNotification,
      sessionStates: {
        'sess-1': {
          messages: [
            { type: 'prompt', content: 'Allow write?', requestId: 'req-abc', options: ['allow', 'deny'] },
          ],
        },
      } as unknown as ConnectionState['sessionStates'],
    })
    setStore(store)
    setConnectionContext(mockCtx)

    handleMessage({
      type: 'permission_expired',
      requestId: 'req-abc',
      message: 'Permission timed out',
    }, mockCtx)

    expect(addInfoNotification).not.toHaveBeenCalled()
  })

  it('marks the matching session notification as read (banner drains, widget retains) for resolved ids (#5008)', () => {
    const addInfoNotification = vi.fn()
    const store = createMockStore({
      activeSessionId: 'sess-1',
      sessionNotifications: [
        makeNotification({ id: 'n-1', requestId: 'req-abc' }),
      ],
      resolvedPermissions: { 'req-abc': 'allow' },
      addInfoNotification,
      sessionStates: {
        'sess-1': { messages: [] },
      } as unknown as ConnectionState['sessionStates'],
    })
    setStore(store)
    setConnectionContext(mockCtx)

    handleMessage({
      type: 'permission_expired',
      requestId: 'req-abc',
      message: 'Permission timed out',
    }, mockCtx)

    const list = store.getState().sessionNotifications
    // #5008 — entry preserved as durable history; just stamped read so the
    // banner stack (which filters by `readAt === undefined`) drops it.
    expect(list).toHaveLength(1)
    expect(list[0]!.readAt).toBeTypeOf('number')
    expect(addInfoNotification).toHaveBeenCalled()
  })
})
