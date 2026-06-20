/**
 * Integration test for the iOS simulator survey wiring (#6136, epic #5530).
 * Guards: snapshot REPLACES simulatorStatus + clears loading; malformed dropped
 * without clearing loading; available:false (off macOS) is a valid state.
 * Mirrors dispatch-host-prune-status.test.ts.
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
import type { ServerSimulatorStatusSnapshotMessage } from '@chroxy/protocol'

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
  return { connectionPhase: 'connected', socket: null, sessions: [], activeSessionId: null, sessionStates: {}, simulatorStatus: null, simulatorStatusLoading: true, messages: [] }
}
function snapshot(over: Partial<ServerSimulatorStatusSnapshotMessage> = {}): ServerSimulatorStatusSnapshotMessage {
  return {
    type: 'simulator_status_snapshot',
    generatedAt: '2026-06-20T12:00:00.000Z',
    available: true,
    note: null,
    devices: [{ udid: 'U-BOOTED', name: 'iPhone 16 Pro', state: 'Booted', runtime: 'iOS 26.1', deviceType: 'iPhone 16 Pro', isAvailable: true }],
    readyForMaestro: { ready: true, bootedSimulator: 'iPhone 16 Pro', metroReachable: true, mockServerReachable: true, reasons: [] },
    ...over,
  } as ServerSimulatorStatusSnapshotMessage
}

describe('simulator status dispatch (#6136)', () => {
  let store: ReturnType<typeof createMockStore>
  let mockSocket: WebSocket
  const ctx = () => ({ url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false })

  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear(); clearDeltaBuffers(); clearPermissionSplits()
    mockSocket = createMockSocket(); store = createMockStore(baseState()); setStore(store)
  })
  afterEach(() => { stopHeartbeat(); clearDeltaBuffers(); clearPermissionSplits(); resetReplayFlags() })

  it('applies simulator_status_snapshot and clears loading', () => {
    handleMessage(snapshot(), ctx() as never)
    const s = store.getState()
    expect(s.simulatorStatus!.devices.map((d) => d.udid)).toEqual(['U-BOOTED'])
    expect(s.simulatorStatus!.readyForMaestro.ready).toBe(true)
    expect(s.simulatorStatusLoading).toBe(false)
  })

  it('relays an available:false (off-macOS) snapshot as a valid state', () => {
    handleMessage(snapshot({ available: false, note: 'not available on this host', devices: [], readyForMaestro: { ready: false, bootedSimulator: null, metroReachable: false, mockServerReachable: false, reasons: [] } }), ctx() as never)
    const s = store.getState()
    expect(s.simulatorStatus!.available).toBe(false)
    expect(s.simulatorStatusLoading).toBe(false)
  })

  it('drops a malformed snapshot without clearing loading', () => {
    handleMessage({ type: 'simulator_status_snapshot', generatedAt: '2026-06-20T12:00:00.000Z' }, ctx() as never)
    expect(store.getState().simulatorStatus).toBeNull()
    expect(store.getState().simulatorStatusLoading).toBe(true)
  })
})
