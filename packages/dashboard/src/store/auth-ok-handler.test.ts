/**
 * Tests for the auth_ok message handler in the dashboard.
 *
 * auth_ok is the most complex single handler (~100 lines): it sets connection
 * phase, stores server context, parses the client list, initiates encryption
 * key exchange, and saves the connection to localStorage.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock the crypto module before importing the handler
vi.mock('./crypto', () => ({
  createKeyPair: vi.fn(() => ({ publicKey: 'mock-pub', secretKey: 'mock-sec' })),
  deriveSharedKey: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  DIRECTION_CLIENT: 0,
  DIRECTION_SERVER: 1,
}))

vi.mock('./persistence', () => ({
  clearPersistedSession: vi.fn(),
}))

import {
  handleMessage,
  setStore,
  setConnectionContext,
  clearDeltaBuffers,
  stopHeartbeat,
} from './message-handler'
import { createKeyPair } from './crypto'
import type { ConnectionState } from './types'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a mock store compatible with setStore(). */
function createMockStore(initial: Partial<ConnectionState>) {
  let state = initial as ConnectionState
  const store = {
    getState: () => state,
    setState: (s: Partial<ConnectionState> | ((prev: ConnectionState) => Partial<ConnectionState>)) => {
      const patch = typeof s === 'function' ? s(state) : s
      state = { ...state, ...patch }
    },
  }
  return store
}

/** Create a mock WebSocket with a send spy. */
function createMockSocket(): WebSocket {
  return {
    send: vi.fn(),
    close: vi.fn(),
    readyState: WebSocket.OPEN,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as WebSocket
}

/** Build a minimal auth_ok message. */
function createAuthOkMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: 'auth_ok',
    serverMode: 'cli',
    cwd: '/home/user/project',
    defaultCwd: '/home/user',
    serverVersion: '0.6.0',
    latestVersion: '0.6.1',
    serverCommit: 'abc1234',
    protocolVersion: 3,
    clientId: 'client-1',
    connectedClients: [
      { clientId: 'client-1', deviceName: 'Dashboard', deviceType: 'desktop', platform: 'macos' },
      { clientId: 'client-2', deviceName: 'Phone', deviceType: 'phone', platform: 'ios' },
    ],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('auth_ok handler', () => {
  let store: ReturnType<typeof createMockStore>
  let mockSocket: WebSocket

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    clearDeltaBuffers()

    mockSocket = createMockSocket()
    store = createMockStore({
      connectionPhase: 'connecting',
      socket: null,
      sessions: [],
      activeSessionId: null,
      sessionStates: {},
      messages: [],
      terminalBuffer: 'old terminal',
      terminalRawBuffer: 'old raw',
      customAgents: [],
      slashCommands: [],
      connectionError: 'previous error',
      connectionRetryCount: 3,
    } as unknown as ConnectionState)
    setStore(store)
  })

  afterEach(() => {
    stopHeartbeat()
    clearDeltaBuffers()
    setConnectionContext(null)
  })

  describe('fresh connection', () => {
    it('sets connectionPhase to connected', () => {
      const ctx = { url: 'wss://test.example.com', token: 'tok', socket: mockSocket, isReconnect: false, silent: false }
      handleMessage(createAuthOkMessage(), ctx as any)

      expect(store.getState().connectionPhase).toBe('connected')
    })

    it('stores server version, commit, and mode', () => {
      const ctx = { url: 'wss://test.example.com', token: 'tok', socket: mockSocket, isReconnect: false, silent: false }
      handleMessage(createAuthOkMessage(), ctx as any)

      const state = store.getState()
      expect(state.serverVersion).toBe('0.6.0')
      expect(state.latestVersion).toBe('0.6.1')
      expect(state.serverCommit).toBe('abc1234')
      expect(state.serverMode).toBe('cli')
    })

    it('stores session cwd and default cwd', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false }
      handleMessage(createAuthOkMessage(), ctx as any)

      const state = store.getState()
      expect(state.sessionCwd).toBe('/home/user/project')
      expect(state.defaultCwd).toBe('/home/user')
    })

    it('stores protocol version', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false }
      handleMessage(createAuthOkMessage({ protocolVersion: 5 }), ctx as any)

      expect(store.getState().serverProtocolVersion).toBe(5)
    })

    it('clears connection error and retry count', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false }
      handleMessage(createAuthOkMessage(), ctx as any)

      const state = store.getState()
      expect(state.connectionError).toBeNull()
      expect(state.connectionRetryCount).toBe(0)
    })

    it('resets messages, terminal, and session state on fresh connect', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false }
      handleMessage(createAuthOkMessage(), ctx as any)

      const state = store.getState()
      expect(state.messages).toEqual([])
      expect(state.terminalBuffer).toBe('')
      expect(state.terminalRawBuffer).toBe('')
      expect(state.sessions).toEqual([])
      expect(state.activeSessionId).toBeNull()
      expect(state.sessionStates).toEqual({})
      expect(state.customAgents).toEqual([])
    })

    it('stores the socket reference', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false }
      handleMessage(createAuthOkMessage(), ctx as any)

      expect(store.getState().socket).toBe(mockSocket)
    })
  })

  describe('post-auth messages', () => {
    it('sends list_providers, list_slash_commands, and list_agents when no encryption', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false }
      handleMessage(createAuthOkMessage(), ctx as any)

      const sends = (mockSocket.send as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[]) => JSON.parse(c[0] as string)
      )
      const types = sends.map((s: Record<string, unknown>) => s.type)
      expect(types).toContain('list_providers')
      expect(types).toContain('list_slash_commands')
      expect(types).toContain('list_agents')
    })

    it('defers post-auth messages when encryption is required', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false }
      handleMessage(createAuthOkMessage({ encryption: 'required' }), ctx as any)

      const sends = (mockSocket.send as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[]) => JSON.parse(c[0] as string)
      )
      const types = sends.map((s: Record<string, unknown>) => s.type)
      // Should send key_exchange but NOT list_providers/list_slash_commands/list_agents yet
      expect(types).toContain('key_exchange')
      expect(types).not.toContain('list_providers')
      expect(types).not.toContain('list_slash_commands')
      expect(types).not.toContain('list_agents')
    })

    it('initiates key exchange with createKeyPair when encryption required', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false }
      handleMessage(createAuthOkMessage({ encryption: 'required' }), ctx as any)

      expect(createKeyPair).toHaveBeenCalled()
      const sends = (mockSocket.send as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[]) => JSON.parse(c[0] as string)
      )
      const keyExchange = sends.find((s: Record<string, unknown>) => s.type === 'key_exchange')
      expect(keyExchange).toEqual({ type: 'key_exchange', publicKey: 'mock-pub' })
    })
  })

  describe('client list parsing', () => {
    it('parses clients array and detects self by clientId', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false }
      handleMessage(createAuthOkMessage({
        clientId: 'client-1',
        connectedClients: [
          { clientId: 'client-1', deviceName: 'Dashboard', deviceType: 'desktop', platform: 'macos' },
          { clientId: 'client-2', deviceName: 'Phone', deviceType: 'phone', platform: 'ios' },
        ],
      }), ctx as any)

      const state = store.getState()
      expect(state.myClientId).toBe('client-1')
      expect(state.connectedClients).toEqual([
        { clientId: 'client-1', deviceName: 'Dashboard', deviceType: 'desktop', platform: 'macos', isSelf: true },
        { clientId: 'client-2', deviceName: 'Phone', deviceType: 'phone', platform: 'ios', isSelf: false },
      ])
    })

    it('filters out invalid clients (missing clientId)', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false }
      handleMessage(createAuthOkMessage({
        clientId: 'c1',
        connectedClients: [
          { clientId: 'c1', deviceName: 'Dashboard', deviceType: 'desktop', platform: 'macos' },
          { deviceName: 'No ID' },
          null,
          42,
        ],
      }), ctx as any)

      expect(store.getState().connectedClients).toEqual([
        { clientId: 'c1', deviceName: 'Dashboard', deviceType: 'desktop', platform: 'macos', isSelf: true },
      ])
    })

    it('defaults deviceType to unknown for invalid values', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false }
      handleMessage(createAuthOkMessage({
        clientId: 'c1',
        connectedClients: [
          { clientId: 'c1', deviceName: 'X', deviceType: 'spaceship', platform: 'mars' },
        ],
      }), ctx as any)

      expect(store.getState().connectedClients).toEqual([
        expect.objectContaining({ deviceType: 'unknown' }),
      ])
    })

    it('handles empty connectedClients array', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false }
      handleMessage(createAuthOkMessage({ connectedClients: [] }), ctx as any)

      expect(store.getState().connectedClients).toEqual([])
    })

    it('handles missing connectedClients', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false }
      handleMessage(createAuthOkMessage({ connectedClients: undefined }), ctx as any)

      expect(store.getState().connectedClients).toEqual([])
    })
  })

  describe('server mode', () => {
    it('sets serverMode to cli when serverMode is cli', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false }
      handleMessage(createAuthOkMessage({ serverMode: 'cli' }), ctx as any)

      expect(store.getState().serverMode).toBe('cli')
    })

    it('sets serverMode to terminal when serverMode is terminal', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false }
      handleMessage(createAuthOkMessage({ serverMode: 'terminal' }), ctx as any)

      expect(store.getState().serverMode).toBe('terminal')
    })

    it('sets serverMode to null for unknown mode', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false }
      handleMessage(createAuthOkMessage({ serverMode: 'unknown_mode' }), ctx as any)

      expect(store.getState().serverMode).toBeNull()
    })
  })

  describe('protocol version validation', () => {
    it('rejects non-integer protocolVersion', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false }
      handleMessage(createAuthOkMessage({ protocolVersion: 2.5 }), ctx as any)

      expect(store.getState().serverProtocolVersion).toBeNull()
    })

    it('rejects zero protocolVersion', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false }
      handleMessage(createAuthOkMessage({ protocolVersion: 0 }), ctx as any)

      expect(store.getState().serverProtocolVersion).toBeNull()
    })

    it('rejects negative protocolVersion', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false }
      handleMessage(createAuthOkMessage({ protocolVersion: -1 }), ctx as any)

      expect(store.getState().serverProtocolVersion).toBeNull()
    })

    it('rejects string protocolVersion', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false }
      handleMessage(createAuthOkMessage({ protocolVersion: '3' }), ctx as any)

      expect(store.getState().serverProtocolVersion).toBeNull()
    })
  })

  describe('webFeatures parsing', () => {
    it('parses webFeatures when provided', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false }
      handleMessage(createAuthOkMessage({
        webFeatures: { available: true, remote: false, teleport: true },
      }), ctx as any)

      expect(store.getState().webFeatures).toEqual({ available: true, remote: false, teleport: true })
    })

    it('defaults webFeatures to all false when not provided', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false }
      handleMessage(createAuthOkMessage(), ctx as any)

      expect(store.getState().webFeatures).toEqual({ available: false, remote: false, teleport: false })
    })
  })

  describe('reconnection', () => {
    it('preserves messages, terminal, and session state on reconnect', () => {
      store = createMockStore({
        connectionPhase: 'reconnecting',
        socket: null,
        sessions: [{ id: 'sess-1', name: 'Test' }],
        activeSessionId: 'sess-1',
        sessionStates: { 'sess-1': { messages: [{ id: 'm1', type: 'response', content: 'hello' }] } },
        messages: [{ id: 'legacy-1', type: 'response', content: 'old' }],
        terminalBuffer: 'existing terminal',
        terminalRawBuffer: 'existing raw',
        customAgents: [{ name: 'agent1' }],
      } as unknown as ConnectionState)
      setStore(store)

      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: true, silent: false }
      handleMessage(createAuthOkMessage(), ctx as any)

      const state = store.getState()
      // On reconnect, these should NOT be reset
      expect(state.terminalBuffer).toBe('existing terminal')
      expect(state.terminalRawBuffer).toBe('existing raw')
      expect(state.sessions).toEqual([{ id: 'sess-1', name: 'Test' }])
      expect(state.activeSessionId).toBe('sess-1')
      expect(state.messages).toEqual([{ id: 'legacy-1', type: 'response', content: 'old' }])
      expect(state.customAgents).toEqual([{ name: 'agent1' }])
    })

    it('still updates connectionPhase and socket on reconnect', () => {
      store = createMockStore({
        connectionPhase: 'reconnecting',
        socket: null,
      } as unknown as ConnectionState)
      setStore(store)

      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: true, silent: false }
      handleMessage(createAuthOkMessage(), ctx as any)

      const state = store.getState()
      expect(state.connectionPhase).toBe('connected')
      expect(state.socket).toBe(mockSocket)
    })
  })

  describe('saved connection', () => {
    it('saves connection to localStorage for quick reconnect', () => {
      const ctx = { url: 'wss://my.server.com', token: 'my-tok', socket: mockSocket, isReconnect: false, silent: false }
      handleMessage(createAuthOkMessage(), ctx as any)

      const state = store.getState()
      expect(state.savedConnection).toEqual({ url: 'wss://my.server.com', token: 'my-tok' })
    })

    it('stores wsUrl and apiToken in state', () => {
      const ctx = { url: 'wss://my.server.com', token: 'my-tok', socket: mockSocket, isReconnect: false, silent: false }
      handleMessage(createAuthOkMessage(), ctx as any)

      const state = store.getState()
      expect(state.wsUrl).toBe('wss://my.server.com')
      expect(state.apiToken).toBe('my-tok')
    })
  })
})
