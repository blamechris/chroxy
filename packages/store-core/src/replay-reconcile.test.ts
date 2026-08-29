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
