/**
 * Dispatch test for find-in-project (#6474, epic #6469).
 *
 * Guards the wire path between the dashboard message handler and the store for
 * `search_results`:
 *   - a valid reply REPLACES `codeSearchResults` and clears `codeSearchLoading`.
 *   - a malformed payload is dropped (Zod safeParse) without mutating state.
 *   - it does NOT touch the unrelated cross-session `searchResults` field.
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

vi.mock('./persistence', () => ({
  clearPersistedSession: vi.fn(),
}))

import {
  handleMessage,
  setStore,
  clearDeltaBuffers,
  clearPermissionSplits,
  stopHeartbeat,
  resetReplayFlags,
} from './message-handler'
import type { ConnectionState } from './types'
import type { ServerSearchResultsMessage } from '@chroxy/protocol'

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

function results(over: Partial<ServerSearchResultsMessage> = {}): ServerSearchResultsMessage {
  return {
    type: 'code_search_results',
    query: 'target',
    results: [{ file: 'src/a.ts', line: 3, column: 7, text: 'const target = 1' }],
    truncated: false,
    error: null,
    ...over,
  }
}

describe('search_results dispatch (#6474)', () => {
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
      codeSearchResults: null,
      codeSearchLoading: true,
      // The unrelated cross-session search field must be untouched.
      searchResults: [],
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

  it('stores the result set and clears the loading flag', () => {
    handleMessage(results(), ctx() as never)
    const s = store.getState()
    expect(s.codeSearchResults).not.toBeNull()
    expect(s.codeSearchResults!.query).toBe('target')
    expect(s.codeSearchResults!.results[0]?.file).toBe('src/a.ts')
    expect(s.codeSearchLoading).toBe(false)
  })

  it('does not touch the unrelated cross-session searchResults field', () => {
    handleMessage(results(), ctx() as never)
    // Cross-session `searchResults` (a different feature) stays as it was.
    expect(Array.isArray(store.getState().searchResults)).toBe(true)
    expect(store.getState().searchResults.length).toBe(0)
  })

  it('replaces a prior result set wholesale', () => {
    handleMessage(results(), ctx() as never)
    handleMessage(results({ query: 'other', results: [] }), ctx() as never)
    expect(store.getState().codeSearchResults!.query).toBe('other')
    expect(store.getState().codeSearchResults!.results).toEqual([])
  })

  it('drops a malformed payload without mutating state or clearing loading', () => {
    const before = store.getState().codeSearchResults
    // Missing the required `results` array.
    handleMessage({ type: 'code_search_results', query: 'x', truncated: false, error: null } as never, ctx() as never)
    expect(store.getState().codeSearchResults).toBe(before)
    expect(store.getState().codeSearchLoading).toBe(true)
  })
})
