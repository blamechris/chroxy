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
import { sessionEndedByStop } from '../utils/turn-ended-by-stop'

const SESSION_ID = 'sess-stop-1'
const OTHER_SESSION_ID = 'sess-stop-2'

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

function baseState(): Partial<ConnectionState> {
  const sessionStates: Record<string, SessionState> = {
    [SESSION_ID]: { ...createEmptySessionState() },
    [OTHER_SESSION_ID]: { ...createEmptySessionState() },
  }
  const serverErrors: unknown[] = []
  return {
    connectionPhase: 'connected',
    socket: null,
    sessions: [
      { sessionId: SESSION_ID, name: 'A', provider: 'claude-sdk' },
      { sessionId: OTHER_SESSION_ID, name: 'B', provider: 'claude-sdk' },
    ],
    activeSessionId: SESSION_ID,
    sessionStates,
    messages: [],
    terminalBuffer: '',
    terminalRawBuffer: '',
    customAgents: [],
    slashCommands: [],
    connectedClients: [],
    serverErrors,
    addServerError: (e: unknown) => { serverErrors.push(e) },
    // session_stopped raises an info toast (#4878) on its way through dispatch.
    addInfoNotification: () => undefined,
    // An unknown sessionId falls through to the flat message log, not to the
    // active session's state — that fallback is exactly what this file's
    // unregistered-session test exercises.
    addMessage: () => undefined,
    appendTerminalData: () => undefined,
    serverProtocolVersion: null,
  } as unknown as Partial<ConnectionState>
}

/**
 * #9272 — the dashboard derives "this turn was ended by a Stop" from the REAL
 * frame sequences the server produces, so the unfocused-window "Finished"
 * notification can skip it. Each cell feeds frames through `handleMessage` and
 * reads the same `sessionEndedByStop` selector App.tsx feeds the hook.
 */
const frame = (m: Record<string, unknown>) => handleMessage({ sessionId: SESSION_ID, ...m }, ctxRef() as any)
let ctxRef: () => unknown

const busy = () => {
  frame({ type: 'agent_busy' })
  frame({ type: 'session_activity', isBusy: true })
}
const idle = () => {
  frame({ type: 'session_activity', isBusy: false })
  frame({ type: 'agent_idle' })
}
const ended = () => sessionEndedByStop(store.getState().sessionStates[SESSION_ID])

let store: ReturnType<typeof createMockStore>

describe('dashboard — turn ended by a Stop (#9272)', () => {
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
    setConnectionContext(ctx() as any)
    ctxRef = ctx
  })

  afterEach(() => {
    stopHeartbeat()
    clearDeltaBuffers()
    clearPermissionSplits()
    resetReplayFlags()
    setConnectionContext(null)
  })

  it('a normal completion is NOT ended by a Stop — control', () => {
    busy()
    frame({ type: 'result', cost: 0.01, duration: 10 })
    idle()
    expect(ended()).toBe(false)
  })

  it('a user Stop after output: plain result, idle, THEN session_stopped', () => {
    busy()
    frame({ type: 'result', cost: 0.01, duration: 10 })
    idle()
    // The result alone cannot say it was a Stop (#8461 strips the outcome)...
    expect(ended()).toBe(false)
    frame({ type: 'session_stopped', code: 0 })
    // ...the trailing session_stopped does.
    expect(ended()).toBe(true)
  })

  it('a Stop with no result: session_stopped, then agent_idle', () => {
    busy()
    frame({ type: 'session_stopped', code: 0 })
    idle()
    expect(ended()).toBe(true)
  })

  it('a stopped_before_output marker result', () => {
    busy()
    frame({ type: 'result', cost: null, duration: null, turnOutcome: 'stopped_before_output', timestamp: 1700000000000 })
    idle()
    expect(ended()).toBe(true)
  })

  it('an interrupted result', () => {
    busy()
    frame({ type: 'result', cost: null, duration: null, turnOutcome: 'interrupted', timestamp: 1700000000001 })
    idle()
    expect(ended()).toBe(true)
  })

  it('a model-ended outcome (truncated) is still a finished turn', () => {
    busy()
    frame({ type: 'result', cost: 0.01, duration: 10, turnOutcome: 'truncated', timestamp: 1700000000002 })
    idle()
    expect(ended()).toBe(false)
  })

  it('is not "ended" while the next turn runs, and resets for a following normal turn', () => {
    busy()
    frame({ type: 'result', cost: null, duration: null, turnOutcome: 'stopped_before_output', timestamp: 1700000000003 })
    frame({ type: 'session_stopped', code: 0 })
    idle()
    expect(ended()).toBe(true)

    busy()
    expect(ended()).toBe(false)
    expect(store.getState().sessionStates[SESSION_ID]!.lastTurnStopped).toBe(false)
    expect(store.getState().sessionStates[SESSION_ID]!.stoppedAt).toBeNull()
    frame({ type: 'result', cost: 0.01, duration: 10 })
    idle()
    expect(ended()).toBe(false)
  })

  it('a stale result flag does not leak into a later turn that ends with no result', () => {
    busy()
    frame({ type: 'result', cost: null, duration: null, turnOutcome: 'interrupted', timestamp: 1700000000004 })
    idle()
    busy()
    idle() // ended with only an idle (e.g. an error-only turn)
    expect(ended()).toBe(false)
  })

  it('applies to the named session only', () => {
    busy()
    handleMessage({ type: 'session_stopped', sessionId: OTHER_SESSION_ID, code: 0 }, ctx() as any)
    idle()
    expect(ended()).toBe(false)
  })
})
