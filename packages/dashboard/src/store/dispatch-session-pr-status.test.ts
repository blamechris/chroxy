/**
 * #7344 — `session_pr_status` dispatch wiring.
 *
 * The load-bearing guard: the snapshot is filed under ITS OWN `sessionId`, not
 * under whichever session happens to be active when the reply lands. A reply
 * can arrive after the user has switched tabs, and misattributing it would show
 * one session's CI state on another session's chip — which is worse than
 * showing nothing, because it is confidently wrong.
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
import type { ServerSessionPrStatusMessage } from '@chroxy/protocol'

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
    sessionPrStatus: {}, sessionPrStatusLoading: { 'sess-A': true, 'sess-B': true },
  }
}
function snapshot(over: Partial<ServerSessionPrStatusMessage> = {}): ServerSessionPrStatusMessage {
  return {
    type: 'session_pr_status',
    requestId: 'r1',
    sessionId: 'sess-A',
    generatedAt: '2026-08-27T00:00:00.000Z',
    branch: 'feat/x',
    repo: { owner: 'blamechris', name: 'chroxy' },
    pr: { number: 7419, title: 't', url: 'https://github.com/blamechris/chroxy/pull/7419', headRefOid: 'abc1234', isDraft: false },
    checks: { state: 'success', counts: { total: 2, passed: 2, failed: 0, pending: 0, skipped: 0, unknown: 0 } },
    merge: { mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', reviewDecision: 'APPROVED' },
    reason: null,
    ...over,
  } as ServerSessionPrStatusMessage
}

describe('session_pr_status dispatch (#7344)', () => {
  let store: ReturnType<typeof createMockStore>
  let mockSocket: WebSocket
  const ctx = () => ({ url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false })

  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear(); clearDeltaBuffers(); clearPermissionSplits()
    mockSocket = createMockSocket(); store = createMockStore(baseState()); setStore(store)
  })
  afterEach(() => { stopHeartbeat(); clearDeltaBuffers(); clearPermissionSplits(); resetReplayFlags() })

  it('stores the snapshot under its own sessionId and clears that session\'s loading flag', () => {
    handleMessage(snapshot(), ctx() as never)
    const s = store.getState()
    expect(s.sessionPrStatus['sess-A']!.pr!.number).toBe(7419)
    // Check state and merge state survive the round trip as separate facts.
    expect(s.sessionPrStatus['sess-A']!.checks!.state).toBe('success')
    expect(s.sessionPrStatus['sess-A']!.merge!.mergeStateStatus).toBe('BLOCKED')
    expect(s.sessionPrStatusLoading['sess-A']).toBeUndefined()
  })

  it('files a background session\'s reply under THAT session, never the active one', () => {
    // activeSessionId is 'sess-A'; the reply is for 'sess-B'.
    handleMessage(snapshot({ sessionId: 'sess-B', pr: { number: 1, title: null, url: null, headRefOid: null, isDraft: false } }), ctx() as never)
    const s = store.getState()
    expect(s.sessionPrStatus['sess-B']!.pr!.number).toBe(1)
    expect(s.sessionPrStatus['sess-A']).toBeUndefined()
    expect(s.sessionPrStatusLoading['sess-B']).toBeUndefined()
    expect(s.sessionPrStatusLoading['sess-A']).toBe(true)
  })

  it('drops a snapshot with a null sessionId rather than attributing it to the active session', () => {
    handleMessage(snapshot({ sessionId: null }), ctx() as never)
    const s = store.getState()
    expect(s.sessionPrStatus).toEqual({})
    expect(s.sessionPrStatusLoading['sess-A']).toBe(true)
  })

  it('drops a malformed payload without clearing loading', () => {
    handleMessage({ type: 'session_pr_status', sessionId: 'sess-A', checks: 'green' } as never, ctx() as never)
    const s = store.getState()
    expect(s.sessionPrStatus).toEqual({})
    expect(s.sessionPrStatusLoading['sess-A']).toBe(true)
  })

  it('stores a degraded snapshot (pr null + reason) as a valid state', () => {
    handleMessage(snapshot({ pr: null, checks: null, merge: null, reason: 'no GitHub remote' }), ctx() as never)
    const s = store.getState()
    expect(s.sessionPrStatus['sess-A']!.reason).toBe('no GitHub remote')
    expect(s.sessionPrStatusLoading['sess-A']).toBeUndefined()
  })
})
