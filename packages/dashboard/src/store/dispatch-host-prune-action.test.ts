/**
 * Integration test for the host prune action wiring (#6140 slice 2, epic #5530).
 * Guards: ack clears the kind's pending state + records a note; malformed dropped;
 * HOST_PRUNE_ACTION_FAILED clears the echoed kind + records the error; other kinds
 * untouched. Mirrors dispatch-byok-pool-action.test.ts.
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
    connectionPhase: 'connected', socket: null, sessions: [], activeSessionId: null, sessionStates: {},
    hostPruneActioningIds: new Set(['all', 'containers']),
    hostPruneActionResults: {},
    messages: [],
  }
}

describe('host prune action dispatch (#6140 slice 2)', () => {
  let store: ReturnType<typeof createMockStore>
  let mockSocket: WebSocket
  const ctx = () => ({ url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false })

  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear(); clearDeltaBuffers(); clearPermissionSplits()
    mockSocket = createMockSocket(); store = createMockStore(baseState()); setStore(store)
  })
  afterEach(() => { stopHeartbeat(); clearDeltaBuffers(); clearPermissionSplits(); resetReplayFlags() })

  it('an ack clears the kind and records a removed-count note', () => {
    handleMessage({ type: 'host_prune_action_ack', kind: 'all', requestId: 'r1', dockerAvailable: true, removedContainers: 2, removedImages: 3, reclaimedBytes: 1_048_576, failures: [] }, ctx() as never)
    const s = store.getState()
    expect(s.hostPruneActioningIds.has('all')).toBe(false)
    expect(s.hostPruneActioningIds.has('containers')).toBe(true) // other kind untouched
    expect(s.hostPruneActionResults['all']!.error).toBeNull()
    expect(s.hostPruneActionResults['all']!.note).toMatch(/Removed 2 containers, 3 images/)
  })

  it('a note flags partial failures', () => {
    handleMessage({ type: 'host_prune_action_ack', kind: 'images', dockerAvailable: true, removedContainers: 0, removedImages: 1, reclaimedBytes: 0, failures: [{ ref: 'chroxy-env:x', error: 'in use' }] }, ctx() as never)
    expect(store.getState().hostPruneActionResults['images']!.note).toMatch(/1 failed/)
  })

  it('drops a malformed ack (missing kind) without touching pending state', () => {
    handleMessage({ type: 'host_prune_action_ack', removedContainers: 1 }, ctx() as never)
    expect(store.getState().hostPruneActioningIds.has('all')).toBe(true)
  })

  it('HOST_PRUNE_ACTION_FAILED clears the echoed kind and records the error', () => {
    store.setState({ addServerError: vi.fn() } as never)
    handleMessage({ type: 'session_error', code: 'HOST_PRUNE_ACTION_FAILED', message: 'docker rmi failed', reason: 'prune-failed', kind: 'all', requestId: 'r1' }, ctx() as never)
    const s = store.getState()
    expect(s.hostPruneActioningIds.has('all')).toBe(false)
    expect(s.hostPruneActioningIds.has('containers')).toBe(true)
    expect(s.hostPruneActionResults['all']!.error).toMatch(/docker rmi failed/)
    expect(s.hostPruneActionResults['all']!.note).toBeNull()
  })

  it('a FAILED without a kind leaves action state alone', () => {
    store.setState({ addServerError: vi.fn() } as never)
    handleMessage({ type: 'session_error', code: 'HOST_PRUNE_ACTION_FAILED', message: 'boom' }, ctx() as never)
    expect(store.getState().hostPruneActioningIds.has('all')).toBe(true)
  })
})
