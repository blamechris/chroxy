/**
 * Integration test for the Android emulator action wiring (#6137, epic #5530).
 * Guards: ack clears the target's pending state + records a note; malformed
 * dropped; EMULATOR_ACTION_FAILED clears the echoed target + records the error;
 * other targets untouched. Mirrors dispatch-simulator-action.test.ts.
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
    emulatorActioningIds: new Set(['Pixel_5_API_33', 'emulator-5554']),
    emulatorActionResults: {},
    messages: [],
  }
}

describe('emulator action dispatch (#6137)', () => {
  let store: ReturnType<typeof createMockStore>
  let mockSocket: WebSocket
  const ctx = () => ({ url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false })

  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear(); clearDeltaBuffers(); clearPermissionSplits()
    mockSocket = createMockSocket(); store = createMockStore(baseState()); setStore(store)
  })
  afterEach(() => { stopHeartbeat(); clearDeltaBuffers(); clearPermissionSplits(); resetReplayFlags() })

  it('a boot ack clears the avd target and records a Starting note', () => {
    handleMessage({ type: 'emulator_action_ack', action: 'boot', avd: 'Pixel_5_API_33', serial: null, requestId: 'r1', status: 'starting' }, ctx() as never)
    const s = store.getState()
    expect(s.emulatorActioningIds.has('Pixel_5_API_33')).toBe(false)
    expect(s.emulatorActioningIds.has('emulator-5554')).toBe(true) // other target untouched
    expect(s.emulatorActionResults['Pixel_5_API_33']!.error).toBeNull()
    expect(s.emulatorActionResults['Pixel_5_API_33']!.note).toMatch(/Starting/)
  })

  it('a kill ack clears the serial target and records a Killed note', () => {
    handleMessage({ type: 'emulator_action_ack', action: 'kill', avd: null, serial: 'emulator-5554', status: 'killed' }, ctx() as never)
    expect(store.getState().emulatorActionResults['emulator-5554']!.note).toMatch(/Killed/)
  })

  it('drops a malformed ack (missing target) without touching pending state', () => {
    handleMessage({ type: 'emulator_action_ack', action: 'boot' }, ctx() as never)
    expect(store.getState().emulatorActioningIds.has('Pixel_5_API_33')).toBe(true)
  })

  it('EMULATOR_ACTION_FAILED (boot) clears the echoed avd and records the error', () => {
    store.setState({ addServerError: vi.fn() } as never)
    handleMessage({ type: 'session_error', code: 'EMULATOR_ACTION_FAILED', message: 'emulator ENOENT', reason: 'boot-failed', action: 'boot', avd: 'Pixel_5_API_33', requestId: 'r1' }, ctx() as never)
    const s = store.getState()
    expect(s.emulatorActioningIds.has('Pixel_5_API_33')).toBe(false)
    expect(s.emulatorActioningIds.has('emulator-5554')).toBe(true)
    expect(s.emulatorActionResults['Pixel_5_API_33']!.error).toMatch(/ENOENT/)
    expect(s.emulatorActionResults['Pixel_5_API_33']!.note).toBeNull()
  })

  it('EMULATOR_ACTION_FAILED (kill) clears the echoed serial', () => {
    store.setState({ addServerError: vi.fn() } as never)
    handleMessage({ type: 'session_error', code: 'EMULATOR_ACTION_FAILED', message: 'device not found', reason: 'kill-failed', action: 'kill', serial: 'emulator-5554' }, ctx() as never)
    expect(store.getState().emulatorActioningIds.has('emulator-5554')).toBe(false)
    expect(store.getState().emulatorActionResults['emulator-5554']!.error).toMatch(/device not found/)
  })

  it('a FAILED without a target leaves action state alone', () => {
    store.setState({ addServerError: vi.fn() } as never)
    handleMessage({ type: 'session_error', code: 'EMULATOR_ACTION_FAILED', message: 'boom' }, ctx() as never)
    expect(store.getState().emulatorActioningIds.has('Pixel_5_API_33')).toBe(true)
  })
})
