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
} from './replay-reconcile'

type Msg = { id: string }

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
    const { rebuildInProgress } = reconcileReplayStart('s1', false, 3)
    expect(rebuildInProgress).toBe(false)
    expect(isRebuildInProgress('s1')).toBe(false)
  })

  it('reconcileReplayEnd returns null swap for a delta replay (messages untouched)', () => {
    reconcileReplayStart('s1', false, 3)
    const { swappedMessages } = reconcileReplayEnd('s1', [{ id: 'a' }])
    expect(swappedMessages).toBeNull()
  })

  it('start frame latestSeq does NOT advance the cursor (mid-replay drop safety)', () => {
    // The cursor must only finalise once the slice is fully delivered (at end),
    // so a socket drop mid-replay can't claim un-applied entries.
    reconcileReplayStart('s1', false, 0, 12)
    expect(getHistoryCursor('s1')).toBeUndefined()
  })

  it('END frame latestSeq advances the cursor even with no entries (already current)', () => {
    reconcileReplayStart('s1', false, 0, 12)
    reconcileReplayEnd('s1', [], 12)
    expect(getHistoryCursor('s1')).toBe(12)
  })

  it('delta replay dedups against the WHOLE message array', () => {
    reconcileReplayStart('s1', false, 2)
    const msgs: Msg[] = [{ id: 'a' }, { id: 'b' }]
    expect(replayDedupCache('s1', msgs)).toEqual(msgs)
  })
})

describe('full rebuild — deferred atomic swap, no blank flash (#5555.4)', () => {
  it('keeps a rebuild in progress and does NOT wipe (caller leaves messages visible)', () => {
    const { rebuildInProgress } = reconcileReplayStart('s1', true, 3)
    expect(rebuildInProgress).toBe(true)
    expect(isRebuildInProgress('s1')).toBe(true)
  })

  it('dedup cache is scoped to the appended tail so the discarded prefix cannot suppress a replayed entry', () => {
    // 3 pre-existing messages; replay starts → baseline 3. The tail (entries
    // appended during replay) is what we dedup against, NOT the prefix.
    reconcileReplayStart('s1', true, 3)
    const msgs: Msg[] = [
      { id: 'old-1' }, { id: 'old-2' }, { id: 'old-3' }, // prefix (discarded)
      { id: 'new-1' }, // replayed so far
    ]
    expect(replayDedupCache('s1', msgs)).toEqual([{ id: 'new-1' }])
  })

  it('end swaps messages down to exactly the replayed tail in one update', () => {
    reconcileReplayStart('s1', true, 2)
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
    reconcileReplayStart('s1', true, 2)
    const { swappedMessages } = reconcileReplayEnd('s1', [{ id: 'old-1' }, { id: 'old-2' }])
    expect(swappedMessages).toEqual([])
  })

  it('messages are never empty mid-replay (no blank flash invariant)', () => {
    // The prefix is preserved in the live array the WHOLE time; only the final
    // reconcileReplayEnd swap changes identity. We assert that dedupCache always
    // exposes a non-destructive view and that no API zeroes the array mid-flight.
    const live: Msg[] = [{ id: 'old-1' }, { id: 'old-2' }, { id: 'old-3' }]
    reconcileReplayStart('s1', true, live.length)
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
    reconcileReplayStart('s1', true, 1)
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

  it('a flush landing AFTER end appends to the already-swapped set with no duplication', () => {
    reconcileReplayStart('s1', true, 1)
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
      reconcileReplayStart('s1', false, 0)
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
      reconcileReplayStart('s1', false, 0)
      reconcileReplayEnd('s1', [])
      expect(sweepUnansweredPromptsAtReplayEnd('s1', [prompt('q1')])).toEqual([
        { id: 'q1', type: 'prompt', answered: REPLAY_RESOLVED_PLACEHOLDER },
      ])
    })

    it('opens the window for a DELTA replay too, not just a full rebuild', () => {
      // `_rebuildBaseline` only tracks full rebuilds, so the window has to be
      // its own thing — a live question races a delta replay just as easily.
      reconcileReplayStart('s1', false, 0)
      expect(isRebuildInProgress('s1')).toBe(false)
      noteLivePromptDuringReplay('s1', 'q1')
      expect(wasPromptLiveDuringReplay('s1', 'q1')).toBe(true)
    })

    it('closes the window at replay end — a later arrival is not protected', () => {
      reconcileReplayStart('s1', true, 0)
      reconcileReplayEnd('s1', [])
      noteLivePromptDuringReplay('s1', 'after-q')
      expect(wasPromptLiveDuringReplay('s1', 'after-q')).toBe(false)
    })

    it('forgets the previous window at the next start', () => {
      reconcileReplayStart('s1', false, 0)
      noteLivePromptDuringReplay('s1', 'q1')
      reconcileReplayEnd('s1', [])
      expect(wasPromptLiveDuringReplay('s1', 'q1')).toBe(true)
      // Second replay: q1 is now just an old on-screen prompt with nothing
      // vouching for it, so the sweep is entitled to stamp it again.
      reconcileReplayStart('s1', false, 1)
      expect(wasPromptLiveDuringReplay('s1', 'q1')).toBe(false)
      reconcileReplayEnd('s1', [])
      expect(sweepUnansweredPromptsAtReplayEnd('s1', [prompt('q1')])).toEqual([
        { id: 'q1', type: 'prompt', answered: REPLAY_RESOLVED_PLACEHOLDER },
      ])
    })

    it("is per-session — s2's window does not protect a prompt in s1", () => {
      reconcileReplayStart('s2', false, 0)
      noteLivePromptDuringReplay('s1', 'q1')
      expect(wasPromptLiveDuringReplay('s1', 'q1')).toBe(false)
      expect(sweepUnansweredPromptsAtReplayEnd('s1', [prompt('q1')])).toEqual([
        { id: 'q1', type: 'prompt', answered: REPLAY_RESOLVED_PLACEHOLDER },
      ])
    })

    it('ignores a null session id or message id', () => {
      reconcileReplayStart('s1', false, 0)
      noteLivePromptDuringReplay(null, 'q1')
      noteLivePromptDuringReplay('s1', null)
      noteLivePromptDuringReplay('s1', '')
      expect(wasPromptLiveDuringReplay('s1', 'q1')).toBe(false)
      expect(wasPromptLiveDuringReplay(null, 'q1')).toBe(false)
      expect(wasPromptLiveDuringReplay('s1', null)).toBe(false)
    })

    it('resetReplayReconcile drops the window and the ledger (fresh auth)', () => {
      reconcileReplayStart('s1', false, 0)
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
    reconcileReplayStart('s1', true, 0) // subscribe_sessions (forceFull)
    reconcileReplayStart('s1', true, 0) // switch_session (forceFull), replay #1 still streaming
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
    reconcileReplayStart('s1', false, 0)
    noteLivePromptDuringReplay('s1', 'q0')
    expect(wasPromptLiveDuringReplay('s1', 'q0')).toBe(true)
    // Replay #2 starts while #1 is in flight: the outer window is still
    // protecting q0, so its evidence must survive.
    reconcileReplayStart('s1', true, 0)
    expect(wasPromptLiveDuringReplay('s1', 'q0')).toBe(true)
  })

  it('refcounts the window: depth climbs per start and returns to 0 on balanced ends', () => {
    expect(getReplayWindowDepth('s1')).toBe(0)
    reconcileReplayStart('s1', false, 0)
    expect(getReplayWindowDepth('s1')).toBe(1)
    reconcileReplayStart('s1', false, 0)
    expect(getReplayWindowDepth('s1')).toBe(2)
    reconcileReplayEnd('s1', [])
    expect(getReplayWindowDepth('s1')).toBe(1)
    reconcileReplayEnd('s1', [])
    expect(getReplayWindowDepth('s1')).toBe(0)
  })

  it('is per-session — s2 starting a replay does not hold s1 window open', () => {
    reconcileReplayStart('s1', false, 0)
    reconcileReplayStart('s2', false, 0)
    reconcileReplayEnd('s1', [])
    expect(getReplayWindowDepth('s1')).toBe(0)
    expect(getReplayWindowDepth('s2')).toBe(1)
    noteLivePromptDuringReplay('s1', 'after-q')
    expect(wasPromptLiveDuringReplay('s1', 'after-q')).toBe(false)
  })

  it('an unmatched end cannot drive the depth negative (a later start still opens once)', () => {
    reconcileReplayEnd('s1', [])
    expect(getReplayWindowDepth('s1')).toBe(0)
    reconcileReplayStart('s1', false, 0)
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
    reconcileReplayStart('s1', true, 0) // replay #1 — subscribe_sessions (forceFull)
    const messages: Msg[] = [{ id: 'live-q' }] // a LIVE arrival during replay #1
    reconcileReplayStart('s1', true, messages.length) // replay #2 — switch_session (forceFull)

    // end#1 must NOT swap — replay #2 is still streaming, so the array is not
    // yet the authoritative set. Pre-fix this returned [] and 'live-q' was gone.
    expect(reconcileReplayEnd('s1', messages).swappedMessages).toBeNull()
    // end#2 closes the last window and swaps at the OUTER baseline (0).
    expect(reconcileReplayEnd('s1', messages).swappedMessages).toEqual([{ id: 'live-q' }])
  })

  it('the single swap is the union of both replays appended tails, prefix still dropped', () => {
    reconcileReplayStart('s1', true, 2) // prefix [old-1, old-2] stays visible
    const live: Msg[] = [{ id: 'old-1' }, { id: 'old-2' }, { id: 'r1-a' }]
    reconcileReplayStart('s1', true, live.length) // replay #2 starts mid-#1
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
    reconcileReplayStart('s1', true, 1)
    const live: Msg[] = [{ id: 'old' }, { id: 'r1-a' }]
    reconcileReplayStart('s1', true, live.length)
    // Replay #2 re-delivers r1-a. It must be inside the dedup cache or it is
    // appended a second time; pre-fix the cache was rescoped to 2 and missed it.
    expect(replayDedupCache('s1', live)).toEqual([{ id: 'r1-a' }])
  })

  it('a rebuild is still in progress after end#1 and cleared after the LAST end', () => {
    reconcileReplayStart('s1', true, 0)
    reconcileReplayStart('s1', true, 0)
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
    reconcileReplayStart('s1', true, 1) // full rebuild, baseline 1
    const live: Msg[] = [{ id: 'old' }, { id: 'r-1' }]
    // The nested delta reports the rebuild that is still in flight, rather than
    // the kind of replay it is itself.
    expect(reconcileReplayStart('s1', false, live.length).rebuildInProgress).toBe(true)
    expect(isRebuildInProgress('s1')).toBe(true)
    expect(reconcileReplayEnd('s1', live).swappedMessages).toBeNull()
    expect(reconcileReplayEnd('s1', live).swappedMessages).toEqual([{ id: 'r-1' }])
  })

  it('SEQUENTIAL full replays each capture a FRESH baseline', () => {
    // "Set only when absent" must not retain a baseline past the last end, or
    // the second replay would keep the first one's messages forever.
    reconcileReplayStart('s1', true, 0)
    expect(reconcileReplayEnd('s1', [{ id: 'r-1' }]).swappedMessages).toEqual([{ id: 'r-1' }])
    reconcileReplayStart('s1', true, 1)
    expect(
      reconcileReplayEnd('s1', [{ id: 'r-1' }, { id: 'r-2' }]).swappedMessages,
    ).toEqual([{ id: 'r-2' }])
  })

  it('is per-session: s2 overlapping replays do not defer s1 swap', () => {
    reconcileReplayStart('s1', true, 1)
    reconcileReplayStart('s2', true, 0)
    reconcileReplayStart('s2', true, 0)
    expect(reconcileReplayEnd('s1', [{ id: 'old' }, { id: 'r-1' }]).swappedMessages).toEqual([
      { id: 'r-1' },
    ])
  })

  it('teardown clears a deferred overlap — a mid-replay socket drop cannot wedge the swap', () => {
    // The deferral is what makes this load-bearing: a start with no matching end
    // strands a +1, and every later end would then decrement from a too-high
    // base and never swap again for that session.
    reconcileReplayStart('s1', true, 0)
    reconcileReplayStart('s1', true, 0)
    resetReplayReconcile()
    expect(isRebuildInProgress('s1')).toBe(false)
    expect(getReplayWindowDepth('s1')).toBe(0)

    reconcileReplayStart('s1', true, 0)
    reconcileReplayStart('s1', true, 0)
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
    reconcileReplayStart('s1', false, 0) // outermost = DELTA (handshake, cursor path)
    const live: Msg[] = [{ id: 'racer' }] // a LIVE arrival during the delta window
    reconcileReplayStart('s1', true, live.length) // nested FULL start
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
    reconcileReplayStart('s1', false, live.length) // outermost DELTA at length 2
    live.push({ id: 'racer' }) // live arrival inside the delta window
    reconcileReplayStart('s1', true, live.length) // nested FULL — must adopt 2, not 3
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
    reconcileReplayStart('s1', false, live.length)
    live.push({ id: 'racer' })
    reconcileReplayStart('s1', true, live.length)

    expect(replayDedupCache('s1', live)).toEqual([{ id: 'racer' }])
  })

  it('keeps a racer that arrives DURING the nested full rebuild (control — green pre-fix)', () => {
    // The other side of the interleave: nothing is appended between the delta
    // start and the full start, so the two baselines coincide and this case was
    // already correct. Here so the fix is pinned as covering BOTH racer
    // positions rather than trading one for the other.
    reconcileReplayStart('s1', false, 0)
    reconcileReplayStart('s1', true, 0)
    const live: Msg[] = [{ id: 'racer' }]
    live.push({ id: 'r-1' })

    expect(reconcileReplayEnd('s1', live).swappedMessages).toBeNull()
    expect(reconcileReplayEnd('s1', live).swappedMessages).toEqual([
      { id: 'racer' },
      { id: 'r-1' },
    ])
  })

  it('reports the rebuild the nested full started, not the delta that opened the window', () => {
    expect(reconcileReplayStart('s1', false, 0).rebuildInProgress).toBe(false)
    expect(isRebuildInProgress('s1')).toBe(false)
    expect(reconcileReplayStart('s1', true, 0).rebuildInProgress).toBe(true)
    expect(isRebuildInProgress('s1')).toBe(true)
    expect(getReplayWindowDepth('s1')).toBe(2)
  })

  it('does not leak the window-open length into the NEXT window', () => {
    // The recorded length lives exactly as long as the refcount does. A stale
    // 5 here would make the following rebuild swap to [] and blank the session.
    reconcileReplayStart('s1', false, 5)
    reconcileReplayEnd('s1', [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }])
    reconcileReplayStart('s1', true, 1)
    expect(
      reconcileReplayEnd('s1', [{ id: 'old' }, { id: 'r-1' }]).swappedMessages,
    ).toEqual([{ id: 'r-1' }])
  })

  it('teardown drops the window-open length with the refcount (mid-window socket drop)', () => {
    reconcileReplayStart('s1', false, 5)
    resetReplayReconcile()
    expect(getReplayWindowDepth('s1')).toBe(0)
    // A fresh rebuild must use ITS OWN length, not the torn-down window's 5.
    reconcileReplayStart('s1', true, 1)
    expect(
      reconcileReplayEnd('s1', [{ id: 'old' }, { id: 'r-1' }]).swappedMessages,
    ).toEqual([{ id: 'r-1' }])

    reconcileReplayStart('s2', false, 5)
    dropReplaySessionState('s2')
    expect(getReplayWindowDepth('s2')).toBe(0)
    reconcileReplayStart('s2', true, 1)
    expect(
      reconcileReplayEnd('s2', [{ id: 'old' }, { id: 'r-1' }]).swappedMessages,
    ).toEqual([{ id: 'r-1' }])
  })

  it('is per-session — s2 opening a delta window does not give s1 a baseline', () => {
    reconcileReplayStart('s2', false, 4)
    reconcileReplayStart('s1', true, 1)
    expect(
      reconcileReplayEnd('s1', [{ id: 'old' }, { id: 'r-1' }]).swappedMessages,
    ).toEqual([{ id: 'r-1' }])
  })

  it('overlapping PURE deltas still swap nothing at all', () => {
    // No full start anywhere, so no baseline is ever recorded and both ends
    // return null — the window-open length is captured but never adopted.
    reconcileReplayStart('s1', false, 2)
    reconcileReplayStart('s1', false, 2)
    const live: Msg[] = [{ id: 'old-1' }, { id: 'old-2' }, { id: 'd-1' }]
    expect(reconcileReplayEnd('s1', live).swappedMessages).toBeNull()
    expect(reconcileReplayEnd('s1', live).swappedMessages).toBeNull()
    expect(isRebuildInProgress('s1')).toBe(false)
    expect(getReplayWindowDepth('s1')).toBe(0)
  })

  // The KNOWN LIMIT, pinned rather than left to be discovered (#7519). When the
  // outermost delta actually APPENDED before the nested full start, its entries
  // are inside the preserved tail, `replayDedupCache` is scoped at the same
  // baseline, and the full replay's re-delivery of them is therefore suppressed
  // — so they keep their early position while the older history the full replay
  // delivers appends after them. Complete, but mis-ORDERED.
  //
  // On main this same interleave returns ['old', 'd-1']: correctly ordered and
  // the racer silently DROPPED, which is the trade #7492 makes deliberately.
  // Change this expectation only alongside #7519.
  it("the delta's own appends keep their early position — the known ordering limit (#7519)", () => {
    const live: Msg[] = [{ id: 'old' }]
    reconcileReplayStart('s1', false, live.length) // outermost DELTA opens at 1
    live.push({ id: 'd-1' }) // the delta appends the newest history entry
    live.push({ id: 'racer' }) // a LIVE arrival
    reconcileReplayStart('s1', true, live.length) // nested FULL start

    // The full replay re-delivers the whole ring buffer, deduped against the
    // cache exactly as both clients do it.
    for (const id of ['old', 'd-1']) {
      const cache = replayDedupCache('s1', live) as Msg[]
      if (!cache.some((m) => m.id === id)) live.push({ id })
    }

    expect(reconcileReplayEnd('s1', live).swappedMessages).toBeNull()
    const swapped = reconcileReplayEnd('s1', live).swappedMessages as Msg[]
    // Nothing is LOST — the racer and both history entries are all present...
    expect(swapped.map((m) => m.id).sort()).toEqual(['d-1', 'old', 'racer'])
    // ...but 'old' is last. This is the #7519 artifact, not the fix working.
    expect(swapped.map((m) => m.id)).toEqual(['d-1', 'racer', 'old'])
  })

  it('a delta nested inside the delta-opened window does not clear the adopted baseline', () => {
    // The delta branch only clears a stale baseline when it OPENS the window
    // (#7477). Now that a nested FULL can install one under a delta-opened
    // window, a THIRD, deeper delta must not cancel that rebuild's swap.
    reconcileReplayStart('s1', false, 0) // outermost DELTA
    const live: Msg[] = [{ id: 'racer' }]
    reconcileReplayStart('s1', true, live.length) // nested FULL
    reconcileReplayStart('s1', false, live.length) // deeper DELTA
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
// #7456 — ledger lifetime: release at replay end, teardown, and a loud cap
// ---------------------------------------------------------------------------
describe('live-arrival ledger lifetime (#7456)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('releases the per-session ledger when the LAST window closes, while the sweep can still read it', () => {
    reconcileReplayStart('s1', false, 0)
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
    reconcileReplayStart('s1', false, 0)
    reconcileReplayStart('s1', false, 0)
    noteLivePromptDuringReplay('s1', 'q1')
    reconcileReplayEnd('s1', [])
    expect(getLiveReplayLedgerSessionIds()).toEqual(['s1'])
    reconcileReplayEnd('s1', [])
    expect(getLiveReplayLedgerSessionIds()).toEqual([])
  })

  it('dropReplaySessionState forgets one session entirely and leaves the others alone', () => {
    reconcileReplayStart('s1', true, 3)
    noteLivePromptDuringReplay('s1', 'q1')
    recordHistorySeq('s1', 11)
    reconcileReplayStart('s2', true, 0)
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
    reconcileReplayStart('s1', false, 0)
    noteLivePromptDuringReplay('s1', 'q1')
    reconcileReplayEnd('s1', [])
    expect(wasPromptLiveDuringReplay('s1', 'q1')).toBe(true)
    dropReplaySessionState('s1')
    expect(wasPromptLiveDuringReplay('s1', 'q1')).toBe(false)
  })

  it('ignores a null/empty session id', () => {
    reconcileReplayStart('s1', false, 0)
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
    reconcileReplayStart('s1', true, 0)
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
    reconcileReplayStart('s1', false, 0)
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
      reconcileReplayStart(sid, false, 0)
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
      reconcileReplayStart(`s${i}`, false, 0)
      noteLivePromptDuringReplay(`s${i}`, `q-${i}`)
    }
    // Touch the oldest so it moves to the tail...
    noteLivePromptDuringReplay('s0', 'q-0-again')
    // ...then overflow by one: s1 (now the oldest) goes, s0 stays.
    reconcileReplayStart('overflow', false, 0)
    noteLivePromptDuringReplay('overflow', 'q-overflow')

    expect(getLiveReplayLedgerSessionIds()).toContain('s0')
    expect(getLiveReplayLedgerSessionIds()).not.toContain('s1')
    expect(wasPromptLiveDuringReplay('s0', 'q-0')).toBe(true)
  })

  it('the cap does not fire in the normal case (no warn for a single session)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    reconcileReplayStart('s1', false, 0)
    noteLivePromptDuringReplay('s1', 'q1')
    noteLivePromptDuringReplay('s1', 'q2')
    reconcileReplayEnd('s1', [])
    expect(warn).not.toHaveBeenCalled()
  })
})
