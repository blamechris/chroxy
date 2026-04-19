/**
 * Tests that permission_expired messages auto-dismiss matching notification banners (#1580)
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

describe('permission_expired auto-dismisses notification banner (#1580)', () => {
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

  it('removes the matching notification when permission_expired is received', () => {
    handleMessage({
      type: 'permission_expired',
      requestId: 'req-abc',
      message: 'Permission timed out',
    }, mockCtx)

    const remaining = store.getState().sessionNotifications
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.requestId).toBe('req-def')
  })

  it('leaves other notifications untouched', () => {
    handleMessage({
      type: 'permission_expired',
      requestId: 'req-abc',
      message: 'Permission timed out',
    }, mockCtx)

    const remaining = store.getState().sessionNotifications
    expect(remaining[0]!.id).toBe('n-2')
    expect(remaining[0]!.message).toBe('Read /etc/hosts')
  })

  it('does nothing when requestId does not match any notification', () => {
    handleMessage({
      type: 'permission_expired',
      requestId: 'req-unknown',
      message: 'Permission timed out',
    }, mockCtx)

    const remaining = store.getState().sessionNotifications
    expect(remaining).toHaveLength(2)
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

  it('still dismisses the matching session notification banner for resolved ids', () => {
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

    expect(store.getState().sessionNotifications).toHaveLength(0)
    expect(addInfoNotification).toHaveBeenCalled()
  })
})
