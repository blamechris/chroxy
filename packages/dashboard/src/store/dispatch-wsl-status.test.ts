/**
 * Integration test for the WSL2 distro survey wiring (#6138, epic #5530).
 * Guards: snapshot REPLACES wslStatus + clears loading; malformed dropped
 * without clearing loading; available:false (off Windows / no wsl.exe) is a
 * valid state. Mirrors dispatch-emulator-status.test.ts.
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
import type { ServerWslStatusSnapshotMessage } from '@chroxy/protocol'

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
  return { connectionPhase: 'connected', socket: null, sessions: [], activeSessionId: null, sessionStates: {}, wslStatus: null, wslStatusLoading: true, messages: [] }
}
function snapshot(over: Partial<ServerWslStatusSnapshotMessage> = {}): ServerWslStatusSnapshotMessage {
  return {
    type: 'wsl_status_snapshot',
    generatedAt: '2026-06-20T12:00:00.000Z',
    available: true,
    note: null,
    defaultDistro: 'Ubuntu',
    distros: [
      { name: 'Ubuntu', state: 'Running', version: 2, isDefault: true },
      { name: 'Debian', state: 'Stopped', version: 2, isDefault: false },
    ],
    ...over,
  } as ServerWslStatusSnapshotMessage
}

describe('wsl status dispatch (#6138)', () => {
  let store: ReturnType<typeof createMockStore>
  let mockSocket: WebSocket
  const ctx = () => ({ url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false })

  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear(); clearDeltaBuffers(); clearPermissionSplits()
    mockSocket = createMockSocket(); store = createMockStore(baseState()); setStore(store)
  })
  afterEach(() => { stopHeartbeat(); clearDeltaBuffers(); clearPermissionSplits(); resetReplayFlags() })

  it('applies wsl_status_snapshot and clears loading', () => {
    handleMessage(snapshot(), ctx() as never)
    const s = store.getState()
    expect(s.wslStatus!.distros.map((d) => d.name)).toEqual(['Ubuntu', 'Debian'])
    expect(s.wslStatus!.defaultDistro).toBe('Ubuntu')
    expect(s.wslStatusLoading).toBe(false)
  })

  it('relays an available:false (off Windows / no wsl.exe) snapshot as a valid state', () => {
    handleMessage(snapshot({ available: false, note: 'WSL is only available on Windows hosts.', defaultDistro: null, distros: [] }), ctx() as never)
    const s = store.getState()
    expect(s.wslStatus!.available).toBe(false)
    expect(s.wslStatus!.distros).toEqual([])
    expect(s.wslStatusLoading).toBe(false)
  })

  it('drops a malformed snapshot without clearing loading', () => {
    handleMessage({ type: 'wsl_status_snapshot', generatedAt: '2026-06-20T12:00:00.000Z' }, ctx() as never)
    expect(store.getState().wslStatus).toBeNull()
    expect(store.getState().wslStatusLoading).toBe(true)
  })
})
