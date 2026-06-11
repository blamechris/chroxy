/**
 * Pairing-approval primitive dispatch (#5510, epic #5509).
 *
 * Guards the wire path between the dashboard message handler and the store for
 * the host approval surface:
 *   - `pair_pending` APPENDS to `pendingPairRequests` (deduped by requestId).
 *   - `pair_resolved` REMOVES the matching request.
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

function pending(requestId: string, deviceName = 'Pixel', verifyCode = '123456') {
  return { type: 'pair_pending', requestId, deviceName, verifyCode, expiresAt: Date.now() + 120_000 }
}

describe('pairing-approval dispatch (#5510)', () => {
  let store: ReturnType<typeof createMockStore>
  let mockSocket: WebSocket

  const ctx = () => ({ url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false })

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    clearDeltaBuffers()
    clearPermissionSplits()
    mockSocket = createMockSocket()
    store = createMockStore({ connectionPhase: 'connected', pendingPairRequests: [] })
    setStore(store)
  })

  afterEach(() => {
    stopHeartbeat()
    clearDeltaBuffers()
    clearPermissionSplits()
    resetReplayFlags()
  })

  it('appends a pair_pending request', () => {
    handleMessage(pending('r1', 'iPhone', '000111') as never, ctx() as never)
    const s = store.getState()
    expect(s.pendingPairRequests).toHaveLength(1)
    const first = s.pendingPairRequests[0]
    if (!first) throw new Error('expected one pending pair request')
    expect(first.requestId).toBe('r1')
    expect(first.deviceName).toBe('iPhone')
    expect(first.verifyCode).toBe('000111')
  })

  it('dedupes by requestId on a replay', () => {
    handleMessage(pending('r1') as never, ctx() as never)
    handleMessage(pending('r1') as never, ctx() as never)
    expect(store.getState().pendingPairRequests).toHaveLength(1)
  })

  it('keeps multiple distinct requests', () => {
    handleMessage(pending('r1') as never, ctx() as never)
    handleMessage(pending('r2') as never, ctx() as never)
    expect(store.getState().pendingPairRequests.map((p) => p.requestId)).toEqual(['r1', 'r2'])
  })

  it('removes a request on pair_resolved', () => {
    handleMessage(pending('r1') as never, ctx() as never)
    handleMessage(pending('r2') as never, ctx() as never)
    handleMessage({ type: 'pair_resolved', requestId: 'r1', reason: 'approved' } as never, ctx() as never)
    expect(store.getState().pendingPairRequests.map((p) => p.requestId)).toEqual(['r2'])
  })

  it('drops a malformed pair_pending without mutating state', () => {
    handleMessage(pending('r1') as never, ctx() as never)
    // Missing verifyCode → schema reject.
    handleMessage({ type: 'pair_pending', requestId: 'bad', deviceName: 'x', expiresAt: 1 } as never, ctx() as never)
    expect(store.getState().pendingPairRequests.map((p) => p.requestId)).toEqual(['r1'])
  })
})
