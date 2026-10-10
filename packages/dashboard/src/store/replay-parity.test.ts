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

describe('live vs replayed transcript -- dashboard (#6630)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
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
  // Only the scenarios that open with the reasoning stream: the cut then lands inside
  // it from the first frame. Every cut re-imports the whole connection store, and this
  // file already runs close to its worker's 4 GB heap (a scenario with a late-placed
  // bubble, #8518, added 13 more cuts and ran it out of memory). That bubble's partial-
  // delivery case is pinned in late-thinking-order.test.ts instead.
  //
  // The excluded scenarios are NAMED (#8532 N2): a position test (`live[0]?.thinking`)
  // would silently drop a future scenario whose reasoning is not first. Removing the
  // exclusion altogether is #8531.
  const hasThinkingEnd = (fx: (typeof REPLAY_PARITY_FIXTURES)[number]) =>
    fx.live.some((f) => f.type === 'stream_end' && f.thinking === true)
  const NOT_INTERRUPTED_BY_NAME: readonly string[] = [
    'tui-thinking-read-after-its-tool-row',
    'tui-thinking-read-after-the-answer',
  ]
  const interruptible = REPLAY_PARITY_FIXTURES.filter(
    (fx) => hasThinkingEnd(fx) && !NOT_INTERRUPTED_BY_NAME.includes(fx.name),
  )

  it('has scenarios to interrupt', () => {
    expect(interruptible.map((f) => f.name)).toEqual(expect.arrayContaining(['thinking-then-reply', 'thinking-without-text']))
  })

  it('the named exclusions are exactly the thinking scenarios that do not open with the reasoning', () => {
    const names = new Set(REPLAY_PARITY_FIXTURES.map((f) => f.name))
    // A name that no longer exists, or no longer carries a reasoning stream.
    for (const name of NOT_INTERRUPTED_BY_NAME) {
      expect(names.has(name), `excluded scenario "${name}" no longer exists`).toBe(true)
      const fx = REPLAY_PARITY_FIXTURES.find((f) => f.name === name)!
      expect(hasThinkingEnd(fx), `excluded scenario "${name}" has no reasoning stream to interrupt`).toBe(true)
    }
    // A scenario the cut loop would skip (or run) that the list does not say so.
    const opensWithReasoning = REPLAY_PARITY_FIXTURES.filter((fx) => hasThinkingEnd(fx) && fx.live[0]?.thinking === true)
    expect(
      interruptible.map((f) => f.name).sort(),
      'the interrupted scenarios must be exactly those that open with the reasoning stream: name the new exclusion in NOT_INTERRUPTED_BY_NAME',
    ).toEqual(opensWithReasoning.map((f) => f.name).sort())
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
