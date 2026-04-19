/**
 * Smoke tests for the dashboard WebSocket message handler.
 *
 * Covers basic dispatch for a handful of key message types, malformed input,
 * and unknown-type handling. The handler is ~2300 lines — this file exercises
 * the dispatch entry points, not every branch.
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
  stopHeartbeat,
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

function baseState(overrides: Partial<ConnectionState> = {}): Partial<ConnectionState> {
  const serverErrors: unknown[] = []
  const terminalWrites: string[] = []
  return {
    connectionPhase: 'connected',
    socket: null,
    sessions: [],
    activeSessionId: null,
    sessionStates: {},
    messages: [],
    terminalBuffer: '',
    terminalRawBuffer: '',
    customAgents: [],
    slashCommands: [],
    connectedClients: [],
    serverErrors,
    addServerError: (e: unknown) => { serverErrors.push(e) },
    appendTerminalData: (d: string) => { terminalWrites.push(d) },
    _terminalWrites: terminalWrites,
    serverProtocolVersion: null,
    ...overrides,
  } as unknown as Partial<ConnectionState>
}

describe('dashboard message-handler dispatch', () => {
  let store: ReturnType<typeof createMockStore>
  let mockSocket: WebSocket
  const ctx = () => ({
    url: 'wss://t',
    token: 'tok',
    socket: mockSocket,
    isReconnect: false,
    silent: false,
  })

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    clearDeltaBuffers()
    mockSocket = createMockSocket()
    store = createMockStore(baseState())
    setStore(store)
  })

  afterEach(() => {
    stopHeartbeat()
    clearDeltaBuffers()
  })

  describe('auth_ok dispatch', () => {
    it('transitions connectionPhase to connected', () => {
      handleMessage(
        {
          type: 'auth_ok',
          serverMode: 'cli',
          cwd: '/tmp',
          serverVersion: '0.6.0',
          protocolVersion: 3,
          clientId: 'c1',
          connectedClients: [],
        },
        ctx() as any,
      )
      expect(store.getState().connectionPhase).toBe('connected')
      expect(store.getState().serverVersion).toBe('0.6.0')
    })
  })

  describe('error dispatch', () => {
    it('routes structured error messages to addServerError', () => {
      handleMessage(
        { type: 'error', code: 'BOOM', message: 'something broke' },
        ctx() as any,
      )
      const state = store.getState() as any
      expect(state.serverErrors).toEqual(['something broke'])
    })

    it('falls back to generic text when message is missing', () => {
      handleMessage({ type: 'error', code: 'X' }, ctx() as any)
      const state = store.getState() as any
      expect(state.serverErrors).toHaveLength(1)
      expect(typeof state.serverErrors[0]).toBe('string')
    })
  })

  describe('session_error dispatch', () => {
    it('pushes non-crash session errors into addServerError', () => {
      handleMessage(
        {
          type: 'session_error',
          category: 'runtime',
          message: 'session failed',
          sessionId: 'sess-1',
        },
        ctx() as any,
      )
      const state = store.getState() as any
      expect(state.serverErrors).toEqual(['session failed'])
    })
  })

  describe('stream_delta dispatch', () => {
    it('forwards delta text to appendTerminalData', () => {
      handleMessage(
        {
          type: 'stream_delta',
          messageId: 'm1',
          sessionId: 'sess-1',
          delta: 'hello ',
        },
        ctx() as any,
      )
      const state = store.getState() as any
      expect(state._terminalWrites).toContain('hello ')
    })
  })

  describe('malformed input', () => {
    it('ignores non-object messages', () => {
      expect(() => handleMessage('not an object', ctx() as any)).not.toThrow()
      expect(() => handleMessage(null, ctx() as any)).not.toThrow()
      expect(() => handleMessage(42, ctx() as any)).not.toThrow()
      expect(() => handleMessage([], ctx() as any)).not.toThrow()
    })

    it('ignores messages with missing or non-string type', () => {
      expect(() => handleMessage({}, ctx() as any)).not.toThrow()
      expect(() => handleMessage({ type: 123 }, ctx() as any)).not.toThrow()
    })
  })

  describe('server_status dispatch (#2836)', () => {
    it('sets serverPhase to tunnel_warming with attempt count for phase=tunnel_warming', () => {
      handleMessage(
        {
          type: 'server_status',
          phase: 'tunnel_warming',
          attempt: 3,
          maxAttempts: 20,
          tunnelMode: 'quick',
          tunnelUrl: 'https://abc.trycloudflare.com',
          message: 'Tunnel warming up… (3/20)',
        },
        ctx() as any,
      )
      const state = store.getState()
      expect(state.serverPhase).toBe('tunnel_warming')
      expect(state.tunnelProgress).toEqual({ attempt: 3, maxAttempts: 20 })
    })

    it('still recognizes legacy phase=tunnel_verifying', () => {
      handleMessage(
        {
          type: 'server_status',
          phase: 'tunnel_verifying',
          attempt: 1,
          maxAttempts: 20,
        },
        ctx() as any,
      )
      const state = store.getState()
      expect(state.serverPhase).toBe('tunnel_warming')
      expect(state.tunnelProgress).toEqual({ attempt: 1, maxAttempts: 20 })
    })

    it('transitions to ready on phase=ready and clears tunnelProgress', () => {
      // First warm up
      handleMessage(
        {
          type: 'server_status',
          phase: 'tunnel_warming',
          attempt: 5,
          maxAttempts: 20,
        },
        ctx() as any,
      )
      expect(store.getState().serverPhase).toBe('tunnel_warming')
      // Then transition to ready
      handleMessage(
        { type: 'server_status', phase: 'ready', tunnelUrl: 'https://abc.trycloudflare.com' },
        ctx() as any,
      )
      expect(store.getState().serverPhase).toBe('ready')
      expect(store.getState().tunnelProgress).toBeNull()
    })

    it('handles tunnel_warming without attempt count (initial broadcast)', () => {
      handleMessage(
        {
          type: 'server_status',
          phase: 'tunnel_warming',
          tunnelMode: 'quick',
          tunnelUrl: 'https://abc.trycloudflare.com',
          message: 'Tunnel warming up…',
        },
        ctx() as any,
      )
      const state = store.getState()
      expect(state.serverPhase).toBe('tunnel_warming')
      expect(state.tunnelProgress).toBeNull()
    })
  })

  describe('unknown message types', () => {
    it('does not throw on unknown types', () => {
      expect(() =>
        handleMessage({ type: 'some_future_type', payload: 'x' }, ctx() as any),
      ).not.toThrow()
    })

    it('warns when server protocol version exceeds client', () => {
      store = createMockStore(baseState({ serverProtocolVersion: 9999 }))
      setStore(store)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      handleMessage({ type: 'brand_new_message' }, ctx() as any)
      expect(warn).toHaveBeenCalled()
      warn.mockRestore()
    })
  })
})
