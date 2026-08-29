/**
 * #7430 — `session_pr_threads` dispatch wiring.
 *
 * Driven through the REAL `handleMessage(raw, ctxOverride?)` two-argument API,
 * the way `dispatch-session-pr-status.test.ts` does. The first version of this
 * file passed four arguments — `(msg, get, set, ctx)` — which type-checked
 * nowhere and ran anyway: argument 2 (a function) is merely truthy, so it
 * satisfied `const ctx = ctxOverride ?? _connectionContext`, and arguments 3
 * and 4 were discarded. The tests READ as though they injected their own
 * get/set and did not, and `Dashboard Type Check` went red on the head commit
 * while the runtime suite stayed green (#7469 Critical 1). Use the sibling
 * idiom; do not re-introduce a shape that only appears to work.
 *
 * Two load-bearing properties:
 *   - a reading is filed under ITS OWN `sessionId`, never the active one;
 *   - a DEGRADED reply must not ERASE a count the user is looking at (#7469 S1).
 *     Overwriting it wholesale would blank the count on a transient
 *     IN_PROGRESS/RATE_LIMITED refusal, with nothing scheduled to repair it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('./crypto', () => ({
  createKeyPair: vi.fn(() => ({ publicKey: 'mock-pub', secretKey: 'mock-sec' })),
  deriveSharedKey: vi.fn(), encrypt: vi.fn(), decrypt: vi.fn(),
  generateConnectionSalt: vi.fn(() => 'mock-salt'),
  deriveConnectionKey: vi.fn(() => new Uint8Array(32)),
  DIRECTION_CLIENT: 0, DIRECTION_SERVER: 1,
}))
vi.mock('./persistence', () => ({ clearPersistedSession: vi.fn() }))

import { handleMessage, setStore, clearDeltaBuffers, clearPermissionSplits, stopHeartbeat, resetReplayFlags } from './message-handler'
import type { ConnectionState } from './types'
import type { ServerSessionPrThreadsMessage } from '@chroxy/protocol'

function createMockStore(initial: Partial<ConnectionState>) {
  let state = initial as ConnectionState
  return {
    getState: () => state,
    setState: (s: Partial<ConnectionState> | ((prev: ConnectionState) => Partial<ConnectionState>)) => {
      state = { ...state, ...(typeof s === 'function' ? s(state) : s) }
    },
  }
}
function createMockSocket(): WebSocket {
  return { send: vi.fn(), close: vi.fn(), readyState: WebSocket.OPEN, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as WebSocket
}
function baseState(): Partial<ConnectionState> {
  return {
    connectionPhase: 'connected', socket: null, sessions: [], activeSessionId: 'sess-A',
    sessionStates: {}, messages: [],
    sessionPrThreads: {}, sessionPrThreadsLoading: { 'sess-A': true, 'sess-B': true },
  }
}
function reading(over: Partial<ServerSessionPrThreadsMessage> = {}): ServerSessionPrThreadsMessage {
  return {
    type: 'session_pr_threads',
    requestId: 'r1',
    sessionId: 'sess-A',
    countedAt: '2026-08-28T00:00:00.000Z',
    prNumber: 7419,
    unresolvedCount: 2,
    totalCount: 9,
    truncated: false,
    reason: null,
    ...over,
  } as ServerSessionPrThreadsMessage
}
/** EXACTLY the shape the handler's `degraded()` puts on the wire. */
function serverDegraded(reason: string, over: Partial<ServerSessionPrThreadsMessage> = {}): ServerSessionPrThreadsMessage {
  return reading({ prNumber: null, unresolvedCount: null, totalCount: null, truncated: false, reason, ...over })
}

describe('session_pr_threads dispatch (#7430)', () => {
  let store: ReturnType<typeof createMockStore>
  let mockSocket: WebSocket
  const ctx = () => ({ url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false })

  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear(); clearDeltaBuffers(); clearPermissionSplits()
    mockSocket = createMockSocket(); store = createMockStore(baseState()); setStore(store)
  })
  afterEach(() => { stopHeartbeat(); clearDeltaBuffers(); clearPermissionSplits(); resetReplayFlags() })

  it('stores the reading under its own sessionId and clears that session\'s loading flag', () => {
    handleMessage(reading(), ctx() as never)
    const s = store.getState()
    expect(s.sessionPrThreads['sess-A']!.unresolvedCount).toBe(2)
    expect(s.sessionPrThreads['sess-A']!.totalCount).toBe(9)
    expect(s.sessionPrThreadsLoading['sess-A']).toBeUndefined()
  })

  it('files a background session\'s reply under THAT session, never the active one', () => {
    handleMessage(reading({ sessionId: 'sess-B', unresolvedCount: 5 }), ctx() as never)
    const s = store.getState()
    expect(s.sessionPrThreads['sess-B']!.unresolvedCount).toBe(5)
    expect(s.sessionPrThreads['sess-A']).toBeUndefined()
    expect(s.sessionPrThreadsLoading['sess-B']).toBeUndefined()
    expect(s.sessionPrThreadsLoading['sess-A']).toBe(true)
  })

  it('drops a reading with a null sessionId rather than attributing it to the active session', () => {
    handleMessage(reading({ sessionId: null }), ctx() as never)
    expect(store.getState().sessionPrThreads).toEqual({})
    expect(store.getState().sessionPrThreadsLoading['sess-A']).toBe(true)
  })

  it('drops a schema-invalid payload without clearing loading', () => {
    // `truncated` is required; a negative count is not a reading at all.
    handleMessage({ ...reading(), truncated: undefined } as never, ctx() as never)
    handleMessage({ ...reading(), unresolvedCount: -1 } as never, ctx() as never)
    expect(store.getState().sessionPrThreads).toEqual({})
    expect(store.getState().sessionPrThreadsLoading['sess-A']).toBe(true)
  })

  it('stores a degraded reading when there is no prior count', () => {
    // The reason IS the payload here — dropping it would leave the consumer to
    // infer, and next to a green CI chip inferring means inferring zero.
    handleMessage(serverDegraded('gh CLI not found on PATH'), ctx() as never)
    const stored = store.getState().sessionPrThreads['sess-A']
    expect(stored!.reason).toBe('gh CLI not found on PATH')
    expect(stored!.unresolvedCount).toBeNull()
    expect(store.getState().sessionPrThreadsLoading['sess-A']).toBeUndefined()
  })

  describe('#7469 S1 — a degraded reply must not ERASE a good count', () => {
    it('keeps the previous count and attaches the new failure', () => {
      handleMessage(reading({ unresolvedCount: 3, totalCount: 11, countedAt: '2026-08-28T00:00:00.000Z' }), ctx() as never)
      handleMessage(serverDegraded('a review-thread count is already running for this client'), ctx() as never)

      const stored = store.getState().sessionPrThreads['sess-A']!
      // The count survives, WITH the clock that says how old it is …
      expect(stored.unresolvedCount).toBe(3)
      expect(stored.totalCount).toBe(11)
      expect(stored.prNumber).toBe(7419)
      expect(stored.countedAt).toBe('2026-08-28T00:00:00.000Z')
      // … and the failure is visible rather than swallowed. Keeping the count
      // silently would be the worse half of this fix: a stale reading presented
      // as current.
      expect(stored.reason).toBe('a review-thread count is already running for this client')
    })

    it('a FRESH good count replaces the retained one wholesale, reason included', () => {
      // Positive control for the retention: a retention that never released
      // would pin the chip to its first count forever.
      handleMessage(reading({ unresolvedCount: 3 }), ctx() as never)
      handleMessage(serverDegraded('boom'), ctx() as never)
      handleMessage(reading({ unresolvedCount: 0, totalCount: 4, countedAt: '2026-08-28T01:00:00.000Z' }), ctx() as never)

      const stored = store.getState().sessionPrThreads['sess-A']!
      expect(stored.unresolvedCount).toBe(0)
      expect(stored.countedAt).toBe('2026-08-28T01:00:00.000Z')
      expect(stored.reason).toBeNull()
    })

    it('retains across CONSECUTIVE failures, taking the newest reason each time', () => {
      handleMessage(reading({ unresolvedCount: 3 }), ctx() as never)
      handleMessage(serverDegraded('first failure'), ctx() as never)
      handleMessage(serverDegraded('second failure'), ctx() as never)

      const stored = store.getState().sessionPrThreads['sess-A']!
      expect(stored.unresolvedCount).toBe(3)
      expect(stored.reason).toBe('second failure')
    })

    it('does NOT carry a count across to a different session', () => {
      // The retention is per session id; borrowing sess-A's count for sess-B
      // would be exactly the cross-session fabrication the filing rule exists
      // to prevent.
      handleMessage(reading({ sessionId: 'sess-A', unresolvedCount: 3 }), ctx() as never)
      handleMessage(serverDegraded('boom', { sessionId: 'sess-B' }), ctx() as never)
      expect(store.getState().sessionPrThreads['sess-B']!.unresolvedCount).toBeNull()
    })

    it('the retained pairing is one the formatter renders honestly', () => {
      // The join to `ci-prefill.ts`: this store emits count + reason together,
      // and the formatter must render BOTH (count, its countedAt, and the
      // caveat). Pinned there as the RETAINED COUNT case; asserted here as the
      // producer so the two cannot drift apart the way #7469 Critical 2 did.
      handleMessage(reading({ unresolvedCount: 3 }), ctx() as never)
      handleMessage(serverDegraded('boom'), ctx() as never)
      const stored = store.getState().sessionPrThreads['sess-A']!
      expect(stored.unresolvedCount).not.toBeNull()
      expect(stored.reason).not.toBeNull()
      expect(stored.prNumber).not.toBeNull()
    })
  })
})
