/**
 * #7603 — dashboard dispatch wiring for the per-session container-lost state.
 *
 * store-core owns the PARSE (handlers.test.ts pins it); this file pins the
 * WIRING: that the dashboard applies the shared patch to the right session, and
 * — the load-bearing half — that it releases the state on exactly one signal.
 *
 * The `claude_ready` test is the one that matters. `stoppedAt` clears on
 * `claude_ready`, so copying that pattern is the obvious thing to do and it is
 * WRONG here: ws-history's `sendSessionInfo` re-sends `claude_ready` on every
 * reconnect and session switch whenever `session.isReady`, and `isReady`
 * describes the child process, not the container. Clearing on it would drop the
 * banner while the container was still gone — a false-safety bug of exactly the
 * class docs/false-safety-guards.md catalogues. That test carries a positive
 * CONTROL so it cannot pass by the message never having been processed.
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

const SESSION_ID = 'sess-cl-1'
const OTHER_SESSION_ID = 'sess-cl-2'
const NOW = 10_000

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

/** The wire shape the server actually produces for a vanish. */
function vanishMessage(sessionId: string, code = 'CONTAINER_VANISHED', message?: string) {
  return {
    type: 'message',
    messageType: 'error',
    content: 'The container for this session is no longer running.',
    timestamp: 1,
    code,
    sessionId,
    ...(message ? { message } : {}),
  }
}

describe('dashboard dispatch — container-lost state (#7603)', () => {
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
    nowSpy = vi.spyOn(Date, 'now').mockReturnValue(NOW)
    store = createMockStore(baseState())
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

  it('arms containerLostAt on a live CONTAINER_VANISHED for the named session', () => {
    handleMessage(vanishMessage(SESSION_ID), ctx() as any)
    const ss = store.getState().sessionStates[SESSION_ID]!
    expect(ss.containerLostAt).toBe(NOW)
    expect(ss.containerReattachError).toBeNull()
    // The chat bubble is still appended — the banner is additive.
    expect(ss.messages.some((m) => m.code === 'CONTAINER_VANISHED')).toBe(true)
  })

  it('records the refusal detail on ENVIRONMENT_UNAVAILABLE', () => {
    handleMessage(
      vanishMessage(SESSION_ID, 'ENVIRONMENT_UNAVAILABLE', 'the environment now runs a different container'),
      ctx() as any,
    )
    const ss = store.getState().sessionStates[SESSION_ID]!
    expect(ss.containerLostAt).toBe(NOW)
    expect(ss.containerReattachError).toBe('the environment now runs a different container')
  })

  it('applies to the session the message names, NOT the active one', () => {
    handleMessage(vanishMessage(OTHER_SESSION_ID), ctx() as any)
    expect(store.getState().sessionStates[OTHER_SESSION_ID]!.containerLostAt).toBe(NOW)
    expect(store.getState().sessionStates[SESSION_ID]!.containerLostAt).toBeNull()
  })

  it('does NOT banner the ACTIVE session when the vanish names an unregistered session', () => {
    // Cross-client parity with the app's test of the same name. The dashboard
    // reaches this safely by a different route — its message-append falls back
    // to the flat `addMessage`, not to the active session's state — but the
    // INVARIANT is shared and is what both clients must hold: a vanish for a
    // session this client does not know must banner nobody, least of all the
    // session the user is looking at.
    handleMessage(vanishMessage('ghost-session-not-in-store'), ctx() as any)

    expect(store.getState().sessionStates[SESSION_ID]!.containerLostAt).toBeNull()
    expect(store.getState().sessionStates[OTHER_SESSION_ID]!.containerLostAt).toBeNull()
  })

  it('leaves the state untouched for an ordinary error message', () => {
    handleMessage(
      { type: 'message', messageType: 'error', content: 'boom', timestamp: 1, sessionId: SESSION_ID },
      ctx() as any,
    )
    expect(store.getState().sessionStates[SESSION_ID]!.containerLostAt).toBeNull()
  })

  it('a completed turn (result) RELEASES the state', () => {
    handleMessage(vanishMessage(SESSION_ID), ctx() as any)
    expect(store.getState().sessionStates[SESSION_ID]!.containerLostAt).toBe(NOW)

    handleMessage({ type: 'result', sessionId: SESSION_ID, cost: 0 }, ctx() as any)
    const ss = store.getState().sessionStates[SESSION_ID]!
    expect(ss.containerLostAt).toBeNull()
    expect(ss.containerReattachError).toBeNull()
  })

  it('claude_ready does NOT release the state (isReady is about the child, not the container)', () => {
    handleMessage(
      vanishMessage(SESSION_ID, 'ENVIRONMENT_UNAVAILABLE', 'rebuilt'),
      ctx() as any,
    )
    // Put the session into the stopped state too, so claude_ready has something
    // it IS expected to clear.
    handleMessage({ type: 'session_stopped', sessionId: SESSION_ID, code: 0 }, ctx() as any)
    expect(store.getState().sessionStates[SESSION_ID]!.stoppedAt).toBe(NOW)

    handleMessage({ type: 'claude_ready', sessionId: SESSION_ID }, ctx() as any)

    const ss = store.getState().sessionStates[SESSION_ID]!
    // CONTROL: claude_ready really was processed — it did the clearing it owns.
    // Without this the two assertions below would hold for free if the message
    // had been dropped anywhere upstream.
    expect(ss.claudeReady).toBe(true)
    expect(ss.stoppedAt).toBeNull()
    // The actual claim.
    expect(ss.containerLostAt).toBe(NOW)
    expect(ss.containerReattachError).toBe('rebuilt')
  })
})
