/**
 * #6543 (IDE P3 feature B) — `permission_input` dispatch. The pulled full
 * redacted tool input lands in `permissionInputs[requestId]`; both found:true
 * and found:false are stored; malformed is dropped. Mirrors dispatch-repo-events.
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
  return { connectionPhase: 'connected', socket: null, sessions: [], activeSessionId: null, sessionStates: {}, permissionInputs: {}, messages: [] }
}

describe('permission_input dispatch (#6543)', () => {
  let store: ReturnType<typeof createMockStore>
  let mockSocket: WebSocket
  const ctx = () => ({ url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false })

  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear(); clearDeltaBuffers(); clearPermissionSplits()
    mockSocket = createMockSocket(); store = createMockStore(baseState()); setStore(store)
  })
  afterEach(() => { stopHeartbeat(); clearDeltaBuffers(); clearPermissionSplits(); resetReplayFlags() })

  it('stores a found:true permission_input keyed by requestId', () => {
    handleMessage({ type: 'permission_input', requestId: 'r1', found: true, tool: 'Write', input: { file_path: '/x', content: 'a\nb' } }, ctx() as never)
    const entry = store.getState().permissionInputs['r1']
    expect(entry!.found).toBe(true)
    expect(entry!.tool).toBe('Write')
    expect((entry!.input as { content: string }).content).toBe('a\nb')
  })

  it('stores a found:false reply so the UI can show "unavailable"', () => {
    handleMessage({ type: 'permission_input', requestId: 'r2', found: false, error: { code: 'NOT_PENDING', message: 'gone' } }, ctx() as never)
    const entry = store.getState().permissionInputs['r2']
    expect(entry!.found).toBe(false)
    expect(entry!.error!.code).toBe('NOT_PENDING')
  })

  it('drops a malformed permission_input (missing found)', () => {
    handleMessage({ type: 'permission_input', requestId: 'r3' }, ctx() as never)
    expect(store.getState().permissionInputs['r3']).toBeUndefined()
  })
})
