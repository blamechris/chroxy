/**
 * Mutation proofs: one broken rule per invariant, swapped in through the
 * policy object, must turn the generated-sequence suite red on THAT
 * invariant. And the design-literal witnesses: each rule read as the design
 * writes it, where the model had to choose otherwise, fails a named invariant.
 *
 * Each case starts at a seed recorded when the proof was written and searches
 * on from there, so the proof stays fast and survives small generator changes.
 * The default policy must pass the same seed: the rule, not the seed, fails.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { withPolicy } from '../../src/freshness/policy.js'
import { runSequence } from './helpers/sequence.js'
import { LITERAL, MUTANTS } from './helpers/variants.js'

const SEEDS = {
  I1a: 1, I1b: 1, I1c: 1, I1d: 1, I2: 1, I2b: 1, I2c: 1605, I3a: 3, I3b: 51, I4a: 1, I4b: 1, I5: 2, I6: 1285,
  I7a: 1, I7b: 5, I7c: 4, I7d: 1, I7e: 236, I7f: 14, I7g: 2, I8: 1, I9: 1,
  ackFreesSlot: 2, anyNewReportIsContent: 1285, contentMayMoveBack: 10, reReadOnResume: 3, staleOwnerBlockInconclusive: 1,
  onlyOwnPromptAnswer: 54, noRecheckAfterOwnerWait: 285,
}
const SEARCH = 300

function firstFailure(policy, expect, from) {
  for (let seed = from; seed < from + SEARCH; seed++) {
    const r = runSequence(seed, { policy })
    if (!r.ok && r.error.id === expect) return { seed, r }
  }
  return null
}

describe('mutation proofs: each invariant goes red when its rule is broken', () => {
  for (const [id, policy] of Object.entries(MUTANTS)) {
    it(`${id}`, () => {
      const f = firstFailure(policy, id, SEEDS[id])
      assert.ok(f, `the ${id} mutant survived ${SEARCH} seeds from ${SEEDS[id]}`)
      assert.ok(runSequence(f.seed).ok, `the default policy also fails seed ${f.seed}`)
    })
  }
})

describe('design-literal witnesses: the design text read literally fails an invariant', () => {
  for (const [name, { policy, expect }] of Object.entries(LITERAL)) {
    it(`${name} fails ${expect}`, () => {
      const f = firstFailure(policy, expect, SEEDS[name])
      assert.ok(f, `${name} did not fail ${expect} in ${SEARCH} seeds from ${SEEDS[name]}`)
      assert.ok(runSequence(f.seed).ok)
    })
  }
})

describe('two guards where the design states one', () => {
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
