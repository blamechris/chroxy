/**
 * Dispatch test for go-to-definition (#6475, epic #6469).
 *
 * Guards the wire path between the dashboard message handler and the store for
 * `symbol_location`:
 *   - a valid result is stored in `symbolLocation` with a FRESH, monotonically
 *     increasing nonce (so a repeat resolve of the same symbol re-fires the
 *     FileBrowserPanel jump effect even when file/line are unchanged).
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
import type { ServerSymbolLocationMessage } from '@chroxy/protocol'

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
    send: vi.fn(),
    close: vi.fn(),
    readyState: WebSocket.OPEN,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as WebSocket
}

function loc(over: Partial<ServerSymbolLocationMessage> = {}): ServerSymbolLocationMessage {
  return {
    type: 'symbol_location',
    symbol: 'doThing',
    file: 'src/foo.ts',
    line: 12,
    error: null,
    ...over,
  }
}

describe('symbol_location dispatch (#6475)', () => {
  let store: ReturnType<typeof createMockStore>
  let mockSocket: WebSocket

  const ctx = () => ({
    url: 'wss://t',
    token: 'tok',
    socket: mockSocket,
    isReconnect: false,
    silent: false,
  })

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
      symbolLocation: null,
      messages: [],
    })
    setStore(store)
  })

  afterEach(() => {
    stopHeartbeat()
    clearDeltaBuffers()
    clearPermissionSplits()
    resetReplayFlags()
  })

  it('stores a resolve hit with a nonce', () => {
    handleMessage(loc(), ctx() as never)
    const s = store.getState().symbolLocation
    expect(s).not.toBeNull()
    expect(s!.symbol).toBe('doThing')
    expect(s!.file).toBe('src/foo.ts')
    expect(s!.line).toBe(12)
    expect(s!.error).toBeNull()
    expect(s!.nonce).toBe(1)
  })

  it('stores a not-found miss (null file/line + error)', () => {
    handleMessage(loc({ symbol: 'ghost', file: null, line: null, error: 'Definition not found' }), ctx() as never)
    const s = store.getState().symbolLocation
    expect(s!.file).toBeNull()
    expect(s!.line).toBeNull()
    expect(s!.error).toMatch(/not found/i)
  })

  it('increments the nonce on each result so an identical re-resolve re-fires', () => {
    handleMessage(loc(), ctx() as never)
    handleMessage(loc(), ctx() as never)
    expect(store.getState().symbolLocation!.nonce).toBe(2)
  })

  it('drops a malformed payload without mutating state', () => {
    const before = store.getState().symbolLocation
    // Missing the required `symbol` field.
    handleMessage({ type: 'symbol_location', file: 'x', line: 1, error: null } as never, ctx() as never)
    expect(store.getState().symbolLocation).toBe(before)
  })
})
