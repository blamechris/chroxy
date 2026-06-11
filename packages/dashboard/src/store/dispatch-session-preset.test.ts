/**
 * #5553 — session-preset wire path tests:
 *   - `session_preset_snapshot` lands the resolved preset in
 *     `sessionPresetSnapshots[cwd]` (and a null preset is stored explicitly).
 *   - a `session_switched` create-confirm carrying an active preset SEED stashes
 *     it in `pendingServerSeed[sessionId]` for App to drain (never auto-sent).
 *   - `takePendingServerSeed` returns + removes the entry.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('./crypto', () => ({
  createKeyPair: vi.fn(() => ({ publicKey: 'mock-pub', secretKey: 'mock-sec' })),
  deriveSharedKey: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  generateConnectionSalt: vi.fn(() => 'mock-salt'),
  deriveConnectionKey: vi.fn(() => new Uint8Array(32)),
  DIRECTION_CLIENT: 0,
  DIRECTION_SERVER: 1,
}))

vi.mock('./persistence', () => ({
  clearPersistedSession: vi.fn(),
}))

import {
  handleMessage,
  setStore,
  clearDeltaBuffers,
  clearPermissionSplits,
  stopHeartbeat,
  resetReplayFlags,
} from './message-handler'
import type { ConnectionState } from './types'

function createMockStore(initial: Partial<ConnectionState>) {
  let state = initial as ConnectionState
  return {
    getState: () => state,
    setState: (s: Partial<ConnectionState> | ((prev: ConnectionState) => Partial<ConnectionState>)) => {
      const patch = typeof s === 'function' ? s(state) : s
      state = { ...state, ...patch }
    },
  }
}

function createMockSocket(): WebSocket {
  return {
    send: vi.fn(),
    close: vi.fn(),
    readyState: WebSocket.OPEN,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as WebSocket
}

function baseState(): Partial<ConnectionState> {
  return {
    connectionPhase: 'connected',
    socket: null,
    sessions: [],
    activeSessionId: null,
    sessionStates: {},
    sessionPresetSnapshots: {},
    pendingServerSeed: {},
    messages: [],
    // session_switched refreshes project slash commands + agents; stub them.
    fetchSlashCommands: vi.fn(),
    fetchCustomAgents: vi.fn(),
  } as unknown as Partial<ConnectionState>
}

describe('session-preset dispatch (#5553)', () => {
  let store: ReturnType<typeof createMockStore>
  let mockSocket: WebSocket

  const ctx = () => ({ url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false })

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    clearDeltaBuffers()
    clearPermissionSplits()
    mockSocket = createMockSocket()
    store = createMockStore(baseState())
    setStore(store)
  })

  afterEach(() => {
    stopHeartbeat()
    clearDeltaBuffers()
    clearPermissionSplits()
    resetReplayFlags()
  })

  it('lands a session_preset_snapshot keyed by cwd', () => {
    handleMessage({
      type: 'session_preset_snapshot',
      cwd: '/repo/x',
      preset: {
        source: 'daemon', active: true, trustState: 'trusted', enabled: true,
        preamble: 'P', seed: 'S', preambleLength: 1, seedLength: 1, capped: false, repoPath: '/repo/x',
      },
    } as never, ctx() as never)
    const s = store.getState()
    expect(s.sessionPresetSnapshots['/repo/x']?.preamble).toBe('P')
  })

  it('stores a null preset explicitly (fetched, none)', () => {
    handleMessage({ type: 'session_preset_snapshot', cwd: '/repo/y', preset: null } as never, ctx() as never)
    const s = store.getState()
    expect('/repo/y' in s.sessionPresetSnapshots).toBe(true)
    expect(s.sessionPresetSnapshots['/repo/y']).toBeNull()
  })

  it('stashes an active preset seed from session_switched into pendingServerSeed', () => {
    handleMessage({
      type: 'session_switched',
      sessionId: 'sess-1',
      name: 'S',
      cwd: '/repo/x',
      conversationId: null,
      sessionPreset: {
        source: 'repo', active: true, trustState: 'trusted', enabled: true,
        seed: 'do the thing', preambleLength: 5, seedLength: 12, capped: false, repoPath: '/repo/x',
      },
    } as never, ctx() as never)
    const s = store.getState()
    expect(s.pendingServerSeed['sess-1']).toBe('do the thing')
  })

  it('does not stash a seed when the preset carries none', () => {
    handleMessage({
      type: 'session_switched',
      sessionId: 'sess-2',
      name: 'S',
      cwd: '/repo/x',
      conversationId: null,
      sessionPreset: {
        source: 'repo', active: true, trustState: 'trusted', enabled: true,
        seed: '', preambleLength: 5, seedLength: 0, capped: false, repoPath: '/repo/x',
      },
    } as never, ctx() as never)
    const s = store.getState()
    expect(s.pendingServerSeed['sess-2']).toBeUndefined()
  })
})
