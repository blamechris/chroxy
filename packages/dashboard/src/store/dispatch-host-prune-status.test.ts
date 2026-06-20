/**
 * Integration test for the host prune survey wiring (#6140, epic #5530).
 * Guards: snapshot REPLACES hostPruneStatus + clears loading; malformed dropped
 * without clearing loading; docker-unavailable is a valid state.
 * Mirrors dispatch-byok-pool-status.test.ts.
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
import type { ServerHostPruneStatusSnapshotMessage } from '@chroxy/protocol'

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
  return { connectionPhase: 'connected', socket: null, sessions: [], activeSessionId: null, sessionStates: {}, hostPruneStatus: null, hostPruneStatusLoading: true, messages: [] }
}
function snapshot(over: Partial<ServerHostPruneStatusSnapshotMessage> = {}): ServerHostPruneStatusSnapshotMessage {
  return {
    type: 'host_prune_status_snapshot',
    generatedAt: '2026-06-19T12:00:00.000Z',
    dockerAvailable: true,
    note: null,
    containers: [{ id: 'aaa', name: 'chroxy-env-foo', state: 'exited', sizeBytes: 10_000_000 }],
    images: [{ id: 'img1', ref: 'chroxy-env:foo-1', repository: 'chroxy-env', sizeBytes: 1_000_000_000 }],
    summary: { containerCount: 1, imageCount: 1, reclaimableBytes: 1_010_000_000 },
    ...over,
  } as ServerHostPruneStatusSnapshotMessage
}

describe('host prune status dispatch (#6140)', () => {
  let store: ReturnType<typeof createMockStore>
  let mockSocket: WebSocket
  const ctx = () => ({ url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false })

  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear(); clearDeltaBuffers(); clearPermissionSplits()
    mockSocket = createMockSocket(); store = createMockStore(baseState()); setStore(store)
  })
  afterEach(() => { stopHeartbeat(); clearDeltaBuffers(); clearPermissionSplits(); resetReplayFlags() })

  it('applies host_prune_status_snapshot and clears loading', () => {
    handleMessage(snapshot(), ctx() as never)
    const s = store.getState()
    expect(s.hostPruneStatus!.summary.containerCount).toBe(1)
    expect(s.hostPruneStatus!.images.map((i) => i.ref)).toEqual(['chroxy-env:foo-1'])
    expect(s.hostPruneStatusLoading).toBe(false)
  })

  it('relays a docker-unavailable snapshot as a valid state', () => {
    handleMessage(snapshot({ dockerAvailable: false, note: 'docker unavailable', containers: [], images: [], summary: { containerCount: 0, imageCount: 0, reclaimableBytes: 0 } }), ctx() as never)
    const s = store.getState()
    expect(s.hostPruneStatus!.dockerAvailable).toBe(false)
    expect(s.hostPruneStatusLoading).toBe(false)
  })

  it('drops a malformed snapshot without clearing loading', () => {
    handleMessage({ type: 'host_prune_status_snapshot', generatedAt: '2026-06-19T12:00:00.000Z' }, ctx() as never)
    expect(store.getState().hostPruneStatus).toBeNull()
    expect(store.getState().hostPruneStatusLoading).toBe(true)
  })
})
