/**
 * #9022 -- the server replays the text an OPEN response stream has produced so far
 * (a reply is recorded only at `stream_end`). These drive the frames the server
 * sends through the dashboard's REAL `handleMessage`, so the order and the
 * dedup assertions are about what the client does, not about a helper.
 *
 * Ordering note: the snapshot frame carries no `historySeq`, so on a FULL replay the
 * client's provenance sort puts it after the numbered entries -- the text renders
 * below the tool cards, the same place a completed reply already lands on main
 * (#9024). The server splice position matters for DELTA replays, which append in
 * arrival order.
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
import { resetReplayReconcile } from '@chroxy/store-core'
import { createEmptySessionState } from './utils'
import type { ConnectionState, ChatMessage } from './types'

const SID = 's1'

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

describe('a replayed partial reply, through the real handler (#9022)', () => {
  let store: ReturnType<typeof createMockStore>
  const ctx = () => ({
    url: 'wss://t', token: 'tok',
    socket: { send: vi.fn(), close: vi.fn(), readyState: 1 } as unknown as WebSocket,
    isReconnect: false, silent: false,
  })
  const send = (msg: Record<string, unknown>) => handleMessage({ sessionId: SID, ...msg }, ctx() as never)
  const msgs = (): ChatMessage[] => store.getState().sessionStates[SID]!.messages
  const flush = () => vi.advanceTimersByTime(500)
  const text = () => msgs().filter((m) => m.type === 'response').map((m) => m.content).join('')
  const count = (needle: string) => text().split(needle).length - 1
  const kinds = () => msgs().map((m) => (m.type === 'user_input' ? 'user' : m.type === 'response' ? 'reply' : m.type))

  function freshStore(messages: ChatMessage[] = []) {
    store = createMockStore({
      connectionPhase: 'connected', socket: null,
      sessions: [{ sessionId: SID, name: 'A', provider: 'byok' }], activeSessionId: SID,
      sessionStates: { [SID]: { ...createEmptySessionState(), isIdle: false, streamingMessageId: null, messages } },
      messages: [], terminalBuffer: '', terminalRawBuffer: '', customAgents: [], slashCommands: [],
      connectedClients: [], serverErrors: [], addServerError: () => undefined, appendTerminalData: () => undefined,
      serverProtocolVersion: null,
    } as unknown as Partial<ConnectionState>)
    setStore(store)
    setConnectionContext(ctx() as never)
  }
  const reset = () => {
    clearDeltaBuffers(); clearPermissionSplits(); resetReplayFlags(); resetReplayReconcile({ clearCursors: true })
  }
  const snapshot = (content: string) => ({ type: 'message', messageType: 'response', messageId: 'm1', content, timestamp: 3 })
  const user = (seq?: number) => ({
    type: 'message', messageType: 'user_input', messageId: 'u-1', content: 'do it', timestamp: 2,
    ...(seq === undefined ? {} : { historySeq: seq }),
  })
  const toolStart = (id: string, seq: number) => ({
    type: 'tool_start', messageId: id, toolUseId: id, tool: 'Read', input: { file_path: '/a' }, historySeq: seq,
  })

  beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); reset(); freshStore() })
  afterEach(() => { stopHeartbeat(); reset(); setConnectionContext(null); vi.useRealTimers() })

  it('a reload (nothing held) restores the streamed text', () => {
    send({ type: 'history_replay_start', fullHistory: true, latestSeq: 2 })
    send(user(1))
    send(snapshot('STREAM-LINE 1\nSTREAM-LINE 2\n'))
    send(toolStart('toolu_1', 2))
    send({ type: 'history_replay_end', latestSeq: 2 })
    expect(count('STREAM-LINE 1')).toBe(1)
    expect(count('STREAM-LINE 2')).toBe(1)
    expect(msgs().filter((m) => m.type === 'tool_use')).toHaveLength(1)
  })

  it('a reload with the transcript kept in storage shows the text once', () => {
    freshStore([
      { id: 'u-1', type: 'user_input', content: 'do it', timestamp: 2 },
      { id: 'm1', type: 'response', content: 'STREAM-LINE 1\nSTREAM-LINE 2\n', timestamp: 3 },
    ] as ChatMessage[])
    send({ type: 'history_replay_start', fullHistory: true, latestSeq: 2 })
    send(user(1))
    send(snapshot('STREAM-LINE 1\nSTREAM-LINE 2\n'))
    send(toolStart('toolu_1', 2))
    send({ type: 'history_replay_end', latestSeq: 2 })
    expect(count('STREAM-LINE 1')).toBe(1)
    expect(count('STREAM-LINE 2')).toBe(1)
  })

  it('K: text-tool-text-tool-text on ONE stream, then a full swap, does not duplicate (chained splits)', () => {
    send(user())
    send({ type: 'agent_busy' })
    send({ type: 'stream_start', messageId: 'm1' })
    send({ type: 'stream_delta', messageId: 'm1', delta: 'Alpha one. ' }); flush()
    send({ type: 'tool_start', messageId: 't1', toolUseId: 't1', tool: 'Read', input: { file_path: '/a' } })
    send({ type: 'tool_result', toolUseId: 't1', result: 'ok' })
    vi.advanceTimersByTime(1000)
    send({ type: 'stream_delta', messageId: 'm1', delta: 'Bravo two. ' }); flush()
    send({ type: 'tool_start', messageId: 't2', toolUseId: 't2', tool: 'Read', input: { file_path: '/b' } })
    send({ type: 'tool_result', toolUseId: 't2', result: 'ok' })
    vi.advanceTimersByTime(1000)
    send({ type: 'stream_delta', messageId: 'm1', delta: 'Charlie three. ' }); flush()

    send({ type: 'history_replay_start', fullHistory: true, latestSeq: 5 })
    send(user(1))
    send(snapshot('Alpha one. Bravo two. Charlie three. '))
    send({ ...toolStart('t1', 2) })
    send({ type: 'tool_result', toolUseId: 't1', result: 'ok', historySeq: 3 })
    send(toolStart('t2', 4))
    send({ type: 'tool_result', toolUseId: 't2', result: 'ok', historySeq: 5 })
    send({ type: 'history_replay_end', latestSeq: 5 })
    for (const word of ['Alpha one.', 'Bravo two.', 'Charlie three.']) expect(count(word)).toBe(1)

    send({ type: 'stream_delta', messageId: 'm1', delta: 'Delta four. ' }); flush()
    for (const word of ['Alpha one.', 'Bravo two.', 'Charlie three.', 'Delta four.']) expect(count(word)).toBe(1)
  })

  it('J: a delta reconnect mid-turn shows the reply AFTER the prompt it answers (claude-tui order)', () => {
    // History: u-0 (1), m0 (2), result (3). The turn then opened its stream BEFORE the
    // input was accepted; the server stamps the reply at its first text, after u-1 (4).
    send({ type: 'history_replay_start', fullHistory: true, latestSeq: 3 })
    send({ type: 'message', messageType: 'user_input', messageId: 'u-0', content: 'first', timestamp: 1, historySeq: 1 })
    send({ type: 'message', messageType: 'response', messageId: 'm0', content: 'OLD ANSWER', timestamp: 1, historySeq: 2 })
    send({ type: 'history_replay_end', latestSeq: 3 })
    send({ type: 'history_replay_start', fullHistory: false, latestSeq: 5 })
    send(user(4))
    send(snapshot('STREAM-LINE 1\n'))
    send(toolStart('toolu_1', 5))
    send({ type: 'history_replay_end', latestSeq: 5 })
    expect(kinds()).toEqual(['user', 'reply', 'user', 'reply', 'tool_use'])
    expect(msgs()[2]!.content).toBe('do it')
    expect(msgs()[3]!.content).toBe('STREAM-LINE 1\n')
  })

  describe('delta replay with the snapshot sent regardless of the cursor (S3)', () => {
    function heldStream(...deltas: string[]) {
      send({ ...user(4) })
      send({ type: 'agent_busy' })
      send({ type: 'stream_start', messageId: 'm1' })
      for (const d of deltas) { send({ type: 'stream_delta', messageId: 'm1', delta: d }); flush() }
      // An ordinary reconnect: the socket dropped, module state survives.
      clearDeltaBuffers()
      resetReplayReconcile()
    }
    const deltaReplay = (content: string) => {
      send({ type: 'history_replay_start', fullHistory: false, latestSeq: 5 })
      send(snapshot(content))
      send(toolStart('toolu_1', 5))
      send({ type: 'history_replay_end', latestSeq: 5 })
    }

    it('refills a delta the client missed, once', () => {
      heldStream('STREAM-LINE 1\n')
      deltaReplay('STREAM-LINE 1\nSTREAM-LINE 2\n')
      expect(count('STREAM-LINE 1')).toBe(1)
      expect(count('STREAM-LINE 2')).toBe(1)
      send({ type: 'stream_delta', messageId: 'm1', delta: 'STREAM-LINE 3\n' }); flush()
      expect(count('STREAM-LINE 1')).toBe(1)
      expect(count('STREAM-LINE 3')).toBe(1)
    })

    it('S-B: the live stream stays live (streamingMessageId kept) across the reconnect', () => {
      heldStream('STREAM-LINE 1\n')
      expect(store.getState().sessionStates[SID]!.streamingMessageId).toBe('m1')
      deltaReplay('STREAM-LINE 1\nSTREAM-LINE 2\n')
      expect(store.getState().sessionStates[SID]!.streamingMessageId).toBe('m1')
    })

    it('does not duplicate a reply the client already holds whole', () => {
      heldStream('STREAM-LINE 1\n', 'STREAM-LINE 2\n')
      deltaReplay('STREAM-LINE 1\nSTREAM-LINE 2\n')
      expect(count('STREAM-LINE 1')).toBe(1)
      expect(count('STREAM-LINE 2')).toBe(1)
    })

    it('does not clobber a client copy that is ahead of the snapshot', () => {
      heldStream('STREAM-LINE 1\n', 'STREAM-LINE 2\n', 'STREAM-LINE 3\n')
      deltaReplay('STREAM-LINE 1\nSTREAM-LINE 2\n')
      expect(count('STREAM-LINE 1')).toBe(1)
      expect(count('STREAM-LINE 3')).toBe(1)
    })

    it('does not duplicate when the client laid the stream out as split bubbles', () => {
      send(user(4))
      send({ type: 'agent_busy' })
      send({ type: 'stream_start', messageId: 'm1' })
      send({ type: 'stream_delta', messageId: 'm1', delta: 'Alpha one. ' }); flush()
      send({ type: 'tool_start', messageId: 't1', toolUseId: 't1', tool: 'Read', input: { file_path: '/a' } })
      send({ type: 'tool_result', toolUseId: 't1', result: 'ok' })
      vi.advanceTimersByTime(1000)
      send({ type: 'stream_delta', messageId: 'm1', delta: 'Bravo two. ' }); flush()
      clearDeltaBuffers()
      resetReplayReconcile()
      deltaReplay('Alpha one. Bravo two. Charlie three. ')
      for (const word of ['Alpha one.', 'Bravo two.', 'Charlie three.']) expect(count(word)).toBe(1)
    })
  })
})
