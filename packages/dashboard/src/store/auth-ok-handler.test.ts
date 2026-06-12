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
  // #5555 — return a parseable envelope so the eager-path burst (which is
  // encrypted once encryptionState is active) serialises to valid JSON.
  encrypt: vi.fn((_json: string, _key: unknown, n: number) => ({ type: 'encrypted', d: 'cipher', n })),
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
  setConnectionContext,
  clearDeltaBuffers,
  stopHeartbeat,
  prepareEagerKeyExchange,
  setPendingKeyPair,
} from './message-handler'
import { createKeyPair, deriveSharedKey, deriveConnectionKey } from './crypto'
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
    // #5555 — reset the module-level eager keypair so a prior test's
    // prepareEagerKeyExchange() doesn't bleed into the discrete-fallback cases.
    setPendingKeyPair(null)

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

    // #3760: server now broadcasts its effective inactivity timeout so the
    // ActivityIndicator can render its "approaching timeout" warning against
    // the real configured value instead of a hardcoded 20-min reference.
    it('stores server resultTimeoutMs when present', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false }
      handleMessage(createAuthOkMessage({ resultTimeoutMs: 45 * 60 * 1000 }), ctx as any)

      expect(store.getState().serverResultTimeoutMs).toBe(45 * 60 * 1000)
    })

    it('leaves serverResultTimeoutMs null when older server omits the field', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false }
      handleMessage(createAuthOkMessage(), ctx as any)

      expect(store.getState().serverResultTimeoutMs).toBeNull()
    })

    it('ignores malformed resultTimeoutMs values (non-positive, non-finite, or non-number)', () => {
      // NaN/Infinity are explicitly rejected to mirror the server's
      // Number.isFinite guard so the client never stores an unusable timeout.
      for (const bad of [0, -1, NaN, Infinity, -Infinity, 'twenty minutes', null]) {
        const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false }
        handleMessage(createAuthOkMessage({ resultTimeoutMs: bad }), ctx as any)
        expect(store.getState().serverResultTimeoutMs).toBeNull()
      }
    })

    // #4497 / #4477 — server advertises its configured stream-stall
    // inactivity window so the chip can humanise the headline copy
    // ("No response for 5 minutes — retry?") instead of a generic phrase.
    it('stores streamStallTimeoutMs when present', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false }
      handleMessage(createAuthOkMessage({ streamStallTimeoutMs: 5 * 60 * 1000 }), ctx as any)

      expect(store.getState().streamStallTimeoutMs).toBe(5 * 60 * 1000)
    })

    it('leaves streamStallTimeoutMs null when older server omits the field', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false }
      handleMessage(createAuthOkMessage(), ctx as any)

      expect(store.getState().streamStallTimeoutMs).toBeNull()
    })

    it('ignores malformed streamStallTimeoutMs values (incl. 0 "disabled" sentinel)', () => {
      // 0 is the protocol's explicit "stall timer disabled" sentinel —
      // treat it the same as absent so the chip falls back to the static
      // phrase rather than rendering "No response for 0 seconds".
      for (const bad of [0, -1, NaN, Infinity, -Infinity, '5m', null]) {
        const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false }
        handleMessage(createAuthOkMessage({ streamStallTimeoutMs: bad }), ctx as any)
        expect(store.getState().streamStallTimeoutMs).toBeNull()
      }
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
      expect(keyExchange).toEqual({ type: 'key_exchange', publicKey: 'mock-pub', salt: 'mock-salt' })
    })
  })

  // #5555 (auth_bootstrap) — when the server advertises capabilities.authBootstrap
  // it pushes the provider/slash/agent lists in an auth_bootstrap burst, so the
  // client skips the 3 connect-time list requests. Without the flag (old server)
  // it requests them as before. Both folded permission modes and the skip apply.
  describe('auth_bootstrap (#5555)', () => {
    function typesFrom(socket: WebSocket) {
      return (socket.send as ReturnType<typeof vi.fn>).mock.calls
        .map((c: unknown[]) => JSON.parse(c[0] as string).type)
    }

    it('skips the 3 list requests when capabilities.authBootstrap is set (unencrypted)', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false }
      handleMessage(createAuthOkMessage({ capabilities: { authBootstrap: true } }), ctx as any)

      const types = typesFrom(mockSocket)
      expect(types).not.toContain('list_providers')
      expect(types).not.toContain('list_slash_commands')
      expect(types).not.toContain('list_agents')
    })

    it('still requests the 3 lists when authBootstrap is absent (old server)', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false }
      handleMessage(createAuthOkMessage(), ctx as any)

      const types = typesFrom(mockSocket)
      expect(types).toContain('list_providers')
      expect(types).toContain('list_slash_commands')
      expect(types).toContain('list_agents')
    })

    it('folds availablePermissionModes from auth_ok into the store', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false }
      handleMessage(
        createAuthOkMessage({ availablePermissionModes: [{ id: 'approve', label: 'Approve' }] }),
        ctx as any,
      )
      expect(store.getState().availablePermissionModes).toEqual([{ id: 'approve', label: 'Approve' }])
    })

    it('applies a subsequent auth_bootstrap burst to the provider/slash/agent stores', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false }
      handleMessage(createAuthOkMessage({ capabilities: { authBootstrap: true } }), ctx as any)
      handleMessage(
        {
          type: 'auth_bootstrap',
          providers: [{ name: 'anthropic' }],
          slashCommands: [{ name: 'clear', source: 'builtin' }],
          agents: [{ name: 'reviewer', source: 'project' }],
        },
        ctx as any,
      )
      expect(store.getState().availableProviders).toEqual([{ name: 'anthropic' }])
      expect(store.getState().slashCommands).toEqual([{ name: 'clear', source: 'builtin' }])
      expect(store.getState().customAgents).toEqual([{ name: 'reviewer', source: 'project' }])
    })
  })

  // #5555 (eager key exchange) — when onopen prepared the keypair eagerly and
  // the server returns serverPublicKey in auth_ok, the client derives the
  // shared key inline and sends the post-auth burst immediately (no discrete
  // key_exchange RTT). When the server omits serverPublicKey (old server), the
  // client falls back to the discrete handshake.
  describe('eager key exchange (#5555)', () => {
    function sendsFrom(socket: WebSocket) {
      return (socket.send as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: unknown[]) => JSON.parse(c[0] as string),
      )
    }

    it('derives the shared key inline and sends the burst when serverPublicKey is present', () => {
      // Simulate onopen having prepared the eager keypair.
      prepareEagerKeyExchange()
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false }
      handleMessage(
        createAuthOkMessage({ encryption: 'required', serverPublicKey: 'server-pub-key' }),
        ctx as any,
      )

      // Eager path derives from the server's public key + our stashed secret.
      expect(deriveSharedKey).toHaveBeenCalledWith('server-pub-key', 'mock-sec')
      expect(deriveConnectionKey).toHaveBeenCalled()

      const types = sendsFrom(mockSocket).map((s) => s.type)
      // No discrete key_exchange frame — the burst flows immediately. The
      // post-auth burst (list_providers/list_slash_commands/list_agents) goes
      // out as encrypted envelopes because encryptionState is now active, so
      // we see 'encrypted' frames, not plaintext list_* types.
      expect(types).not.toContain('key_exchange')
      expect(types).not.toContain('list_providers') // encrypted now
      expect(types.filter((t) => t === 'encrypted').length).toBeGreaterThanOrEqual(3)
    })

    it('falls back to the discrete key_exchange when serverPublicKey is absent (old server)', () => {
      prepareEagerKeyExchange()
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false }
      // encryption required but NO serverPublicKey → old server.
      handleMessage(createAuthOkMessage({ encryption: 'required' }), ctx as any)

      const types = sendsFrom(mockSocket).map((s) => s.type)
      expect(types).toContain('key_exchange')
      expect(types).not.toContain('list_providers')
      // Did not derive eagerly.
      expect(deriveSharedKey).not.toHaveBeenCalled()
    })

    // #5555 follow-up (hardening) — a non-empty MALFORMED serverPublicKey passes
    // the shared-parser's empty/non-string filter but makes deriveSharedKey
    // throw. The eager derivation must be wrapped so the throw degrades to the
    // discrete handshake instead of tearing the connection down.
    it('falls back to the discrete key_exchange when eager deriveSharedKey throws (malformed key)', () => {
      ;(deriveSharedKey as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
        throw new Error('Invalid peer public key: expected length 32, got 5')
      })
      prepareEagerKeyExchange()
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false }
      handleMessage(
        createAuthOkMessage({ encryption: 'required', serverPublicKey: 'bogus' }),
        ctx as any,
      )

      const types = sendsFrom(mockSocket).map((s) => s.type)
      // Degraded to the discrete handshake — connection NOT torn down.
      expect(types).toContain('key_exchange')
      // Burst not sent in plaintext (still gated behind the discrete exchange).
      expect(types).not.toContain('list_providers')
      // Socket stays open (no close on a recoverable eager failure).
      expect(mockSocket.close).not.toHaveBeenCalled()
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

    it('sets serverMode to null for unknown mode', () => {
      // #4810: the wire protocol only emits 'cli'; 'terminal' and other
      // values are treated as unknown (previously 'terminal' was accepted).
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false }
      handleMessage(createAuthOkMessage({ serverMode: 'unknown_mode' }), ctx as any)

      expect(store.getState().serverMode).toBeNull()
    })

    it('sets serverMode to null when serverMode is terminal (dead branch, #4810)', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false }
      handleMessage(createAuthOkMessage({ serverMode: 'terminal' }), ctx as any)

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

  // #3272: server-advertised capability map. Dashboard gates UI
  // affordances on these flags so older servers don't render dead
  // buttons against unimplemented WS handlers. Missing flag = false
  // (fail-closed) so unmapped capabilities never accidentally enable.
  describe('serverCapabilities parsing (#3272)', () => {
    it('parses capabilities when provided', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false }
      handleMessage(createAuthOkMessage({
        capabilities: { skillTrustAccept: true, futureFeature: false },
      }), ctx as any)

      expect(store.getState().serverCapabilities).toEqual({
        skillTrustAccept: true,
        futureFeature: false,
      })
    })

    it('defaults serverCapabilities to {} when omitted (older server)', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false }
      handleMessage(createAuthOkMessage(), ctx as any)

      expect(store.getState().serverCapabilities).toEqual({})
    })

    it('coerces non-true values to false (malformed entries cannot enable a gate)', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false }
      handleMessage(createAuthOkMessage({
        capabilities: {
          legitFlag: true,
          stringTrue: 'true',  // not a real boolean
          numberOne: 1,         // truthy but not boolean true
          nullVal: null,
        },
      }), ctx as any)

      const caps = store.getState().serverCapabilities
      expect(caps.legitFlag).toBe(true)
      expect(caps.stringTrue).toBe(false)
      expect(caps.numberOne).toBe(false)
      expect(caps.nullVal).toBe(false)
    })

    it('treats array `capabilities` as missing (not an object)', () => {
      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false }
      handleMessage(createAuthOkMessage({
        capabilities: ['not', 'an', 'object'] as unknown,
      }), ctx as any)

      expect(store.getState().serverCapabilities).toEqual({})
    })

    // #3272 review: stale capabilities from a previous connection must
    // be overwritten on fresh auth_ok. Otherwise UI gates from the old
    // server stay enabled against a new (older) server that doesn't
    // advertise the same flags.
    it('overwrites stale capabilities from a previous connection on fresh auth_ok', () => {
      store = createMockStore({
        connectionPhase: 'reconnecting',
        socket: null,
        serverCapabilities: { skillTrustAccept: true, otherFlag: true },
      } as unknown as ConnectionState)
      setStore(store)

      const ctx = { url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: true, silent: false }
      handleMessage(createAuthOkMessage(), ctx as any) // no capabilities in payload

      expect(store.getState().serverCapabilities).toEqual({})
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
