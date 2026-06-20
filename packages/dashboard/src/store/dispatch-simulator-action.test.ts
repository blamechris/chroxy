/**
 * Integration test for the simulator action wiring (#6136 slice 3, epic #5530).
 * Guards: ack clears the udid's pending state + records a note; malformed dropped;
 * SIMULATOR_ACTION_FAILED clears the echoed udid + records the error; other udids
 * untouched. Mirrors dispatch-host-prune-action.test.ts.
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
    simulatorActioningIds: new Set(['U-A', 'U-B']),
    simulatorActionResults: {},
    messages: [],
  }
}

describe('simulator action dispatch (#6136 slice 3)', () => {
  let store: ReturnType<typeof createMockStore>
  let mockSocket: WebSocket
  const ctx = () => ({ url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false })

  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear(); clearDeltaBuffers(); clearPermissionSplits()
    mockSocket = createMockSocket(); store = createMockStore(baseState()); setStore(store)
  })
  afterEach(() => { stopHeartbeat(); clearDeltaBuffers(); clearPermissionSplits(); resetReplayFlags() })

  it('a boot ack clears the udid and records a state note', () => {
    handleMessage({ type: 'simulator_action_ack', action: 'boot', udid: 'U-A', requestId: 'r1', status: 'Booted' }, ctx() as never)
    const s = store.getState()
    expect(s.simulatorActioningIds.has('U-A')).toBe(false)
    expect(s.simulatorActioningIds.has('U-B')).toBe(true) // other udid untouched
    expect(s.simulatorActionResults['U-A']!.error).toBeNull()
    expect(s.simulatorActionResults['U-A']!.note).toMatch(/Booted/)
  })

  it('a shutdown ack records a shut-down note', () => {
    handleMessage({ type: 'simulator_action_ack', action: 'shutdown', udid: 'U-A', status: 'Shutdown' }, ctx() as never)
    expect(store.getState().simulatorActionResults['U-A']!.note).toMatch(/Shut down/)
  })

  it('drops a malformed ack (missing udid) without touching pending state', () => {
    handleMessage({ type: 'simulator_action_ack', action: 'boot' }, ctx() as never)
    expect(store.getState().simulatorActioningIds.has('U-A')).toBe(true)
  })

  it('SIMULATOR_ACTION_FAILED clears the echoed udid and records the error', () => {
    store.setState({ addServerError: vi.fn() } as never)
    handleMessage({ type: 'session_error', code: 'SIMULATOR_ACTION_FAILED', message: 'Unable to boot device', reason: 'boot-failed', action: 'boot', udid: 'U-A', requestId: 'r1' }, ctx() as never)
    const s = store.getState()
    expect(s.simulatorActioningIds.has('U-A')).toBe(false)
    expect(s.simulatorActioningIds.has('U-B')).toBe(true)
    expect(s.simulatorActionResults['U-A']!.error).toMatch(/Unable to boot device/)
    expect(s.simulatorActionResults['U-A']!.note).toBeNull()
  })

  it('a FAILED without a udid leaves action state alone', () => {
    store.setState({ addServerError: vi.fn() } as never)
    handleMessage({ type: 'session_error', code: 'SIMULATOR_ACTION_FAILED', message: 'boom' }, ctx() as never)
    expect(store.getState().simulatorActioningIds.has('U-A')).toBe(true)
  })
})
