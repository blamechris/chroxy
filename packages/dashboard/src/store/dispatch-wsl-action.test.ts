/**
 * Integration test for the WSL2 distro action wiring (#6138, epic #5530).
 * Guards: ack clears the distro's pending state + records a note; malformed
 * dropped; WSL_ACTION_FAILED clears the echoed distro + records the error;
 * other targets untouched. Mirrors dispatch-emulator-action.test.ts.
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
    wslActioningIds: new Set(['Ubuntu', 'Debian']),
    wslActionResults: {},
    messages: [],
  }
}

describe('wsl action dispatch (#6138)', () => {
  let store: ReturnType<typeof createMockStore>
  let mockSocket: WebSocket
  const ctx = () => ({ url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false })

  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear(); clearDeltaBuffers(); clearPermissionSplits()
    mockSocket = createMockSocket(); store = createMockStore(baseState()); setStore(store)
  })
  afterEach(() => { stopHeartbeat(); clearDeltaBuffers(); clearPermissionSplits(); resetReplayFlags() })

  it('a start ack clears the distro target and records a Started note', () => {
    handleMessage({ type: 'wsl_action_ack', action: 'start', distro: 'Ubuntu', requestId: 'r1', status: 'running' }, ctx() as never)
    const s = store.getState()
    expect(s.wslActioningIds.has('Ubuntu')).toBe(false)
    expect(s.wslActioningIds.has('Debian')).toBe(true) // other target untouched
    expect(s.wslActionResults['Ubuntu']!.error).toBeNull()
    expect(s.wslActionResults['Ubuntu']!.note).toMatch(/Started/)
  })

  it('a terminate ack clears the distro target and records a Terminated note', () => {
    handleMessage({ type: 'wsl_action_ack', action: 'terminate', distro: 'Debian', status: 'stopped' }, ctx() as never)
    expect(store.getState().wslActionResults['Debian']!.note).toMatch(/Terminated/)
  })

  it('appends an unexpected status to the note', () => {
    handleMessage({ type: 'wsl_action_ack', action: 'start', distro: 'Ubuntu', status: 'installing' }, ctx() as never)
    expect(store.getState().wslActionResults['Ubuntu']!.note).toMatch(/installing/)
  })

  it('drops a malformed ack (missing distro) without touching pending state', () => {
    handleMessage({ type: 'wsl_action_ack', action: 'start' }, ctx() as never)
    expect(store.getState().wslActioningIds.has('Ubuntu')).toBe(true)
  })

  it('WSL_ACTION_FAILED (start) clears the echoed distro and records the error', () => {
    store.setState({ addServerError: vi.fn() } as never)
    handleMessage({ type: 'session_error', code: 'WSL_ACTION_FAILED', message: 'wsl.exe ENOENT', reason: 'start-failed', action: 'start', distro: 'Ubuntu', requestId: 'r1' }, ctx() as never)
    const s = store.getState()
    expect(s.wslActioningIds.has('Ubuntu')).toBe(false)
    expect(s.wslActioningIds.has('Debian')).toBe(true)
    expect(s.wslActionResults['Ubuntu']!.error).toMatch(/ENOENT/)
    expect(s.wslActionResults['Ubuntu']!.note).toBeNull()
  })

  it('WSL_ACTION_FAILED (terminate) clears the echoed distro', () => {
    store.setState({ addServerError: vi.fn() } as never)
    handleMessage({ type: 'session_error', code: 'WSL_ACTION_FAILED', message: 'no distribution', reason: 'terminate-failed', action: 'terminate', distro: 'Debian' }, ctx() as never)
    expect(store.getState().wslActioningIds.has('Debian')).toBe(false)
    expect(store.getState().wslActionResults['Debian']!.error).toMatch(/no distribution/)
  })

  it('a FAILED without a distro leaves action state alone', () => {
    store.setState({ addServerError: vi.fn() } as never)
    handleMessage({ type: 'session_error', code: 'WSL_ACTION_FAILED', message: 'boom' }, ctx() as never)
    expect(store.getState().wslActioningIds.has('Ubuntu')).toBe(true)
  })
})
