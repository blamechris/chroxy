import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  createDeltaFlusher,
  DELTA_FLUSH_MIN_MS,
  DELTA_FLUSH_FLOOR_MS,
  DELTA_FLUSH_MAX_MS,
  type DeltaFlushScheduler,
  type PendingDelta,
} from './delta-flush'

// Deterministic scheduler: records armed callbacks keyed by a synthetic handle
// so a test can fire the pending timer by hand (no real time, no fake-timer
// global patching). `fire()` runs the one armed callback (the flusher only ever
// arms a single timer at a time). `armed()` reports whether one is pending.
function makeFakeScheduler() {
  let nextHandle = 1
  const pending = new Map<number, { cb: () => void; ms: number }>()
  const scheduler: DeltaFlushScheduler = {
    setTimeout: (cb, ms) => {
      const handle = nextHandle++
      pending.set(handle, { cb, ms })
      return handle as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeout: (handle) => {
      pending.delete(handle as unknown as number)
    },
  }
  return {
    scheduler,
    armed: () => pending.size > 0,
    /** The ms the single armed timer was scheduled with (or null). */
    armedMs: () => {
      const first = pending.values().next()
      return first.done ? null : first.value.ms
    },
    /** Fire the single armed callback (mimics the coalescing window elapsing). */
    fire: () => {
      const entry = pending.values().next()
      if (entry.done) return
      const handle = pending.keys().next().value as number
      pending.delete(handle)
      entry.value.cb()
    },
  }
}

describe('createDeltaFlusher', () => {
  let applied: Array<Map<string, PendingDelta>>
  let ewmaRtt: number | null

  beforeEach(() => {
    applied = []
    ewmaRtt = null
  })

  function build(scheduler: DeltaFlushScheduler) {
    return createDeltaFlusher({
      getEwmaRtt: () => ewmaRtt,
      applyDeltas: (updates) => {
        applied.push(updates)
      },
      scheduler,
    })
  }

  it('exposes a live accumulator map the hot path writes into', () => {
    const { scheduler } = makeFakeScheduler()
    const f = build(scheduler)
    expect(f.pendingDeltas).toBeInstanceOf(Map)
    expect(f.pendingDeltas.size).toBe(0)
    f.pendingDeltas.set('m1', { sessionId: 's1', delta: 'hi' })
    expect(f.pendingDeltas.size).toBe(1)
  })

  it('accumulates deltas and flushes the batch when the window elapses', () => {
    const fake = makeFakeScheduler()
    const f = build(fake.scheduler)

    f.pendingDeltas.set('m1', { sessionId: 's1', delta: 'a' })
    f.schedule()
    f.pendingDeltas.set('m2', { sessionId: 's1', delta: 'b' })
    f.schedule() // second schedule is a no-op — one shared window

    expect(applied).toHaveLength(0) // nothing applied until the timer fires
    fake.fire()

    expect(applied).toHaveLength(1)
    expect([...applied[0]!.entries()]).toEqual([
      ['m1', { sessionId: 's1', delta: 'a' }],
      ['m2', { sessionId: 's1', delta: 'b' }],
    ])
    expect(f.pendingDeltas.size).toBe(0) // accumulator cleared on flush
  })

  it('coalesces a burst into a single window (first-arm-wins)', () => {
    const fake = makeFakeScheduler()
    const f = build(fake.scheduler)

    for (let i = 0; i < 5; i++) {
      f.pendingDeltas.set(`m${i}`, { sessionId: 's1', delta: String(i) })
      f.schedule()
    }
    // Only ONE timer is armed for the whole burst.
    expect(fake.armed()).toBe(true)
    fake.fire()
    expect(applied).toHaveLength(1)
    expect(applied[0]!.size).toBe(5)
    expect(fake.armed()).toBe(false)
  })

  it('passes a detached snapshot to applyDeltas (further appends do not leak in)', () => {
    const fake = makeFakeScheduler()
    const f = build(fake.scheduler)
    f.pendingDeltas.set('m1', { sessionId: null, delta: 'first' })
    f.schedule()
    fake.fire()
    // Mutating the accumulator after the flush must not touch the snapshot.
    f.pendingDeltas.set('m2', { sessionId: null, delta: 'later' })
    expect(applied[0]!.has('m2')).toBe(false)
    expect(applied[0]!.size).toBe(1)
  })

  describe('EWMA-driven window resolution (through resolveDeltaFlushMs)', () => {
    it('uses the flush floor when RTT is unknown (null)', () => {
      const fake = makeFakeScheduler()
      const f = build(fake.scheduler)
      ewmaRtt = null
      f.pendingDeltas.set('m', { sessionId: null, delta: 'x' })
      f.schedule()
      expect(fake.armedMs()).toBe(DELTA_FLUSH_FLOOR_MS)
      expect(f.currentIntervalMs()).toBe(DELTA_FLUSH_FLOOR_MS)
    })

    it('uses the tight floor on a cheap link', () => {
      const fake = makeFakeScheduler()
      const f = build(fake.scheduler)
      ewmaRtt = 10 // <= cheap threshold
      f.pendingDeltas.set('m', { sessionId: null, delta: 'x' })
      f.schedule()
      expect(fake.armedMs()).toBe(DELTA_FLUSH_MIN_MS)
    })

    it('uses the max window on a poor link', () => {
      const fake = makeFakeScheduler()
      const f = build(fake.scheduler)
      ewmaRtt = 1000 // >= poor threshold
      f.pendingDeltas.set('m', { sessionId: null, delta: 'x' })
      f.schedule()
      expect(fake.armedMs()).toBe(DELTA_FLUSH_MAX_MS)
    })

    it('reads RTT lazily on each schedule (interval tracks live RTT)', () => {
      const fake = makeFakeScheduler()
      const f = build(fake.scheduler)
      ewmaRtt = 10
      f.pendingDeltas.set('m', { sessionId: null, delta: 'x' })
      f.schedule()
      expect(fake.armedMs()).toBe(DELTA_FLUSH_MIN_MS)
      fake.fire()
      // RTT degrades before the next window — the next schedule must re-resolve.
      ewmaRtt = 1000
      f.pendingDeltas.set('m2', { sessionId: null, delta: 'y' })
      f.schedule()
      expect(fake.armedMs()).toBe(DELTA_FLUSH_MAX_MS)
    })
  })

  describe('setIntervalOverride', () => {
    it('pins the window to a constant regardless of RTT', () => {
      const fake = makeFakeScheduler()
      const f = build(fake.scheduler)
      ewmaRtt = 1000 // would otherwise be MAX
      f.setIntervalOverride(7)
      f.pendingDeltas.set('m', { sessionId: null, delta: 'x' })
      f.schedule()
      expect(fake.armedMs()).toBe(7)
      expect(f.currentIntervalMs()).toBe(7)
    })

    it('restores adaptive behavior when set back to null', () => {
      const fake = makeFakeScheduler()
      const f = build(fake.scheduler)
      f.setIntervalOverride(7)
      expect(f.currentIntervalMs()).toBe(7)
      f.setIntervalOverride(null)
      ewmaRtt = null
      expect(f.currentIntervalMs()).toBe(DELTA_FLUSH_FLOOR_MS)
    })

    it('treats an override of 0 as a real value (not "unset")', () => {
      const fake = makeFakeScheduler()
      const f = build(fake.scheduler)
      ewmaRtt = 1000
      f.setIntervalOverride(0)
      expect(f.currentIntervalMs()).toBe(0)
    })
  })

  describe('flushNow', () => {
    it('applies the accumulator immediately and cancels the pending timer', () => {
      const fake = makeFakeScheduler()
      const f = build(fake.scheduler)
      f.pendingDeltas.set('m1', { sessionId: 's1', delta: 'a' })
      f.schedule()
      expect(fake.armed()).toBe(true)

      f.flushNow()
      expect(applied).toHaveLength(1)
      expect(applied[0]!.size).toBe(1)
      expect(fake.armed()).toBe(false) // timer cancelled
      expect(f.pendingDeltas.size).toBe(0)
    })

    it('is a no-op apply when the accumulator is empty', () => {
      const fake = makeFakeScheduler()
      const f = build(fake.scheduler)
      f.flushNow()
      expect(applied).toHaveLength(0)
    })

    it('does not double-apply when the timer later fires (timer was cleared)', () => {
      const fake = makeFakeScheduler()
      const f = build(fake.scheduler)
      f.pendingDeltas.set('m1', { sessionId: 's1', delta: 'a' })
      f.schedule()
      f.flushNow()
      // If a stale handle somehow fired, the accumulator is empty → no-op.
      fake.fire()
      expect(applied).toHaveLength(1)
    })
  })

  describe('clear / dispose (teardown)', () => {
    it('drops buffered deltas WITHOUT applying them', () => {
      const fake = makeFakeScheduler()
      const f = build(fake.scheduler)
      f.pendingDeltas.set('m1', { sessionId: 's1', delta: 'a' })
      f.schedule()

      f.clear()
      expect(applied).toHaveLength(0) // dropped, not flushed
      expect(f.pendingDeltas.size).toBe(0)
      expect(fake.armed()).toBe(false) // timer cancelled
    })

    it('a fired timer after clear is inert (accumulator empty)', () => {
      const fake = makeFakeScheduler()
      const f = build(fake.scheduler)
      f.pendingDeltas.set('m1', { sessionId: 's1', delta: 'a' })
      f.schedule()
      f.clear()
      fake.fire()
      expect(applied).toHaveLength(0)
    })

    it('dispose is an alias of clear', () => {
      const fake = makeFakeScheduler()
      const f = build(fake.scheduler)
      f.pendingDeltas.set('m1', { sessionId: 's1', delta: 'a' })
      f.schedule()
      f.dispose()
      expect(applied).toHaveLength(0)
      expect(f.pendingDeltas.size).toBe(0)
      expect(fake.armed()).toBe(false)
    })

    it('can schedule again after a clear (re-armable)', () => {
      const fake = makeFakeScheduler()
      const f = build(fake.scheduler)
      f.schedule()
      f.clear()
      expect(fake.armed()).toBe(false)
      f.pendingDeltas.set('m1', { sessionId: 's1', delta: 'a' })
      f.schedule()
      expect(fake.armed()).toBe(true)
      fake.fire()
      expect(applied).toHaveLength(1)
    })
  })

  describe('key handling', () => {
    it('last-write-wins on a duplicate key within one window (Map semantics)', () => {
      const fake = makeFakeScheduler()
      const f = build(fake.scheduler)
      // The hot path (sharedStreamDelta) appends by re-setting the same key; the
      // accumulator is a Map so the same id holds one merged entry.
      f.pendingDeltas.set('m1', { sessionId: 's1', delta: 'a' })
      f.pendingDeltas.set('m1', { sessionId: 's1', delta: 'ab' })
      f.schedule()
      fake.fire()
      expect(applied[0]!.size).toBe(1)
      expect(applied[0]!.get('m1')).toEqual({ sessionId: 's1', delta: 'ab' })
    })

    it('preserves insertion order across distinct keys', () => {
      const fake = makeFakeScheduler()
      const f = build(fake.scheduler)
      f.pendingDeltas.set('z', { sessionId: null, delta: '1' })
      f.pendingDeltas.set('a', { sessionId: null, delta: '2' })
      f.pendingDeltas.set('m', { sessionId: null, delta: '3' })
      f.schedule()
      fake.fire()
      expect([...applied[0]!.keys()]).toEqual(['z', 'a', 'm'])
    })

    it('keeps deltas tagged by their originating session across a multi-session batch', () => {
      const fake = makeFakeScheduler()
      const f = build(fake.scheduler)
      f.pendingDeltas.set('m1', { sessionId: 's1', delta: 'a' })
      f.pendingDeltas.set('m2', { sessionId: 's2', delta: 'b' })
      f.pendingDeltas.set('m3', { sessionId: null, delta: 'c' })
      f.schedule()
      fake.fire()
      expect(applied[0]!.get('m1')!.sessionId).toBe('s1')
      expect(applied[0]!.get('m2')!.sessionId).toBe('s2')
      expect(applied[0]!.get('m3')!.sessionId).toBeNull()
    })
  })

  describe('re-entrancy', () => {
    it('lets applyDeltas re-arm the next window from inside the flush', () => {
      const fake = makeFakeScheduler()
      let pass = 0
      const f = createDeltaFlusher({
        getEwmaRtt: () => null,
        applyDeltas: (updates) => {
          applied.push(updates)
          // Simulate a downstream producer enqueuing more work during the flush.
          if (pass === 0) {
            pass = 1
            f.pendingDeltas.set('m2', { sessionId: null, delta: 'b' })
            f.schedule()
          }
        },
        scheduler: fake.scheduler,
      })
      f.pendingDeltas.set('m1', { sessionId: null, delta: 'a' })
      f.schedule()
      fake.fire() // applies m1, re-arms for m2
      expect(fake.armed()).toBe(true)
      fake.fire() // applies m2
      expect(applied).toHaveLength(2)
      expect(applied[1]!.get('m2')).toEqual({ sessionId: null, delta: 'b' })
    })
  })

  it('defaults to the global timer surface when no scheduler is injected', () => {
    // Fake timers patch the global setTimeout/clearTimeout, so advancing the
    // clock only fires the flush if the flusher really armed a GLOBAL timer —
    // deterministic, no real sleep.
    vi.useFakeTimers()
    try {
      const f = createDeltaFlusher({
        getEwmaRtt: () => null,
        applyDeltas: (updates) => {
          applied.push(updates)
        },
      })
      f.setIntervalOverride(1)
      f.pendingDeltas.set('m1', { sessionId: null, delta: 'a' })
      f.schedule()
      vi.advanceTimersByTime(1)
      expect(applied).toHaveLength(1)
      f.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
