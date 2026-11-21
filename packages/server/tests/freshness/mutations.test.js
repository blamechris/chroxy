/**
 * Mutation proofs: one broken rule per invariant, swapped in through the
 * policy object, must turn the generated-sequence suite red on THAT
 * invariant. Where a check guards structure that no policy rule reaches (a
 * fold, a planner closing what it opened), a test-only fault hook breaks it
 * instead. And the literal-reading witnesses: each rule read literally, where
 * the model had to choose otherwise, fails a named invariant (README lists
 * them).
 *
 * Each case starts at a seed recorded when the proof was written and searches
 * on from there, so the proof stays fast and survives small generator changes.
 * The default policy must pass the same seed: the rule, not the seed, fails.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { withPolicy } from './model/policy.js'
import { MIN, T0, createHarness } from './helpers/harness.js'
import { InvariantError, checkStep, createMonitor } from './helpers/invariants.js'
import { runSequence } from './helpers/sequence.js'
import { LITERAL, MUTANTS } from './helpers/variants.js'
import * as W from './helpers/world.js'

const SEEDS = {
  I1a: 1, I1b: 1, I1c: 1, I1d: 1, I2: 1, I2b: 1, I2c: 2093, 'I2c.front': 782, I3a: 1, I3b: 14, I4a: 3, I4b: 8, 'I4b.lapsed': 1, I5: 11, I6: 158,
  I7a: 1, 'I7a.onset': 1, I7i: 2, I7b: 1, I7c: 2, I7d: 14, I7f: 30, 'I7f.window': 875, I7g: 7, I8: 2, I8b: 1, I9: 9, I10: 1,
  I11: 7, 'I11.handover': 116,
  ackFreesSlot: 1, anyNewReportIsContent: 158, contentMayMoveBack: 12, reReadOnResume: 1, raiseBesideOwnerBlock: 7,
  onlyOwnPromptAnswer: 232, noRecheckAfterOwnerWait: 151,
}
const SEARCH = 300

function firstFailure(expect, from, opts) {
  for (let seed = from; seed < from + SEARCH; seed++) {
    const r = runSequence(seed, opts)
    if (!r.ok && r.error.id === expect) return { seed, r }
  }
  return null
}

describe('mutation proofs: each invariant goes red when its rule is broken', () => {
  for (const [name, policy] of Object.entries(MUTANTS)) {
    if (name === 'I7e') continue
    const expect = name.split('.')[0]
    it(`${name}`, () => {
      const f = firstFailure(expect, SEEDS[name], { policy })
      assert.ok(f, `the ${name} mutant survived ${SEARCH} seeds from ${SEEDS[name]}`)
      assert.ok(runSequence(f.seed).ok, `the default policy also fails seed ${f.seed}`)
    })
  }

  // Random sequences rarely keep one source's budget full of new onsets for
  // long enough, and a starvation that leaves budget unused is I7d's to
  // catch, so I7e is proven on a schedule built for it: a victim goes stale,
  // and a newer competitor goes stale at every tick after.
  it('I7e (scenario): newest onset first starves an old onset past the bound', () => {
    const run = (policy) => {
      const h = createHarness({ config: { per_source: { chroxy: 15 }, investigation_budget_per_tick: 1 }, ...(policy ? { policy } : {}) })
      const victim = W.addSession(h.world, { source: 'chroxy', native_id: 'v', scope: 'r' })
      W.author(h.world, victim, T0, { state: 'running', next: 'v' })
      for (let k = 0; k < 8; k++) {
        const c = W.addSession(h.world, { source: 'chroxy', native_id: `c${k}`, scope: 'r' })
        W.author(h.world, c, T0 + k * 15 * MIN, { state: 'running', next: 'c' })
      }
      const mon = createMonitor({ config: h.ctx.state.config, firstCycleBound: 3, surfaceBound: 100 })
      try {
        for (let k = 1; k <= 14; k++) {
          h.tick('chroxy', T0 + k * 15 * MIN)
          checkStep(mon, h)
        }
      } catch (e) {
        if (e instanceof InvariantError) return e.id
        throw e
      }
      return null
    }
    assert.equal(run(), null)
    assert.equal(run(MUTANTS.I7e), 'I7e')
  })

  it('I7h (fault): a planner that never writes an investigation\'s close record is caught', () => {
    const drop = (d) => d.kind === 'investigation' && d.body.phase === 'close'
    const f = firstFailure('I7h', 1, { fault: { dropAppend: drop } })
    assert.ok(f)
    assert.ok(runSequence(f.seed).ok)
  })

  it('I4b (fault): an attention item resolved but recorded as superseded, with no gone item, is caught', () => {
    const rewriteAppend = (d) => (d.kind === 'surface' && d.body.origin === 'attention' && d.body.step === 'resolved' ? { ...d, body: { ...d.body, step: 'withdrawn', reason: 'superseded' } } : d)
    const f = firstFailure('I4b', 1, { fault: { rewriteAppend } })
    assert.ok(f)
    assert.ok(runSequence(f.seed).ok)
  })

  it('I4b (fault): a seed item withdrawn as owner-stated with no owner "done" is caught', () => {
    const rewriteAppend = (d) => (d.kind === 'surface' && d.body.origin === 'seed' && d.body.step === 'resolved' ? { ...d, body: { ...d.body, step: 'withdrawn', reason: 'owner_stated_unverified' } } : d)
    const f = firstFailure('I4b', 1, { fault: { rewriteAppend } })
    assert.ok(f)
    assert.ok(runSequence(f.seed).ok)
  })

  it('I4b (fault): an attention item withdrawn as merged with no owner-block item carrying it is caught', () => {
    const rewriteAppend = (d) => (d.kind === 'surface' && d.body.origin === 'attention' && d.body.step === 'resolved' ? { ...d, body: { ...d.body, step: 'withdrawn', reason: 'merged' } } : d)
    const f = firstFailure('I4b', 1, { fault: { rewriteAppend } })
    assert.ok(f)
    assert.ok(runSequence(f.seed).ok)
  })

  it('I11 (fault): a carried condition whose clearing is never written stays named after it ended, and is caught', () => {
    const dropAppend = (d) => d.kind === 'surface' && d.body.step === 'updated' && d.body.carry?.op === 'clear'
    const f = firstFailure('I11', 1, { fault: { dropAppend } })
    assert.ok(f)
    assert.ok(runSequence(f.seed).ok)
  })

  it('I4c (fault): a derived state that drops an open item is caught', () => {
    const afterStep = (h, i) => {
      if (i !== 60) return
      const it = [...h.ctx.state.items.values()].find((x) => x.open)
      if (it) it.open = false
    }
    const f = firstFailure('I4c', 1, { fault: { afterStep } })
    assert.ok(f)
    assert.ok(runSequence(f.seed).ok)
  })
})

describe('literal-reading witnesses: the rule read literally fails an invariant', () => {
  for (const [name, { policy, expect }] of Object.entries(LITERAL)) {
    it(`${name} fails ${expect}`, () => {
      const f = firstFailure(expect, SEEDS[name], { policy })
      assert.ok(f, `${name} did not fail ${expect} in ${SEARCH} seeds from ${SEEDS[name]}`)
      assert.ok(runSequence(f.seed).ok)
    })
  }
})

describe('two guards where the rules state one', () => {
  // No second send after a crash is held by two rules: an attempt record
  // uses up its step (so the replay never plans it again) and the key is
  // looked up before an attempt. Either alone suffices; the I3b mutant breaks
  // both. Shown here on the seed where the pair fails.
  it('the key lookup alone, or the attempt using up its step alone, still stops a second send', () => {
    const seed = SEEDS.I3b
    assert.equal(runSequence(seed, { policy: MUTANTS.I3b }).error?.id, 'I3b')
    for (const single of [withPolicy({ attemptAlreadyRecorded: () => false }), withPolicy({ attemptUsesOrdinal: false })]) {
      const r = runSequence(seed, { policy: single })
      assert.notEqual(r.error?.id, 'I3b')
    }
  })

  // "One return per episode" is held by the stored counter and by the
  // constant ordinal 1 in the `returned` key. Break the counter alone and the
  // key silently refuses the second return, leaving the item acknowledged and
  // holding the slot (I2b).
  it('breaking only the return counter wedges the slot instead of sending twice', () => {
    const r = runSequence(SEEDS.I2b, { policy: withPolicy({ verifyFailedStep: () => 'returned' }) })
    assert.equal(r.error?.id, 'I2b')
    const pair = runSequence(SEEDS.I1c, { policy: MUTANTS.I1c })
    assert.equal(pair.error?.id, 'I1c')
  })
})
