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
// requestId that the user already answered (race condition with server-side
// expiry).
//
// #7388 — the gate is now the prompt's own `answered` decision token, read via
// the SHARED `isPermissionRequestAnswered` (the same call the app makes), not
// the dashboard-only `resolvedPermissions` map. These tests therefore seed an
// ANSWERED prompt; the last one below is the positive control proving the old
// signal alone no longer suppresses.
// ---------------------------------------------------------------------------
describe('permission_expired info toast for resolved requests (#2839)', () => {
  it('fires addInfoNotification when the matching prompt carries a decision token', () => {
    const addInfoNotification = vi.fn()
    const store = createMockStore({
      activeSessionId: 'sess-1',
      sessionNotifications: [],
      resolvedPermissions: { 'req-abc': 'allow' },
      addInfoNotification,
      sessionStates: {
        'sess-1': {
          messages: [
            { type: 'prompt', content: 'Allow write?', requestId: 'req-abc', answered: 'allow' },
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

  it('marks the matching session notification as read (banner drains, widget retains) for answered ids (#5008)', () => {
    const addInfoNotification = vi.fn()
    const store = createMockStore({
      activeSessionId: 'sess-1',
      sessionNotifications: [
        makeNotification({ id: 'n-1', requestId: 'req-abc' }),
      ],
      resolvedPermissions: { 'req-abc': 'allow' },
      addInfoNotification,
      sessionStates: {
        'sess-1': {
          messages: [
            { type: 'prompt', content: 'Allow write?', requestId: 'req-abc', answered: 'allow' },
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

    const list = store.getState().sessionNotifications
    // #5008 — entry preserved as durable history; just stamped read so the
    // banner stack (which filters by `readAt === undefined`) drops it.
    expect(list).toHaveLength(1)
    expect(list[0]!.readAt).toBeTypeOf('number')
    expect(addInfoNotification).toHaveBeenCalled()
  })

  // #7388 positive control. Without this, every test above would still pass if
  // the gate silently fell back to `resolvedPermissions` — they all seed BOTH
  // signals, because in production both are written together. This is the one
  // input that separates them, and it is the input that matters: a long session
  // evicts old entries from `resolvedPermissions` (capped at 1000 by
  // `capResolvedPermissions`) while `answered` lives on the message forever.
  it('does NOT suppress on resolvedPermissions alone — the retired signal (#7388)', () => {
    const addInfoNotification = vi.fn()
    const store = createMockStore({
      activeSessionId: 'sess-1',
      sessionNotifications: [],
      resolvedPermissions: { 'req-abc': 'allow' },
      addInfoNotification,
      sessionStates: {
        'sess-1': {
          messages: [
            // The map says answered; the message does not. The message wins.
            { type: 'prompt', content: 'Allow write?', requestId: 'req-abc' },
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
    const msg = store.getState().sessionStates['sess-1']!.messages[0]!
    expect(msg.content).toContain('(Expired')
  })

  // #7388 / #7380 — `answered` merely being SET is not a decision.
  // `history_replay_end` blanket-stamps '(resolved)' on prompts NOBODY answered;
  // suppressing on it would tell those users their response was recorded.
  it("does NOT suppress on history_replay_end's '(resolved)' placeholder", () => {
    const addInfoNotification = vi.fn()
    const store = createMockStore({
      activeSessionId: 'sess-1',
      sessionNotifications: [],
      resolvedPermissions: {},
      addInfoNotification,
      sessionStates: {
        'sess-1': {
          messages: [
            { type: 'prompt', content: 'Allow write?', requestId: 'req-abc', answered: '(resolved)' },
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
    const msg = store.getState().sessionStates['sess-1']!.messages[0]!
    expect(msg.content).toContain('(Expired')
  })

  // #7388 — the dashboard's flat `messages` list is a real answered-prompt
  // location (markPromptAnsweredByRequestId falls back to it when the prompt is
  // in no session, and so does the permission_resolved handler). Passing it to
  // the shared predicate is load-bearing, not defensive.
  it('suppresses when the answered prompt lives only in the flat messages list', () => {
    const addInfoNotification = vi.fn()
    const store = createMockStore({
      activeSessionId: 'sess-1',
      sessionNotifications: [],
      resolvedPermissions: {},
      addInfoNotification,
      messages: [
        { type: 'prompt', content: 'Allow write?', requestId: 'req-abc', answered: 'deny' },
      ] as unknown as ConnectionState['messages'],
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
  })
})
