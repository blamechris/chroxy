/**
 * Dispatch test for find-all-references (#6477, epic #6469).
 *
 * Guards the wire path between the dashboard message handler and the store for
 * `references_result`:
 *   - a valid reply REPLACES `referencesResult` and clears `referencesLoading`.
 *   - a malformed payload is dropped (Zod safeParse) without mutating state.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('./crypto', () => ({
  createKeyPair: vi.fn(() => ({ publicKey: 'mock-pub', secretKey: 'mock-sec' })),
  deriveSharedKey: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  generateConnectionSalt: vi.fn(() => 'mock-salt'),
  deriveConnectionKey: vi.fn(() => new Uint8Array(32)),
  DIRECTION_CLIENT: 0,
  DIRECTION_SERVER: 1,
}))

vi.mock('./persistence', () => ({ clearPersistedSession: vi.fn() }))

import {
  handleMessage,
  setStore,
  clearDeltaBuffers,
  clearPermissionSplits,
  stopHeartbeat,
  resetReplayFlags,
} from './message-handler'
import type { ConnectionState } from './types'
import type { ServerReferencesResultMessage } from '@chroxy/protocol'

function createMockStore(initial: Partial<ConnectionState>) {
  let state = initial as ConnectionState
  return {
    getState: () => state,
    setState: (s: Partial<ConnectionState> | ((prev: ConnectionState) => Partial<ConnectionState>)) => {
      const patch = typeof s === 'function' ? s(state) : s
      state = { ...state, ...patch }
    },
  }
}

function createMockSocket(): WebSocket {
  return {
    send: vi.fn(), close: vi.fn(), readyState: WebSocket.OPEN,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  } as unknown as WebSocket
}

function refs(over: Partial<ServerReferencesResultMessage> = {}): ServerReferencesResultMessage {
  return {
    type: 'references_result',
    symbol: 'widget',
    results: [{ file: 'src/a.ts', line: 3, column: 7, text: 'const widget = 1' }],
    truncated: false,
    error: null,
    ...over,
  }
}

describe('references_result dispatch (#6477)', () => {
  let store: ReturnType<typeof createMockStore>
  let mockSocket: WebSocket
  const ctx = () => ({ url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false })

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    clearDeltaBuffers()
    clearPermissionSplits()
    mockSocket = createMockSocket()
    store = createMockStore({
      connectionPhase: 'connected',
      socket: null,
      sessions: [],
      activeSessionId: null,
      sessionStates: {},
      referencesResult: null,
      referencesLoading: true,
      messages: [],
    } as unknown as Partial<ConnectionState>)
    setStore(store)
  })

  afterEach(() => {
    stopHeartbeat()
    clearDeltaBuffers()
    clearPermissionSplits()
    resetReplayFlags()
  })

  it('stores the reference set and clears the loading flag', () => {
    handleMessage(refs(), ctx() as never)
    const s = store.getState()
    expect(s.referencesResult).not.toBeNull()
    expect(s.referencesResult!.symbol).toBe('widget')
    expect(s.referencesResult!.results[0]?.file).toBe('src/a.ts')
    expect(s.referencesLoading).toBe(false)
  })

  it('replaces a prior reference set wholesale', () => {
    handleMessage(refs(), ctx() as never)
    handleMessage(refs({ symbol: 'other', results: [] }), ctx() as never)
    expect(store.getState().referencesResult!.symbol).toBe('other')
    expect(store.getState().referencesResult!.results).toEqual([])
  })

  it('drops a malformed payload without mutating state or clearing loading', () => {
    const before = store.getState().referencesResult
    handleMessage({ type: 'references_result', symbol: 'x', truncated: false, error: null } as never, ctx() as never)
    expect(store.getState().referencesResult).toBe(before)
    expect(store.getState().referencesLoading).toBe(true)
  })
})
