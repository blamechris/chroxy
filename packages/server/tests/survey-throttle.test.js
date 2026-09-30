import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createSurveyThrottle, forgetSurveyKey, _testTotalRecordCount } from '../src/handlers/survey-throttle.js'

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

describe('#7450 — forgetSurveyKey prunes every throttle instance through ONE call', () => {
  it('drops the record for (owner, key), so a later open() is admitted immediately', () => {
    const h = harness()
    h.open('sess-1').commit({ id: 'a' }, { replayable: true })
    assert.equal(h.open('sess-1').admitted, false, 'still inside the window')

    forgetSurveyKey(h.owner, 'sess-1')

    // No `advance()` — the record is gone outright, not merely expired.
    const after = h.open('sess-1')
    assert.equal(after.admitted, true, 'forgetting the key must re-open the window immediately')
    assert.equal(after.cached, undefined, 'admitted opens carry no `cached` field at all')
  })

  it('does not disturb a DIFFERENT key under the same owner', () => {
    const h = harness()
    h.open('sess-1').commit({ id: 'a' }, { replayable: true })
    h.open('sess-2').commit({ id: 'b' }, { replayable: true })

    forgetSurveyKey(h.owner, 'sess-1')

    assert.equal(h.open('sess-1').admitted, true, 'sess-1 was forgotten')
    assert.equal(h.open('sess-2').admitted, false, 'sess-2 must be unaffected')
    assert.deepEqual(h.open('sess-2').cached, { id: 'b' })
  })

  it('does not disturb the SAME key under a DIFFERENT owner', () => {
    const h1 = harness()
    const h2 = harness()
    h1.open('sess-1').commit({ id: 'owner1' }, { replayable: true })
    h2.open('sess-1').commit({ id: 'owner2' }, { replayable: true })

    forgetSurveyKey(h1.owner, 'sess-1')

    assert.equal(h1.open('sess-1').admitted, true, "owner1's record was forgotten")
    assert.equal(h2.open('sess-1').admitted, false, "owner2's record must survive — different owner")
  })

  it('is a no-op for an owner/key that was never opened, or already forgotten twice', () => {
    const h = harness()
    assert.doesNotThrow(() => forgetSurveyKey(h.owner, 'never-opened'))
    h.open('sess-1').commit({ id: 'a' }, { replayable: true })
    forgetSurveyKey(h.owner, 'sess-1')
    assert.doesNotThrow(() => forgetSurveyKey(h.owner, 'sess-1'), 'forgetting twice must not throw')
  })

  it('ONE call reaches EVERY throttle instance created via createSurveyThrottle — the acceptance property', () => {
    // The defect #7450 catalogues is a guard wired to only SOME of its callers:
    // #7430 gave the threads handler its own createSurveyThrottle() instance
    // rather than sharing the status handler's, so a prune implemented against
    // one instance alone would silently miss the other (and any future third
    // one). Two independently-created instances stand in for "two handlers,
    // two module-level throttles" without importing either handler module.
    const owner = {}
    const statusThrottle = createSurveyThrottle()
    const threadsThrottle = createSurveyThrottle()
    statusThrottle.open(owner, 'sess-1', 1_000, 5_000).commit({ kind: 'status' }, { replayable: true })
    threadsThrottle.open(owner, 'sess-1', 1_000, 5_000).commit({ kind: 'threads' }, { replayable: true })

    assert.equal(statusThrottle.open(owner, 'sess-1', 1_500, 5_000).admitted, false, 'sanity: status is throttled')
    assert.equal(threadsThrottle.open(owner, 'sess-1', 1_500, 5_000).admitted, false, 'sanity: threads is throttled')

    forgetSurveyKey(owner, 'sess-1')

    assert.equal(statusThrottle.open(owner, 'sess-1', 1_600, 5_000).admitted, true, 'the status throttle must be pruned')
    assert.equal(threadsThrottle.open(owner, 'sess-1', 1_600, 5_000).admitted, true, 'the threads throttle must be pruned too, by the SAME call')
  })

  it('_testTotalRecordCount sums records for one owner across every instance — the bound the acceptance test reads', () => {
    const owner = {}
    const a = createSurveyThrottle()
    const b = createSurveyThrottle()
    assert.equal(_testTotalRecordCount(owner), 0)
    a.open(owner, 'k1', 0, 5_000).commit({}, { replayable: true })
    assert.equal(_testTotalRecordCount(owner), 1)
    b.open(owner, 'k2', 0, 5_000).commit({}, { replayable: true })
    assert.equal(_testTotalRecordCount(owner), 2)
    forgetSurveyKey(owner, 'k1')
    assert.equal(_testTotalRecordCount(owner), 1)
    forgetSurveyKey(owner, 'k2')
    assert.equal(_testTotalRecordCount(owner), 0)
  })
})

describe('#7450 scope addition — a completed reading writes THROUGH a superseded record', () => {
  // The interleaving from #7445's re-verification: two first-ever surveys of
  // one session overlap because the first is slower than the throttle window
  // itself, so a THIRD request outside the window is admitted before the first
  // has committed anything. Writing only to the closure-captured `record` —
  // the pre-fix behaviour — strands the first survey's completed reading in an
  // orphaned record nobody reads again, and a request landing in that gap
  // degrades with RATE_LIMITED_REASON despite a reading having completed.

  it('a late commit on a SUPERSEDED record writes through to the CURRENT one', () => {
    const h = harness()
    const first = h.open('sess-1') // admitted at t=1000
    h.advance(6_000) // past the window — a second survey is admitted
    h.open('sess-1') // admitted at t=7000; nothing committed yet

    // The first (slow) survey finally finishes and commits, AFTER being
    // superseded by the second's admission.
    first.commit({ id: 'first (slow)' }, { replayable: true })

    // A request arriving now must see the FIRST survey's reading, not a
    // degrade — `second` opened the window but has not committed anything of
    // its own, so it holds nothing newer to protect.
    h.advance(1)
    const replay = h.open('sess-1')
    assert.equal(replay.admitted, false, 'still inside the SECOND window')
    assert.deepEqual(replay.cached, { id: 'first (slow)' }, "the first survey's completed reading must be reachable")
  })

  it("a superseding survey's OWN later commit still wins over an older one's late write-through", () => {
    const h = harness()
    const first = h.open('sess-1') // t=1000
    h.advance(6_000)
    const second = h.open('sess-1') // t=7000

    // The second (faster) survey commits FIRST.
    second.commit({ id: 'second (fast)' }, { replayable: true })
    // The first, older survey finally resolves and tries to write through.
    first.commit({ id: 'first (stale)' }, { replayable: true })

    h.advance(1)
    const replay = h.open('sess-1')
    assert.deepEqual(replay.cached, { id: 'second (fast)' }, "the newer survey's own reading must not be overwritten by an older one's late arrival")
  })

  it('the STILL-CURRENT (non-superseded) path is unaffected — a solo survey commits normally', () => {
    const h = harness()
    h.open('sess-1').commit({ id: 'solo' }, { replayable: true })
    h.advance(1)
    assert.deepEqual(h.open('sess-1').cached, { id: 'solo' })
  })

  it('write-through respects `replayable: false` — it opens no cache where none exists', () => {
    const h = harness()
    const first = h.open('sess-1')
    h.advance(6_000)
    h.open('sess-1') // second, admitted, nothing committed
    first.commit({ id: 'first (failed)' }, { replayable: false })

    h.advance(1)
    assert.equal(h.open('sess-1').cached, null, 'a non-replayable late reading must not populate the cache via write-through either')
  })

  it('a late write-through after the key was FORGOTTEN (session destroyed mid-flight) does not resurrect a record', () => {
    const h = harness()
    const first = h.open('sess-1')
    h.advance(6_000)
    h.open('sess-1') // supersedes `first`

    forgetSurveyKey(h.owner, 'sess-1') // the session was destroyed while both surveys were in flight

    assert.doesNotThrow(() => first.commit({ id: 'late, orphaned session' }, { replayable: true }))
    h.advance(1)
    assert.equal(h.open('sess-1').admitted, true, 'a forgotten key must not be silently recreated by a late write-through')
  })
})

describe('#8091 (C1) — a write-through can no longer be silently lost by a later rollback', () => {
  // Filed from review of #8088: write-through used to MUTATE the current
  // record in place, so rollback()'s identity check (`records.get(key) !==
  // record`) could not tell "nothing happened since I was admitted" apart
  // from "my record was mutated in place by an unrelated survey's
  // write-through" — both looked identical under raw object identity.
  //
  // FIX: every record now carries a `token` — a fresh marker minted at
  // `open()` time — and a write-through REPLACES the record (never mutates
  // it in place) while carrying the CURRENT record's token and `.at` forward
  // unchanged. `rollback()` keys on that token, not on object identity, so it
  // can still tell a stale call (someone newer has since taken over) apart
  // from "the object I'm looking at is still mine, just enriched."
  //
  // DESIGN DECISION (stated explicitly, since the coordinator left the
  // specific outcome to this PR): a rollback undoes the ROLLED-BACK survey's
  // OWN admission in full, including its window — consistent with "a failed
  // survey spent no budget, so the next retry must not be refused for it."
  // Concretely: `rollback()` restores `{ at: prior.at, snapshot:
  // newest(current, prior) }` — the WINDOW reverts to whatever was true
  // before the rolled-back gate was ever admitted, while the SNAPSHOT is
  // never allowed to regress to something older than what is already there
  // (comparing `snapshotAt`, exactly like `commit()`'s own write-through
  // guard). A reading is therefore NEVER lost to any later rollback — it is
  // simply carried forward as the next admission's replay-cache — even
  // though, in the specific repro below, that means the very next request
  // is freely ADMITTED (a fresh survey) rather than throttled: B's rollback
  // undoing ITS OWN stamp legitimately reopens the window all the way back
  // to A's original (long-elapsed) admission time.

  it("the reviewer's exact interleaving: A writes through onto B's slot, then B rolls back — A's reading survives", () => {
    const throttle = createSurveyThrottle()
    const owner = {}
    const A = throttle.open(owner, 'sess-1', 1_000, 5_000) // admitted
    const B = throttle.open(owner, 'sess-1', 7_000, 5_000) // supersedes A

    A.commit({ id: 'A-result' }, { replayable: true }) // write-through into B's (current) record
    B.rollback() // B's survey later throws

    // B's rollback fully undoes B's own admission — the window reverts to
    // A's ORIGINAL (t=1000) admission, which by t=7500 has long elapsed
    // (6500ms >= the 5000ms window) — so this request is ADMITTED, not
    // throttled. That is the outcome this design chooses; see the block
    // comment above.
    const after = throttle.open(owner, 'sess-1', 7_500, 5_000)
    assert.equal(after.admitted, true, "B's rollback must fully undo B's own stamp, reopening to A's original window")

    // But A's completed reading is NEVER discarded — it is carried forward
    // as the brand-new admission's own replay-cache, so a second request
    // landing in the same instant (before `after` itself completes) is
    // throttled and replays it rather than seeing a blank slate.
    const pileOn = throttle.open(owner, 'sess-1', 7_500, 5_000)
    assert.equal(pileOn.admitted, false, "the brand-new admission opened its own window")
    assert.deepEqual(pileOn.cached, { id: 'A-result' }, "A's completed reading must never be discarded by B's rollback")
  })

  it('mirror order: B rolls back BEFORE A ever completes, then A writes through onto its own (restored) slot', () => {
    const throttle = createSurveyThrottle()
    const owner = {}
    const A = throttle.open(owner, 'sess-1', 1_000, 5_000)
    const B = throttle.open(owner, 'sess-1', 7_000, 5_000) // supersedes A

    B.rollback() // nothing committed yet — a full undo, as if B never existed
    A.commit({ id: 'A-result' }, { replayable: true }) // lands on what is now A's own restored slot again

    // A's own window (opened at t=1000) is still in force.
    const soon = throttle.open(owner, 'sess-1', 1_500, 5_000)
    assert.equal(soon.admitted, false, "A's own window must still be in force")
    assert.deepEqual(soon.cached, { id: 'A-result' })
  })

  it('a stale rollback stays a no-op even when its slot was write-through-enriched while it was current', () => {
    // A different actor's write-through landing on B's slot while B was still
    // current must not make B's EVENTUAL (very late) rollback able to disturb
    // a THIRD, even-newer admission that has since taken over.
    const throttle = createSurveyThrottle()
    const owner = {}
    const A = throttle.open(owner, 'sess-1', 1_000, 5_000)
    const B = throttle.open(owner, 'sess-1', 7_000, 5_000) // supersedes A
    A.commit({ id: 'A-result' }, { replayable: true }) // write-through lands on B's slot while B is current
    const C = throttle.open(owner, 'sess-1', 13_000, 5_000) // supersedes B in turn
    C.commit({ id: 'C-result' }, { replayable: true })

    B.rollback() // B itself never committed or rolled back until now

    const after = throttle.open(owner, 'sess-1', 13_500, 5_000)
    assert.equal(after.admitted, false, "C's window must survive B's stale rollback")
    assert.deepEqual(after.cached, { id: 'C-result' })
  })

  it('an OLDER admission rolling back after a write-through never overwrites the CURRENT reading', () => {
    // A itself decides its write attempt is worthless right after handing it
    // off is not a real call pattern (a caller commits XOR rolls back), but a
    // DIFFERENT, even-older admission rolling back late must not disturb a
    // write-through that already landed on a newer slot.
    const throttle = createSurveyThrottle()
    const owner = {}
    const zero = throttle.open(owner, 'sess-1', 100, 5_000) // the oldest of all
    const A = throttle.open(owner, 'sess-1', 6_000, 5_000) // supersedes `zero`
    throttle.open(owner, 'sess-1', 12_000, 5_000) // B: supersedes A
    A.commit({ id: 'A-result' }, { replayable: true }) // write-through onto B's slot

    zero.rollback() // long stale — B (and A's write-through) have since taken over

    const after = throttle.open(owner, 'sess-1', 12_500, 5_000)
    assert.equal(after.admitted, false)
    assert.deepEqual(after.cached, { id: 'A-result' }, "zero's stale rollback must not disturb A's write-through onto B's slot")
  })
})

describe('S3 — the write-through recency guard\'s tie-break is pinned', () => {
  it('an EXACT snapshotAt tie keeps the CURRENT reading (>=, not >)', () => {
    // The review's own mutant (`>=` -> `>`) survived the full targeted suite
    // (191/191) because every existing test compares clearly-ordered
    // timestamps. Constructing an exact tie legitimately (via the public API)
    // needs two DIFFERENT admissions that share one admission timestamp —
    // `forget()` (a session_destroyed prune) resets the key so a second
    // admission can reuse the same tick a first one used.
    const throttle = createSurveyThrottle()
    const owner = {}

    const A = throttle.open(owner, 'sess-1', 5_000, 5_000)
    throttle.forget(owner, 'sess-1')
    const B = throttle.open(owner, 'sess-1', 5_000, 5_000) // same tick as A, on a fresh key

    B.commit({ id: 'B (current)' }, { replayable: true }) // snapshotAt becomes exactly 5000

    // A's own admission time is ALSO exactly 5000 — an exact tie against B's
    // already-recorded snapshotAt.
    A.commit({ id: 'A (late, tied)' }, { replayable: true })

    const after = throttle.open(owner, 'sess-1', 5_500, 5_000)
    assert.deepEqual(after.cached, { id: 'B (current)' }, 'on an exact tie, the CURRENT reading must win — the boundary this test pins')
  })
})

describe('#8094 — a straggler admitted before forget() cannot write through into a reused id\'s new record', () => {
  // `commit()`'s write-through orders only by `snapshotAt`, so a record with
  // NO reading yet (`snapshotAt: null`, the S3/write-through guard's escape
  // hatch) passes that guard unconditionally. `forget()` (a session_destroyed
  // prune) deletes the record outright, so a NEW admission on the same key —
  // a reused session id via `preserveId` restore/rebind — starts a record
  // with `snapshotAt: null` again. A survey admitted under the FORGOTTEN
  // (prior) incarnation that finally resolves after the reuse then looks,
  // from `commit()`'s point of view, identical to an ordinary in-flight
  // straggler being written through onto its own still-live successor — the
  // one case `snapshotAt: null` is meant to allow. Nothing in `at`/`token`
  // distinguishes "superseded, same session" from "superseded by a forget +
  // reuse, different incarnation" — hence a `lineage` the record carries
  // forward on an ordinary supersede and mints fresh only when there is no
  // `prior` to copy from (i.e. right after a `forget()`).

  it("admit A, forget, admit B (same key) — A's late commit does not land in B's record", () => {
    const h = harness()
    const A = h.open('sess-1') // admitted under the key's FIRST incarnation

    forgetSurveyKey(h.owner, 'sess-1') // session destroyed while A's survey was in flight

    h.open('sess-1') // the id is REUSED (preserveId restore/rebind) — a brand-new incarnation, snapshotAt: null

    // A's straggling survey finally resolves. It must not be able to write
    // into the NEW incarnation's record merely because that record has no
    // reading of its own yet.
    A.commit({ id: 'A (straggler from the forgotten incarnation)' }, { replayable: true })

    h.advance(1)
    const replay = h.open('sess-1')
    assert.equal(replay.admitted, false, "still inside B's window")
    assert.equal(replay.cached, null, "B's record must hold no reading from A's stale write-through")
  })

  it('POSITIVE CONTROL: the ordinary (non-forget) superseded write-through is unaffected — same lineage still writes through', () => {
    // Without this, a fix that blocked EVERY write-through (not just a
    // cross-lineage one) would pass the test above for the wrong reason.
    const h = harness()
    const first = h.open('sess-1')
    h.advance(6_000)
    h.open('sess-1') // supersedes `first` — no forget() in between, same lineage

    first.commit({ id: 'first (slow)' }, { replayable: true })

    h.advance(1)
    const replay = h.open('sess-1')
    assert.equal(replay.admitted, false)
    assert.deepEqual(replay.cached, { id: 'first (slow)' }, 'a same-lineage write-through must still land')
  })
})
