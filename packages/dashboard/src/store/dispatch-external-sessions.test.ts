/**
 * Integration test for the mission-control external-session survey wiring
 * (#5969, epic #5422 phase 4). Guards: snapshot REPLACES externalSessionsSnapshot
 * + clears loading; malformed dropped without clearing loading; a refusal
 * (error + empty sessions) is a valid state. Mirrors dispatch-wsl-status.test.ts.
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
import type { ServerExternalSessionsSnapshotMessage } from '@chroxy/protocol'

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
  return { connectionPhase: 'connected', socket: null, sessions: [], activeSessionId: null, sessionStates: {}, externalSessionsSnapshot: null, externalSessionsLoading: true, messages: [] }
}
function snapshot(over: Partial<ServerExternalSessionsSnapshotMessage> = {}): ServerExternalSessionsSnapshotMessage {
  return {
    type: 'external_sessions_snapshot',
    generatedAt: '2026-06-20T12:00:00.000Z',
    sessions: [
      { source: 'cli', sessionId: 'x1', name: 'chroxy', project: 'chroxy', cwd: '/home/u/chroxy', status: 'running', subagents: 1, lastActivityTs: 1_000_500 },
      { source: 'cli', sessionId: 'x2', name: 'widget', project: null, cwd: '/home/u/widget', status: 'idle', subagents: 0, lastActivityTs: 1_000_000 },
    ],
    ...over,
  } as ServerExternalSessionsSnapshotMessage
}

describe('external sessions dispatch (#5969)', () => {
  let store: ReturnType<typeof createMockStore>
  let mockSocket: WebSocket
  const ctx = () => ({ url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false })

  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear(); clearDeltaBuffers(); clearPermissionSplits()
    mockSocket = createMockSocket(); store = createMockStore(baseState()); setStore(store)
  })
  afterEach(() => { stopHeartbeat(); clearDeltaBuffers(); clearPermissionSplits(); resetReplayFlags() })

  it('applies external_sessions_snapshot and clears loading', () => {
    handleMessage(snapshot(), ctx() as never)
    const s = store.getState()
    expect(s.externalSessionsSnapshot!.sessions.map((x) => x.sessionId)).toEqual(['x1', 'x2'])
    expect(s.externalSessionsSnapshot!.sessions[0]!.status).toBe('running')
    expect(s.externalSessionsLoading).toBe(false)
  })

  it('relays a refusal snapshot (error + empty sessions) as a valid state', () => {
    handleMessage(snapshot({ sessions: [], error: { code: 'FORBIDDEN', message: 'nope' } }), ctx() as never)
    const s = store.getState()
    expect(s.externalSessionsSnapshot!.sessions).toEqual([])
    expect(s.externalSessionsSnapshot!.error!.code).toBe('FORBIDDEN')
    expect(s.externalSessionsLoading).toBe(false)
  })

  it('drops a malformed snapshot without clearing loading', () => {
    handleMessage({ type: 'external_sessions_snapshot', sessions: 'not-an-array' }, ctx() as never)
    expect(store.getState().externalSessionsSnapshot).toBeNull()
    expect(store.getState().externalSessionsLoading).toBe(true)
  })
})
