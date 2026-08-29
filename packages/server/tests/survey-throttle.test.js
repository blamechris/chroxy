import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createSurveyThrottle } from '../src/handlers/survey-throttle.js'

/**
 * Tests for the shared per-session survey throttle (#7436 → extracted #7430,
 * hardened #7469).
 *
 * The property this file exists for is the REQUIRED `replayable` argument.
 * Review on #7469 found the "don't cache a failure" rule implemented at ONE of
 * the gate's two call sites: the threads handler had it, the status handler
 * still committed unconditionally, and a security doc had already been written
 * claiming the property for both. That is the `docs/false-safety-guards.md`
 * "a guard wired to only some of its callers" shape — correct for every input
 * it sees, never reached by the rest.
 *
 * A second call-site guard would have the same failure mode as the first, so
 * the decision moved INTO the gate as a required argument that throws when it
 * is missing. The gate stays domain-blind — it has no idea what makes a PR
 * status or a thread count worth replaying — but a caller can no longer forget
 * to decide. Forgetting is now a crash on the first survey, not a silent cache.
 */

/** A throttle plus a hand-driven clock and a stable owner key. */
function harness(minIntervalMs = 5_000) {
  const throttle = createSurveyThrottle()
  const owner = {}
  let now = 1_000
  return {
    owner,
    advance: (ms) => { now += ms },
    open: (key = 'k') => throttle.open(owner, key, now, minIntervalMs),
  }
}

describe('#7469 — commit() requires an explicit replayable decision', () => {
  it('THROWS when the option bag is missing entirely', () => {
    const h = harness()
    const gate = h.open()
    assert.throws(() => gate.commit({ ok: true }), /replayable/)
  })

  it('THROWS when replayable is absent, undefined, or not a boolean', () => {
    // Each of these is a plausible way to get it wrong — an empty bag, a typo'd
    // key, a truthy-but-not-boolean expression forwarded from a caller.
    for (const opts of [{}, { replayable: undefined }, { replayable: 'yes' }, { replayable: 1 }, { replayable: null }]) {
      const gate = harness().open()
      assert.throws(() => gate.commit({ ok: true }, opts), /replayable/, `should have thrown for ${JSON.stringify(opts)}`)
    }
  })

  it('a throw leaves NOTHING cached — it fails closed, not open', () => {
    // The point of throwing rather than defaulting: a caller that forgot must
    // not end up with the permissive behaviour by accident.
    const h = harness()
    const gate = h.open()
    assert.throws(() => gate.commit({ ok: true }))
    h.advance(1)
    assert.equal(h.open().cached, null, 'a refused commit must not have cached anything')
  })

  it('POSITIVE CONTROL: an explicit boolean does NOT throw, either way', () => {
    // Without this the assertions above would pass for a commit() that always
    // threw, which would be a different bug with the same test result.
    const a = harness().open()
    assert.doesNotThrow(() => a.commit({ ok: true }, { replayable: true }))
    const b = harness().open()
    assert.doesNotThrow(() => b.commit({ ok: true }, { replayable: false }))
  })
})

describe('#7469 — replayable decides what a throttled request gets back', () => {
  it('replayable:true caches the reading for the window', () => {
    const h = harness()
    const gate = h.open()
    gate.commit({ id: 'good' }, { replayable: true })
    h.advance(1_000)
    const second = h.open()
    assert.equal(second.admitted, false, 'still inside the window')
    assert.deepEqual(second.cached, { id: 'good' })
  })

  it('replayable:false caches NOTHING when there is no prior reading', () => {
    const h = harness()
    h.open().commit({ id: 'degraded' }, { replayable: false })
    h.advance(1_000)
    const second = h.open()
    assert.equal(second.admitted, false, 'a non-replayable reading still OPENS the window')
    assert.equal(second.cached, null, 'the caller must degrade rather than replay a failure')
  })

  it('replayable:false KEEPS a prior good reading instead of overwriting it', () => {
    // The keep-last-good half. A transient failure must not blank a reading
    // other clients are looking at — #7445's Critical 1 by another route.
    const h = harness()
    h.open().commit({ id: 'good' }, { replayable: true })
    h.advance(6_000)
    h.open().commit({ id: 'degraded' }, { replayable: false })
    h.advance(1_000)
    assert.deepEqual(h.open().cached, { id: 'good' }, 'the good reading must survive the failure')
  })

  it('a later replayable reading DOES replace the retained one', () => {
    // Positive control for the retention: a cache that never released would
    // pin every client to the first reading forever.
    const h = harness()
    h.open().commit({ id: 'good' }, { replayable: true })
    h.advance(6_000)
    h.open().commit({ id: 'degraded' }, { replayable: false })
    h.advance(6_000)
    h.open().commit({ id: 'fresh' }, { replayable: true })
    h.advance(1_000)
    assert.deepEqual(h.open().cached, { id: 'fresh' })
  })

  it('the window opens on ADMISSION, whatever the reading turns out to be', () => {
    // A survey that reached the CLI and came back unusable still spent the
    // subprocess budget the throttle protects, so it must not be free to retry.
    const h = harness()
    h.open().commit({ id: 'degraded' }, { replayable: false })
    h.advance(4_999)
    assert.equal(h.open().admitted, false)
    h.advance(2)
    assert.equal(h.open().admitted, true, 'and past the window it is admitted again')
  })
})

describe('#7469 — rollback is unchanged by the replayable argument', () => {
  it('rollback after a THROWN survey reopens the window immediately', () => {
    // A thrown survey never reached the CLI, so it spent nothing.
    const h = harness()
    h.open().rollback()
    assert.equal(h.open().admitted, true)
  })

  it('rollback restores the PRIOR cache rather than clearing it', () => {
    // `cached` only exists on the REFUSED branch of the gate's return union, so
    // the retained reading has to be observed through a refusal rather than off
    // the admitted handle — an assertion on the wrong branch reads `undefined`
    // and would fail for a reason that has nothing to do with the cache.
    const h = harness()
    h.open().commit({ id: 'good' }, { replayable: true })
    h.advance(6_000)
    h.open().rollback()

    const retry = h.open()
    assert.equal(retry.admitted, true, 'the window was rolled back, so the retry is admitted')
    retry.commit({ id: 'degraded' }, { replayable: false })
    h.advance(1_000)
    assert.deepEqual(h.open().cached, { id: 'good' }, 'the good reading survived both the rollback and the failure')
  })

  it('rollback is compare-and-restore — a newer admission is not destroyed', () => {
    // #7445 reproduced this: in-flight guards are per CLIENT, so a slow survey
    // and a newer admitted one can overlap, and an unconditional delete here
    // wipes the newer client's stamp and cache when the slow one fails late.
    const h = harness()
    const slow = h.open()
    h.advance(6_000)
    h.open().commit({ id: 'newer' }, { replayable: true })
    slow.rollback()
    h.advance(1_000)
    const after = h.open()
    assert.equal(after.admitted, false, "the newer client's window must survive")
    assert.deepEqual(after.cached, { id: 'newer' })
  })

  it('throttles per KEY — one session does not refuse another', () => {
    const h = harness()
    h.open('sess-1').commit({ id: 'a' }, { replayable: true })
    assert.equal(h.open('sess-2').admitted, true)
  })
})
