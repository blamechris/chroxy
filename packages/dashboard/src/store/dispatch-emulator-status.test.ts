/**
 * Integration test for the Android emulator survey wiring (#6137, epic #5530).
 * Guards: snapshot REPLACES emulatorStatus + clears loading; malformed dropped
 * without clearing loading; available:false (no SDK) is a valid state.
 * Mirrors dispatch-simulator-status.test.ts.
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
import type { ServerEmulatorStatusSnapshotMessage } from '@chroxy/protocol'

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
  return { connectionPhase: 'connected', socket: null, sessions: [], activeSessionId: null, sessionStates: {}, emulatorStatus: null, emulatorStatusLoading: true, messages: [] }
}
function snapshot(over: Partial<ServerEmulatorStatusSnapshotMessage> = {}): ServerEmulatorStatusSnapshotMessage {
  return {
    type: 'emulator_status_snapshot',
    generatedAt: '2026-06-20T12:00:00.000Z',
    available: true,
    note: null,
    devices: [{ avd: 'Pixel_7_API_34', serial: 'emulator-5554', state: 'running' }],
    readyForMaestro: { ready: true, runningDevice: 'Pixel_7_API_34', metroReachable: true, mockServerReachable: true, reasons: [] },
    ...over,
  } as ServerEmulatorStatusSnapshotMessage
}

describe('emulator status dispatch (#6137)', () => {
  let store: ReturnType<typeof createMockStore>
  let mockSocket: WebSocket
  const ctx = () => ({ url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false })

  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear(); clearDeltaBuffers(); clearPermissionSplits()
    mockSocket = createMockSocket(); store = createMockStore(baseState()); setStore(store)
  })
  afterEach(() => { stopHeartbeat(); clearDeltaBuffers(); clearPermissionSplits(); resetReplayFlags() })

  it('applies emulator_status_snapshot and clears loading', () => {
    handleMessage(snapshot(), ctx() as never)
    const s = store.getState()
    expect(s.emulatorStatus!.devices.map((d) => d.serial)).toEqual(['emulator-5554'])
    expect(s.emulatorStatus!.readyForMaestro.ready).toBe(true)
    expect(s.emulatorStatusLoading).toBe(false)
  })

  it('relays an available:false (no SDK) snapshot as a valid state', () => {
    handleMessage(snapshot({ available: false, note: 'no Android SDK', devices: [], readyForMaestro: { ready: false, runningDevice: null, metroReachable: false, mockServerReachable: false, reasons: [] } }), ctx() as never)
    const s = store.getState()
    expect(s.emulatorStatus!.available).toBe(false)
    expect(s.emulatorStatusLoading).toBe(false)
  })

  it('drops a malformed snapshot without clearing loading', () => {
    handleMessage({ type: 'emulator_status_snapshot', generatedAt: '2026-06-20T12:00:00.000Z' }, ctx() as never)
    expect(store.getState().emulatorStatus).toBeNull()
    expect(store.getState().emulatorStatusLoading).toBe(true)
  })
})
