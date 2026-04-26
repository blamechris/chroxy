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
  resetReplayFlags,
} from './message-handler'
import { createEmptySessionState } from './utils'
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
    resetReplayFlags()
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

    // Issue #2904: bound-token error should be rewritten to something
    // actionable that names the session instead of the raw "Not authorized".
    it('rewrites SESSION_TOKEN_MISMATCH with bound session name into an actionable hint', () => {
      handleMessage(
        {
          type: 'session_error',
          code: 'SESSION_TOKEN_MISMATCH',
          message: 'Not authorized: client is bound to a specific session',
          boundSessionId: 'sess-xyz',
          boundSessionName: 'MarchBorne',
        },
        ctx() as any,
      )
      const state = store.getState() as any
      expect(state.serverErrors).toHaveLength(1)
      const err = state.serverErrors[0]
      expect(err).toContain('MarchBorne')
      expect(err).toMatch(/disconnect/i)
    })

    it('falls back to the raw message when boundSessionName is missing', () => {
      handleMessage(
        {
          type: 'session_error',
          code: 'SESSION_TOKEN_MISMATCH',
          message: 'Not authorized: client is bound to a specific session',
          // no boundSessionName — old server OR name lookup failed
        },
        ctx() as any,
      )
      const state = store.getState() as any
      expect(state.serverErrors).toEqual([
        'Not authorized: client is bound to a specific session',
      ])
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

  describe('history replay: user_input rehydration', () => {
    function seed() {
      store = createMockStore(
        baseState({
          activeSessionId: 's1',
          sessions: [{ sessionId: 's1', name: 'S1' } as any],
          sessionStates: { s1: createEmptySessionState() },
        }),
      )
      setStore(store)
    }

    // Regression: server replays historical user prompts as
    // { type: 'message', messageType: 'user_input' }. On plain reconnect replay
    // (no session switch) the dashboard dropped them, leaving the chat empty
    // or showing orphaned assistant responses.
    it('rehydrates user_input entries during reconnect replay', () => {
      seed()
      handleMessage({ type: 'history_replay_start', sessionId: 's1' }, ctx() as any)
      handleMessage(
        {
          type: 'message',
          messageType: 'user_input',
          content: 'scan the repo',
          sessionId: 's1',
          timestamp: 100,
        },
        ctx() as any,
      )
      const msgs = (store.getState() as any).sessionStates.s1.messages
      expect(msgs).toHaveLength(1)
      expect(msgs[0].type).toBe('user_input')
      expect(msgs[0].content).toBe('scan the repo')
    })

    // Previously a "cache is fresh" guard skipped ALL replay entries once the
    // legacy flat messages array had anything. Per-entry dedup at the same
    // handler already prevents duplicates, so the blanket guard was removed.
    it('does not blanket-skip replay when legacy messages list is non-empty', () => {
      seed()
      ;(store.getState() as any).messages = [{ id: 'legacy', type: 'system', content: 'x', timestamp: 1 }]
      handleMessage({ type: 'history_replay_start', sessionId: 's1' }, ctx() as any)
      handleMessage(
        {
          type: 'message',
          messageType: 'response',
          content: 'new response',
          messageId: 'resp-1',
          sessionId: 's1',
          timestamp: 500,
        },
        ctx() as any,
      )
      const msgs = (store.getState() as any).sessionStates.s1.messages
      expect(msgs).toHaveLength(1)
      expect(msgs[0].type).toBe('response')
      expect(msgs[0].content).toBe('new response')
    })

    // Issue #2902: the sender's optimistic user_input carries the same id the
    // server stamped (via clientMessageId). On reconnect, replay must dedup by
    // that id — otherwise sender sees their own prompt twice.
    it('dedups replayed user_input against optimistic entry sharing the same id', () => {
      seed()
      const sharedId = 'user-7-1700000000000'
      ;(store.getState() as any).sessionStates.s1.messages = [
        { id: sharedId, type: 'user_input', content: 'hi there', timestamp: 1 },
      ]
      handleMessage({ type: 'history_replay_start', sessionId: 's1' }, ctx() as any)
      handleMessage(
        {
          type: 'message',
          messageType: 'user_input',
          content: 'hi there [1 file(s) attached]', // server may suffix attachment marker
          messageId: sharedId,
          sessionId: 's1',
          timestamp: 2, // differs from optimistic timestamp
        },
        ctx() as any,
      )
      const msgs = (store.getState() as any).sessionStates.s1.messages
      expect(msgs).toHaveLength(1)
    })

    it('preserves server-assigned messageId on rehydrated user_input (for future dedup)', () => {
      seed()
      handleMessage({ type: 'history_replay_start', sessionId: 's1' }, ctx() as any)
      handleMessage(
        {
          type: 'message',
          messageType: 'user_input',
          content: 'replayed prompt',
          messageId: 'uin-123-9',
          sessionId: 's1',
          timestamp: 100,
        },
        ctx() as any,
      )
      const msgs = (store.getState() as any).sessionStates.s1.messages
      expect(msgs).toHaveLength(1)
      expect(msgs[0].id).toBe('uin-123-9')
    })

    it('skips messageType=user_input entries outside replay', () => {
      seed()
      handleMessage(
        {
          type: 'message',
          messageType: 'user_input',
          content: 'live echo',
          sessionId: 's1',
          timestamp: 200,
        },
        ctx() as any,
      )
      const msgs = (store.getState() as any).sessionStates.s1.messages
      expect(msgs).toHaveLength(0)
    })
  })

  describe('history replay: tool_start dedup (#2901)', () => {
    function seedWithTool(toolId: string) {
      store = createMockStore(
        baseState({
          activeSessionId: 's1',
          sessions: [{ sessionId: 's1', name: 'S1' } as any],
          sessionStates: {
            s1: {
              ...createEmptySessionState(),
              messages: [
                { id: toolId, type: 'tool_use', content: 'Bash: ls', tool: 'Bash', timestamp: 1 },
              ],
            },
          },
        }),
      )
      setStore(store)
    }

    // Regression: on plain reconnect replay (not a session switch), the
    // dashboard's `tool_start` handler had a blanket
    // `_receivingHistoryReplay && !_isSessionSwitchReplay && get().messages.length > 0`
    // early return that fired against the legacy flat `messages` array — but
    // multi-session state keeps that array empty, so the guard never tripped
    // and replayed tool_use entries appended on top of the live copies. The
    // per-id dedup at the same handler now runs on every replay path.
    it('deduplicates tool_use by stable messageId during plain reconnect replay', () => {
      seedWithTool('tool-1')
      handleMessage({ type: 'history_replay_start', sessionId: 's1' }, ctx() as any)
      handleMessage(
        {
          type: 'tool_start',
          messageId: 'tool-1',
          tool: 'Bash',
          input: 'ls',
          sessionId: 's1',
        },
        ctx() as any,
      )
      const msgs = (store.getState() as any).sessionStates.s1.messages
      expect(msgs).toHaveLength(1)
      expect(msgs[0].id).toBe('tool-1')
    })

    it('deduplicates tool_use by stable messageId during session-switch replay', () => {
      seedWithTool('tool-1')
      handleMessage(
        { type: 'history_replay_start', sessionId: 's1', fullHistory: true },
        ctx() as any,
      )
      // session-switch replay clears messages first, so re-seed a tool to
      // simulate the replay sending the same tool a client already cached
      // (e.g. from a previous fetch). We bypass the clear by re-injecting.
      ;(store.getState() as any).sessionStates.s1.messages = [
        { id: 'tool-1', type: 'tool_use', content: 'Bash: ls', tool: 'Bash', timestamp: 1 },
      ]
      handleMessage(
        {
          type: 'tool_start',
          messageId: 'tool-1',
          tool: 'Bash',
          input: 'ls',
          sessionId: 's1',
        },
        ctx() as any,
      )
      const msgs = (store.getState() as any).sessionStates.s1.messages
      expect(msgs).toHaveLength(1)
    })

    it('appends new tool_use whose id is not yet in cache (legitimate replay)', () => {
      seedWithTool('tool-1')
      handleMessage({ type: 'history_replay_start', sessionId: 's1' }, ctx() as any)
      handleMessage(
        {
          type: 'tool_start',
          messageId: 'tool-2',
          tool: 'Read',
          input: 'file.ts',
          sessionId: 's1',
        },
        ctx() as any,
      )
      const msgs = (store.getState() as any).sessionStates.s1.messages
      expect(msgs).toHaveLength(2)
      expect(msgs[1].id).toBe('tool-2')
      expect(msgs[1].tool).toBe('Read')
    })

    it('does not blanket-skip tool_start replay when legacy messages list is non-empty', () => {
      // Pre-fix: legacy `messages.length > 0` guard would drop this entire
      // tool_start because the flat array had something. Per-id dedup lets
      // genuinely new tools through.
      seedWithTool('tool-1')
      ;(store.getState() as any).messages = [
        { id: 'legacy', type: 'system', content: 'x', timestamp: 1 },
      ]
      handleMessage({ type: 'history_replay_start', sessionId: 's1' }, ctx() as any)
      handleMessage(
        {
          type: 'tool_start',
          messageId: 'tool-3',
          tool: 'Edit',
          input: 'patch',
          sessionId: 's1',
        },
        ctx() as any,
      )
      const msgs = (store.getState() as any).sessionStates.s1.messages
      expect(msgs).toHaveLength(2)
      expect(msgs[1].id).toBe('tool-3')
    })

    it('appends tool_use normally outside any history replay (live event)', () => {
      seedWithTool('tool-1')
      // No history_replay_start — this is a live tool_start
      handleMessage(
        {
          type: 'tool_start',
          messageId: 'tool-1', // same id, still appended because not in replay
          tool: 'Bash',
          input: 'ls',
          sessionId: 's1',
        },
        ctx() as any,
      )
      const msgs = (store.getState() as any).sessionStates.s1.messages
      // Live duplicates are unusual but not handled here — only replay dedups.
      expect(msgs).toHaveLength(2)
    })
  })

  describe('pairing_refreshed dispatch (#2916)', () => {
    it('increments pairingRefreshedCount when pairing_refreshed arrives', () => {
      store = createMockStore(baseState({ pairingRefreshedCount: 0 } as any))
      setStore(store)
      handleMessage({ type: 'pairing_refreshed' }, ctx() as any)
      expect((store.getState() as any).pairingRefreshedCount).toBe(1)
    })

    it('increments on each subsequent pairing_refreshed', () => {
      store = createMockStore(baseState({ pairingRefreshedCount: 3 } as any))
      setStore(store)
      handleMessage({ type: 'pairing_refreshed' }, ctx() as any)
      expect((store.getState() as any).pairingRefreshedCount).toBe(4)
    })
  })


  describe('result — cost calculation for Codex/Gemini (cost: null from server)', () => {
    function seedWithModel(sessionId: string, model: string) {
      store = createMockStore(
        baseState({
          sessions: [{ sessionId, name: 'S', model } as any],
          sessionStates: { [sessionId]: createEmptySessionState() },
        }),
      )
      setStore(store)
    }

    it('computes lastResultCost client-side for a known Codex model when server sends cost: null', () => {
      seedWithModel('s-codex', 'gpt-4o')
      handleMessage(
        {
          type: 'result',
          sessionId: 's-codex',
          cost: null,
          usage: { input_tokens: 1000, output_tokens: 500 },
        },
        ctx() as any,
      )
      // gpt-4o: (1000/1000)*0.0025 + (500/1000)*0.01 = 0.0075
      const cost = (store.getState() as any).sessionStates['s-codex'].lastResultCost
      expect(cost).not.toBeNull()
      expect(cost).toBeCloseTo(0.0075, 6)
    })

    it('computes lastResultCost client-side for a known Gemini model when server sends cost: null', () => {
      seedWithModel('s-gemini', 'gemini-2.5-pro')
      handleMessage(
        {
          type: 'result',
          sessionId: 's-gemini',
          cost: null,
          usage: { input_tokens: 10000, output_tokens: 2000 },
        },
        ctx() as any,
      )
      // gemini-2.5-pro: (10000/1000)*0.00125 + (2000/1000)*0.01 = 0.0125 + 0.02 = 0.0325
      const cost = (store.getState() as any).sessionStates['s-gemini'].lastResultCost
      expect(cost).not.toBeNull()
      expect(cost).toBeCloseTo(0.0325, 6)
    })

    it('leaves lastResultCost null when model is unknown and server sends cost: null', () => {
      seedWithModel('s-unknown', 'some-unknown-model')
      handleMessage(
        {
          type: 'result',
          sessionId: 's-unknown',
          cost: null,
          usage: { input_tokens: 1000, output_tokens: 500 },
        },
        ctx() as any,
      )
      const cost = (store.getState() as any).sessionStates['s-unknown'].lastResultCost
      expect(cost).toBeNull()
    })

    it('uses server-provided cost when it is a number (Claude passthrough)', () => {
      seedWithModel('s-claude', 'claude-3-5-sonnet-20241022')
      handleMessage(
        {
          type: 'result',
          sessionId: 's-claude',
          cost: 0.042,
          usage: { input_tokens: 5000, output_tokens: 1000 },
        },
        ctx() as any,
      )
      const cost = (store.getState() as any).sessionStates['s-claude'].lastResultCost
      expect(cost).toBe(0.042)
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
