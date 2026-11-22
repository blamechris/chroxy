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

vi.mock('../utils/native-notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/native-notifications')>()
  return { ...actual, sendNativeNotification: vi.fn(() => true) }
})

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
import { renderHook, cleanup, act } from '@testing-library/react'
import { sessionStopStamp } from '../utils/turn-ended-by-stop'
import {
  useTurnCompleteNotification,
  STOP_SIGNAL_GRACE_MS,
  type TurnCompleteSession,
} from '../hooks/useTurnCompleteNotification'
import { sendNativeNotification } from '../utils/native-notifications'

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
 * #9272 — the unfocused-window "Finished" notification, driven END TO END from
 * the real frame sequences the server produces: frames go through
 * `handleMessage`, and the store state is mapped the way App.tsx maps it
 * (`sessionStopStamp`) into the real `useTurnCompleteNotification`.
 */
const mockSend = vi.mocked(sendNativeNotification)
let store: ReturnType<typeof createMockStore>
let ctxRef: () => unknown
let hook: ReturnType<typeof renderHook<void, { sessions: TurnCompleteSession[] }>>

function sessionsFromStore(): TurnCompleteSession[] {
  const ss = store.getState().sessionStates[SESSION_ID]!
  return [{
    sessionId: SESSION_ID,
    name: 'A',
    busy: ss.isIdle === false,
    awaitingPermission: false,
    stopStamp: sessionStopStamp(ss),
  }]
}
const sync = () => act(() => hook.rerender({ sessions: sessionsFromStore() }))
const frame = (m: Record<string, unknown>) => {
  vi.advanceTimersByTime(2) // distinct stamps per frame
  handleMessage({ sessionId: SESSION_ID, ...m }, ctxRef() as any)
  sync()
}
const busy = () => {
  frame({ type: 'agent_busy' })
  frame({ type: 'session_activity', isBusy: true })
}
/** A turn that goes busy through `session_activity` alone: no agent_busy. */
const busyViaActivityOnly = () => frame({ type: 'session_activity', isBusy: true })
const idle = () => {
  frame({ type: 'session_activity', isBusy: false })
  frame({ type: 'agent_idle' })
}
const settle = () => act(() => { vi.advanceTimersByTime(STOP_SIGNAL_GRACE_MS + 1) })

describe('dashboard — Finished notification vs a Stop, from real frames (#9272)', () => {
  let mockSocket: WebSocket
  let originalHasFocus: typeof document.hasFocus
  const ctx = () => ({ url: 'wss://t', token: 'tok', socket: mockSocket, isReconnect: false, silent: false })

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    localStorage.clear()
    clearDeltaBuffers()
    clearPermissionSplits()
    originalHasFocus = document.hasFocus
    document.hasFocus = () => false
    mockSocket = createMockSocket()
    store = createMockStore(baseState())
    setStore(store)
    setConnectionContext(ctx() as any)
    ctxRef = ctx
    hook = renderHook(
      ({ sessions }: { sessions: TurnCompleteSession[] }) =>
        useTurnCompleteNotification(sessions, { enabled: true, connected: true }),
      { initialProps: { sessions: sessionsFromStore() } },
    )
  })

  afterEach(() => {
    cleanup()
    document.hasFocus = originalHasFocus
    stopHeartbeat()
    clearDeltaBuffers()
    clearPermissionSplits()
    resetReplayFlags()
    setConnectionContext(null)
    vi.useRealTimers()
  })

  it('a normal completion notifies — control', () => {
    busy()
    frame({ type: 'result', cost: 0.01, duration: 10 })
    idle()
    settle()
    expect(mockSend).toHaveBeenCalledOnce()
  })

  it('a user Stop after output (plain result, idle, THEN session_stopped) does not', () => {
    busy()
    frame({ type: 'result', cost: 0.01, duration: 10 })
    idle()
    frame({ type: 'session_stopped', code: 0 })
    settle()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('a Stop with no result (session_stopped, then agent_idle) does not', () => {
    busy()
    frame({ type: 'session_stopped', code: 0 })
    idle()
    settle()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('a stopped_before_output marker result does not', () => {
    busy()
    frame({ type: 'result', cost: null, duration: null, turnOutcome: 'stopped_before_output', timestamp: 1700000000000 })
    idle()
    settle()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('an interrupted result does not', () => {
    busy()
    frame({ type: 'result', cost: null, duration: null, turnOutcome: 'interrupted', timestamp: 1700000000001 })
    idle()
    settle()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('a model-ended outcome (truncated) still notifies', () => {
    busy()
    frame({ type: 'result', cost: 0.01, duration: 10, turnOutcome: 'truncated', timestamp: 1700000000002 })
    idle()
    settle()
    expect(mockSend).toHaveBeenCalledOnce()
  })

  it('a Stop, then a next turn through agent_busy that completes normally, notifies', () => {
    busy()
    frame({ type: 'result', cost: null, duration: null, turnOutcome: 'stopped_before_output', timestamp: 1700000000003 })
    frame({ type: 'session_stopped', code: 0 })
    idle()
    settle()
    expect(mockSend).not.toHaveBeenCalled()

    busy()
    frame({ type: 'result', cost: 0.01, duration: 10 })
    idle()
    settle()
    expect(mockSend).toHaveBeenCalledOnce()
  })

  it('a Stop, then a next turn that goes busy via session_activity ALONE (no agent_busy), notifies', () => {
    // agent_busy is only sent with a non-thinking stream_start, so a tool-only or
    // early-erroring turn never clears stoppedAt / the result stamp. The stale
    // stamp must not suppress this turn.
    busy()
    frame({ type: 'result', cost: null, duration: null, turnOutcome: 'interrupted', timestamp: 1700000000005 })
    frame({ type: 'session_stopped', code: 0 })
    idle()
    settle()
    expect(mockSend).not.toHaveBeenCalled()

    busyViaActivityOnly()
    frame({ type: 'result', cost: 0.01, duration: 10 })
    idle()
    settle()
    expect(mockSend).toHaveBeenCalledOnce()
  })

  it('a replayed stop result during a live turn does not suppress its completion', () => {
    busy()
    frame({ type: 'result', cost: null, duration: null, turnOutcome: 'interrupted', timestamp: 1700000000006, replayed: true })
    frame({ type: 'result', cost: null, duration: null, turnOutcome: 'stopped_before_output', timestamp: 1700000000007, historySeq: 4 })
    frame({ type: 'result', cost: 0.01, duration: 10 })
    idle()
    settle()
    expect(mockSend).toHaveBeenCalledOnce()
  })

  it('a LIVE stop result is what stamps — control for the replay cell', () => {
    busy()
    frame({ type: 'result', cost: null, duration: null, turnOutcome: 'interrupted', timestamp: 1700000000008 })
    idle()
    settle()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('a Stop on another session does not suppress this one', () => {
    busy()
    handleMessage({ type: 'session_stopped', sessionId: OTHER_SESSION_ID, code: 0 }, ctx() as any)
    frame({ type: 'result', cost: 0.01, duration: 10 })
    idle()
    settle()
    expect(mockSend).toHaveBeenCalledOnce()
  })
})
