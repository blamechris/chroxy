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
  clearPermissionSplits,
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
    // Fake timers for the 100ms delta batcher — runAllTimers() flushes
    // synchronously instead of waiting on real wall-clock setTimeout(150).
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

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

    // #3071 — when stream_start is dropped (e.g., session not yet in store at
    // the time it arrived), the next stream_delta with the same messageId must
    // NOT concatenate onto the existing tool_use bubble. The delta handler
    // defends by detecting the type collision and lazy-creating a suffixed
    // response. Mirrors the equivalent fix in the mobile app handler.
    it('lazy-creates response bubble when stream_delta lands on a tool_use id', () => {
      const toolMsg = { id: 'msg-1', type: 'tool_use' as const, content: 'ls', timestamp: 1 }
      store = createMockStore(baseState({
        activeSessionId: 's1',
        sessionStates: {
          s1: { ...createEmptySessionState(), messages: [toolMsg] },
        },
      }))
      setStore(store)

      // Skip stream_start — simulate the dropped/raced case
      handleMessage(
        { type: 'stream_delta', messageId: 'msg-1', sessionId: 's1', delta: 'After tool ' },
        ctx() as any,
      )
      handleMessage(
        { type: 'stream_delta', messageId: 'msg-1', sessionId: 's1', delta: 'response' },
        ctx() as any,
      )
      // Flush the 100ms delta batcher
      vi.runAllTimers()

      const ss = (store.getState() as any).sessionStates.s1
      const responseMsg = ss.messages.find((m: any) => m.id === 'msg-1-response')
      expect(responseMsg).toBeDefined()
      expect(responseMsg?.type).toBe('response')
      expect(responseMsg?.content).toBe('After tool response')
      // tool_use bubble must remain pristine — no concatenated assistant text
      const toolUseMsg = ss.messages.find((m: any) => m.id === 'msg-1')
      expect(toolUseMsg?.content).toBe('ls')
    })

    // Same defensive fallback in the flat-messages mode, exercised when the
    // session isn't registered in sessionStates yet (pre-session bootstrap or
    // server hasn't echoed session_switched). The collision must still route to
    // a suffixed response id without polluting the tool_use bubble.
    it('lazy-creates response bubble in flat-messages mode when collision hits a tool_use', () => {
      const toolMsg = { id: 'msg-flat', type: 'tool_use' as const, content: 'ls', timestamp: 1 }
      store = createMockStore(baseState({
        activeSessionId: null,
        sessionStates: {},
        messages: [toolMsg],
      }))
      setStore(store)

      handleMessage(
        { type: 'stream_delta', messageId: 'msg-flat', delta: 'flat ' },
        ctx() as any,
      )
      handleMessage(
        { type: 'stream_delta', messageId: 'msg-flat', delta: 'response' },
        ctx() as any,
      )
      vi.runAllTimers()

      const flat = (store.getState() as any).messages
      const responseMsg = flat.find((m: any) => m.id === 'msg-flat-response')
      expect(responseMsg).toBeDefined()
      expect(responseMsg?.type).toBe('response')
      expect(responseMsg?.content).toBe('flat response')
      const toolUseMsg = flat.find((m: any) => m.id === 'msg-flat')
      expect(toolUseMsg?.content).toBe('ls')
    })

    // Belt-and-suspenders: even if a stream_delta sneaks past the defensive
    // remap in handleStreamDelta (e.g. the colliding tool_use is added to
    // state AFTER the delta is queued), flushPendingDeltas itself must never
    // apply delta text onto a non-response message.
    it('flushPendingDeltas type-filter prevents tool_use corruption when collision slips past defensive remap', () => {
      store = createMockStore(baseState({
        activeSessionId: 's1',
        sessionStates: {
          s1: { ...createEmptySessionState(), messages: [] },
        },
      }))
      setStore(store)

      // Step 1: dispatch delta when no message exists at this id — defensive
      // remap can't catch the collision since the tool_use isn't there yet.
      handleMessage(
        { type: 'stream_delta', messageId: 'msg-race', sessionId: 's1', delta: 'must not leak' },
        ctx() as any,
      )

      // Step 2: race condition — tool_use is added AFTER the delta is queued
      // but BEFORE the 100ms batcher flushes.
      ;(store as any).setState((s: any) => ({
        sessionStates: {
          ...s.sessionStates,
          s1: {
            ...s.sessionStates.s1,
            messages: [{ id: 'msg-race', type: 'tool_use' as const, content: 'ls', timestamp: 1 }],
          },
        },
      }))

      // Step 3: flush
      vi.runAllTimers()

      const ss = (store.getState() as any).sessionStates.s1
      const toolUse = ss.messages.find((m: any) => m.id === 'msg-race' && m.type === 'tool_use')
      // tool_use bubble must remain pristine — no delta concatenation
      expect(toolUse?.content).toBe('ls')
      // Orphan-create suffixes the response id when there's a non-response
      // collision, so the messages array does not contain duplicate ids.
      const orphan = ss.messages.find((m: any) => m.id === 'msg-race-response')
      expect(orphan?.type).toBe('response')
      expect(orphan?.content).toBe('must not leak')
      // No two messages share an id.
      const ids = ss.messages.map((m: any) => m.id)
      expect(new Set(ids).size).toBe(ids.length)
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

  // Regression for #3163: when a turn opens with a tool (no preamble text →
  // no stream_start), streamingMessageId is still 'pending' from sendInput.
  // The 5-second safety timer in sendInput would otherwise clear it, hiding
  // the stop button for the rest of the tool execution. tool_start must bump
  // streamingMessageId out of 'pending' so the safety timer no-ops.
  describe('tool_start streamingMessageId bump (#3163)', () => {
    it('bumps streamingMessageId out of "pending" when the turn opens with a tool', () => {
      store = createMockStore(
        baseState({
          activeSessionId: 's1',
          sessions: [{ sessionId: 's1', name: 'S1' } as any],
          sessionStates: {
            s1: { ...createEmptySessionState(), messages: [], streamingMessageId: 'pending' },
          },
        }),
      )
      setStore(store)
      handleMessage(
        {
          type: 'tool_start',
          messageId: 'toolu_first',
          tool: 'Bash',
          toolUseId: 'toolu_first',
          input: { command: 'ls' },
          sessionId: 's1',
        },
        ctx() as any,
      )
      const ss = (store.getState() as any).sessionStates.s1
      // streamingMessageId is bumped to the tool bubble's id, which matches
      // the wire messageId when one is provided.
      expect(ss.streamingMessageId).toBe(ss.messages[0].id)
      expect(ss.streamingMessageId).toBe('toolu_first')
      expect(ss.streamingMessageId).not.toBe('pending')
    })

    it('does NOT overwrite streamingMessageId when stream_start has already fired', () => {
      store = createMockStore(
        baseState({
          activeSessionId: 's1',
          sessions: [{ sessionId: 's1', name: 'S1' } as any],
          sessionStates: {
            s1: { ...createEmptySessionState(), messages: [], streamingMessageId: 'msg-real' },
          },
        }),
      )
      setStore(store)
      handleMessage(
        {
          type: 'tool_start',
          messageId: 'toolu_after_text',
          tool: 'Bash',
          toolUseId: 'toolu_after_text',
          input: { command: 'ls' },
          sessionId: 's1',
        },
        ctx() as any,
      )
      const ss = (store.getState() as any).sessionStates.s1
      expect(ss.streamingMessageId).toBe('msg-real')
    })

    it('bumps off "pending" using the synthesized tool bubble id when tool_start has no messageId', () => {
      store = createMockStore(
        baseState({
          activeSessionId: 's1',
          sessions: [{ sessionId: 's1', name: 'S1' } as any],
          sessionStates: {
            s1: { ...createEmptySessionState(), messages: [], streamingMessageId: 'pending' },
          },
        }),
      )
      setStore(store)
      handleMessage(
        {
          type: 'tool_start',
          // messageId omitted — defensive against schema-violating input
          tool: 'Bash',
          toolUseId: 'toolu_no_msgid',
          input: { command: 'ls' },
          sessionId: 's1',
        },
        ctx() as any,
      )
      const ss = (store.getState() as any).sessionStates.s1
      // sharedToolStart synthesizes a 'tool-N-<ts>' id when msg.messageId is
      // missing, and we bump streamingMessageId to that exact id so it always
      // matches a real message in state. No separate sentinel needed.
      expect(ss.messages).toHaveLength(1)
      expect(ss.streamingMessageId).toBe(ss.messages[0].id)
      expect(ss.streamingMessageId).not.toBe('pending')
      expect(ss.streamingMessageId).toMatch(/^tool-\d+-\d+$/)
    })

    // Flat-state branch (legacy / pre-session bootstrap): when the target
    // session isn't in sessionStates, sendInput writes 'pending' to flat state
    // and tool_start should bump it off 'pending' there too.
    it('bumps off "pending" in the flat-state branch when sessionStates is empty', () => {
      const flatBase = baseState({
        activeSessionId: null,
        sessions: [],
        sessionStates: {},
        messages: [],
        streamingMessageId: 'pending',
      }) as Record<string, unknown>
      // The dashboard's tool_start handler calls get().addMessage in the
      // flat-state path; provide a minimal mock that pushes to messages.
      flatBase.addMessage = (m: unknown) => {
        const s = store.getState() as { messages: unknown[] }
        ;(store as { setState: (p: Record<string, unknown>) => void }).setState({ messages: [...s.messages, m] })
      }
      store = createMockStore(flatBase)
      setStore(store)
      handleMessage(
        {
          type: 'tool_start',
          messageId: 'toolu_flat',
          tool: 'Bash',
          toolUseId: 'toolu_flat',
          input: { command: 'ls' },
          // No sessionId — flat-state path
        },
        ctx() as any,
      )
      const state = store.getState() as any
      expect(state.streamingMessageId).toBe('toolu_flat')
      expect(state.streamingMessageId).not.toBe('pending')
      expect(state.messages.some((m: any) => m.id === 'toolu_flat' && m.type === 'tool_use')).toBe(true)
    })
  })

  // Regression for #3171: when the Agent SDK shuts down abnormally, agent_idle
  // can fire without a closing stream_end/result. Pre-#3171 the only paths that
  // cleared streamingMessageId mid-turn were stream_end, result, disconnect, or
  // a subsequent stream_start/tool_start — none of which arrive in this corner.
  // The 5s safety timer in sendInput used to recover this case but was bypassed
  // by #3170. agent_idle is now the recovery hook: it must clear streamingMessageId
  // so the stop button hides.
  describe('agent_idle clears streamingMessageId (#3171)', () => {
    it('clears streamingMessageId when agent_idle fires mid-stream', () => {
      store = createMockStore(
        baseState({
          activeSessionId: 's1',
          sessions: [{ sessionId: 's1', name: 'S1' } as any],
          sessionStates: {
            s1: { ...createEmptySessionState(), messages: [], streamingMessageId: 'msg-active', isIdle: false },
          },
        }),
      )
      setStore(store)
      handleMessage({ type: 'agent_idle', sessionId: 's1' }, ctx() as any)
      const ss = (store.getState() as any).sessionStates.s1
      expect(ss.isIdle).toBe(true)
      expect(ss.streamingMessageId).toBeNull()
    })

    it('also clears the "pending" sentinel left by sendInput on abnormal shutdown', () => {
      store = createMockStore(
        baseState({
          activeSessionId: 's1',
          sessions: [{ sessionId: 's1', name: 'S1' } as any],
          sessionStates: {
            s1: { ...createEmptySessionState(), messages: [], streamingMessageId: 'pending', isIdle: false },
          },
        }),
      )
      setStore(store)
      handleMessage({ type: 'agent_idle', sessionId: 's1' }, ctx() as any)
      const ss = (store.getState() as any).sessionStates.s1
      expect(ss.streamingMessageId).toBeNull()
    })

    // Legacy/pre-bootstrap path: when the session isn't registered in
    // sessionStates yet, sendInput writes flat 'pending' and the dashboard UI
    // reads flat streamingMessageId directly. agent_idle must clear flat state
    // here too — without this, abnormal idle in legacy/PTY mode leaves the
    // stop button stuck. (Copilot review feedback on initial PR.)
    it('clears flat streamingMessageId when no sessionState is registered (legacy/pre-bootstrap)', () => {
      store = createMockStore(
        baseState({
          activeSessionId: null,
          sessions: [],
          sessionStates: {},
          streamingMessageId: 'pending',
          isIdle: false,
        } as any),
      )
      setStore(store)
      handleMessage({ type: 'agent_idle' }, ctx() as any)
      const state = store.getState() as any
      expect(state.streamingMessageId).toBeNull()
      expect(state.isIdle).toBe(true)
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

  describe('permission_request content rendering (#3122)', () => {
    it('renders just the tool name when description is missing', () => {
      store = createMockStore(
        baseState({
          activeSessionId: 's-perm',
          sessionStates: {
            's-perm': createEmptySessionState(),
          },
        }),
      )
      setStore(store)
      handleMessage(
        {
          type: 'permission_request',
          sessionId: 's-perm',
          requestId: 'perm-no-desc',
          tool: 'Bash',
          input: { command: 'ls' },
        },
        ctx() as any,
      )
      const msgs = (store.getState() as any).sessionStates['s-perm'].messages
      const promptMsg = msgs.find((m: any) => m.type === 'prompt')
      expect(promptMsg).toBeDefined()
      expect(promptMsg.content).toBe('Bash')
      expect(promptMsg.content).not.toContain('undefined')
    })

    it('falls back to "Permission required" when both tool and description are missing', () => {
      store = createMockStore(
        baseState({
          activeSessionId: 's-perm',
          sessionStates: {
            's-perm': createEmptySessionState(),
          },
        }),
      )
      setStore(store)
      handleMessage(
        {
          type: 'permission_request',
          sessionId: 's-perm',
          requestId: 'perm-bare',
        },
        ctx() as any,
      )
      const msgs = (store.getState() as any).sessionStates['s-perm'].messages
      const promptMsg = msgs.find((m: any) => m.type === 'prompt')
      expect(promptMsg).toBeDefined()
      expect(promptMsg.content).toBe('Permission required')
    })
  })

  // #3247 — direct unit coverage for the three skill message handlers.
  // The defensive normalization in handleSkillsList (#3209/#3205) is
  // forward-compat code: a future server adding fields shouldn't break
  // older dashboards. Without direct tests, a refactor could silently
  // drop the normalization and the next protocol bump breaks pre-existing
  // clients.
  describe('skill message handlers (#3247)', () => {
    function withSession(sessionId: string, overrides: Partial<ConnectionState> = {}) {
      const empty = createEmptySessionState()
      return baseState({
        activeSessionId: sessionId,
        sessionStates: { [sessionId]: empty },
        ...overrides,
      })
    }

    describe('skills_list', () => {
      it('stores normalized skills array on the active session', () => {
        store = createMockStore(withSession('s1'))
        setStore(store)
        handleMessage({
          type: 'skills_list',
          skills: [
            { name: 'review', description: 'Review PRs', source: 'global', activation: 'auto', active: true },
            { name: 'commit', source: 'repo', activation: 'manual', active: false },
          ],
        }, ctx() as any)

        const skills = (store.getState() as any).sessionStates.s1.skills
        expect(skills).toHaveLength(2)
        expect(skills[0]).toMatchObject({ name: 'review', source: 'global', activation: 'auto', active: true })
        expect(skills[1]).toMatchObject({ name: 'commit', source: 'repo', activation: 'manual', active: false })
      })

      it('routes to the explicit sessionId when provided (not just active)', () => {
        const empty = createEmptySessionState()
        store = createMockStore(baseState({
          activeSessionId: 's1',
          sessionStates: { s1: empty, s2: empty },
        }))
        setStore(store)
        handleMessage({
          type: 'skills_list',
          sessionId: 's2',
          skills: [{ name: 'fmt' }],
        }, ctx() as any)

        const states = (store.getState() as any).sessionStates
        expect(states.s2.skills).toHaveLength(1)
        expect(states.s1.skills).toBeUndefined()
      })

      it('falls back to activeSessionId when sessionId is absent', () => {
        store = createMockStore(withSession('sFallback'))
        setStore(store)
        handleMessage({ type: 'skills_list', skills: [{ name: 'one' }] }, ctx() as any)

        const skills = (store.getState() as any).sessionStates.sFallback.skills
        expect(skills).toHaveLength(1)
        expect(skills[0].name).toBe('one')
      })

      it('ignores non-array skills payload (no throw, no mutation)', () => {
        store = createMockStore(withSession('s1'))
        setStore(store)
        expect(() =>
          handleMessage({ type: 'skills_list', skills: 'not-an-array' }, ctx() as any),
        ).not.toThrow()
        expect((store.getState() as any).sessionStates.s1.skills).toBeUndefined()
      })

      it('filters out entries with non-string name', () => {
        store = createMockStore(withSession('s1'))
        setStore(store)
        handleMessage({
          type: 'skills_list',
          skills: [
            { name: 'good' },
            { name: 42 },
            { name: null },
            {},
            { name: 'also-good' },
          ],
        }, ctx() as any)

        const skills = (store.getState() as any).sessionStates.s1.skills
        expect(skills.map((s: any) => s.name)).toEqual(['good', 'also-good'])
      })

      it('coerces unknown source / activation values to undefined', () => {
        store = createMockStore(withSession('s1'))
        setStore(store)
        handleMessage({
          type: 'skills_list',
          skills: [
            { name: 'a', source: 'something-new', activation: 'experimental', active: 'yes' },
          ],
        }, ctx() as any)

        const skill = (store.getState() as any).sessionStates.s1.skills[0]
        expect(skill.source).toBeUndefined()
        expect(skill.activation).toBeUndefined()
        // active normalised: only `boolean` types pass through
        expect(skill.active).toBeUndefined()
      })

      it('preserves audit metadata when present, drops non-string types', () => {
        store = createMockStore(withSession('s1'))
        setStore(store)
        handleMessage({
          type: 'skills_list',
          skills: [
            {
              name: 'auditable',
              version: '1.2.3',
              hashPrefix: 'deadbeef',
              firstSeen: '2026-01-01T00:00:00.000Z',
              lastVerified: '2026-05-03T00:00:00.000Z',
            },
            {
              name: 'malformed-meta',
              version: 42,
              hashPrefix: null,
              firstSeen: 12345,
              lastVerified: { iso: '2026-05-03' },
            },
          ],
        }, ctx() as any)

        const skills = (store.getState() as any).sessionStates.s1.skills
        expect(skills[0].version).toBe('1.2.3')
        expect(skills[0].hashPrefix).toBe('deadbeef')
        expect(skills[0].firstSeen).toBe('2026-01-01T00:00:00.000Z')
        expect(skills[0].lastVerified).toBe('2026-05-03T00:00:00.000Z')
        expect(skills[1].version).toBeUndefined()
        expect(skills[1].hashPrefix).toBeUndefined()
        expect(skills[1].firstSeen).toBeUndefined()
        expect(skills[1].lastVerified).toBeUndefined()
      })

      it('no-op when no active session and no sessionId on message', () => {
        store = createMockStore(baseState({ activeSessionId: null, sessionStates: {} }))
        setStore(store)
        expect(() =>
          handleMessage({ type: 'skills_list', skills: [{ name: 'a' }] }, ctx() as any),
        ).not.toThrow()
      })

      it('no-op when targetId resolves but no sessionStates entry exists', () => {
        store = createMockStore(baseState({
          activeSessionId: 'ghost',
          sessionStates: {},
        }))
        setStore(store)
        expect(() =>
          handleMessage({ type: 'skills_list', skills: [{ name: 'a' }] }, ctx() as any),
        ).not.toThrow()
      })
    })

    describe('skill_activated / skill_deactivated', () => {
      it('skill_activated flips active=true on the matching cached skill', () => {
        const empty = createEmptySessionState()
        store = createMockStore(baseState({
          activeSessionId: 's1',
          sessionStates: {
            s1: { ...empty, skills: [{ name: 'x', activation: 'manual', active: false }] },
          },
        }))
        setStore(store)
        handleMessage({ type: 'skill_activated', skillName: 'x' }, ctx() as any)

        const skill = (store.getState() as any).sessionStates.s1.skills.find((s: any) => s.name === 'x')
        expect(skill.active).toBe(true)
      })

      it('skill_deactivated flips active=false on the matching cached skill', () => {
        const empty = createEmptySessionState()
        store = createMockStore(baseState({
          activeSessionId: 's1',
          sessionStates: {
            s1: { ...empty, skills: [{ name: 'x', activation: 'manual', active: true }] },
          },
        }))
        setStore(store)
        handleMessage({ type: 'skill_deactivated', skillName: 'x' }, ctx() as any)

        const skill = (store.getState() as any).sessionStates.s1.skills.find((s: any) => s.name === 'x')
        expect(skill.active).toBe(false)
      })

      it('skill_activated leaves non-matching skills untouched', () => {
        const empty = createEmptySessionState()
        store = createMockStore(baseState({
          activeSessionId: 's1',
          sessionStates: {
            s1: { ...empty, skills: [
              { name: 'x', activation: 'manual', active: false },
              { name: 'y', activation: 'manual', active: false },
            ] },
          },
        }))
        setStore(store)
        handleMessage({ type: 'skill_activated', skillName: 'x' }, ctx() as any)

        const skills = (store.getState() as any).sessionStates.s1.skills
        expect(skills.find((s: any) => s.name === 'x').active).toBe(true)
        expect(skills.find((s: any) => s.name === 'y').active).toBe(false)
      })

      // Lock in current behaviour when no skills are cached: the handler
      // calls `updateSession` with `(state.skills || []).map(...)`, which
      // writes an empty array (initialising the field from undefined).
      // Future contract: the next `list_skills` response is authoritative
      // and will overwrite this with the real skill set. The empty array
      // is a transient placeholder, not a final state.
      it('skill_activated initialises skills to [] when none were cached (next list_skills is authoritative)', () => {
        store = createMockStore(withSession('s1'))
        setStore(store)
        expect(() =>
          handleMessage({ type: 'skill_activated', skillName: 'x' }, ctx() as any),
        ).not.toThrow()
        // Sanity: starts undefined.
        // (createEmptySessionState doesn't set `skills`.)
        // After dispatch: empty array (no entries to flip; placeholder
        // until list_skills arrives).
        const skills = (store.getState() as any).sessionStates.s1.skills
        expect(skills).toEqual([])
      })

      it('skill_activated routes to explicit sessionId rather than active', () => {
        const empty = createEmptySessionState()
        store = createMockStore(baseState({
          activeSessionId: 's1',
          sessionStates: {
            s1: { ...empty, skills: [{ name: 'x', activation: 'manual', active: false }] },
            s2: { ...empty, skills: [{ name: 'x', activation: 'manual', active: false }] },
          },
        }))
        setStore(store)
        handleMessage({ type: 'skill_activated', sessionId: 's2', skillName: 'x' }, ctx() as any)

        const states = (store.getState() as any).sessionStates
        expect(states.s1.skills[0].active).toBe(false)
        expect(states.s2.skills[0].active).toBe(true)
      })

      it('skill_activated no-ops when sessionId targets a session not in store', () => {
        const empty = createEmptySessionState()
        store = createMockStore(baseState({
          activeSessionId: 's1',
          sessionStates: {
            s1: { ...empty, skills: [{ name: 'x', activation: 'manual', active: false }] },
          },
        }))
        setStore(store)
        expect(() =>
          handleMessage({ type: 'skill_activated', sessionId: 'ghost', skillName: 'x' }, ctx() as any),
        ).not.toThrow()
        // s1 untouched
        expect((store.getState() as any).sessionStates.s1.skills[0].active).toBe(false)
      })

      it('skill_activated ignores non-string skillName', () => {
        const empty = createEmptySessionState()
        const initial = [{ name: 'x', activation: 'manual' as const, active: false }]
        store = createMockStore(baseState({
          activeSessionId: 's1',
          sessionStates: { s1: { ...empty, skills: initial } },
        }))
        setStore(store)
        handleMessage({ type: 'skill_activated', skillName: 42 }, ctx() as any)
        handleMessage({ type: 'skill_activated', skillName: null }, ctx() as any)
        handleMessage({ type: 'skill_activated' }, ctx() as any)

        expect((store.getState() as any).sessionStates.s1.skills[0].active).toBe(false)
      })

      it('two sequential skill_activated broadcasts for different skills both apply', () => {
        const empty = createEmptySessionState()
        store = createMockStore(baseState({
          activeSessionId: 's1',
          sessionStates: {
            s1: { ...empty, skills: [
              { name: 'a', activation: 'manual', active: false },
              { name: 'b', activation: 'manual', active: false },
            ] },
          },
        }))
        setStore(store)

        handleMessage({ type: 'skill_activated', skillName: 'a' }, ctx() as any)
        handleMessage({ type: 'skill_activated', skillName: 'b' }, ctx() as any)

        const skills = (store.getState() as any).sessionStates.s1.skills
        expect(skills.find((s: any) => s.name === 'a').active).toBe(true)
        expect(skills.find((s: any) => s.name === 'b').active).toBe(true)
      })
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
