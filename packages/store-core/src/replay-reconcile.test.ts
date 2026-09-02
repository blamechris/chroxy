import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  resetReplayReconcile,
  recordHistorySeq,
  getHistoryCursors,
  getHistoryCursor,
  reconcileReplayStart,
  reconcileReplayEnd,
  isRebuildInProgress,
  replayDedupCache,
  noteLivePromptDuringReplay,
  wasPromptLiveDuringReplay,
  sweepUnansweredPromptsAtReplayEnd,
  REPLAY_RESOLVED_PLACEHOLDER,
  getReplayWindowDepth,
  getLiveReplayLedgerSessionIds,
  dropReplaySessionState,
  MAX_LIVE_REPLAY_LEDGERS,
  beginReplayFrame,
  endReplayFrame,
  noteReplayMessagesUpdate,
  getReplayAppendProvenance,
  MAX_REPLAY_APPEND_PROVENANCE,
} from './replay-reconcile'

type Msg = { id: string }

/**
 * N placeholder on-screen messages, for a start whose prefix IDS are never
 * consulted — a delta that opens no baseline, or a window torn down before any
 * swap. Anywhere the prefix is actually cut, the test passes the REAL array, so
 * the walk in `resolveBaselineIndex` runs against the ids the swap will see
 * (#7524).
 */
const prefix = (n: number): Msg[] => Array.from({ length: n }, (_, i) => ({ id: `p-${i + 1}` }))

/**
 * ONE dispatched wire frame, driven exactly as both clients drive it since
 * #7519: open the provenance scope with the RAW frame, let the frame mutate the
 * session's `messages`, report that mutation through the observation hook their
 * `updateSession` now carries, and close the scope in a `finally`.
 *
 * `seq` is the frame's `historySeq` and is the whole discriminator — a number
 * for an entry the REPLAY delivered (`sendHistoryEntry` stamps every one),
 * absent for a live broadcast. Passing the raw frame rather than a boolean is
 * the point: the clients pass the frame too, so a test cannot classify an
 * append in a way the wire could not.
 */
const frame = (
  sessionId: string,
  messages: Msg[],
  seq: number | null,
  mutate: (m: Msg[]) => void,
): void => {
  beginReplayFrame(seq === null ? { type: 'message' } : { type: 'message', historySeq: seq })
  try {
    const before = messages.slice()
    mutate(messages)
    noteReplayMessagesUpdate(sessionId, before, messages)
  } finally {
    endReplayFrame()
  }
}

/** The replay re-delivering one history entry through the dedup gate. */
const replayed = (sessionId: string, messages: Msg[], id: string, seq: number): void =>
  frame(sessionId, messages, seq, (m) => {
    const cache = replayDedupCache(sessionId, m) as Msg[]
    if (!cache.some((x) => x.id === id)) m.push({ id })
  })

/** A live broadcast appending one entry while the window is open. */
const arrivedLive = (sessionId: string, messages: Msg[], id: string): void =>
  frame(sessionId, messages, null, (m) => m.push({ id }))

const idsOf = (messages: unknown): (string | undefined)[] | null =>
  (messages as Msg[] | null)?.map((m) => m.id) ?? null

beforeEach(() => {
  resetReplayReconcile({ clearCursors: true })
})

describe('history cursor tracking (#5555.3)', () => {
  it('advances the per-session cursor to the highest seq seen', () => {
    recordHistorySeq('s1', 1)
    recordHistorySeq('s1', 5)
    recordHistorySeq('s1', 3) // out of order — must NOT regress
    expect(getHistoryCursor('s1')).toBe(5)
  })

  it('keeps cursors per-session', () => {
    recordHistorySeq('s1', 4)
    recordHistorySeq('s2', 9)
    expect(getHistoryCursors()).toEqual({ s1: 4, s2: 9 })
  })

  it('ignores non-finite / negative / non-number seqs', () => {
    recordHistorySeq('s1', NaN)
    recordHistorySeq('s1', -1)
    recordHistorySeq('s1', '7' as unknown)
    expect(getHistoryCursor('s1')).toBeUndefined()
  })

  it('getHistoryCursors returns {} when empty (omit the auth field)', () => {
    expect(getHistoryCursors()).toEqual({})
  })

  // #5555.3 review thread: the server honours at most MAX_HISTORY_CURSORS (64)
  // keys from a single auth. The client must cap+evict LRU so it never sends a
  // cursor the server would drop, and — critically — never evicts the active
  // (most-recently-updated) session's cursor.
  it('caps the cursor map at 64, evicting the least-recently-updated keys', () => {
    for (let i = 0; i < 100; i++) recordHistorySeq(`s${i}`, i + 1)
    const cursors = getHistoryCursors()
    expect(Object.keys(cursors).length).toBe(64)
    // The 36 oldest (s0..s35) were evicted; the 64 newest survive.
    expect(cursors['s0']).toBeUndefined()
    expect(cursors['s35']).toBeUndefined()
    expect(cursors['s36']).toBe(37)
    expect(cursors['s99']).toBe(100)
  })

  it('touching an old session refreshes its recency so it is not evicted', () => {
    for (let i = 0; i < 64; i++) recordHistorySeq(`s${i}`, 1)
    // s0 is currently the oldest. Advance its cursor → moves it to the tail.
    recordHistorySeq('s0', 2)
    // Add one more new session → eviction fires; s1 (now oldest) goes, not s0.
    recordHistorySeq('s64', 1)
    const cursors = getHistoryCursors()
    expect(Object.keys(cursors).length).toBe(64)
    expect(cursors['s0']).toBe(2) // refreshed, retained
    expect(cursors['s1']).toBeUndefined() // evicted as the new oldest
    expect(cursors['s64']).toBe(1)
  })

  it('resetReplayReconcile retains cursors unless clearCursors', () => {
    recordHistorySeq('s1', 3)
    resetReplayReconcile() // baseline only
    expect(getHistoryCursor('s1')).toBe(3)
    resetReplayReconcile({ clearCursors: true })
    expect(getHistoryCursor('s1')).toBeUndefined()
  })
})

describe('delta replay — append-only, no rebuild (#5555.4)', () => {
  it('reconcileReplayStart(fullHistory=false) does NOT start a rebuild', () => {
    const { rebuildInProgress } = reconcileReplayStart('s1', false, prefix(3))
    expect(rebuildInProgress).toBe(false)
    expect(isRebuildInProgress('s1')).toBe(false)
  })

  it('reconcileReplayEnd returns null swap for a delta replay (messages untouched)', () => {
    reconcileReplayStart('s1', false, prefix(3))
    const { swappedMessages } = reconcileReplayEnd('s1', [{ id: 'a' }])
    expect(swappedMessages).toBeNull()
  })

  it('start frame latestSeq does NOT advance the cursor (mid-replay drop safety)', () => {
    // The cursor must only finalise once the slice is fully delivered (at end),
    // so a socket drop mid-replay can't claim un-applied entries.
    reconcileReplayStart('s1', false, [], 12)
    expect(getHistoryCursor('s1')).toBeUndefined()
  })

  it('END frame latestSeq advances the cursor even with no entries (already current)', () => {
    reconcileReplayStart('s1', false, [], 12)
    reconcileReplayEnd('s1', [], 12)
    expect(getHistoryCursor('s1')).toBe(12)
  })

  it('delta replay dedups against the WHOLE message array', () => {
    reconcileReplayStart('s1', false, prefix(2))
    const msgs: Msg[] = [{ id: 'a' }, { id: 'b' }]
    expect(replayDedupCache('s1', msgs)).toEqual(msgs)
  })
})

describe('full rebuild — deferred atomic swap, no blank flash (#5555.4)', () => {
  it('keeps a rebuild in progress and does NOT wipe (caller leaves messages visible)', () => {
    const { rebuildInProgress } = reconcileReplayStart('s1', true, prefix(3))
    expect(rebuildInProgress).toBe(true)
    expect(isRebuildInProgress('s1')).toBe(true)
  })

  it('dedup cache is scoped to the appended tail so the discarded prefix cannot suppress a replayed entry', () => {
    // 3 pre-existing messages; replay starts → baseline 3. The tail (entries
    // appended during replay) is what we dedup against, NOT the prefix.
    reconcileReplayStart('s1', true, [{ id: 'old-1' }, { id: 'old-2' }, { id: 'old-3' }])
    const msgs: Msg[] = [
      { id: 'old-1' }, { id: 'old-2' }, { id: 'old-3' }, // prefix (discarded)
      { id: 'new-1' }, // replayed so far
    ]
    expect(replayDedupCache('s1', msgs)).toEqual([{ id: 'new-1' }])
  })

  it('end swaps messages down to exactly the replayed tail in one update', () => {
    reconcileReplayStart('s1', true, [{ id: 'old-1' }, { id: 'old-2' }])
    // prefix [old-1, old-2] stayed visible; replay appended [r-1, r-2, r-3]
    const finalArray: Msg[] = [
      { id: 'old-1' }, { id: 'old-2' },
      { id: 'r-1' }, { id: 'r-2' }, { id: 'r-3' },
    ]
    const { swappedMessages } = reconcileReplayEnd('s1', finalArray)
    expect(swappedMessages).toEqual([{ id: 'r-1' }, { id: 'r-2' }, { id: 'r-3' }])
    // rebuild cleared
    expect(isRebuildInProgress('s1')).toBe(false)
  })

  it('empty replay (baseline at end) swaps to [] — server trimmed history to nothing', () => {
    reconcileReplayStart('s1', true, [{ id: 'old-1' }, { id: 'old-2' }])
    const { swappedMessages } = reconcileReplayEnd('s1', [{ id: 'old-1' }, { id: 'old-2' }])
    expect(swappedMessages).toEqual([])
  })

  it('messages are never empty mid-replay (no blank flash invariant)', () => {
    // The prefix is preserved in the live array the WHOLE time; only the final
    // reconcileReplayEnd swap changes identity. We assert that dedupCache always
    // exposes a non-destructive view and that no API zeroes the array mid-flight.
    const live: Msg[] = [{ id: 'old-1' }, { id: 'old-2' }, { id: 'old-3' }]
    reconcileReplayStart('s1', true, live)
    // simulate appending replayed entries
    live.push({ id: 'r-1' })
    expect(live.length).toBe(4) // never dropped below the prefix
    live.push({ id: 'r-2' })
    const { swappedMessages } = reconcileReplayEnd('s1', live)
    expect(swappedMessages).toEqual([{ id: 'r-1' }, { id: 'r-2' }])
  })
})

describe('replay × delta-flusher race ordering (#5588)', () => {
  it('a forced flush landing DURING a full rebuild survives the swap in array order', () => {
    reconcileReplayStart('s1', true, [{ id: 'old' }])
    // prefix [old]; replay appends r-1, then a forced flush appends a streamed
    // response f-1, then replay appends r-2.
    const live: Msg[] = [
      { id: 'old' },
      { id: 'r-1' },
      { id: 'f-1' }, // racing flush
      { id: 'r-2' },
    ]
    const { swappedMessages } = reconcileReplayEnd('s1', live)
    // Tail preserved in exact array order — flush neither dropped nor reordered.
    expect(swappedMessages).toEqual([{ id: 'r-1' }, { id: 'f-1' }, { id: 'r-2' }])
  })

  it('with provenance, the flush sorts AFTER the replayed set — chronological, not array order', () => {
    // #7519 changed this shape deliberately, and the module's ordering note says
    // so. Array order put the racing flush BETWEEN two replayed entries because
    // that is where it landed on the wire; it is a live streamed response, so it
    // is newer than every history entry the rebuild is replaying, and it belongs
    // last. Nothing is duplicated and nothing is dropped — the same two
    // guarantees the array-order version above pins, now with the order corrected.
    const live: Msg[] = [{ id: 'old' }]
    reconcileReplayStart('s1', true, live)
    replayed('s1', live, 'r-1', 1)
    arrivedLive('s1', live, 'f-1') // the forced delta flush
    replayed('s1', live, 'r-2', 2)

    const swapped = reconcileReplayEnd('s1', live).swappedMessages as Msg[]
    expect(swapped.map((m) => m.id)).toEqual(['r-1', 'r-2', 'f-1'])
    expect(swapped).toHaveLength(3)
  })

  it('a flush landing AFTER end appends to the already-swapped set with no duplication', () => {
    reconcileReplayStart('s1', true, [{ id: 'old' }])
    const live: Msg[] = [{ id: 'old' }, { id: 'r-1' }]
    const { swappedMessages } = reconcileReplayEnd('s1', live)
    expect(swappedMessages).toEqual([{ id: 'r-1' }])
    // Post-end, no rebuild is active, so a later flush just appends normally;
    // reconcileReplayEnd for a non-rebuild session returns null (no second swap).
    expect(reconcileReplayEnd('s1', [{ id: 'r-1' }, { id: 'f-1' }]).swappedMessages).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// #7420 — the history_replay_end unanswered-prompt sweep
// ---------------------------------------------------------------------------
//
// The sweep's premise is "anything in history is already resolved". Two things
// build a `type: 'prompt'` ChatMessage and history splits them:
//
//   - `permission_request` is server-transient (never in the ring buffer) and
//     is the only producer that sets `requestId` — #7410/#7419 excluded it.
//   - `user_question` IS in the ring buffer AND is broadcast live, and its
//     ChatMessage sets neither `requestId` nor `expiresAt` — so the two are
//     byte-identical here and only the ARRIVING FRAME could tell them apart
//     (`historySeq` is stamped by replayHistory, never by a live broadcast).
//
// `noteLivePromptDuringReplay` is where that observation is kept.
type Prompt = { id: string; type: string; answered?: string; requestId?: string }

const prompt = (id: string, extra: Partial<Prompt> = {}): Prompt => ({
  id,
  type: 'prompt',
  ...extra,
})

describe('replay-end unanswered-prompt sweep (#7380 / #7410 / #7420)', () => {
  it('stamps an unanswered, requestId-less prompt', () => {
    const out = sweepUnansweredPromptsAtReplayEnd('s1', [prompt('q1')])
    expect(out).toEqual([{ id: 'q1', type: 'prompt', answered: REPLAY_RESOLVED_PLACEHOLDER }])
    expect(REPLAY_RESOLVED_PLACEHOLDER).toBe('(resolved)')
  })

  it('returns null when nothing is stampable (caller emits a no-op patch)', () => {
    expect(sweepUnansweredPromptsAtReplayEnd('s1', [])).toBeNull()
    expect(sweepUnansweredPromptsAtReplayEnd('s1', [{ id: 'm1', type: 'response' }])).toBeNull()
    expect(sweepUnansweredPromptsAtReplayEnd('s1', [prompt('q1', { answered: 'yes' })])).toBeNull()
  })

  it('never touches a permission prompt — #7410/#7419 unchanged', () => {
    // Both shapes #7419 protects: with and without a TTL. Only `requestId` is
    // required, because `expiresAt` is absent whenever the frame omitted
    // `remainingMs`.
    expect(
      sweepUnansweredPromptsAtReplayEnd('s1', [
        prompt('p1', { requestId: 'req-1' }),
        prompt('p2', { requestId: 'req-2' }),
      ]),
    ).toBeNull()
  })

  it('leaves other messages untouched and stamps only the stampable prompts', () => {
    const out = sweepUnansweredPromptsAtReplayEnd('s1', [
      { id: 'm1', type: 'response' },
      prompt('q1'),
      prompt('p1', { requestId: 'req-1' }),
      prompt('q2', { answered: 'a' }),
    ])
    expect(out).toEqual([
      { id: 'm1', type: 'response' },
      { id: 'q1', type: 'prompt', answered: REPLAY_RESOLVED_PLACEHOLDER },
      { id: 'p1', type: 'prompt', requestId: 'req-1' },
      { id: 'q2', type: 'prompt', answered: 'a' },
    ])
  })

  it('returns null for a null/empty sessionId (the sweep is per-session)', () => {
    expect(sweepUnansweredPromptsAtReplayEnd(null, [prompt('q1')])).toBeNull()
    expect(sweepUnansweredPromptsAtReplayEnd(undefined, [prompt('q1')])).toBeNull()
  })

  describe('live-arrival ledger', () => {
    it('skips a prompt that arrived live inside the window, stamps one the replay delivered', () => {
      reconcileReplayStart('s1', false, [])
      // Only the live one is recorded; the replayed one carried a historySeq at
      // the call site and so is never noted.
      noteLivePromptDuringReplay('s1', 'live-q')
      // Positive control — the fixture actually took effect. Without it, a
      // green "not stamped" could just as well mean the note never landed.
      expect(wasPromptLiveDuringReplay('s1', 'live-q')).toBe(true)
      expect(wasPromptLiveDuringReplay('s1', 'replayed-q')).toBe(false)
      reconcileReplayEnd('s1', [])

      const out = sweepUnansweredPromptsAtReplayEnd('s1', [
        prompt('replayed-q'),
        prompt('live-q'),
      ])
      expect(out).toEqual([
        { id: 'replayed-q', type: 'prompt', answered: REPLAY_RESOLVED_PLACEHOLDER },
        { id: 'live-q', type: 'prompt' },
      ])
    })

    it('is a no-op outside a replay window — a prompt that pre-dates it stays stampable', () => {
      noteLivePromptDuringReplay('s1', 'q1')
      expect(wasPromptLiveDuringReplay('s1', 'q1')).toBe(false)
      reconcileReplayStart('s1', false, [])
      reconcileReplayEnd('s1', [])
      expect(sweepUnansweredPromptsAtReplayEnd('s1', [prompt('q1')])).toEqual([
        { id: 'q1', type: 'prompt', answered: REPLAY_RESOLVED_PLACEHOLDER },
      ])
    })

    it('opens the window for a DELTA replay too, not just a full rebuild', () => {
      // `_rebuildBaseline` only tracks full rebuilds, so the window has to be
      // its own thing — a live question races a delta replay just as easily.
      reconcileReplayStart('s1', false, [])
      expect(isRebuildInProgress('s1')).toBe(false)
      noteLivePromptDuringReplay('s1', 'q1')
      expect(wasPromptLiveDuringReplay('s1', 'q1')).toBe(true)
    })

    it('closes the window at replay end — a later arrival is not protected', () => {
      reconcileReplayStart('s1', true, [])
      reconcileReplayEnd('s1', [])
      noteLivePromptDuringReplay('s1', 'after-q')
      expect(wasPromptLiveDuringReplay('s1', 'after-q')).toBe(false)
    })

    it('forgets the previous window at the next start', () => {
      reconcileReplayStart('s1', false, [])
      noteLivePromptDuringReplay('s1', 'q1')
      reconcileReplayEnd('s1', [])
      expect(wasPromptLiveDuringReplay('s1', 'q1')).toBe(true)
      // Second replay: q1 is now just an old on-screen prompt with nothing
      // vouching for it, so the sweep is entitled to stamp it again.
      reconcileReplayStart('s1', false, prefix(1))
      expect(wasPromptLiveDuringReplay('s1', 'q1')).toBe(false)
      reconcileReplayEnd('s1', [])
      expect(sweepUnansweredPromptsAtReplayEnd('s1', [prompt('q1')])).toEqual([
        { id: 'q1', type: 'prompt', answered: REPLAY_RESOLVED_PLACEHOLDER },
      ])
    })

    it("is per-session — s2's window does not protect a prompt in s1", () => {
      reconcileReplayStart('s2', false, [])
      noteLivePromptDuringReplay('s1', 'q1')
      expect(wasPromptLiveDuringReplay('s1', 'q1')).toBe(false)
      expect(sweepUnansweredPromptsAtReplayEnd('s1', [prompt('q1')])).toEqual([
        { id: 'q1', type: 'prompt', answered: REPLAY_RESOLVED_PLACEHOLDER },
      ])
    })

    it('ignores a null session id or message id', () => {
      reconcileReplayStart('s1', false, [])
      noteLivePromptDuringReplay(null, 'q1')
      noteLivePromptDuringReplay('s1', null)
      noteLivePromptDuringReplay('s1', '')
      expect(wasPromptLiveDuringReplay('s1', 'q1')).toBe(false)
      expect(wasPromptLiveDuringReplay(null, 'q1')).toBe(false)
      expect(wasPromptLiveDuringReplay('s1', null)).toBe(false)
    })

    it('resetReplayReconcile drops the window and the ledger (fresh auth)', () => {
      reconcileReplayStart('s1', false, [])
      noteLivePromptDuringReplay('s1', 'q1')
      resetReplayReconcile()
      expect(wasPromptLiveDuringReplay('s1', 'q1')).toBe(false)
      // Window gone too: a note after the reset is not retroactively honoured.
      noteLivePromptDuringReplay('s1', 'q2')
      expect(wasPromptLiveDuringReplay('s1', 'q2')).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// #7455 — overlapping replays of ONE session
// ---------------------------------------------------------------------------
//
// The server can have two replays of the same session in flight at once, and
// neither caller checks: `subscribe_sessions` replays every newly-subscribed
// background session (session-handlers.js), and `switch_session` calls
// `replayHistory(ws, targetId, { forceFull: true })` UNCONDITIONALLY — including
// for a session the client already subscribed to. `replayHistory` chunks 20
// entries at a time over `setImmediate` with back-pressure pauses, so replay #1
// is still streaming when the user taps into the session and starts replay #2.
// Wire order: start(X) … start(X) … end(X) … end(X).
//
// With membership (a Set) rather than a refcount that sequence loses the #7420
// protection in the tail: start#2 discards start#1's evidence, and end#1 closes
// the window while replay #2 is still streaming, so every live question between
// end#1 and end#2 falls through the `noteLivePromptDuringReplay` gate and is
// stamped '(resolved)' by end#2's sweep — the exact bug #7420 fixed.
describe('overlapping replays of one session (#7455)', () => {
  it('keeps the window open until the LAST end — a racer after end#1 is still protected', () => {
    // The reviewer's reproduction, verbatim: start, start, note, end, note, end.
    reconcileReplayStart('s1', true, []) // subscribe_sessions (forceFull)
    reconcileReplayStart('s1', true, []) // switch_session (forceFull), replay #1 still streaming
    noteLivePromptDuringReplay('s1', 'q1')
    reconcileReplayEnd('s1', [])
    noteLivePromptDuringReplay('s1', 'q2')
    reconcileReplayEnd('s1', [])

    // Positive controls: both fixtures took effect, so the "unstamped" below is
    // about the ledger and not about a note that never landed.
    expect(wasPromptLiveDuringReplay('s1', 'q1')).toBe(true)
    expect(wasPromptLiveDuringReplay('s1', 'q2')).toBe(true)

    // A genuinely replayed prompt is still stamped, so this is not a vacuous
    // "the sweep did nothing" pass.
    expect(
      sweepUnansweredPromptsAtReplayEnd('s1', [prompt('replayed-q'), prompt('q1'), prompt('q2')]),
    ).toEqual([
      { id: 'replayed-q', type: 'prompt', answered: REPLAY_RESOLVED_PLACEHOLDER },
      { id: 'q1', type: 'prompt' },
      { id: 'q2', type: 'prompt' },
    ])
  })

  it('a nested start does NOT discard the still-open outer window ledger', () => {
    reconcileReplayStart('s1', false, [])
    noteLivePromptDuringReplay('s1', 'q0')
    expect(wasPromptLiveDuringReplay('s1', 'q0')).toBe(true)
    // Replay #2 starts while #1 is in flight: the outer window is still
    // protecting q0, so its evidence must survive.
    reconcileReplayStart('s1', true, [])
    expect(wasPromptLiveDuringReplay('s1', 'q0')).toBe(true)
  })

  it('refcounts the window: depth climbs per start and returns to 0 on balanced ends', () => {
    expect(getReplayWindowDepth('s1')).toBe(0)
    reconcileReplayStart('s1', false, [])
    expect(getReplayWindowDepth('s1')).toBe(1)
    reconcileReplayStart('s1', false, [])
    expect(getReplayWindowDepth('s1')).toBe(2)
    reconcileReplayEnd('s1', [])
    expect(getReplayWindowDepth('s1')).toBe(1)
    reconcileReplayEnd('s1', [])
    expect(getReplayWindowDepth('s1')).toBe(0)
  })

  it('is per-session — s2 starting a replay does not hold s1 window open', () => {
    reconcileReplayStart('s1', false, [])
    reconcileReplayStart('s2', false, [])
    reconcileReplayEnd('s1', [])
    expect(getReplayWindowDepth('s1')).toBe(0)
    expect(getReplayWindowDepth('s2')).toBe(1)
    noteLivePromptDuringReplay('s1', 'after-q')
    expect(wasPromptLiveDuringReplay('s1', 'after-q')).toBe(false)
  })

  it('an unmatched end cannot drive the depth negative (a later start still opens once)', () => {
    reconcileReplayEnd('s1', [])
    expect(getReplayWindowDepth('s1')).toBe(0)
    reconcileReplayStart('s1', false, [])
    expect(getReplayWindowDepth('s1')).toBe(1)
    reconcileReplayEnd('s1', [])
    expect(getReplayWindowDepth('s1')).toBe(0)
    noteLivePromptDuringReplay('s1', 'q1')
    expect(wasPromptLiveDuringReplay('s1', 'q1')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// #7477 — the rebuild BASELINE across those same overlapping replays
// ---------------------------------------------------------------------------
//
// One map over from #7455, and the same non-refcount shape:
// `reconcileReplayStart` OVERWROTE `_rebuildBaseline` on every full rebuild and
// `reconcileReplayEnd` DELETED it on the first end. So for `start start end end`
// with a live message appended BETWEEN the two starts, end#1 sliced the array at
// replay #2's baseline and applied the result as the atomic swap — removing that
// message from the store outright, not merely stamping it '(resolved)'.
//
// #7455 scoped this out as "a cosmetic mis-swap". It is not: the gap between the
// two starts is precisely the live-racer window #7420 exists to protect, so the
// ledger vouched for the message and the swap then threw it away.
//
// The fix mirrors the window refcount exactly: the OUTERMOST full rebuild owns
// the baseline (set only when absent), and the swap is deferred to the end that
// closes the LAST window. Slicing at the outer baseline yields the union of both
// replays' appended tails, and `replayDedupCache` — scoped at that same baseline
// — lets replay #2 dedup against what replay #1 already appended.
describe('overlapping full rebuilds — swap at the OUTERMOST baseline (#7477)', () => {
  it('keeps a live message appended between the two starts (the issue reproduction)', () => {
    // Verbatim from the issue.
    reconcileReplayStart('s1', true, []) // replay #1 — subscribe_sessions (forceFull)
    const messages: Msg[] = [{ id: 'live-q' }] // a LIVE arrival during replay #1
    reconcileReplayStart('s1', true, messages) // replay #2 — switch_session (forceFull)

    // end#1 must NOT swap — replay #2 is still streaming, so the array is not
    // yet the authoritative set. Pre-fix this returned [] and 'live-q' was gone.
    expect(reconcileReplayEnd('s1', messages).swappedMessages).toBeNull()
    // end#2 closes the last window and swaps at the OUTER baseline (0).
    expect(reconcileReplayEnd('s1', messages).swappedMessages).toEqual([{ id: 'live-q' }])
  })

  it('the single swap is the union of both replays appended tails, prefix still dropped', () => {
    reconcileReplayStart('s1', true, [{ id: 'old-1' }, { id: 'old-2' }]) // prefix [old-1, old-2] stays visible
    const live: Msg[] = [{ id: 'old-1' }, { id: 'old-2' }, { id: 'r1-a' }]
    reconcileReplayStart('s1', true, live) // replay #2 starts mid-#1
    live.push({ id: 'racer' }, { id: 'r2-a' })

    expect(reconcileReplayEnd('s1', live).swappedMessages).toBeNull()
    // The prefix is still discarded (the swap is real, not a no-op), and
    // everything appended since the OUTER start survives in array order.
    expect(reconcileReplayEnd('s1', live).swappedMessages).toEqual([
      { id: 'r1-a' },
      { id: 'racer' },
      { id: 'r2-a' },
    ])
  })

  it('the dedup cache stays scoped to the OUTER baseline while replay #2 streams', () => {
    reconcileReplayStart('s1', true, [{ id: 'old' }])
    const live: Msg[] = [{ id: 'old' }, { id: 'r1-a' }]
    reconcileReplayStart('s1', true, live)
    // Replay #2 re-delivers r1-a. It must be inside the dedup cache or it is
    // appended a second time; pre-fix the cache was rescoped to 2 and missed it.
    expect(replayDedupCache('s1', live)).toEqual([{ id: 'r1-a' }])
  })

  it('a rebuild is still in progress after end#1 and cleared after the LAST end', () => {
    reconcileReplayStart('s1', true, [])
    reconcileReplayStart('s1', true, [])
    reconcileReplayEnd('s1', [])
    expect(isRebuildInProgress('s1')).toBe(true)
    expect(getReplayWindowDepth('s1')).toBe(1)
    reconcileReplayEnd('s1', [])
    expect(isRebuildInProgress('s1')).toBe(false)
    expect(getReplayWindowDepth('s1')).toBe(0)
  })

  it('a nested DELTA replay does not clear the still-open rebuild baseline', () => {
    // The delta branch clears a stale baseline, which is right for a genuinely
    // new window and wrong for one nested inside a live full rebuild: it used to
    // delete the outer baseline, and then the swap never happened at all and the
    // about-to-be-discarded prefix stayed on screen forever.
    reconcileReplayStart('s1', true, [{ id: 'old' }]) // full rebuild, baseline 1
    const live: Msg[] = [{ id: 'old' }, { id: 'r-1' }]
    // The nested delta reports the rebuild that is still in flight, rather than
    // the kind of replay it is itself.
    expect(reconcileReplayStart('s1', false, live).rebuildInProgress).toBe(true)
    expect(isRebuildInProgress('s1')).toBe(true)
    expect(reconcileReplayEnd('s1', live).swappedMessages).toBeNull()
    expect(reconcileReplayEnd('s1', live).swappedMessages).toEqual([{ id: 'r-1' }])
  })

  it('SEQUENTIAL full replays each capture a FRESH baseline', () => {
    // "Set only when absent" must not retain a baseline past the last end, or
    // the second replay would keep the first one's messages forever.
    reconcileReplayStart('s1', true, [])
    expect(reconcileReplayEnd('s1', [{ id: 'r-1' }]).swappedMessages).toEqual([{ id: 'r-1' }])
    reconcileReplayStart('s1', true, [{ id: 'r-1' }])
    expect(
      reconcileReplayEnd('s1', [{ id: 'r-1' }, { id: 'r-2' }]).swappedMessages,
    ).toEqual([{ id: 'r-2' }])
  })

  it('is per-session: s2 overlapping replays do not defer s1 swap', () => {
    reconcileReplayStart('s1', true, [{ id: 'old' }])
    reconcileReplayStart('s2', true, [])
    reconcileReplayStart('s2', true, [])
    expect(reconcileReplayEnd('s1', [{ id: 'old' }, { id: 'r-1' }]).swappedMessages).toEqual([
      { id: 'r-1' },
    ])
  })

  it('teardown clears a deferred overlap — a mid-replay socket drop cannot wedge the swap', () => {
    // The deferral is what makes this load-bearing: a start with no matching end
    // strands a +1, and every later end would then decrement from a too-high
    // base and never swap again for that session.
    reconcileReplayStart('s1', true, [])
    reconcileReplayStart('s1', true, [])
    resetReplayReconcile()
    expect(isRebuildInProgress('s1')).toBe(false)
    expect(getReplayWindowDepth('s1')).toBe(0)

    reconcileReplayStart('s1', true, [])
    reconcileReplayStart('s1', true, [])
    dropReplaySessionState('s1')
    expect(isRebuildInProgress('s1')).toBe(false)
    expect(getReplayWindowDepth('s1')).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// #7492 — the OUTERMOST window owns the baseline whatever KIND opened it
// ---------------------------------------------------------------------------
describe('full rebuild nested inside a DELTA window (#7492)', () => {
  it('keeps a live racer that arrived before the nested full start (the issue reproduction)', () => {
    // Verbatim from the issue. Pre-fix: end#2 returned [{ id: 'r-1' }] — the
    // delta contributed no baseline, so the NESTED full start was the first to
    // set one and captured a length that already counted the racer.
    reconcileReplayStart('s1', false, []) // outermost = DELTA (handshake, cursor path)
    const live: Msg[] = [{ id: 'racer' }] // a LIVE arrival during the delta window
    reconcileReplayStart('s1', true, live) // nested FULL start
    live.push({ id: 'r-1' }) // the full replay appends

    expect(reconcileReplayEnd('s1', live).swappedMessages).toBeNull()
    expect(reconcileReplayEnd('s1', live).swappedMessages).toEqual([
      { id: 'racer' },
      { id: 'r-1' },
    ])
  })

  it('still discards the pre-WINDOW prefix — the swap is real, not an identity slice', () => {
    // The adopted baseline is the length at the 0->1 transition, so a session
    // that had messages on screen before the delta opened still gets them
    // sliced off by the rebuild. Without this the fix would "pass" by never
    // swapping anything.
    const live: Msg[] = [{ id: 'old-1' }, { id: 'old-2' }]
    reconcileReplayStart('s1', false, live) // outermost DELTA at length 2
    live.push({ id: 'racer' }) // live arrival inside the delta window
    reconcileReplayStart('s1', true, live) // nested FULL — must adopt 2, not 3
    live.push({ id: 'r-1' })

    expect(reconcileReplayEnd('s1', live).swappedMessages).toBeNull()
    expect(reconcileReplayEnd('s1', live).swappedMessages).toEqual([
      { id: 'racer' },
      { id: 'r-1' },
    ])
  })

  it('scopes the dedup cache at the ADOPTED baseline, not at the nested full start', () => {
    // The dedup cache and the swap baseline are the same number by
    // construction (`replayDedupCache` reads `_rebuildBaseline`), so adopting
    // the window-open length has to move BOTH — otherwise the racer survives
    // the swap and is invisible to dedup.
    const live: Msg[] = [{ id: 'old' }]
    reconcileReplayStart('s1', false, live)
    live.push({ id: 'racer' })
    reconcileReplayStart('s1', true, live)

    expect(replayDedupCache('s1', live)).toEqual([{ id: 'racer' }])
  })

  it('keeps a racer that arrives DURING the nested full rebuild (control — green pre-fix)', () => {
    // The other side of the interleave: nothing is appended between the delta
    // start and the full start, so the two baselines coincide and this case was
    // already correct. Here so the fix is pinned as covering BOTH racer
    // positions rather than trading one for the other.
    reconcileReplayStart('s1', false, [])
    reconcileReplayStart('s1', true, [])
    const live: Msg[] = [{ id: 'racer' }]
    live.push({ id: 'r-1' })

    expect(reconcileReplayEnd('s1', live).swappedMessages).toBeNull()
    expect(reconcileReplayEnd('s1', live).swappedMessages).toEqual([
      { id: 'racer' },
      { id: 'r-1' },
    ])
  })

  it('reports the rebuild the nested full started, not the delta that opened the window', () => {
    expect(reconcileReplayStart('s1', false, []).rebuildInProgress).toBe(false)
    expect(isRebuildInProgress('s1')).toBe(false)
    expect(reconcileReplayStart('s1', true, []).rebuildInProgress).toBe(true)
    expect(isRebuildInProgress('s1')).toBe(true)
    expect(getReplayWindowDepth('s1')).toBe(2)
  })

  it('does not leak the window-open length into the NEXT window', () => {
    // The recorded length lives exactly as long as the refcount does. A stale
    // 5 here would make the following rebuild swap to [] and blank the session.
    reconcileReplayStart('s1', false, [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }])
    reconcileReplayEnd('s1', [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }])
    reconcileReplayStart('s1', true, [{ id: 'old' }])
    expect(
      reconcileReplayEnd('s1', [{ id: 'old' }, { id: 'r-1' }]).swappedMessages,
    ).toEqual([{ id: 'r-1' }])
  })

  it('teardown drops the window-open length with the refcount (mid-window socket drop)', () => {
    reconcileReplayStart('s1', false, prefix(5))
    resetReplayReconcile()
    expect(getReplayWindowDepth('s1')).toBe(0)
    // A fresh rebuild must use ITS OWN length, not the torn-down window's 5.
    reconcileReplayStart('s1', true, [{ id: 'old' }])
    expect(
      reconcileReplayEnd('s1', [{ id: 'old' }, { id: 'r-1' }]).swappedMessages,
    ).toEqual([{ id: 'r-1' }])

    reconcileReplayStart('s2', false, prefix(5))
    dropReplaySessionState('s2')
    expect(getReplayWindowDepth('s2')).toBe(0)
    reconcileReplayStart('s2', true, [{ id: 'old' }])
    expect(
      reconcileReplayEnd('s2', [{ id: 'old' }, { id: 'r-1' }]).swappedMessages,
    ).toEqual([{ id: 'r-1' }])
  })

  it('is per-session — s2 opening a delta window does not give s1 a baseline', () => {
    reconcileReplayStart('s2', false, prefix(4))
    reconcileReplayStart('s1', true, [{ id: 'old' }])
    expect(
      reconcileReplayEnd('s1', [{ id: 'old' }, { id: 'r-1' }]).swappedMessages,
    ).toEqual([{ id: 'r-1' }])
  })

  it('overlapping PURE deltas still swap nothing at all', () => {
    // No full start anywhere, so no baseline is ever recorded and both ends
    // return null — the window-open length is captured but never adopted.
    reconcileReplayStart('s1', false, [{ id: 'old-1' }, { id: 'old-2' }])
    reconcileReplayStart('s1', false, [{ id: 'old-1' }, { id: 'old-2' }])
    const live: Msg[] = [{ id: 'old-1' }, { id: 'old-2' }, { id: 'd-1' }]
    expect(reconcileReplayEnd('s1', live).swappedMessages).toBeNull()
    expect(reconcileReplayEnd('s1', live).swappedMessages).toBeNull()
    expect(isRebuildInProgress('s1')).toBe(false)
    expect(getReplayWindowDepth('s1')).toBe(0)
  })

  // WAS the known ordering limit, now the fix (#7519). When the outermost delta
  // APPENDED before the nested full start, its entries sit inside the preserved
  // tail, `replayDedupCache` is scoped at the same baseline, and the full
  // replay's re-delivery of them is suppressed — so in ARRAY order they keep
  // their early position while the older history the full replay delivers lands
  // after them. Complete, but mis-ORDERED: measured `['d-1','racer','old']`
  // before this landed, and `['old','d-1']` on pre-#7492 `main`, which had the
  // order right only by dropping the racer.
  //
  // The swap no longer returns array order. Each append made while the window is
  // open carries the `historySeq` of the frame that caused it, so the tail comes
  // back as (replayed, in the SERVER's history order) ++ (live, in arrival
  // order) — which is chronological for all three entries here. The companion
  // block below (`append PROVENANCE …`) is where the mechanism itself is pinned;
  // this is the issue's own reproduction, kept where it was found.
  it("the delta's own appends come back in HISTORY order, racer last (#7519)", () => {
    const live: Msg[] = [{ id: 'old' }]
    reconcileReplayStart('s1', false, live) // outermost DELTA opens at 1
    replayed('s1', live, 'd-1', 2) // the delta replays the newest history entry
    arrivedLive('s1', live, 'racer') // a LIVE arrival
    reconcileReplayStart('s1', true, live) // nested FULL start

    // The full replay re-delivers the whole ring buffer oldest-first, deduped
    // against the cache exactly as both clients do it — 'old' is appended, 'd-1'
    // dedups against the copy the delta already appended.
    replayed('s1', live, 'old', 1)
    replayed('s1', live, 'd-1', 2)
    expect(live.map((m) => m.id)).toEqual(['old', 'd-1', 'racer', 'old'])

    expect(reconcileReplayEnd('s1', live).swappedMessages).toBeNull()
    const swapped = reconcileReplayEnd('s1', live).swappedMessages as Msg[]
    // Nothing is LOST — the racer and both history entries are all present...
    expect(swapped.map((m) => m.id).sort()).toEqual(['d-1', 'old', 'racer'])
    // ...and 'old' is FIRST: seq 1 before seq 2, live racer after both.
    expect(swapped.map((m) => m.id)).toEqual(['old', 'd-1', 'racer'])
  })

  it('a delta nested inside the delta-opened window does not clear the adopted baseline', () => {
    // The delta branch only clears a stale baseline when it OPENS the window
    // (#7477). Now that a nested FULL can install one under a delta-opened
    // window, a THIRD, deeper delta must not cancel that rebuild's swap.
    reconcileReplayStart('s1', false, []) // outermost DELTA
    const live: Msg[] = [{ id: 'racer' }]
    reconcileReplayStart('s1', true, live) // nested FULL
    reconcileReplayStart('s1', false, live) // deeper DELTA
    live.push({ id: 'r-1' })

    expect(isRebuildInProgress('s1')).toBe(true)
    expect(reconcileReplayEnd('s1', live).swappedMessages).toBeNull()
    expect(reconcileReplayEnd('s1', live).swappedMessages).toBeNull()
    expect(reconcileReplayEnd('s1', live).swappedMessages).toEqual([
      { id: 'racer' },
      { id: 'r-1' },
    ])
  })
})

// ---------------------------------------------------------------------------
// #7519 — per-append PROVENANCE: the swap returns the tail in chronological
// order, not in the order the replay and the live wire happened to interleave
// ---------------------------------------------------------------------------
//
// Measured on the branch point (19d5f22), verbatim from the issue and from
// #7542's second-racer table, and every row is what this block now asserts:
//
//   worked example      array ['old','d-1','racer','old']
//                       was ['d-1','racer','old']            now ['old','d-1','racer']
//   + a second racer    array ['old','d-1','racer-A','old','racer-B']
//                       was ['d-1','racer-A','old','racer-B'] (2 inversions)
//                       now ['old','d-1','racer-A','racer-B'] (0)
//
// The two shapes #7542 rejected are rejected by construction here: a second CUT
// point cannot separate these (both regions hold both kinds), and an id-keyed
// SET cannot either (#7556 — a replayed id matching a surviving prefix entry is
// appended as a second copy, and a membership test then matches the PREFIX copy
// and cuts at 0). The record is a per-append parallel ARRAY, and every use of it
// re-verifies its alignment against the array as it stands.
describe('append PROVENANCE orders the swapped tail (#7519)', () => {
  it('a second racer during the nested rebuild lands last too (the #7542 table)', () => {
    const live: Msg[] = [{ id: 'old' }]
    reconcileReplayStart('s1', false, live)
    replayed('s1', live, 'd-1', 2)
    arrivedLive('s1', live, 'racer-A')
    reconcileReplayStart('s1', true, live)
    replayed('s1', live, 'old', 1)
    replayed('s1', live, 'd-1', 2)
    arrivedLive('s1', live, 'racer-B') // arrives DURING the nested rebuild
    expect(live.map((m) => m.id)).toEqual(['old', 'd-1', 'racer-A', 'old', 'racer-B'])

    expect(reconcileReplayEnd('s1', live).swappedMessages).toBeNull()
    // The row #7542 measured at 2 inversions for BOTH the shipped behaviour and
    // the sketch it rejected. Zero here.
    expect(idsOf(reconcileReplayEnd('s1', live).swappedMessages)).toEqual([
      'old',
      'd-1',
      'racer-A',
      'racer-B',
    ])
  })

  it('replayed entries sort by historySeq, NOT by the order the frames arrived', () => {
    // The reason the record holds the seq rather than a replayed/live boolean.
    // A bare partition would return delivery order — ['r-9','r-3','r-1'] — which
    // is exactly as wrong as array order for a delta that ran newest-first
    // before a full rebuild re-delivered the rest.
    const live: Msg[] = [{ id: 'old' }]
    reconcileReplayStart('s1', true, live)
    replayed('s1', live, 'r-9', 9)
    replayed('s1', live, 'r-3', 3)
    replayed('s1', live, 'r-1', 1)

    expect(idsOf(reconcileReplayEnd('s1', live).swappedMessages)).toEqual(['r-1', 'r-3', 'r-9'])
  })

  it('equal seqs keep delivery order (the comparator tiebreak, not the engine)', () => {
    const live: Msg[] = [{ id: 'old' }]
    reconcileReplayStart('s1', true, live)
    replayed('s1', live, 'r-a', 5)
    replayed('s1', live, 'r-b', 5)
    replayed('s1', live, 'r-c', 5)

    expect(idsOf(reconcileReplayEnd('s1', live).swappedMessages)).toEqual(['r-a', 'r-b', 'r-c'])
  })

  it('a live-only tail keeps arrival order — nothing to sort, nothing moved', () => {
    const live: Msg[] = [{ id: 'old' }]
    reconcileReplayStart('s1', true, live)
    arrivedLive('s1', live, 'L1')
    arrivedLive('s1', live, 'L2')
    arrivedLive('s1', live, 'L3')

    expect(idsOf(reconcileReplayEnd('s1', live).swappedMessages)).toEqual(['L1', 'L2', 'L3'])
  })

  it('an append-only full rebuild is UNCHANGED — the ordering is a no-op (control)', () => {
    // The positive control for the whole block: an ordinary reconnect replays
    // oldest-first with no racer, so provenance order and array order coincide.
    // Without this the block reads as "the reorder is doing something" when what
    // it must do first is nothing.
    const live: Msg[] = [{ id: 'p1' }, { id: 'p2' }]
    reconcileReplayStart('s1', true, live)
    replayed('s1', live, 'r-1', 1)
    replayed('s1', live, 'r-2', 2)
    replayed('s1', live, 'r-3', 3)

    expect(idsOf(reconcileReplayEnd('s1', live).swappedMessages)).toEqual(['r-1', 'r-2', 'r-3'])
  })

  it('a replayed frame carrying NO seq is treated as live — presence is the whole signal', () => {
    // `sendHistoryEntry` stamps every replayed entry, and #7420 already depends
    // on that. Said plainly rather than assumed: an unstamped frame is
    // indistinguishable from a live broadcast HERE, so it sorts with the live
    // half. That is the documented floor, not a silent mis-classification.
    const live: Msg[] = [{ id: 'old' }]
    reconcileReplayStart('s1', true, live)
    frame('s1', live, null, (m) => m.push({ id: 'unstamped' }))
    replayed('s1', live, 'r-1', 1)

    expect(idsOf(reconcileReplayEnd('s1', live).swappedMessages)).toEqual(['r-1', 'unstamped'])
  })

  it('refuses a seq `recordHistorySeq` would refuse — one validity rule, not two', () => {
    // NaN / Infinity / negative: the cursor already rejects them
    // (`ignores non-finite / negative / non-number seqs`), so ordering must too,
    // and the refusal lands on LIVE — late, never hoisted into history.
    const live: Msg[] = [{ id: 'old' }]
    reconcileReplayStart('s1', true, live)
    for (const [id, seq] of [
      ['bad-nan', Number.NaN],
      ['bad-inf', Number.POSITIVE_INFINITY],
      ['bad-neg', -1],
    ] as [string, number][]) {
      frame('s1', live, seq, (m) => m.push({ id }))
    }
    replayed('s1', live, 'r-1', 1)

    expect(getReplayAppendProvenance('s1')).toEqual([
      { id: 'bad-nan', seq: null },
      { id: 'bad-inf', seq: null },
      { id: 'bad-neg', seq: null },
      { id: 'r-1', seq: 1 },
    ])
    expect(idsOf(reconcileReplayEnd('s1', live).swappedMessages)).toEqual([
      'r-1',
      'bad-nan',
      'bad-inf',
      'bad-neg',
    ])
  })

  // --- the degradations, each pinned rather than left to be discovered ------

  it('an append NO observation point saw degrades to array order — and drops nothing', () => {
    // The record is allowed to UNDER-count: a store path that appends without
    // going through `updateSession` is simply absent from it. `resolveCut` takes
    // the MINIMUM of the walk and the provenance start precisely so that costs
    // only the improvement — the pre-#7519 array order — and never an entry.
    const live: Msg[] = [{ id: 'old' }]
    reconcileReplayStart('s1', false, live)
    replayed('s1', live, 'd-1', 2)
    arrivedLive('s1', live, 'racer')
    reconcileReplayStart('s1', true, live)
    replayed('s1', live, 'old', 1)
    replayed('s1', live, 'd-1', 2)
    live.push({ id: 'unwired' }) // an append nothing reported

    expect(reconcileReplayEnd('s1', live).swappedMessages).toBeNull()
    expect(idsOf(reconcileReplayEnd('s1', live).swappedMessages)).toEqual([
      'd-1',
      'racer',
      'old',
      'unwired',
    ])
  })

  // --- the `thinking` placeholder, on the racer path (#7574 review, finding 1)
  //
  // `sendMessage` appends the user's bubble AND a `{ id: 'thinking' }`
  // placeholder (`connection.ts:3550` dashboard, `:1710` app), and every
  // `message` frame — every replayed history entry included — STRIPS that
  // placeholder while appending
  // (`ss.messages.filter((m) => m.id !== 'thinking' || …)`). So a user typing
  // mid-replay makes the next replayed entry a remove-then-append, which is
  // neither branch of `noteReplayMessagesUpdate`.
  //
  // These two pin the CURRENT, degraded behaviour, and they are `go red with
  // the docs` pins rather than red-first ones: they cannot fail today because
  // they describe today. What makes them worth writing is that they REACH red
  // — a naive repair that simply accepts remove-then-append as an append flips
  // both — so when the repair lands (#7577) these are the tests that say so,
  // and they go with it rather than being discovered stale. Neither shape
  // loses, duplicates or reorders a message: both land on exactly pre-#7519
  // behaviour.
  it('KNOWN LIMIT: a user typing mid-replay drops the record for the window (#7577)', () => {
    const live: Msg[] = [{ id: 'old' }]
    reconcileReplayStart('s1', false, live)
    replayed('s1', live, 'h-2', 2)
    arrivedLive('s1', live, 'racer')
    reconcileReplayStart('s1', true, live)
    // `sendMessage`: the user's bubble AND the placeholder, in ONE update.
    frame('s1', live, null, (m) => m.push({ id: 'u-1' }, { id: 'thinking' }))
    // The next replayed entry strips the placeholder while appending.
    frame('s1', live, 1, (m) => {
      const kept = m.filter((e) => e.id !== 'thinking')
      m.length = 0
      m.push(...kept, { id: 'h-1' })
    })
    // Unclassifiable, so the record goes rather than drifting.
    expect(getReplayAppendProvenance('s1')).toBeNull()

    expect(reconcileReplayEnd('s1', live).swappedMessages).toBeNull()
    // Array order — the #7519 artifact verbatim, with the oldest history entry
    // last. The truth is ['h-1','h-2','racer','u-1'].
    expect(idsOf(reconcileReplayEnd('s1', live).swappedMessages)).toEqual([
      'h-2',
      'racer',
      'u-1',
      'h-1',
    ])
  })

  it('KNOWN LIMIT: a strip while the record is still EMPTY under-counts instead (#7577)', () => {
    // The quieter second shape: the placeholder is already on screen when the
    // window opens (send, drop, reconnect inside the safety-net timer), so the
    // strip lands at `n === 0`. Branch 2 is vacuous there — deliberately, it is
    // what keeps #7543 — so the record is KEPT and the append it could not
    // classify is simply not recorded. An under-count, which `Math.min` and the
    // swap's exact-alignment gate already make safe, rather than a drop.
    const live: Msg[] = [{ id: 'old' }, { id: 'thinking' }]
    reconcileReplayStart('s1', true, live)
    frame('s1', live, 1, (m) => {
      const kept = m.filter((e) => e.id !== 'thinking')
      m.length = 0
      m.push(...kept, { id: 'h-1' })
    })
    replayed('s1', live, 'h-2', 2)

    // Kept, and short by one — 'h-1' never entered it.
    expect(idsOf(getReplayAppendProvenance('s1'))).toEqual(['h-2'])
    // So `start !== cut` and the reorder does not run. Nothing is lost.
    expect(idsOf(reconcileReplayEnd('s1', live).swappedMessages)).toEqual(['h-1', 'h-2'])
  })

  it('a mid-array INSERT cannot enter an EMPTY record with a fabricated seq (#7574 F2)', () => {
    // The reviewer's reproduction. With no anchor at `n === 0` the append branch
    // was taken on ANY growth, so an insert recorded the shifted last element of
    // `before` — a PREFIX entry — carrying the inserting frame's seq. The ids
    // line up, so `provenanceStart` passes, the over-count pulls the cut below
    // the walk, and the swap returned ['r-1','r-2','p3']: a prefix entry kept
    // and sorted to the end by a seq that was never its own — an order NEITHER
    // the walk nor array order produces. Measured red before the anchor landed.
    const live: Msg[] = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }]
    reconcileReplayStart('s1', true, live)
    frame('s1', live, 99, (m) => m.splice(1, 0, { id: 'X' })) // a mid-array insert
    frame('s1', live, 1, (m) => m.push({ id: 'r-1' }))
    frame('s1', live, 2, (m) => m.push({ id: 'r-2' }))
    frame('s1', live, null, (m) => {
      m.splice(
        m.findIndex((e) => e.id === 'X'),
        1,
      )
    })

    // No prefix entry in the record, and no fabricated seq.
    expect(getReplayAppendProvenance('s1')).toEqual([
      { id: 'r-1', seq: 1 },
      { id: 'r-2', seq: 2 },
    ])
    // The walk's own answer, which is `main`'s.
    expect(idsOf(reconcileReplayEnd('s1', live).swappedMessages)).toEqual(['r-1', 'r-2'])
  })

  it('branch 2 stays VACUOUS at n === 0 — borrowing branch 1 anchor would undo #7543', () => {
    // The trap in the fix for the finding above, pinned so the next reader does
    // not fall into it: the two branches need DIFFERENT anchors. Branch 1 asks
    // "is the append point unmoved" and at `n === 0` must anchor on `before`'s
    // last entry. Branch 2 asks "does the record still describe the tail", and
    // an EMPTY record describes any tail vacuously. Anchoring branch 2 the same
    // way reds all three #7543 tests, because the whole-prefix removal empties
    // `messages` while the record is still empty and then has no index to
    // anchor at — measured, on the reviewer's own literal snippet.
    const live: Msg[] = [{ id: 'a' }, { id: 'b' }]
    reconcileReplayStart('s1', true, live)
    frame('s1', live, null, (m) => { m.length = 0 })
    expect(getReplayAppendProvenance('s1')).toEqual([]) // kept, not dropped
    replayed('s1', live, 'a', 1)
    expect(idsOf(getReplayAppendProvenance('s1'))).toEqual(['a'])
  })

  it('a record that is not `before`’s own tail is given up, not argued with', () => {
    // The precondition guarding both branches. It cannot be reached from a live
    // path (every removal that empties the record also empties `before`), so it
    // is a floor rather than a case — but a record longer than the array it is
    // supposed to be the tail of is the drifted array #7556 rules out, and a
    // floor with no test is the shape this repo keeps a catalogue for.
    const live: Msg[] = [{ id: 'old' }]
    reconcileReplayStart('s1', true, live)
    replayed('s1', live, 'r-1', 1)
    replayed('s1', live, 'r-2', 2)
    // `before` shorter than the two-entry record: unreachable live, refused here.
    noteReplayMessagesUpdate('s1', [{ id: 'old' }], live)
    expect(getReplayAppendProvenance('s1')).toBeNull()
  })

  it('the record is POSITIONAL: a tail that no longer matches it is refused, not trusted', () => {
    // The guard the whole mechanism rests on. If the parallel array has drifted
    // by even one position it describes each tail entry with its NEIGHBOUR's
    // provenance, and the swap would reorder against a lie — silently, and in
    // the direction that looks like a fix. `provenanceStart` re-verifies the run
    // id by id at every use and returns null on the first disagreement.
    const live: Msg[] = [{ id: 'old' }]
    reconcileReplayStart('s1', true, live)
    replayed('s1', live, 'r-9', 9)
    arrivedLive('s1', live, 'L1')
    replayed('s1', live, 'r-1', 1)
    // The record still says [r-9(9), L1(live), r-1(1)] — but the array no longer
    // does: something removed the middle entry without reporting it.
    live.splice(2, 1)
    expect(live.map((m) => m.id)).toEqual(['old', 'r-9', 'r-1'])

    // Refused: array order, and the walk's cut. Not [r-1, r-9] (which is what
    // trusting the drifted record would produce — r-1 read as L1's live slot and
    // r-9 hoisted past it).
    expect(idsOf(reconcileReplayEnd('s1', live).swappedMessages)).toEqual(['r-9', 'r-1'])
  })

  it('a mid-window MOVE gives the record up rather than let it drift', () => {
    // `reorderEmptyResponseSlot` moves a message to the end of the array
    // (#7524). Reported through the hook like any other update, that is neither
    // an append nor an untouched run, so the record is dropped for the rest of
    // the window and the swap reverts to array order.
    const live: Msg[] = [{ id: 'old' }]
    reconcileReplayStart('s1', true, live)
    replayed('s1', live, 'r-2', 2)
    replayed('s1', live, 'r-1', 1)
    expect(getReplayAppendProvenance('s1')).toHaveLength(2)

    frame('s1', live, null, (m) => {
      const [moved] = m.splice(1, 1) // 'r-2' moves to the end
      m.push(moved as Msg)
    })
    expect(getReplayAppendProvenance('s1')).toBeNull()
    expect(idsOf(reconcileReplayEnd('s1', live).swappedMessages)).toEqual(['r-1', 'r-2'])
  })

  it('a PREFIX removal keeps the record — it is the shape #7543 is made of', () => {
    // The one non-append shape the record survives, and it has to: Stop dropping
    // every queued bubble mid-window is a removal that lands entirely in the
    // prefix, and it is the setup for #7543's degenerate window. Giving up here
    // would give up the case the record exists to decide.
    const live: Msg[] = [{ id: 'p1' }, { id: 'p2' }]
    reconcileReplayStart('s1', true, live)
    replayed('s1', live, 'r-1', 1)
    frame('s1', live, null, (m) => m.splice(0, 2)) // Stop drops both bubbles
    expect(idsOf(getReplayAppendProvenance('s1'))).toEqual(['r-1'])
    replayed('s1', live, 'r-2', 2)

    expect(idsOf(reconcileReplayEnd('s1', live).swappedMessages)).toEqual(['r-1', 'r-2'])
  })

  it('an id-less append disables the record rather than recording a hole', () => {
    // Same bail as `snapshotPrefix`, and for a sharper reason: two id-less
    // entries compare EQUAL in the alignment check, so a hole does not merely
    // fail to help — it would license a reorder nothing verified.
    const live: Msg[] = [{ id: 'old' }]
    reconcileReplayStart('s1', true, live)
    replayed('s1', live, 'r-2', 2)
    frame('s1', live, 1, (m) => m.push({} as Msg))
    expect(getReplayAppendProvenance('s1')).toBeNull()
    replayed('s1', live, 'r-1', 1)

    // Array order, unchanged — and nothing lost.
    expect(idsOf(reconcileReplayEnd('s1', live).swappedMessages)).toEqual([
      'r-2',
      undefined,
      'r-1',
    ])
  })

  // --- the frame scope ------------------------------------------------------

  it('closing the frame scope is what keeps the NEXT live append live', () => {
    // The `finally` in both clients' `handleMessage`, pinned by its consequence.
    // A scope left open past the dispatch stamps the frame's seq on whatever the
    // store appends next — and the nearest such append is the optimistic bubble
    // a user types mid-replay, i.e. the live racer this family of issues exists
    // to protect.
    const live: Msg[] = [{ id: 'old' }]
    reconcileReplayStart('s1', true, live)
    replayed('s1', live, 'r-5', 5)
    // The user's own message, appended by a store action and not by a frame.
    const before = live.slice()
    live.push({ id: 'typed' })
    noteReplayMessagesUpdate('s1', before, live)

    expect(getReplayAppendProvenance('s1')).toEqual([
      { id: 'r-5', seq: 5 },
      { id: 'typed', seq: null },
    ])
    expect(idsOf(reconcileReplayEnd('s1', live).swappedMessages)).toEqual(['r-5', 'typed'])
  })

  it('a LEAKED scope would stamp it replayed — the mutant this pins, run forwards', () => {
    // The negative control for the test above: the same sequence with the scope
    // left open (what dropping the `finally` does) classifies the typed message
    // as replayed at seq 5, ties with 'r-5', and orders it by array position
    // instead of holding it after the replayed set. Written out so "the finally
    // is load-bearing" is a measurement rather than a claim.
    const live: Msg[] = [{ id: 'old' }]
    reconcileReplayStart('s1', true, live)
    beginReplayFrame({ type: 'message', historySeq: 5 })
    const beforeReplay = live.slice()
    live.push({ id: 'r-5' })
    noteReplayMessagesUpdate('s1', beforeReplay, live)
    // ...no endReplayFrame() here — the leak.
    const before = live.slice()
    live.push({ id: 'typed' })
    noteReplayMessagesUpdate('s1', before, live)
    endReplayFrame()

    expect(getReplayAppendProvenance('s1')).toEqual([
      { id: 'r-5', seq: 5 },
      { id: 'typed', seq: 5 }, // WRONG — a live arrival called history
    ])
  })

  it('the scope is cleared by a transport teardown that lands mid-dispatch', () => {
    beginReplayFrame({ type: 'message', historySeq: 7 })
    resetReplayReconcile()
    const live: Msg[] = [{ id: 'old' }]
    reconcileReplayStart('s1', true, live)
    const before = live.slice()
    live.push({ id: 'after-reset' })
    noteReplayMessagesUpdate('s1', before, live)
    expect(getReplayAppendProvenance('s1')).toEqual([{ id: 'after-reset', seq: null }])
    endReplayFrame()
  })

  // --- lifetime: the record dies with the window, at all four teardowns -----

  it('the record dies with the window — last end, fresh start, reset, drop', () => {
    // The memory shape `ReplayWindow` states for the baseline, held to for the
    // provenance parked on it. It lives on the SAME record the two maps share,
    // so there is no fifth place to remember.
    const live: Msg[] = [{ id: 'old' }]
    reconcileReplayStart('s1', true, live)
    replayed('s1', live, 'r-1', 1)
    expect(getReplayAppendProvenance('s1')).toHaveLength(1)
    reconcileReplayEnd('s1', live) // the LAST end takes it with the swap
    expect(getReplayAppendProvenance('s1')).toBeNull()

    // A fresh window starts from an EMPTY record, never the previous window's.
    const live2: Msg[] = [{ id: 'r-1' }]
    reconcileReplayStart('s1', true, live2)
    expect(getReplayAppendProvenance('s1')).toEqual([])
    replayed('s1', live2, 'r-2', 2)
    resetReplayReconcile()
    expect(getReplayAppendProvenance('s1')).toBeNull()

    reconcileReplayStart('s2', true, [])
    const live3: Msg[] = []
    replayed('s2', live3, 'r-3', 3)
    expect(getReplayAppendProvenance('s2')).toHaveLength(1)
    dropReplaySessionState('s2')
    expect(getReplayAppendProvenance('s2')).toBeNull()
  })

  it('is a no-op outside a window, and per-session inside one', () => {
    const live: Msg[] = [{ id: 'a' }]
    // No window open for s1 at all.
    noteReplayMessagesUpdate('s1', [], live)
    expect(getReplayAppendProvenance('s1')).toBeNull()
    noteReplayMessagesUpdate(null, [], live)
    noteReplayMessagesUpdate('', [], live)

    reconcileReplayStart('s1', true, [])
    reconcileReplayStart('s2', true, [])
    const s1Live: Msg[] = []
    replayed('s1', s1Live, 'r-1', 1)
    expect(getReplayAppendProvenance('s1')).toHaveLength(1)
    expect(getReplayAppendProvenance('s2')).toEqual([])
  })

  it('a NESTED start keeps the outer window record — provenance spans the window', () => {
    // The record belongs to the window, not to a replay: the whole point of
    // #7519 is that a delta's appends and a nested full rebuild's appends sit in
    // ONE tail and have to be ordered against each other.
    const live: Msg[] = [{ id: 'old' }]
    reconcileReplayStart('s1', false, live)
    replayed('s1', live, 'd-1', 2)
    reconcileReplayStart('s1', true, live)
    expect(idsOf(getReplayAppendProvenance('s1'))).toEqual(['d-1'])
  })

  it('caps ONE window record and says so LOUDLY, degrading to array order', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const live: Msg[] = [{ id: 'old' }]
    reconcileReplayStart('s1', true, live)
    for (let i = 0; i <= MAX_REPLAY_APPEND_PROVENANCE; i++) {
      replayed('s1', live, `r-${i}`, MAX_REPLAY_APPEND_PROVENANCE - i)
    }
    // Dropped, never truncated: a truncated array is positionally WRONG, which
    // is the one state this record must not be in.
    expect(getReplayAppendProvenance('s1')).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    const line = String(warn.mock.calls[0]?.[0])
    expect(line).toContain('[replay-reconcile]')
    expect(line).toContain(String(MAX_REPLAY_APPEND_PROVENANCE))
    expect(line).toContain('s1')
    expect(line).toContain('#7519')

    // ...and the consequence the warn text claims, demonstrated: the swap keeps
    // everything and returns it in array order rather than by seq.
    const swapped = reconcileReplayEnd('s1', live).swappedMessages as Msg[]
    expect(swapped).toHaveLength(MAX_REPLAY_APPEND_PROVENANCE + 1)
    expect(swapped[0]?.id).toBe('r-0')
  })

  it('the cap does not fire on an ordinary replay (no warn)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const live: Msg[] = [{ id: 'old' }]
    reconcileReplayStart('s1', true, live)
    for (let i = 0; i < 50; i++) replayed('s1', live, `r-${i}`, i)
    reconcileReplayEnd('s1', live)
    expect(warn).not.toHaveBeenCalled()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })
})

// ---------------------------------------------------------------------------
// #7524 — the baseline is where the PREFIX ends, not an index that once was
// ---------------------------------------------------------------------------
//
// The baseline used to be an array INDEX captured at the window's 0->1
// transition and held until the last end. Nothing in the module owns
// `messages`, and three store paths REMOVE from it without touching the window:
// `sendInterrupt` (Stop) drops every queued bubble, `cancelQueuedMessage` drops
// one, `reorderEmptyResponseSlot` moves one to the end. After any of them the
// index addressed a different element and the swap cut there anyway.
//
// Both reproductions below are the #7522 reviewer's, verbatim, and both were
// measured RED before the fix: the first returned ['r3'] with r1 and r2
// silently gone, the second returned [] — a blanked transcript. The class is
// older than #7492: the same arithmetic bites a FULL-opened window whenever the
// shrink lands after the full start, which is the third case here.
describe('mid-window messages SHRINK moves the swap cut (#7524)', () => {
  it('keeps every replayed entry when Stop drops the queued bubbles mid-window', () => {
    // 2 history entries + 2 queued bubbles on screen; the user taps Stop
    // between the delta start and the nested full start.
    const live: Msg[] = [{ id: 'h1' }, { id: 'h2' }, { id: 'q1' }, { id: 'q2' }]
    reconcileReplayStart('s1', false, live) // outermost DELTA, prefix of 4
    live.splice(2, 2) // sendInterrupt: both queued bubbles dropped
    reconcileReplayStart('s1', true, live) // nested FULL adopts the WINDOW's prefix
    live.push({ id: 'r1' }, { id: 'r2' }, { id: 'r3' })

    expect(reconcileReplayEnd('s1', live).swappedMessages).toBeNull()
    // Pre-fix: [{ id: 'r3' }]. The cut sat at 4 — two entries into the replayed
    // tail — so r1 and r2 were sliced off with the prefix.
    expect(reconcileReplayEnd('s1', live).swappedMessages).toEqual([
      { id: 'r1' },
      { id: 'r2' },
      { id: 'r3' },
    ])
  })

  it('does not blank the transcript when the shrink is larger than the replay', () => {
    const live: Msg[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
    reconcileReplayStart('s1', false, live)
    live.length = 1
    reconcileReplayStart('s1', true, live)
    live.push({ id: 'r-1' })

    expect(reconcileReplayEnd('s1', live).swappedMessages).toBeNull()
    // Pre-fix: [] — the whole session, replayed set included, vanished.
    expect(reconcileReplayEnd('s1', live).swappedMessages).toEqual([{ id: 'r-1' }])
  })

  it('covers a shrink AFTER the start, under a FULL-opened window (pre-#7492 class)', () => {
    // No delta anywhere: this is the shape that bites `main`'s outermost-FULL
    // baseline, and the reason the fix is the baseline's SHAPE rather than
    // which of two lengths #7492 adopts.
    const live: Msg[] = [{ id: 'h1' }, { id: 'h2' }, { id: 'q1' }, { id: 'q2' }]
    reconcileReplayStart('s1', true, live) // outermost FULL, prefix of 4
    live.push({ id: 'r1' }) // the replay is already streaming...
    live.splice(2, 2) // ...when Stop drops the queued bubbles
    live.push({ id: 'r2' })

    // Pre-fix: [] — the cut at 4 landed exactly at the end of a 4-long array.
    expect(reconcileReplayEnd('s1', live).swappedMessages).toEqual([
      { id: 'r1' },
      { id: 'r2' },
    ])
  })

  it('moves the dedup cache with the swap, not independently of it', () => {
    // The cache and the swap read the SAME record through the same resolution.
    // If only one of them followed the shrink, a replayed entry would either be
    // suppressed by the about-to-be-discarded prefix or appended twice.
    const live: Msg[] = [{ id: 'h1' }, { id: 'h2' }, { id: 'q1' }, { id: 'q2' }]
    reconcileReplayStart('s1', false, live)
    live.splice(2, 2)
    reconcileReplayStart('s1', true, live)
    // Nothing replayed yet: the tail is empty, so nothing can dedup against it.
    expect(replayDedupCache('s1', live)).toEqual([])
    live.push({ id: 'r1' })
    // Pre-fix: [] — the cache sat past the end and r1 was invisible to dedup.
    expect(replayDedupCache('s1', live)).toEqual([{ id: 'r1' }])
    live.push({ id: 'r2' })
    expect(replayDedupCache('s1', live)).toEqual([{ id: 'r1' }, { id: 'r2' }])
    // ...and the swap agrees with the cache, exactly.
    expect(reconcileReplayEnd('s1', live).swappedMessages).toBeNull()
    expect(reconcileReplayEnd('s1', live).swappedMessages).toEqual([
      { id: 'r1' },
      { id: 'r2' },
    ])
  })

  it('handles a single-bubble cancel (cancelQueuedMessage), not just a bulk Stop', () => {
    const live: Msg[] = [{ id: 'h1' }, { id: 'cancel-me' }, { id: 'h2' }]
    reconcileReplayStart('s1', true, live)
    // `messages.filter((m) => m.id !== clientMessageId)` — a hole in the MIDDLE
    // of the prefix, which a "shrink from the end" assumption would miss.
    const idx = live.findIndex((m) => m.id === 'cancel-me')
    live.splice(idx, 1)
    live.push({ id: 'r-1' })

    expect(reconcileReplayEnd('s1', live).swappedMessages).toEqual([{ id: 'r-1' }])
  })

  it('handles a removal at the FRONT of the prefix', () => {
    const live: Msg[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    reconcileReplayStart('s1', true, live)
    live.splice(0, 1)
    live.push({ id: 'r-1' })

    expect(reconcileReplayEnd('s1', live).swappedMessages).toEqual([{ id: 'r-1' }])
  })

  it('handles the prefix being removed ENTIRELY (cut collapses to 0, nothing lost)', () => {
    const live: Msg[] = [{ id: 'a' }, { id: 'b' }]
    reconcileReplayStart('s1', false, live)
    live.length = 0
    reconcileReplayStart('s1', true, live)
    live.push({ id: 'r-1' })

    expect(reconcileReplayEnd('s1', live).swappedMessages).toBeNull()
    expect(reconcileReplayEnd('s1', live).swappedMessages).toEqual([{ id: 'r-1' }])
  })

  it("follows reorderEmptyResponseSlot's move-to-the-end", () => {
    // `message-handler.ts:2498-2511` — length-preserving, but it takes an entry
    // out of the prefix and puts it at the very end of the array, i.e. inside
    // the tail. The cut has to come back by one or the swap keeps a message the
    // rebuild is replacing AND loses the last replayed entry.
    const live: Msg[] = [{ id: 'a' }, { id: 'empty-slot' }, { id: 'c' }]
    reconcileReplayStart('s1', true, live)
    const slot = live.splice(1, 1)[0]!
    live.push({ id: 'r-1' }, slot)

    expect(reconcileReplayEnd('s1', live).swappedMessages).toEqual([
      { id: 'r-1' },
      { id: 'empty-slot' },
    ])
  })

  it('is per-session — s2 shrinking does not move s1 cut', () => {
    const s1Live: Msg[] = [{ id: 'a' }, { id: 'b' }]
    const s2Live: Msg[] = [{ id: 'x' }, { id: 'y' }]
    reconcileReplayStart('s1', true, s1Live)
    reconcileReplayStart('s2', true, s2Live)
    s2Live.length = 0
    s1Live.push({ id: 'r-1' })

    expect(reconcileReplayEnd('s1', s1Live).swappedMessages).toEqual([{ id: 'r-1' }])
  })

  // --- the two boundaries of the mechanism ---------------------------------

  it('an APPEND-ONLY window cuts at exactly openLen — the resolution is a no-op', () => {
    // The positive control for every other describe in this file: with nothing
    // removed, the walk consumes the whole prefix and returns the same number
    // the pre-#7524 index held. If this ever drifts, the #5555.4 / #5588 /
    // #7477 / #7492 blocks are no longer measuring what they claim to.
    const live: Msg[] = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }]
    reconcileReplayStart('s1', true, live)
    // The full replay re-delivers the SAME ids it is replacing — the case where
    // a search-ahead resolution would match a prefix id against its own
    // re-delivered copy and cut past the replayed set.
    live.push({ id: 'p1' }, { id: 'p2' }, { id: 'p3' })

    expect(reconcileReplayEnd('s1', live).swappedMessages).toEqual([
      { id: 'p1' },
      { id: 'p2' },
      { id: 'p3' },
    ])
  })

  it('a removed id RE-DELIVERED into the tail must not pull the cut past it', () => {
    // The reason the walk is greedy-but-positional rather than a search-ahead.
    // A search allowed to skip forward finds the removed 'q1' at index 2 — its
    // re-delivered copy, inside the replayed tail — and cuts there, returning []
    // and blanking the session. The walk here halts instead, because the message
    // AT the cut ('r-1') continues no remaining prefix id.
    //
    // Note what this does NOT show, since the comment here used to claim it: the
    // walk does not "stop at the first mismatch" and cannot "only ever cut
    // SHORT". It skips a non-matching prefix id and tries the next against the
    // same message — which is what makes `handles a removal at the FRONT of the
    // prefix` pass — and it can march into the tail when the surviving prefix
    // runs out. The 'r-1' between the survivor and the re-delivered 'q1' is what
    // stops it here. Both of those cases are pinned below (#7543).
    const live: Msg[] = [{ id: 'h1' }, { id: 'q1' }]
    reconcileReplayStart('s1', true, live)
    live.splice(1, 1) // the queued bubble is cancelled...
    live.push({ id: 'r-1' }, { id: 'q1' }) // ...and the replay delivers an entry reusing its id

    expect(reconcileReplayEnd('s1', live).swappedMessages).toEqual([
      { id: 'r-1' },
      { id: 'q1' },
    ])
  })

  // --- what the walk alone does NOT cover, and what provenance adds (#7543) -
  //
  // `messages[0..cut)` is the greedy SUBSEQUENCE match of `prefixIds`, so once
  // the surviving prefix runs out the walk continues into the appended tail if
  // the tail keeps matching — and a full replay re-delivers exactly the ids the
  // prefix held. Measured on `main` AND on the pre-#7519 branch point: [] and
  // ['c'], the replayed set discarded both times.
  //
  // The walk still does that; nothing here changed it, because nothing id-based
  // can (the pin below is the proof, and it stays). What changed is that the cut
  // is no longer the walk ALONE: `resolveCut` also knows how many entries the
  // window APPENDED, and everything a window appended is past the prefix by
  // definition. The smaller of the two wins, so these two shapes now keep the
  // replayed set — and the legitimate empty replay beside them, which recorded
  // ZERO appends, still swaps to [].
  it('whole prefix removed + same ids re-delivered keeps the replayed set (#7543)', () => {
    const live: Msg[] = [{ id: 'a' }, { id: 'b' }]
    reconcileReplayStart('s1', true, live)
    // Stop drops every queued bubble mid-window, reported through the same
    // observation hook both clients' `updateSession` carries.
    frame('s1', live, null, (m) => { m.length = 0 })
    // The replay re-delivers them in order, through the dedup gate exactly as
    // both clients drive it.
    replayed('s1', live, 'a', 1)
    replayed('s1', live, 'b', 2)
    // The replayed set IS there — the fixture took effect — and the swap now
    // keeps it. Measured [] before #7519.
    expect(live.map((m) => m.id)).toEqual(['a', 'b'])
    expect(reconcileReplayEnd('s1', live).swappedMessages).toEqual([{ id: 'a' }, { id: 'b' }])
  })

  it('a removal followed by its id being re-appended moves the cut to 0 (#7543)', () => {
    const live: Msg[] = [{ id: 'a' }, { id: 'b' }]
    reconcileReplayStart('s1', true, live)
    frame('s1', live, null, (m) => { m.splice(0, 2) }) // two removed
    replayed('s1', live, 'a', 1)
    replayed('s1', live, 'b', 2)
    replayed('s1', live, 'c', 3)
    // The walk still says 2 ('a' and 'b' re-match the prefix ids from the tail);
    // the provenance says three entries were appended, so the cut is 0. Measured
    // ['c'] before #7519.
    expect(reconcileReplayEnd('s1', live).swappedMessages).toEqual([
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ])
  })

  it('the same two shapes still blank/truncate when provenance is UNAVAILABLE', () => {
    // The other direction, kept because removing it would leave the pair above
    // reading as "the walk was fixed". It was not: with no record to consult —
    // an un-instrumented store path, an id-less append, a window past the cap —
    // `resolveCut` is the walk and the pre-#7519 values come straight back.
    const live: Msg[] = [{ id: 'a' }, { id: 'b' }]
    reconcileReplayStart('s1', true, live)
    live.length = 0
    for (const id of ['a', 'b']) {
      const cache = replayDedupCache('s1', live) as Msg[]
      if (!cache.some((m) => m.id === id)) live.push({ id })
    }
    expect(live.map((m) => m.id)).toEqual(['a', 'b'])
    expect(reconcileReplayEnd('s1', live).swappedMessages).toEqual([])

    const live2: Msg[] = [{ id: 'a' }, { id: 'b' }]
    reconcileReplayStart('s2', true, live2)
    live2.splice(0, 2)
    live2.push({ id: 'a' }, { id: 'b' }, { id: 'c' })
    expect(reconcileReplayEnd('s2', live2).swappedMessages).toEqual([{ id: 'c' }])
  })

  // WHY those two shapes could not be fixed from the ids — mechanically, not in
  // prose, and STILL TRUE. The module's entire view of `messages` is `idOf` (its
  // only reader), and its entire record of the prefix is `prefixIds`. The two
  // states below present the SAME id sequence against the SAME recorded prefix
  // while their CORRECT answers differ, so no function of those two inputs can
  // serve both:
  //
  //   A  legitimate empty replay — prefix intact, the server trimmed history to
  //      nothing. Correct swap `[]`, pinned by `empty replay (baseline at end)
  //      swaps to []`.
  //   B  the #7543 degenerate — whole prefix removed, replay re-delivered the
  //      same ids. Correct swap `[a, b]`.
  //
  // Any resolver that returns `[a, b]` for B returns it for A too, and breaks
  // the empty-replay contract in the same motion. That rules out all three
  // id-only shapes proposed for #7543 — a degenerate-outcome guard ("never
  // return an empty swap when the walk consumed everything"), an
  // `openLen`-bounded fallback, and a survivor-anchor requirement — because each
  // is a function of exactly these inputs. What was left is provenance per
  // append: `historySeq` present ⇒ replayed, observed at the call sites, which
  // is #7519 — and which is what the second half of this test now measures. The
  // first half is unchanged and stays unchanged: it is the reason no future
  // id-only "fix" may be accepted here, and deleting it once the answer arrived
  // would leave nothing refusing the next one.
  //
  // Object identity is not the escape hatch either. A mid-window UPDATE to a
  // prefix message REPLACES its object (`{ ...m, … }` — `finalizeThinkingStreams`
  // in handlers/stream.ts, `peelSlotContent` in each client's message-handler,
  // every tool_result patch), so an identity walk would stall at the first
  // streamed-into or patched prefix entry and collapse the cut to an identity
  // slice: #7477's failure, on a far more reachable path than this one.
  //
  // This test is the REASON the two expectations above read as they do — first
  // that they were pinned, now that they are what they are.
  it('#7543 is undecidable from the IDS, and DECIDED by the provenance (#7519)', () => {
    // The cut the module resolves, read through the one public surface that
    // exposes it: `replayDedupCache` returns `messages.slice(cut)`.
    const cutOf = (sid: string, messages: Msg[]) =>
      messages.length - (replayDedupCache(sid, messages) as Msg[]).length

    // --- A: prefix intact, replay delivered nothing. Correct swap: [].
    const a: Msg[] = [{ id: 'a' }, { id: 'b' }]
    reconcileReplayStart('sA', true, a)

    // --- B: whole prefix removed, replay re-delivered the same ids through the
    // dedup gate exactly as both clients drive it. Correct swap: [a, b].
    const b: Msg[] = [{ id: 'a' }, { id: 'b' }]
    reconcileReplayStart('sB', true, b)
    b.length = 0
    for (const id of ['a', 'b']) {
      const cache = replayDedupCache('sB', b) as Msg[]
      if (!cache.some((m) => m.id === id)) b.push({ id })
    }
    // Both fixtures took effect and are genuinely distinct histories...
    expect(b.map((m) => m.id)).toEqual(['a', 'b'])

    // ...and the module cannot tell them apart: same ids, same resolved cut.
    expect(a.map((m) => m.id)).toEqual(b.map((m) => m.id))
    expect(cutOf('sA', a)).toBe(cutOf('sB', b))
    expect(reconcileReplayEnd('sA', a).swappedMessages).toEqual(
      reconcileReplayEnd('sB', b).swappedMessages,
    )

    // The same holds for the second #7543 shape, where the correct answers are
    // ['c'] (A2: prefix intact, one entry replayed) and ['a','b','c'] (B2: the
    // prefix removed and all three replayed).
    const a2: Msg[] = [{ id: 'a' }, { id: 'b' }]
    reconcileReplayStart('sA2', true, a2)
    a2.push({ id: 'c' })

    const b2: Msg[] = [{ id: 'a' }, { id: 'b' }]
    reconcileReplayStart('sB2', true, b2)
    b2.splice(0, 2)
    b2.push({ id: 'a' }, { id: 'b' }, { id: 'c' })

    expect(a2.map((m) => m.id)).toEqual(b2.map((m) => m.id))
    expect(cutOf('sA2', a2)).toBe(cutOf('sB2', b2))
    expect(reconcileReplayEnd('sA2', a2).swappedMessages).toEqual(
      reconcileReplayEnd('sB2', b2).swappedMessages,
    )

    // --- and now the SAME two histories, driven through the observation hook
    // both clients carry since #7519. The ids are still identical — that half is
    // not repaired and cannot be — but the module is no longer looking only at
    // ids, and the two now resolve to their own correct answers.
    const c: Msg[] = [{ id: 'a' }, { id: 'b' }]
    reconcileReplayStart('sC', true, c) // A again: prefix intact, nothing replayed

    const d: Msg[] = [{ id: 'a' }, { id: 'b' }]
    reconcileReplayStart('sD', true, d) // B again: prefix removed, ids re-delivered
    frame('sD', d, null, (m) => { m.length = 0 })
    replayed('sD', d, 'a', 1)
    replayed('sD', d, 'b', 2)

    expect(c.map((m) => m.id)).toEqual(d.map((m) => m.id))
    // The distinguishing input, named: zero appends against two.
    expect(getReplayAppendProvenance('sC')).toEqual([])
    expect(idsOf(getReplayAppendProvenance('sD'))).toEqual(['a', 'b'])
    expect(reconcileReplayEnd('sC', c).swappedMessages).toEqual([]) // still correct
    expect(reconcileReplayEnd('sD', d).swappedMessages).toEqual([{ id: 'a' }, { id: 'b' }])
  })

  it('but ONE survivor at the front already keeps more than the raw index does', () => {
    // The positive control for the two pins above — without it they read as "the
    // mechanism does nothing". Same re-delivery, one prefix entry surviving: the
    // walk halts on it and the replayed set is kept. `main`'s raw index returns
    // ['b'] here, losing the re-delivered 'a'; this returns both.
    const live: Msg[] = [{ id: 'a' }, { id: 'b' }]
    reconcileReplayStart('s1', true, live)
    live.length = 1 // 'a' survives
    for (const id of ['a', 'b']) {
      const cache = replayDedupCache('s1', live) as Msg[]
      if (!cache.some((m) => m.id === id)) live.push({ id })
    }
    expect(reconcileReplayEnd('s1', live).swappedMessages).toEqual([
      { id: 'a' },
      { id: 'b' },
    ])
  })

  it('degrades to the plain index — never to 0 — when the prefix has an un-idable entry', () => {
    // `snapshotPrefix` bails rather than recording a hole. A hole would stall
    // the walk and collapse the cut towards 0, i.e. an identity slice: a swap
    // that silently never happens and leaves the discarded prefix on screen,
    // which is #7477's failure rather than this one's. No ChatMessage reaches
    // this, so the pin is on the FLOOR, not on a live path.
    const live: Msg[] = [{} as Msg, { id: 'h2' }]
    reconcileReplayStart('s1', true, live)
    live.push({ id: 'r-1' })
    expect(reconcileReplayEnd('s1', live).swappedMessages).toEqual([{ id: 'r-1' }])
  })
})

// ---------------------------------------------------------------------------
// #7456 — ledger lifetime: release at replay end, teardown, and a loud cap
// ---------------------------------------------------------------------------
describe('live-arrival ledger lifetime (#7456)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('releases the per-session ledger when the LAST window closes, while the sweep can still read it', () => {
    reconcileReplayStart('s1', false, [])
    noteLivePromptDuringReplay('s1', 'q1')
    expect(getLiveReplayLedgerSessionIds()).toEqual(['s1'])

    reconcileReplayEnd('s1', [])
    // The caller runs the sweep immediately after `reconcileReplayEnd` returns,
    // so the evidence must still be readable...
    expect(wasPromptLiveDuringReplay('s1', 'q1')).toBe(true)
    expect(sweepUnansweredPromptsAtReplayEnd('s1', [prompt('q1')])).toBeNull()
    // ...but it is no longer RETAINED per-session: nothing accumulates for a
    // session that is replayed once and then pruned.
    expect(getLiveReplayLedgerSessionIds()).toEqual([])
  })

  it('does not release while an overlapping replay is still open (#7455 interaction)', () => {
    reconcileReplayStart('s1', false, [])
    reconcileReplayStart('s1', false, [])
    noteLivePromptDuringReplay('s1', 'q1')
    reconcileReplayEnd('s1', [])
    expect(getLiveReplayLedgerSessionIds()).toEqual(['s1'])
    reconcileReplayEnd('s1', [])
    expect(getLiveReplayLedgerSessionIds()).toEqual([])
  })

  it('dropReplaySessionState forgets one session entirely and leaves the others alone', () => {
    reconcileReplayStart('s1', true, prefix(3))
    noteLivePromptDuringReplay('s1', 'q1')
    recordHistorySeq('s1', 11)
    reconcileReplayStart('s2', true, [])
    noteLivePromptDuringReplay('s2', 'q2')
    recordHistorySeq('s2', 22)

    dropReplaySessionState('s1')

    expect(getReplayWindowDepth('s1')).toBe(0)
    expect(getLiveReplayLedgerSessionIds()).toEqual(['s2'])
    expect(wasPromptLiveDuringReplay('s1', 'q1')).toBe(false)
    expect(isRebuildInProgress('s1')).toBe(false)
    expect(getHistoryCursor('s1')).toBeUndefined()
    // s2 untouched.
    expect(getReplayWindowDepth('s2')).toBe(1)
    expect(wasPromptLiveDuringReplay('s2', 'q2')).toBe(true)
    expect(isRebuildInProgress('s2')).toBe(true)
    expect(getHistoryCursor('s2')).toBe(22)
  })

  it('dropReplaySessionState also drops a ledger already released to the sweep', () => {
    reconcileReplayStart('s1', false, [])
    noteLivePromptDuringReplay('s1', 'q1')
    reconcileReplayEnd('s1', [])
    expect(wasPromptLiveDuringReplay('s1', 'q1')).toBe(true)
    dropReplaySessionState('s1')
    expect(wasPromptLiveDuringReplay('s1', 'q1')).toBe(false)
  })

  it('ignores a null/empty session id', () => {
    reconcileReplayStart('s1', false, [])
    noteLivePromptDuringReplay('s1', 'q1')
    dropReplaySessionState(null)
    dropReplaySessionState('')
    dropReplaySessionState(undefined)
    expect(wasPromptLiveDuringReplay('s1', 'q1')).toBe(true)
  })

  // The socket-drop leak. A drop mid-replay means `history_replay_end` never
  // arrives, so with a refcounted window the stranded +1 would keep the session
  // permanently "in replay": its ledger would never be released and every later
  // prompt would be protected forever. Both clients now call
  // `resetReplayReconcile()` from `socket.onclose`/`socket.onerror`.
  it('a drop mid-replay strands nothing once the transport teardown runs', () => {
    reconcileReplayStart('s1', true, [])
    noteLivePromptDuringReplay('s1', 'q1')
    recordHistorySeq('s1', 5)

    resetReplayReconcile() // socket.onclose / socket.onerror

    expect(getReplayWindowDepth('s1')).toBe(0)
    expect(getLiveReplayLedgerSessionIds()).toEqual([])
    expect(wasPromptLiveDuringReplay('s1', 'q1')).toBe(false)
    expect(isRebuildInProgress('s1')).toBe(false)
    // Cursors are NOT transport state — they are what makes the reconnect a
    // delta replay instead of a full rebuild.
    expect(getHistoryCursor('s1')).toBe(5)

    // ...and the #7420 protection still works on the NEXT replay.
    reconcileReplayStart('s1', false, [])
    noteLivePromptDuringReplay('s1', 'q2')
    reconcileReplayEnd('s1', [])
    expect(
      sweepUnansweredPromptsAtReplayEnd('s1', [prompt('q1'), prompt('q2')]),
    ).toEqual([
      { id: 'q1', type: 'prompt', answered: REPLAY_RESOLVED_PLACEHOLDER },
      { id: 'q2', type: 'prompt' },
    ])
  })

  it('caps the ledger map and says so LOUDLY — never a silent truncation', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // One open window with one live question per session, one past the cap.
    for (let i = 0; i < MAX_LIVE_REPLAY_LEDGERS + 1; i++) {
      const sid = `s${i}`
      reconcileReplayStart(sid, false, [])
      noteLivePromptDuringReplay(sid, `q-${i}`)
    }
    expect(getLiveReplayLedgerSessionIds()).toHaveLength(MAX_LIVE_REPLAY_LEDGERS)
    // LRU: the least-recently-noted session is the one evicted, never the
    // just-touched one.
    expect(getLiveReplayLedgerSessionIds()).not.toContain('s0')
    expect(getLiveReplayLedgerSessionIds()).toContain(`s${MAX_LIVE_REPLAY_LEDGERS}`)
    expect(wasPromptLiveDuringReplay('s0', 'q-0')).toBe(false)
    // ...and the consequence the warn text claims, demonstrated rather than
    // implied: the evicted session's question is now stampable again.
    reconcileReplayEnd('s0', [])
    expect(sweepUnansweredPromptsAtReplayEnd('s0', [prompt('q-0')])).toEqual([
      { id: 'q-0', type: 'prompt', answered: REPLAY_RESOLVED_PLACEHOLDER },
    ])

    // The log names the module, the cap, the evicted session AND the
    // consequence — an evicted ledger un-protects a racing AskUserQuestion.
    expect(warn).toHaveBeenCalledTimes(1)
    const line = String(warn.mock.calls[0]?.[0])
    expect(line).toContain('[replay-reconcile]')
    expect(line).toContain(String(MAX_LIVE_REPLAY_LEDGERS))
    expect(line).toContain('s0')
    expect(line).toContain('#7456')
    expect(line).toContain(REPLAY_RESOLVED_PLACEHOLDER)
  })

  it('re-noting an existing session refreshes its recency so it is not the one evicted', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (let i = 0; i < MAX_LIVE_REPLAY_LEDGERS; i++) {
      reconcileReplayStart(`s${i}`, false, [])
      noteLivePromptDuringReplay(`s${i}`, `q-${i}`)
    }
    // Touch the oldest so it moves to the tail...
    noteLivePromptDuringReplay('s0', 'q-0-again')
    // ...then overflow by one: s1 (now the oldest) goes, s0 stays.
    reconcileReplayStart('overflow', false, [])
    noteLivePromptDuringReplay('overflow', 'q-overflow')

    expect(getLiveReplayLedgerSessionIds()).toContain('s0')
    expect(getLiveReplayLedgerSessionIds()).not.toContain('s1')
    expect(wasPromptLiveDuringReplay('s0', 'q-0')).toBe(true)
  })

  it('the cap does not fire in the normal case (no warn for a single session)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    reconcileReplayStart('s1', false, [])
    noteLivePromptDuringReplay('s1', 'q1')
    noteLivePromptDuringReplay('s1', 'q2')
    reconcileReplayEnd('s1', [])
    expect(warn).not.toHaveBeenCalled()
  })
})
