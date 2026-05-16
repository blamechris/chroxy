/**
 * Integration test for the message-handler dispatch entry's
 * lastClientActivityAt bump (#3762).
 *
 * Guards against the regression where activity-bearing events
 * (stream_delta, stream_start, etc.) would not reset
 * sessionStates[id].lastClientActivityAt — the timestamp the
 * ActivityIndicator and idle-disconnect timers key off of.
 *
 * isActivityEvent() has unit tests in store-core/utils.test.ts, but
 * the wiring between the dispatch entry and the store update was
 * previously uncovered. This test exercises that wire end-to-end:
 *   - explicit msg.sessionId path
 *   - active-session-fallback path (msg has no sessionId)
 *   - passive events (server_status) must NOT bump the timestamp
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
  setConnectionContext,
  clearDeltaBuffers,
  clearPermissionSplits,
  stopHeartbeat,
  resetReplayFlags,
} from './message-handler'
import { createEmptySessionState } from './utils'
import type { ConnectionState, SessionState } from './types'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const SESSION_ID = 'sess-activity-1'
const OTHER_SESSION_ID = 'sess-activity-2'

function createMockStore(initial: Partial<ConnectionState>) {
  let state = initial as ConnectionState
  return {
    getState: () => state,
    setState: (
      s: Partial<ConnectionState> | ((prev: ConnectionState) => Partial<ConnectionState>),
    ) => {
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

function baseState(
  initialActivityAt: number | null,
  opts: { withInactivityWarning?: boolean; twoSessions?: boolean } = {},
): Partial<ConnectionState> {
  const primary: SessionState = {
    ...createEmptySessionState(),
    lastClientActivityAt: initialActivityAt,
  }
  if (opts.withInactivityWarning) {
    primary.inactivityWarning = {
      lastActivityAt: 1_000,
      thresholdMs: 60_000,
      raisedAt: 2_000,
    } as SessionState['inactivityWarning']
  }
  const sessionStates: Record<string, SessionState> = { [SESSION_ID]: primary }
  const sessions: any[] = [{ sessionId: SESSION_ID, name: 'A', provider: 'claude-sdk' }]
  if (opts.twoSessions) {
    sessionStates[OTHER_SESSION_ID] = {
      ...createEmptySessionState(),
      lastClientActivityAt: initialActivityAt,
    }
    sessions.push({ sessionId: OTHER_SESSION_ID, name: 'B', provider: 'claude-sdk' })
  }
  // Minimal store shape mirroring message-handler.test.ts:baseState().
  const serverErrors: unknown[] = []
  return {
    connectionPhase: 'connected',
    socket: null,
    sessions,
    activeSessionId: SESSION_ID,
    sessionStates,
    messages: [],
    terminalBuffer: '',
    terminalRawBuffer: '',
    customAgents: [],
    slashCommands: [],
    connectedClients: [],
    serverErrors,
    addServerError: (e: unknown) => {
      serverErrors.push(e)
    },
    appendTerminalData: () => undefined,
    serverProtocolVersion: null,
  } as unknown as Partial<ConnectionState>
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dashboard message-handler dispatch — lastClientActivityAt (#3762)', () => {
  let store: ReturnType<typeof createMockStore>
  let mockSocket: WebSocket
  let nowSpy: ReturnType<typeof vi.spyOn>
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
    // Pin Date.now() so we can assert the exact bump value.
    nowSpy = vi.spyOn(Date, 'now').mockReturnValue(10_000)
    store = createMockStore(baseState(/* initialActivityAt */ 100))
    setStore(store)
    setConnectionContext(ctx() as any)
  })

  afterEach(() => {
    nowSpy.mockRestore()
    stopHeartbeat()
    clearDeltaBuffers()
    clearPermissionSplits()
    resetReplayFlags()
    setConnectionContext(null)
  })

  describe('activity events bump lastClientActivityAt', () => {
    it('stream_delta with explicit sessionId bumps lastClientActivityAt', () => {
      handleMessage(
        { type: 'stream_delta', messageId: 'd1', sessionId: SESSION_ID, delta: 'hi' },
        ctx() as any,
      )
      const ss = store.getState().sessionStates[SESSION_ID]
      expect(ss.lastClientActivityAt).toBe(10_000)
    })

    it('stream_delta without sessionId falls back to activeSessionId', () => {
      handleMessage(
        { type: 'stream_delta', messageId: 'd2', delta: 'hello' },
        ctx() as any,
      )
      const ss = store.getState().sessionStates[SESSION_ID]
      expect(ss.lastClientActivityAt).toBe(10_000)
    })

    it('stream_start, stream_end, tool_start, tool_result, message, result all bump the timestamp', () => {
      const cases: any[] = [
        { type: 'stream_start', messageId: 's1', sessionId: SESSION_ID },
        { type: 'stream_end', messageId: 's1', sessionId: SESSION_ID },
        { type: 'tool_start', messageId: 't1', sessionId: SESSION_ID, tool: 'Bash', input: {} },
        { type: 'tool_result', messageId: 't1', sessionId: SESSION_ID, output: '' },
        { type: 'message', messageId: 'm1', sessionId: SESSION_ID, role: 'assistant', content: 'hi' },
        { type: 'result', sessionId: SESSION_ID, cost: 0, duration: 1 },
      ]
      for (let i = 0; i < cases.length; i++) {
        nowSpy.mockReturnValue(20_000 + i)
        handleMessage(cases[i], ctx() as any)
        const ss = store.getState().sessionStates[SESSION_ID]
        expect(ss.lastClientActivityAt).toBe(20_000 + i)
      }
    })

    it('explicit sessionId targets that session, not the active one', () => {
      store = createMockStore(baseState(100, { twoSessions: true }))
      setStore(store)

      nowSpy.mockReturnValue(30_000)
      handleMessage(
        { type: 'stream_delta', messageId: 'd3', sessionId: OTHER_SESSION_ID, delta: 'data' },
        ctx() as any,
      )

      const target = store.getState().sessionStates[OTHER_SESSION_ID]
      const active = store.getState().sessionStates[SESSION_ID]
      expect(target.lastClientActivityAt).toBe(30_000)
      // The active session's timestamp must not be touched when sessionId
      // is explicit — the dispatch entry must route to the right slot.
      expect(active.lastClientActivityAt).toBe(100)
    })

    it('dismisses an outstanding inactivityWarning when activity arrives (#3899)', () => {
      store = createMockStore(baseState(100, { withInactivityWarning: true }))
      setStore(store)

      handleMessage(
        { type: 'stream_delta', messageId: 'd4', sessionId: SESSION_ID, delta: 'x' },
        ctx() as any,
      )

      const ss = store.getState().sessionStates[SESSION_ID]
      expect(ss.lastClientActivityAt).toBe(10_000)
      expect(ss.inactivityWarning).toBeNull()
    })
  })

  describe('passive events do NOT bump lastClientActivityAt', () => {
    it('server_status leaves lastClientActivityAt unchanged', () => {
      handleMessage(
        { type: 'server_status', sessionId: SESSION_ID, status: 'idle' },
        ctx() as any,
      )
      const ss = store.getState().sessionStates[SESSION_ID]
      expect(ss.lastClientActivityAt).toBe(100)
    })

    it('pong leaves lastClientActivityAt unchanged', () => {
      handleMessage({ type: 'pong' }, ctx() as any)
      const ss = store.getState().sessionStates[SESSION_ID]
      expect(ss.lastClientActivityAt).toBe(100)
    })

    it('unknown message type leaves lastClientActivityAt unchanged', () => {
      // Use a synthetic unknown type — it will fall through every dispatch
      // branch without touching sessionStates, isolating the negative-path
      // assertion from any per-case handler mutations (e.g. session_list
      // rewriting the entire sessionStates map).
      handleMessage(
        { type: 'totally_unknown_type_for_3762', sessionId: SESSION_ID },
        ctx() as any,
      )
      const ss = store.getState().sessionStates[SESSION_ID]
      expect(ss.lastClientActivityAt).toBe(100)
    })
  })

  describe('edge cases', () => {
    it('activity event with unknown sessionId and no activeSessionId is a no-op', () => {
      store = createMockStore({
        ...baseState(null),
        activeSessionId: null,
        sessions: [],
        sessionStates: {},
      })
      setStore(store)

      expect(() => {
        handleMessage(
          { type: 'stream_delta', messageId: 'orphan', sessionId: 'nope', delta: 'x' },
          ctx() as any,
        )
      }).not.toThrow()
      expect(store.getState().sessionStates).toEqual({})
    })
  })
})
