/**
 * #8599 -- CLIENT contract test. Given the frames the server sends a late-joining
 * dashboard for a busy session (session_list busy, a replay whose old results are
 * NOT followed by agent_idle), the store stays busy and the InputBar busy props
 * (the same `inputBarBusyProps` App.tsx uses) show Stop. A stray agent_idle would
 * hide it. That the server really sends that frame sequence is pinned in
 * packages/server/tests/late-join-busy-replay.test.js. Not covered here: pressing
 * Stop/Escape and busy queueing (owner-path smoke).
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
vi.mock('./persistence', () => ({ clearPersistedSession: vi.fn() }))

import {
  handleMessage, setStore, setConnectionContext, clearDeltaBuffers,
  clearPermissionSplits, stopHeartbeat, resetReplayFlags,
} from './message-handler'
import { inputBarBusyProps } from '../lib/session-busy'
import type { ConnectionState } from './types'

const SID = 'sess-late'

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

describe('late join of a busy session keeps Stop (#8599)', () => {
  let store: ReturnType<typeof createMockStore>
  const ctx = () => ({
    url: 'wss://t', token: 'tok',
    socket: { send: vi.fn(), close: vi.fn(), readyState: 1 } as unknown as WebSocket,
    isReconnect: false, silent: false,
  })
  const send = (msg: Record<string, unknown>) => handleMessage(msg, ctx() as never)
  const ss = () => store.getState().sessionStates[SID]!
  const showsStop = () => {
    const b = inputBarBusyProps({ streamingMessageId: ss().streamingMessageId, isIdle: ss().isIdle })
    return b.isBusy || b.isStreaming
  }

  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    clearDeltaBuffers()
    clearPermissionSplits()
    store = createMockStore({
      connectionPhase: 'connected',
      socket: null,
      sessions: [], activeSessionId: null, sessionStates: {},
      messages: [], terminalBuffer: '', terminalRawBuffer: '', customAgents: [], slashCommands: [],
      connectedClients: [], serverErrors: [], addServerError: () => undefined,
      appendTerminalData: () => undefined, serverProtocolVersion: null,
      fetchSlashCommands: () => undefined, fetchCustomAgents: () => undefined,
    } as unknown as Partial<ConnectionState>)
    setStore(store)
    setConnectionContext(ctx() as never)
  })
  afterEach(() => {
    stopHeartbeat(); clearDeltaBuffers(); clearPermissionSplits(); resetReplayFlags()
    setConnectionContext(null); vi.useRealTimers()
  })

  const join = (busy: boolean) => {
    send({ type: 'session_list', sessions: [{ sessionId: SID, name: 'A', provider: 'codex', isBusy: busy }] })
    send({ type: 'session_switched', sessionId: SID, name: 'A', cwd: '/r' })
    send({ type: 'history_replay_start', sessionId: SID, fullHistory: true, latestSeq: 6 })
    send({ type: 'message', sessionId: SID, messageType: 'user_input', content: 'one', timestamp: 1, historySeq: 1 })
    send({ type: 'message', sessionId: SID, messageType: 'response', content: 'done one', messageId: 'r1', timestamp: 2, historySeq: 2 })
    send({ type: 'result', sessionId: SID, replayed: true, timestamp: 3, historySeq: 3 })
    if (!busy) send({ type: 'agent_idle', sessionId: SID })
    send({ type: 'message', sessionId: SID, messageType: 'user_input', content: 'two', timestamp: 4, historySeq: 4 })
    send({ type: 'history_replay_end', sessionId: SID, latestSeq: 6 })
  }

  it('busy session: still busy, Stop shown, after the replay', () => {
    join(true)
    expect(ss().isIdle).toBe(false)
    expect(showsStop()).toBe(true)
  })

  it('idle session: idle after the replay, orphan tool chips cleared', () => {
    send({ type: 'session_list', sessions: [{ sessionId: SID, name: 'A', provider: 'codex', isBusy: false }] })
    send({ type: 'session_switched', sessionId: SID, name: 'A', cwd: '/r' })
    send({ type: 'history_replay_start', sessionId: SID, fullHistory: true, latestSeq: 3 })
    send({ type: 'tool_start', sessionId: SID, messageId: 't1', tool: 'Bash', toolUseId: 'tu1', input: {}, historySeq: 1 })
    send({ type: 'result', sessionId: SID, replayed: true, timestamp: 3, historySeq: 2 })
    send({ type: 'agent_idle', sessionId: SID })
    send({ type: 'history_replay_end', sessionId: SID, latestSeq: 3 })
    expect(ss().isIdle).toBe(true)
    expect(ss().activeTools).toHaveLength(0)
    expect(showsStop()).toBe(false)
  })

  it('a session_activity busy frame restores Stop after a stray idle', () => {
    join(true)
    send({ type: 'agent_idle', sessionId: SID })
    expect(showsStop()).toBe(false)
    send({ type: 'session_activity', sessionId: SID, isBusy: true })
    expect(ss().isIdle).toBe(false)
    expect(showsStop()).toBe(true)
  })

  it('an agent_idle inside the replay of a busy session WOULD hide Stop (why the server must not send it)', () => {
    join(true)
    send({ type: 'agent_idle', sessionId: SID })
    expect(showsStop()).toBe(false)
  })
})
