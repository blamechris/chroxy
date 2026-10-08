/**
 * #8444 -- a connection that drops MID-REPLY, through the REAL dashboard store.
 *
 * The client holds the start of a response (one bubble, or several once a tool has
 * split the turn), the server finishes the turn and records ONE `response` entry
 * under the stream id, and on reconnect a cursor replay delivers that entry. Dedup by
 * id used to drop it as a duplicate -- the cursor moves past the entry, so nothing
 * retried and the rest of the reply was gone until a full rebuild. The reasoning twin
 * of this is in replay-parity.test.ts (#8443); the app has the same cases in
 * packages/app/__tests__/contract-replay-parity.test.ts.
 *
 * A separate file from replay-parity.test.ts on purpose: that file reloads the whole
 * connection store for every case, and adding a case per frame of every scenario to
 * it exhausts the worker's heap. This one loads the store once and resets the
 * handler's module state between runs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  REPLAY_PARITY_FIXTURES,
  CURSOR_REPLAY_SCENARIOS,
  REPLAY_PARITY_SESSION_ID as SID,
  replayParityModel,
  type ReplayParityFrame,
} from '@chroxy/store-core'
import { useConnectionStore } from './connection'
import {
  _testMessageHandler,
  clearDeltaBuffers,
  clearPermissionSplits,
  resetReplayFlags,
} from './message-handler'
import { createEmptySessionState } from './utils'

function boot() {
  clearDeltaBuffers()
  clearPermissionSplits()
  resetReplayFlags()
  useConnectionStore.setState({
    activeSessionId: SID,
    sessionStates: { [SID]: createEmptySessionState() },
    socket: null,
  })
  _testMessageHandler.setContext({
    url: 'ws://x', token: 't', isReconnect: false, silent: false,
    socket: { send: () => {}, readyState: 1 } as unknown as WebSocket,
  })
  const session = () => useConnectionStore.getState().sessionStates[SID]!
  const send = (m: ReplayParityFrame) => _testMessageHandler.handle({ ...m })
  return { session, send }
}

/** The transcript of a client that stayed connected for the whole turn. */
function runConnected(frames: ReplayParityFrame[]) {
  const { session, send } = boot()
  for (const frame of frames) send(frame)
  vi.runAllTimers() // stream deltas buffer behind a flush timer
  return replayParityModel(session().messages)
}

/**
 * A client whose delivery stopped after `live` and that reconnects with a cursor: the
 * server replays the entries recorded since (`fullHistory: false`).
 */
function runCutThenCursorReplay(live: ReplayParityFrame[], replay: ReplayParityFrame[]) {
  const { session, send } = boot()
  for (const frame of live) send(frame)
  vi.runAllTimers()
  const heldStreaming = session().streamingMessageId
  const latestSeq = replay.reduce((max, f) => Math.max(max, typeof f.historySeq === 'number' ? f.historySeq : 0), 0)
  send({ type: 'history_replay_start', sessionId: SID, fullHistory: false, truncated: false, latestSeq })
  for (const frame of replay) send(frame)
  send({ type: 'history_replay_end', sessionId: SID, latestSeq })
  vi.runAllTimers()
  const { messages, streamingMessageId } = session()
  return { model: replayParityModel(messages), messages, heldStreaming, streamingMessageId }
}

const isResponseEnd = (f: ReplayParityFrame) => f.type === 'stream_end' && f.thinking !== true
const replyText = (model: ReturnType<typeof replayParityModel>) =>
  model.filter((r) => r.type === 'response').map((r) => r.content).join('')

describe('a connection cut mid-reply is completed by the cursor replay -- dashboard (#8444)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    clearDeltaBuffers()
    vi.useRealTimers()
  })

  // The permission scenarios are excluded: the live card is a pending prompt the
  // replay resolves in place, which is not what this checks.
  const scenarios: Array<{ name: string; live: ReplayParityFrame[]; replay: ReplayParityFrame[] }> = [
    ...REPLAY_PARITY_FIXTURES.filter((fx) => !fx.name.startsWith('permission-')),
    ...CURSOR_REPLAY_SCENARIOS,
  ].filter((fx) => fx.live.some(isResponseEnd))

  it('has reply scenarios to interrupt', () => {
    expect(scenarios.map((f) => f.name)).toEqual(
      expect.arrayContaining(['plain-reply', 'text-around-a-tool', 'tools-then-summary-tui', 'long-reply', 'two-tool-rounds']),
    )
  })

  // Cutting after every frame up to the reply's stream_end covers every point inside
  // it: before any text, after each stream_delta, and around each tool.
  //
  // Wherever the cut falls the whole reply must show exactly once and no bubble id may
  // repeat. The transcript must also equal the one a connected client has, except for
  // a reply a tool splits in two when the client had not yet seen all the tools: the
  // history keeps one entry per stream and no boundary inside it (#8438), so the replay
  // cannot say where those tools fell in the text. Tool cards are compared in full,
  // input included: a card held from its tool_start without the tool_result that
  // carries the input is completed by the replayed start (#8455).
  for (const fx of scenarios) {
    const endIdx = fx.live.findIndex(isResponseEnd)
    for (let cut = 1; cut <= endIdx; cut++) {
      it(`${fx.name}: delivery cut after live frame ${cut} of ${endIdx} ends with the transcript a connected client has`, () => {
        const full = runConnected(fx.live)
        const atCut = runConnected(fx.live.slice(0, cut))
        const { model, messages } = runCutThenCursorReplay(fx.live.slice(0, cut), fx.replay)
        expect(replyText(model)).toBe(replyText(full))
        expect(new Set(messages.map((m) => m.id)).size, 'a bubble id appears twice').toBe(messages.length)
        const tools = (rows: typeof full) => rows.filter((r) => r.type === 'tool_use').length
        const splitByATool = full.filter((r) => r.type === 'response').length > 1
        if (!splitByATool || tools(atCut) === tools(full)) expect(model).toEqual(full)
      })
    }
  }

  it('a reply completed by the cursor replay no longer reads as streaming', () => {
    const sc = CURSOR_REPLAY_SCENARIOS.find((s) => s.name === 'long-reply')!
    const cut = sc.live.findIndex((f) => f.type === 'stream_delta') + 2
    // Only the reply entry replays: the frames after it (result, idle) settle the
    // session on their own and would hide a marker the completion left behind.
    const out = runCutThenCursorReplay(sc.live.slice(0, cut), sc.replay.filter((f) => f.type === 'message'))
    expect(out.heldStreaming, 'the cut must leave the reply streaming').toBe('m1')
    expect(replyText(out.model)).toBe('The build passed on every platform, so it can ship.')
    expect(out.streamingMessageId).toBeNull()
  })
})
