/**
 * #8518 — a thinking block that claude-tui reads from the transcript AFTER the
 * tool_start (or the answer) it was thought before is placed above it, live and
 * on a reload. The server says where (`thinkingPrecedes`); this proves the
 * dashboard's handler honours it through the shared store-core placement. See
 * app/src/__tests__/store/message-handler-late-thinking-order.test.ts for the
 * mobile twin.
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
import type { ConnectionState, ChatMessage } from './types'

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

describe('a late thinking block is placed by its ordering hint (#8518)', () => {
  let store: ReturnType<typeof createMockStore>
  const ctx = () => ({
    url: 'wss://t',
    token: 'tok',
    socket: { send: vi.fn(), close: vi.fn(), readyState: 1 } as unknown as WebSocket,
    isReconnect: false,
    silent: false,
  })
  const send = (msg: Record<string, unknown>) => handleMessage({ sessionId: SID, ...msg }, ctx() as never)
  const ids = () => store.getState().sessionStates[SID]!.messages.map((m) => m.id)
  const thinkingFrames = (precedes?: unknown) => {
    send({ type: 'stream_start', messageId: `${TURN}-thinking-0`, thinking: true, ...(precedes ? { thinkingPrecedes: precedes } : {}) })
    send({ type: 'stream_delta', messageId: `${TURN}-thinking-0`, delta: 'reasoning', thinking: true })
    send({ type: 'stream_end', messageId: `${TURN}-thinking-0`, thinking: true, thinkingDurationMs: 700 })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    clearDeltaBuffers()
    clearPermissionSplits()
    store = createMockStore({
      connectionPhase: 'connected',
      socket: null,
      sessions: [{ sessionId: SID, name: 'A', provider: 'claude-tui' }],
      activeSessionId: SID,
      sessionStates: { [SID]: { ...createEmptySessionState(), isIdle: true, streamingMessageId: null } },
      messages: [],
      terminalBuffer: '',
      terminalRawBuffer: '',
      customAgents: [],
      slashCommands: [],
      connectedClients: [],
      serverErrors: [],
      addServerError: () => undefined,
      appendTerminalData: () => undefined,
      serverProtocolVersion: null,
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
  })

  it('a block that names the tool it precedes lands directly above that tool row', () => {
    send({ type: 'stream_start', messageId: TURN })
    send({ type: 'tool_start', messageId: 'toolu_a', toolUseId: 'toolu_a', tool: 'Bash', input: { command: 'ls' } })
    thinkingFrames({ kind: 'tool_use', toolUseId: 'toolu_a' })

    expect(ids()).toEqual([TURN, `${TURN}-thinking-0`, 'toolu_a'])
    const bubble = store.getState().sessionStates[SID]!.messages.find((m) => m.type === 'thinking')!
    expect(bubble).toMatchObject({ content: 'reasoning', thinkingStreaming: false, thinkingDurationMs: 700 })
  })

  it('with two tool calls, each block goes above its own', () => {
    send({ type: 'tool_start', messageId: 'toolu_a', toolUseId: 'toolu_a', tool: 'Bash', input: {} })
    send({ type: 'tool_start', messageId: 'toolu_b', toolUseId: 'toolu_b', tool: 'Read', input: {} })
    send({ type: 'stream_start', messageId: `${TURN}-thinking-1`, thinking: true, thinkingPrecedes: { kind: 'tool_use', toolUseId: 'toolu_b' } })
    send({ type: 'stream_start', messageId: `${TURN}-thinking-0`, thinking: true, thinkingPrecedes: { kind: 'tool_use', toolUseId: 'toolu_a' } })
    expect(ids()).toEqual([`${TURN}-thinking-0`, 'toolu_a', `${TURN}-thinking-1`, 'toolu_b'])
  })

  it('a block that names the response it precedes lands above the answer that is already shown', () => {
    send({ type: 'stream_start', messageId: TURN })
    send({ type: 'stream_delta', messageId: TURN, delta: 'The answer is 42.' })
    send({ type: 'stream_end', messageId: TURN })
    thinkingFrames({ kind: 'response', messageId: TURN })
    expect(ids()).toEqual([`${TURN}-thinking-0`, TURN])
  })

  it('without a hint (an older server, or a block that arrived in order) it is appended as it always was', () => {
    send({ type: 'tool_start', messageId: 'toolu_a', toolUseId: 'toolu_a', tool: 'Bash', input: {} })
    thinkingFrames()
    expect(ids()).toEqual(['toolu_a', `${TURN}-thinking-0`])
  })

  it('a hint whose target is not there yet (the block beat its tool_start) is appended, and the row lands after it', () => {
    thinkingFrames({ kind: 'tool_use', toolUseId: 'toolu_a' })
    send({ type: 'tool_start', messageId: 'toolu_a', toolUseId: 'toolu_a', tool: 'Bash', input: {} })
    expect(ids()).toEqual([`${TURN}-thinking-0`, 'toolu_a'])
  })

  it('the delta and end of a placed block update the bubble where it was put, not at the end', () => {
    send({ type: 'tool_start', messageId: 'toolu_a', toolUseId: 'toolu_a', tool: 'Bash', input: {} })
    send({ type: 'stream_start', messageId: `${TURN}-thinking-0`, thinking: true, thinkingPrecedes: { kind: 'tool_use', toolUseId: 'toolu_a' } })
    send({ type: 'tool_result', toolUseId: 'toolu_a', result: 'ok' })
    send({ type: 'stream_delta', messageId: `${TURN}-thinking-0`, delta: 'x', thinking: true })
    expect(ids()).toEqual([`${TURN}-thinking-0`, 'toolu_a'])
  })

  describe('after a reload (history replay)', () => {
    const replayThinkingEntry = (extra: Record<string, unknown>) => ({
      type: 'message', messageType: 'response', kind: 'thinking', content: 'reasoning', messageId: `${TURN}-thinking-0`,
      thinkingDurationMs: 700, timestamp: 30, ...extra,
    })

    it('the recorded hint puts the rebuilt bubble above its tool row, as it was live', () => {
      send({ type: 'history_replay_start', fullHistory: true })
      send({ type: 'tool_start', messageId: 'toolu_a', toolUseId: 'toolu_a', tool: 'Bash', input: {}, timestamp: 20, historySeq: 1 })
      send(replayThinkingEntry({ historySeq: 2, thinkingPrecedes: { kind: 'tool_use', toolUseId: 'toolu_a' } }))
      send({ type: 'history_replay_end' })
      expect(ids()).toEqual([`${TURN}-thinking-0`, 'toolu_a'])
    })

    it('the recorded hint puts the rebuilt bubble above the answer', () => {
      send({ type: 'history_replay_start', fullHistory: true })
      send({ type: 'message', messageType: 'response', content: 'The answer is 42.', messageId: TURN, timestamp: 20, historySeq: 1 })
      send(replayThinkingEntry({ historySeq: 2, thinkingPrecedes: { kind: 'response', messageId: TURN } }))
      send({ type: 'history_replay_end' })
      expect(ids()).toEqual([`${TURN}-thinking-0`, TURN])
    })

    it('a connection cut mid-reasoning: the cursor replay fills the placed bubble in where it is, and adds nothing', () => {
      send({ type: 'tool_start', messageId: 'toolu_a', toolUseId: 'toolu_a', tool: 'Bash', input: {} })
      send({ type: 'stream_start', messageId: `${TURN}-thinking-0`, thinking: true, thinkingPrecedes: { kind: 'tool_use', toolUseId: 'toolu_a' } })
      send({ type: 'stream_delta', messageId: `${TURN}-thinking-0`, delta: 'reas', thinking: true })
      send({ type: 'history_replay_start', fullHistory: false })
      send({ type: 'tool_start', messageId: 'toolu_a', toolUseId: 'toolu_a', tool: 'Bash', input: {}, timestamp: 20, historySeq: 1 })
      send(replayThinkingEntry({ historySeq: 2, thinkingPrecedes: { kind: 'tool_use', toolUseId: 'toolu_a' } }))
      send({ type: 'history_replay_end' })
      expect(ids()).toEqual([`${TURN}-thinking-0`, 'toolu_a'])
      expect(store.getState().sessionStates[SID]!.messages[0]).toMatchObject({ content: 'reasoning', thinkingStreaming: false })
    })

    it('the flat fallback (a replayed entry for a session the store holds no state for) honours the hint too (#8532 N3)', () => {
      const toolRow = { id: 'toolu_a', type: 'tool_use', toolUseId: 'toolu_a', tool: 'Bash', content: '', timestamp: 20 }
      // The real store's addMessage (connection.ts): append, dropping the 'thinking' placeholder.
      const addMessage = (m: ChatMessage) => store.setState((st) => ({
        messages: [...st.messages.filter((x) => x.id !== 'thinking' || m.id === 'thinking'), m],
      }))
      store.setState({ messages: [toolRow], addMessage } as unknown as Partial<ConnectionState>)
      send({ type: 'history_replay_start', sessionId: 'sess-unknown', fullHistory: true })
      send({ ...replayThinkingEntry({ historySeq: 2, thinkingPrecedes: { kind: 'tool_use', toolUseId: 'toolu_a' } }), sessionId: 'sess-unknown' })
      send({ type: 'history_replay_end', sessionId: 'sess-unknown' })
      expect(store.getState().messages.map((m) => m.id)).toEqual([`${TURN}-thinking-0`, 'toolu_a'])
    })

    it('an entry without a hint is appended (history recorded before the hint existed)', () => {
      send({ type: 'history_replay_start', fullHistory: true })
      send({ type: 'tool_start', messageId: 'toolu_a', toolUseId: 'toolu_a', tool: 'Bash', input: {}, timestamp: 20, historySeq: 1 })
      send(replayThinkingEntry({ historySeq: 2 }))
      send({ type: 'history_replay_end' })
      expect(ids()).toEqual(['toolu_a', `${TURN}-thinking-0`])
    })
  })
})
