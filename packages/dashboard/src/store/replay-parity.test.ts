/**
 * #6630 -- live vs replayed transcript, through the REAL dashboard store.
 *
 * The shared fixtures (`@chroxy/store-core` REPLAY_PARITY_FIXTURES) hold, per
 * scenario, the frames the server sends live and the frames a full-rebuild replay
 * (session switch, reload) delivers for the SAME session events -- both produced
 * by the real server code (packages/server/tests/replay-parity-wire.test.js keeps
 * them honest). This feeds each set to the dashboard's real message handler and
 * compares the transcripts that result. The app runs the same fixtures through
 * its own handler (packages/app/__tests__/contract-replay-parity.test.ts).
 *
 * A scenario in REPLAY_PARITY_DIVERGENCES is a known, tracked gap and is pinned on
 * both sides; every other scenario must come out EQUAL.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  REPLAY_PARITY_FIXTURES,
  REPLAY_PARITY_DIVERGENCES,
  REPLAY_PARITY_SESSION_ID as SID,
  replayParityModel,
  type ReplayParityFrame,
} from '@chroxy/store-core'
import { createEmptySessionState } from './utils'

async function boot() {
  const { useConnectionStore } = await import('./connection')
  const { _testMessageHandler } = await import('./message-handler')
  useConnectionStore.setState({
    activeSessionId: SID,
    sessionStates: { [SID]: createEmptySessionState() },
    socket: null,
  })
  _testMessageHandler.setContext({
    url: 'ws://x', token: 't', isReconnect: false, silent: false,
    socket: { send: () => {}, readyState: 1 } as unknown as WebSocket,
  })
  const read = () => useConnectionStore.getState().sessionStates[SID]!.messages
  const send = (m: ReplayParityFrame) => _testMessageHandler.handle({ ...m })
  return { read, send, store: useConnectionStore }
}

/** The frames as a connected client receives them while the turn happens. */
async function runLive(frames: ReplayParityFrame[]) {
  const { read, send } = await boot()
  for (const frame of frames) send(frame)
  vi.runAllTimers() // stream deltas buffer behind a flush timer
  return replayParityModel(read())
}

/** The frames a session switch / reload delivers: a full rebuild of the transcript. */
async function runReplay(frames: ReplayParityFrame[]) {
  const { read, send } = await boot()
  const latestSeq = frames.reduce((max, f) => Math.max(max, typeof f.historySeq === 'number' ? f.historySeq : 0), 0)
  send({ type: 'history_replay_start', sessionId: SID, fullHistory: true, truncated: false, latestSeq })
  for (const frame of frames) send(frame)
  send({ type: 'history_replay_end', sessionId: SID, latestSeq })
  vi.runAllTimers()
  return replayParityModel(read())
}

/**
 * A client that watched the turn LIVE and then reconnects with a cursor: the
 * server replays the entries after the cursor (`fullHistory: false`), which are
 * all the entries of this turn, and the client must dedup them against the
 * messages it already holds -- no duplicate bubble, nothing lost.
 */
async function runLiveThenCursorReplay(live: ReplayParityFrame[], replay: ReplayParityFrame[]) {
  const { read, send } = await boot()
  for (const frame of live) send(frame)
  vi.runAllTimers()
  const latestSeq = replay.reduce((max, f) => Math.max(max, typeof f.historySeq === 'number' ? f.historySeq : 0), 0)
  send({ type: 'history_replay_start', sessionId: SID, fullHistory: false, truncated: false, latestSeq })
  for (const frame of replay) send(frame)
  send({ type: 'history_replay_end', sessionId: SID, latestSeq })
  vi.runAllTimers()
  return replayParityModel(read())
}

/**
 * Every case re-imports the connection store (`vi.resetModules()`), and importing it
 * registers a `visibilitychange` listener on the jsdom `document` -- which outlives
 * the module registry, so each listener pins its whole module graph (~48 MB of heap,
 * not collectable) for the rest of the file. 34 cases ran this file at ~3.4 GB RSS,
 * within reach of its worker's 4 GB heap (#8531). Record what the import adds to the
 * document and take it off after each case, so a case's store is collectable.
 *
 * A manual patch and not `vi.spyOn`: a spy keeps every call's arguments in
 * `mock.calls`, which is the same listener closures, so it re-creates the retention.
 */
function trackDocumentListeners() {
  const added: Array<[string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined]> = []
  const original = document.addEventListener
  document.addEventListener = function (this: Document, type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
    added.push([type, listener, options])
    return original.call(this, type, listener, options)
  } as typeof document.addEventListener
  return {
    types: () => added.map(([type]) => type),
    release() {
      document.addEventListener = original
      for (const [type, listener, options] of added.splice(0)) document.removeEventListener(type, listener, options)
    },
  }
}

describe('live vs replayed transcript -- dashboard (#6630)', () => {
  let listeners: ReturnType<typeof trackDocumentListeners>
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    listeners = trackDocumentListeners()
  })
  afterEach(() => {
    vi.useRealTimers()
    listeners.release()
  })

  // The release above is only worth anything while the import still registers on the
  // document where trackDocumentListeners can see it: if that moves (another target,
  // another API), the leak returns and nothing else here goes red.
  it('the connection store import registers its document listener where the harness can release it', async () => {
    await boot()
    expect(listeners.types()).toContain('visibilitychange')
  })

  it('has fixtures, and every pinned divergence names a scenario that exists', () => {
    expect(REPLAY_PARITY_FIXTURES.length).toBeGreaterThanOrEqual(8)
    const names = new Set(REPLAY_PARITY_FIXTURES.map((f) => f.name))
    for (const name of Object.keys(REPLAY_PARITY_DIVERGENCES)) {
      expect(names.has(name), `divergence "${name}" has no scenario`).toBe(true)
    }
  })

  for (const fx of REPLAY_PARITY_FIXTURES) {
    it(`${fx.name}: ${fx.description}`, async () => {
      const live = await runLive(fx.live)
      vi.resetModules()
      const replay = await runReplay(fx.replay)
      // A transcript that is empty on both sides is equal for the wrong reason.
      expect(live.length, `${fx.name}: live transcript is empty`).toBeGreaterThan(0)
      expect(replay.length, `${fx.name}: replayed transcript is empty`).toBeGreaterThan(0)

      const divergence = REPLAY_PARITY_DIVERGENCES[fx.name]
      if (!divergence) {
        expect(replay).toEqual(live)
        return
      }
      expect(live, `${fx.name}: live model (tracked by #${divergence.issue})`).toEqual(divergence.live)
      expect(replay, `${fx.name}: replay model (tracked by #${divergence.issue})`).toEqual(divergence.replay)
      // The gap must still be a gap: when it closes, delete the entry.
      expect(replay, `${fx.name}: #${divergence.issue} appears fixed -- delete its REPLAY_PARITY_DIVERGENCES entry`).not.toEqual(live)
    })
  }
  // The permission scenarios are excluded: the live card is a pending prompt the
  // replay resolves in place (store-core's reconcileHeldPermissionCard, covered by
  // permission-outcome-replay.test.ts), which is not the dedup this checks.
  const cursorReplayable = REPLAY_PARITY_FIXTURES.filter((fx) => !fx.name.startsWith('permission-'))

  for (const fx of cursorReplayable) {
    it(`${fx.name}: a cursor replay onto the live transcript adds nothing and loses nothing`, async () => {
      const liveOnly = await runLive(fx.live)
      vi.resetModules()
      const after = await runLiveThenCursorReplay(fx.live, fx.replay)
      expect(liveOnly.length, `${fx.name}: live transcript is empty`).toBeGreaterThan(0)
      expect(after).toEqual(liveOnly)
    })
  }
  // A connection that drops MID-reasoning: the client holds a partial thinking
  // bubble, the server finishes the thought, and the cursor replay carries the full
  // text and duration. The held copy must be filled in (the cursor moves past the
  // entry, so nothing would ever retry), not discarded as a duplicate.
  //
  // EVERY scenario with a reasoning stream (#8531): the cut loop used to skip the ones
  // whose bubble is placed late (#8518) because each cut leaked a whole store (see
  // trackDocumentListeners). A scenario whose reasoning does not open the turn still
  // gets its cuts -- they run up to the frame that closes the stream, wherever it is.
  const hasThinkingEnd = (fx: (typeof REPLAY_PARITY_FIXTURES)[number]) =>
    fx.live.some((f) => f.type === 'stream_end' && f.thinking === true)
  const interruptible = REPLAY_PARITY_FIXTURES.filter(hasThinkingEnd)

  it('has scenarios to interrupt, including the ones whose reasoning is not the first frame', () => {
    const names = interruptible.map((f) => f.name)
    expect(names).toEqual(expect.arrayContaining(['thinking-then-reply', 'thinking-without-text']))
    // The scenarios #8518 added, whose bubble is read after the row it precedes: they
    // are what the exclusion used to drop, so they must be in the loop.
    expect(names).toEqual(expect.arrayContaining(['tui-thinking-read-after-its-tool-row', 'tui-thinking-read-after-the-answer']))
    // A scenario with a reasoning frame but no closing one would be skipped by the
    // filter: the cut loop stops at the closing frame, so name it rather than lose it.
    const streamsReasoning = REPLAY_PARITY_FIXTURES.filter((fx) => fx.live.some((f) => f.thinking === true))
    expect(
      streamsReasoning.filter((fx) => !hasThinkingEnd(fx)).map((fx) => fx.name),
      'a scenario streams reasoning but never closes it with a thinking stream_end, so no cut is run on it',
    ).toEqual([])
  })

  for (const fx of interruptible) {
    const endIdx = fx.live.findIndex((f) => f.type === 'stream_end' && f.thinking === true)
    for (let cut = 1; cut <= endIdx; cut++) {
      it(`${fx.name}: delivery cut after live frame ${cut} of ${endIdx} is completed by the cursor replay`, async () => {
        const full = await runLive(fx.live)
        vi.resetModules()
        const after = await runLiveThenCursorReplay(fx.live.slice(0, cut), fx.replay)
        expect(after).toEqual(full)
      })
    }
  }
})
