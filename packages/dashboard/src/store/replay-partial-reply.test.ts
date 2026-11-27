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

  describe('a reply a tool call interrupted is laid out around its tool cards when the replay ends (#9024)', () => {
    const A = 'Alpha one. '
    const B = 'Bravo two. '
    const C = 'Charlie three. '
    const splits = [{ at: A.length, toolUseId: 't1' }, { at: (A + B).length, toolUseId: 't2' }]
    const entry = (content: string, sp: unknown, seq?: number) => ({
      type: 'message', messageType: 'response', messageId: 'm1', content, timestamp: 3, splits: sp,
      ...(seq === undefined ? {} : { historySeq: seq }),
    })
    const toolResult = (id: string, seq: number) => ({ type: 'tool_result', toolUseId: id, result: 'ok', historySeq: seq })
    const layout = () => msgs().map((m) => (m.type === 'response' ? `${m.id}:${m.content}` : m.type === 'tool_use' ? `tool:${m.toolUseId}` : m.type))
    // The wire order the SERVER produces for an open stream: the snapshot (no historySeq) is
    // spliced in at the seq its text began, i.e. BEFORE the tool rows that followed it.
    const openSnapshot = (text: string, sp: unknown) => entry(text, sp)
    const t1Split = [{ at: A.length, toolUseId: 't1' }]

    it('a reload of a finished turn: text, card, text, card, text, with exact ids', () => {
      send({ type: 'history_replay_start', fullHistory: true, latestSeq: 6 })
      send(user(1))
      send(toolStart('t1', 2)); send(toolResult('t1', 3))
      send(toolStart('t2', 4)); send(toolResult('t2', 5))
      send(entry(A + B + C, splits, 6))
      send({ type: 'history_replay_end', latestSeq: 6 })
      expect(layout()).toEqual(['user_input', `m1-seg-0:${A}`, 'tool:t1', `m1-seg-1:${B}`, 'tool:t2', `m1:${C}`])
      expect(msgs().some((m) => m.responseSplits !== undefined)).toBe(false)
    })

    it('B-2 full reload mid-turn, server order (snapshot BEFORE its tool rows): text above the card, the rest below', () => {
      send({ type: 'history_replay_start', fullHistory: true, latestSeq: 3 })
      send(user(1))
      send(openSnapshot(A + '42', t1Split))
      send(toolStart('t1', 2)); send(toolResult('t1', 3))
      send({ type: 'history_replay_end', latestSeq: 3 })
      expect(layout()).toEqual(['user_input', `m1-seg-0:${A}`, 'tool:t1', 'm1:42'])
    })

    it('Codex 2: a live delta after that reload extends the TAIL below the card', () => {
      send({ type: 'history_replay_start', fullHistory: true, latestSeq: 3 })
      send(user(1))
      send(openSnapshot(A + '42', t1Split))
      send(toolStart('t1', 2)); send(toolResult('t1', 3))
      send({ type: 'history_replay_end', latestSeq: 3 })
      send({ type: 'stream_delta', messageId: 'm1', delta: '.' }); flush()
      expect(layout()).toEqual(['user_input', `m1-seg-0:${A}`, 'tool:t1', 'm1:42.'])
    })

    it('B-2 delta replay mid-turn, server order: the same layout', () => {
      send({ type: 'history_replay_start', fullHistory: false, latestSeq: 3 })
      send(openSnapshot(A + '42', t1Split))
      send(toolStart('t1', 2)); send(toolResult('t1', 3))
      send({ type: 'history_replay_end', latestSeq: 3 })
      expect(layout()).toEqual([`m1-seg-0:${A}`, 'tool:t1', 'm1:42'])
    })

    it('a snapshot that ends exactly at the card (empty tail), then a live delta: the new text is shown once, below the card', () => {
      send({ type: 'history_replay_start', fullHistory: true, latestSeq: 3 })
      send(user(1))
      send(openSnapshot(A, t1Split))
      send(toolStart('t1', 2)); send(toolResult('t1', 3))
      send({ type: 'history_replay_end', latestSeq: 3 })
      expect(layout()).toEqual(['user_input', `m1-seg-0:${A}`, 'tool:t1'])
      send({ type: 'stream_delta', messageId: 'm1', delta: 'Bravo' }); flush()
      expect(count('Bravo')).toBe(1)
      expect(count('Alpha one.')).toBe(1)
      expect(msgs()[msgs().length - 1]!.type).toBe('response')
    })

    it('an open snapshot, then the closing entry on a cursor replay: held [seg-0, tool, m1] completes the tail once', () => {
      send({ type: 'history_replay_start', fullHistory: true, latestSeq: 3 })
      send(user(1))
      send(openSnapshot(A + '42', t1Split))
      send(toolStart('t1', 2)); send(toolResult('t1', 3))
      send({ type: 'history_replay_end', latestSeq: 3 })
      clearDeltaBuffers(); resetReplayReconcile()
      send({ type: 'history_replay_start', fullHistory: false, latestSeq: 4 })
      send(entry(A + '42.', t1Split, 4))
      send({ type: 'history_replay_end', latestSeq: 4 })
      expect(layout()).toEqual(['user_input', `m1-seg-0:${A}`, 'tool:t1', 'm1:42.'])
    })

    it('an open snapshot, then the closing entry on a cursor replay: held [seg-0, tool] (empty tail) gets the rest below the card, once', () => {
      send({ type: 'history_replay_start', fullHistory: true, latestSeq: 3 })
      send(user(1))
      send(openSnapshot(A, t1Split))
      send(toolStart('t1', 2)); send(toolResult('t1', 3))
      send({ type: 'history_replay_end', latestSeq: 3 })
      clearDeltaBuffers(); resetReplayReconcile()
      send({ type: 'history_replay_start', fullHistory: false, latestSeq: 4 })
      send(entry(A + 'Bravo.', t1Split, 4))
      send({ type: 'history_replay_end', latestSeq: 4 })
      expect(msgs().map((m) => m.type)).toEqual(['user_input', 'response', 'tool_use', 'response'])
      expect(msgs().filter((m) => m.type === 'response').map((m) => m.content)).toEqual([A, 'Bravo.'])
    })

    it('a client that watched the turn live and then reloads shows each text once, in order, and the live stream carries on', () => {
      send(user())
      send({ type: 'agent_busy' })
      send({ type: 'stream_start', messageId: 'm1' })
      send({ type: 'stream_delta', messageId: 'm1', delta: A }); flush()
      send({ type: 'tool_start', messageId: 't1', toolUseId: 't1', tool: 'Read', input: { file_path: '/a' } })
      send({ type: 'tool_result', toolUseId: 't1', result: 'ok' })
      vi.advanceTimersByTime(1000)
      send({ type: 'stream_delta', messageId: 'm1', delta: B }); flush()
      send({ type: 'history_replay_start', fullHistory: true, latestSeq: 3 })
      send(user(1))
      send(openSnapshot(A + B, t1Split))
      send(toolStart('t1', 2)); send(toolResult('t1', 3))
      send({ type: 'history_replay_end', latestSeq: 3 })
      expect(layout()).toEqual(['user_input', `m1-seg-0:${A}`, 'tool:t1', `m1:${B}`])
      send({ type: 'stream_delta', messageId: 'm1', delta: C }); flush()
      // the live remap to the old continuation bubble (gone with the swap) opens a new one:
      // as before this change, each text once and in order
      for (const word of ['Alpha one.', 'Bravo two.', 'Charlie three.']) expect(count(word)).toBe(1)
      expect(msgs().findIndex((m) => m.content.includes('Charlie'))).toBeGreaterThan(msgs().findIndex((m) => m.type === 'tool_use'))
    })

    it('a delta reconnect after the turn was watched live adds nothing', () => {
      send(user(1))
      send({ type: 'agent_busy' })
      send({ type: 'stream_start', messageId: 'm1' })
      send({ type: 'stream_delta', messageId: 'm1', delta: A }); flush()
      send({ type: 'tool_start', messageId: 't1', toolUseId: 't1', tool: 'Read', input: { file_path: '/a' } })
      send({ type: 'tool_result', toolUseId: 't1', result: 'ok' })
      vi.advanceTimersByTime(1000)
      send({ type: 'stream_delta', messageId: 'm1', delta: B }); flush()
      send({ type: 'stream_end', messageId: 'm1' })
      const before = layout().map((l) => l.replace(/-cont-\d+/, '-cont-#'))
      clearDeltaBuffers()
      resetReplayReconcile()
      send({ type: 'history_replay_start', fullHistory: false, latestSeq: 4 })
      send(toolStart('t1', 2)); send(toolResult('t1', 3))
      send(entry(A + B, t1Split, 4))
      send({ type: 'history_replay_end', latestSeq: 4 })
      expect(layout().map((l) => l.replace(/-cont-\d+/, '-cont-#'))).toEqual(before)
    })

    it('C2: a mid-sentence interruption replays as live drew it: ONE bubble m1 above the card', () => {
      const text = 'Let me check the file first.'
      send({ type: 'history_replay_start', fullHistory: true, latestSeq: 4 })
      send(user(1))
      send(toolStart('t1', 2)); send(toolResult('t1', 3))
      send(entry(text, [{ at: 'Let me check the'.length, toolUseId: 't1' }], 4))
      send({ type: 'history_replay_end', latestSeq: 4 })
      expect(layout()).toEqual(['user_input', `m1:${text}`, 'tool:t1'])
    })

    it('C4 / Codex 3: an earlier tool row that is not held (older than a delta replay window): exact layout, no repeat', () => {
      send({ type: 'history_replay_start', fullHistory: false, latestSeq: 7 })
      send(toolStart('t2', 5)); send(toolResult('t2', 6))
      send(entry(A + B + C, splits, 7))
      send({ type: 'history_replay_end', latestSeq: 7 })
      expect(layout()).toEqual([`m1-seg-1:${A + B}`, 'tool:t2', `m1:${C}`])
    })

    it('S-1: a live message that lands in the middle of a chunked replay stays after the replayed reply', () => {
      send({ type: 'history_replay_start', fullHistory: true, latestSeq: 6 })
      send(user(1))
      send(toolStart('t1', 2)); send(toolResult('t1', 3))
      send({ type: 'message', messageType: 'response', messageId: 'live-1', content: 'LIVE', timestamp: 9 })
      send(entry(A + C, t1Split, 4))
      send({ type: 'history_replay_end', latestSeq: 4 })
      const ids = layout()
      expect(ids.indexOf(`m1-seg-0:${A}`)).toBeLessThan(ids.indexOf('tool:t1'))
      expect(ids.indexOf(`m1:${C}`)).toBeGreaterThan(ids.indexOf('tool:t1'))
      expect(ids.indexOf(`m1:${C}`)).toBeLessThan(ids.findIndex((l) => l.startsWith('live-1')))
    })
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
