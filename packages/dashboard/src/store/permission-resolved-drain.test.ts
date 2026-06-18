/**
 * permission_resolved drains the banner stack while preserving the
 * notifications widget's durable history (#5008).
 *
 * Pre-#5008 the handler removed the matching notification outright via
 * `.filter(...)`, which silently drained every approved/denied alert from
 * the widget. The widget's framing ("see read+unread history of every
 * intervention") demands we keep the row and just stamp `readAt = Date.now()`
 * — banners filter by `readAt === undefined` so they still vanish on
 * resolution, while the widget retains the entry as part of its durable
 * history.
 *
 * Mirrors permission-expired-dismiss.test.ts for the resolved code path.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { setStore, handleMessage, setConnectionContext } from './message-handler'
import type { ConnectionState, SessionNotification } from './types'

function createMockStore(initialState: Partial<ConnectionState>) {
  let state = initialState as ConnectionState
  return {
    getState: () => state,
    setState: (
      updater:
        | Partial<ConnectionState>
        | ((s: ConnectionState) => Partial<ConnectionState>),
    ) => {
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

function makeNotification(
  overrides: Partial<SessionNotification> = {},
): SessionNotification {
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

describe('permission_resolved drains banners while preserving widget history (#5008)', () => {
  let store: ReturnType<typeof createMockStore>

  beforeEach(() => {
    store = createMockStore({
      activeSessionId: 'sess-1',
      // `messages` is the flat-fallback path inside handlePermissionResolved
      // when no sessionStates entry owns the requestId — keep it as an empty
      // array so the fallback `.map()` doesn't NPE.
      messages: [],
      sessionNotifications: [
        makeNotification({ id: 'n-1', requestId: 'req-abc' }),
        makeNotification({
          id: 'n-2',
          requestId: 'req-def',
          message: 'Read /etc/hosts',
        }),
      ],
      sessionStates: {
        'sess-1': {
          messages: [
            {
              type: 'prompt',
              content: 'Allow write?',
              requestId: 'req-abc',
              options: ['allow', 'deny'],
            },
          ],
        },
      } as unknown as ConnectionState['sessionStates'],
    })
    setStore(store)
    setConnectionContext(mockCtx)
  })

  it('stamps readAt on the matching notification but keeps it in the list (#5008)', () => {
    const before = Date.now()
    handleMessage(
      {
        type: 'permission_resolved',
        requestId: 'req-abc',
        decision: 'allow',
      },
      mockCtx,
    )
    const after = Date.now()

    const list = store.getState().sessionNotifications
    // #5008 — entry preserved as durable history.
    expect(list).toHaveLength(2)
    const matched = list.find(n => n.requestId === 'req-abc')!
    expect(matched.readAt).toBeTypeOf('number')
    expect(matched.readAt!).toBeGreaterThanOrEqual(before)
    expect(matched.readAt!).toBeLessThanOrEqual(after)
  })

  it('leaves other notifications untouched (still unread)', () => {
    handleMessage(
      {
        type: 'permission_resolved',
        requestId: 'req-abc',
        decision: 'deny',
      },
      mockCtx,
    )

    const list = store.getState().sessionNotifications
    const other = list.find(n => n.requestId === 'req-def')!
    expect(other.id).toBe('n-2')
    expect(other.message).toBe('Read /etc/hosts')
    expect(other.readAt).toBeUndefined()
  })

  it('does nothing when requestId does not match any notification', () => {
    handleMessage(
      {
        type: 'permission_resolved',
        requestId: 'req-unknown',
        decision: 'allow',
      },
      mockCtx,
    )

    const list = store.getState().sessionNotifications
    expect(list).toHaveLength(2)
    expect(list.every(n => n.readAt === undefined)).toBe(true)
  })

  it('does not overwrite a previously-set readAt (idempotent mark-read) (#5008)', () => {
    // The operator already acked the notification via the widget; a
    // subsequent permission_resolved (e.g. another client's decision arrives
    // over the socket) must not clobber the original ack timestamp.
    const ackedAt = 1_700_000_000_000
    store = createMockStore({
      activeSessionId: 'sess-1',
      messages: [],
      sessionNotifications: [
        makeNotification({ id: 'n-1', requestId: 'req-abc', readAt: ackedAt }),
      ],
      sessionStates: {
        'sess-1': { messages: [] },
      } as unknown as ConnectionState['sessionStates'],
    })
    setStore(store)

    handleMessage(
      {
        type: 'permission_resolved',
        requestId: 'req-abc',
        decision: 'allow',
      },
      mockCtx,
    )

    const list = store.getState().sessionNotifications
    expect(list).toHaveLength(1)
    expect(list[0]!.readAt).toBe(ackedAt)
  })

  it('drops the entry from the unread banner stack (banner filter contract) (#5008)', () => {
    // The banner stack filters by `readAt === undefined`. After resolution,
    // the matching entry must no longer appear in that filtered slice even
    // though it remains in the underlying list.
    handleMessage(
      {
        type: 'permission_resolved',
        requestId: 'req-abc',
        decision: 'allow',
      },
      mockCtx,
    )

    const unreadOnly = store
      .getState()
      .sessionNotifications.filter(n => n.readAt === undefined)
    expect(unreadOnly).toHaveLength(1)
    expect(unreadOnly[0]!.requestId).toBe('req-def')
  })
})
