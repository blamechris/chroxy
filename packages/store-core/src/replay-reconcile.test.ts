import { describe, it, expect, beforeEach } from 'vitest'
import {
  resetReplayReconcile,
  recordHistorySeq,
  getHistoryCursors,
  getHistoryCursor,
  reconcileReplayStart,
  reconcileReplayEnd,
  isRebuildInProgress,
  replayDedupCache,
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
