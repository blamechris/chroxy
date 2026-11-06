/**
 * #8960 -- a response still streaming when a FULL replay window opens (tab switch
 * mid-turn) keeps its already-received text across the swap, through the
 * dashboard's real handler. The shared rule is pinned in store-core's
 * replay-live-stream-carry.test.ts.
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
  handleMessage,
  setStore,
  setConnectionContext,
  clearDeltaBuffers,
  clearPermissionSplits,
  stopHeartbeat,
  resetReplayFlags,
} from './message-handler'
import { createEmptySessionState } from './utils'
import type { ConnectionState } from './types'

const SID = 'sess-order'
const TURN = 'turn-1'

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


describe('a streaming response survives a full replay swap (#8960)', () => {
  let store: ReturnType<typeof createMockStore>
  const ctx = () => ({
    url: 'wss://t', token: 'tok',
    socket: { send: vi.fn(), close: vi.fn(), readyState: 1 } as unknown as WebSocket,
    isReconnect: false, silent: false,
  })
  const send = (msg: Record<string, unknown>) => handleMessage({ sessionId: SID, ...msg }, ctx() as never)
  const msgs = () => store.getState().sessionStates[SID]!.messages

  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    clearDeltaBuffers()
    clearPermissionSplits()
    store = createMockStore({
      connectionPhase: 'connected',
      socket: null,
      sessions: [{ sessionId: SID, name: 'A', provider: 'claude-tui' }],
      activeSessionId: SID,
      sessionStates: { [SID]: { ...createEmptySessionState(), isIdle: true, streamingMessageId: null } },
      messages: [], terminalBuffer: '', terminalRawBuffer: '', customAgents: [], slashCommands: [],
      connectedClients: [], serverErrors: [], addServerError: () => undefined,
      appendTerminalData: () => undefined, serverProtocolVersion: null,
    } as unknown as Partial<ConnectionState>)
    setStore(store)
    setConnectionContext(ctx() as never)
  })

  afterEach(() => {
    stopHeartbeat()
    clearDeltaBuffers()
    clearPermissionSplits()
    resetReplayFlags()
    setConnectionContext(null)
    vi.useRealTimers()
  })

  it('stream part one, replay window, stream part two reads "part one part two"', () => {
    send({ type: 'stream_start', messageId: TURN })
    send({ type: 'stream_delta', messageId: TURN, delta: 'part one ' })
    vi.advanceTimersByTime(500)
    send({ type: 'history_replay_start', fullHistory: true })
    send({ type: 'history_replay_end' })
    send({ type: 'stream_delta', messageId: TURN, delta: 'part two' })
    vi.advanceTimersByTime(500)
    const rows = msgs().filter((m) => m.id === TURN)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.content).toBe('part one part two')
  })

  // #8965 -- in-progress content that `streamingMessageId` does not name.
  it('keeps the pre-permission text when a permission prompt split the stream', () => {
    send({ type: 'agent_busy' })
    send({ type: 'stream_start', messageId: TURN })
    send({ type: 'stream_delta', messageId: TURN, delta: 'before the prompt' })
    vi.advanceTimersByTime(500)
    send({ type: 'permission_request', requestId: 'perm-1', tool: 'Bash', input: { command: 'ls' } })
    // The split nulls the live stream id; the response is still open server-side.
    expect(store.getState().sessionStates[SID]!.streamingMessageId).toBeNull()
    send({ type: 'history_replay_start', fullHistory: true })
    send({ type: 'history_replay_end' })
    const rows = msgs().filter((m) => m.id === TURN)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.content).toBe('before the prompt')
  })

  it('keeps a response whose stream_end lands inside the replay window', () => {
    send({ type: 'stream_start', messageId: TURN })
    send({ type: 'stream_delta', messageId: TURN, delta: 'whole answer' })
    vi.advanceTimersByTime(500)
    send({ type: 'history_replay_start', fullHistory: true })
    send({ type: 'stream_end', messageId: TURN })
    send({ type: 'history_replay_end' })
    const rows = msgs().filter((m) => m.id === TURN)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.content).toBe('whole answer')
  })

  it('does not duplicate a response the replay already delivers', () => {
    send({ type: 'stream_start', messageId: TURN })
    send({ type: 'stream_delta', messageId: TURN, delta: 'whole answer' })
    vi.advanceTimersByTime(500)
    send({ type: 'history_replay_start', fullHistory: true })
    send({ type: 'message', messageType: 'response', messageId: TURN, content: 'whole answer', timestamp: 1, historySeq: 1 })
    send({ type: 'stream_end', messageId: TURN })
    send({ type: 'history_replay_end', latestSeq: 1 })
    expect(msgs().filter((m) => m.id === TURN)).toHaveLength(1)
  })

  it('keeps the in-flight response across a mid-turn reconnect whose history holds an old result + agent_idle', () => {
    send({ type: 'agent_busy' })
    send({ type: 'stream_start', messageId: TURN })
    send({ type: 'stream_delta', messageId: TURN, delta: 'before the prompt' })
    vi.advanceTimersByTime(500)
    send({ type: 'permission_request', requestId: 'perm-1', tool: 'Bash', input: { command: 'ls' } })
    send({ type: 'history_replay_start', fullHistory: true })
    send({ type: 'message', messageType: 'user_input', content: 'old question', timestamp: 1, historySeq: 1 })
    send({ type: 'message', messageType: 'response', messageId: 'hist-r', content: 'old reply', timestamp: 2, historySeq: 2 })
    send({ type: 'result', historySeq: 3 })
    send({ type: 'agent_idle' }) // the server follows every replayed result with one
    send({ type: 'history_replay_end', latestSeq: 3 })
    const rows = msgs().filter((m) => m.id === TURN)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.content).toBe('before the prompt')
  })

  it('a live turn that ends inside the window is kept once, and not again by the next swap', () => {
    send({ type: 'agent_busy' })
    send({ type: 'stream_start', messageId: TURN })
    send({ type: 'stream_delta', messageId: TURN, delta: 'whole answer' })
    vi.advanceTimersByTime(500)
    send({ type: 'history_replay_start', fullHistory: true })
    send({ type: 'stream_end', messageId: TURN })
    send({ type: 'agent_idle' })
    send({ type: 'history_replay_end' })
    expect(msgs().filter((m) => m.id === TURN)).toHaveLength(1)
    send({ type: 'history_replay_start', fullHistory: true })
    send({ type: 'history_replay_end' })
    expect(msgs().filter((m) => m.id === TURN)).toHaveLength(0)
  })

  it("does not resurrect turn A's dead stream mid turn B after an idle resync", () => {
    send({ type: 'agent_busy' })
    send({ type: 'stream_start', messageId: TURN })
    send({ type: 'stream_delta', messageId: TURN, delta: 'dead partial' })
    vi.advanceTimersByTime(500)
    send({ type: 'session_activity', isBusy: false })
    send({ type: 'agent_busy' })
    send({ type: 'stream_start', messageId: 'turn-b' })
    send({ type: 'history_replay_start', fullHistory: true })
    send({ type: 'history_replay_end' })
    expect(msgs().filter((m) => m.id === TURN)).toHaveLength(0)
    expect(msgs().filter((m) => m.id === 'turn-b')).toHaveLength(1)
  })

  it('keeps a running tool card when a queued message was sent mid-turn', () => {
    send({ type: 'message', messageType: 'user_input', messageId: 'u1', content: 'go', timestamp: 1 })
    send({ type: 'agent_busy' })
    send({ type: 'tool_start', messageId: 'tool-1', tool: 'Bash', toolUseId: 'tu-1', input: { command: 'sleep 9' } })
    const sid = store.getState().sessionStates[SID]!
    store.setState({
      sessionStates: {
        ...store.getState().sessionStates,
        [SID]: {
          ...sid,
          messages: [...sid.messages, { id: 'q1', type: 'user_input', content: 'next', timestamp: 3 }],
          queuedMessages: [{ clientMessageId: 'q1', text: 'next', queuedAt: 3, status: 'pending' }],
        },
      },
    } as never)
    send({ type: 'history_replay_start', fullHistory: true })
    send({ type: 'history_replay_end' })
    expect(msgs().filter((m) => m.type === 'tool_use').map((m) => m.id)).toEqual(['tool-1'])
  })

  it('does not resurrect a stream whose stream_end was missed once the session went idle', () => {
    send({ type: 'stream_start', messageId: TURN })
    send({ type: 'stream_delta', messageId: TURN, delta: 'partial, never persisted' })
    vi.advanceTimersByTime(500)
    send({ type: 'agent_idle' })
    // A NEXT turn is in flight, so the turnInFlight gate alone would let the stale
    // stream through; only the turn-end clear of the ledger keeps it out.
    send({ type: 'agent_busy' })
    send({ type: 'history_replay_start', fullHistory: true })
    send({ type: 'history_replay_end' })
    expect(msgs().filter((m) => m.id === TURN)).toHaveLength(0)
  })

  it('keeps a tool card that is still running', () => {
    send({ type: 'agent_busy' })
    send({ type: 'tool_start', messageId: 'tool-1', tool: 'Bash', toolUseId: 'tu-1', input: { command: 'sleep 9' } })
    send({ type: 'history_replay_start', fullHistory: true })
    send({ type: 'history_replay_end' })
    expect(msgs().filter((m) => m.type === 'tool_use').map((m) => m.id)).toEqual(['tool-1'])
  })
})
