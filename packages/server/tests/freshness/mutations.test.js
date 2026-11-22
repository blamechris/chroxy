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
import { makeConfig } from './model/config.js'
import { itemIds } from './model/keys.js'
import { planConfig, run } from './model/reconciler.js'
import { Crash, MIN, OWNER, T0, createHarness } from './helpers/harness.js'
import { InvariantError, checkStep, createMonitor } from './helpers/invariants.js'
import { runSequence } from './helpers/sequence.js'
import { LITERAL, MUTANTS } from './helpers/variants.js'
import * as W from './helpers/world.js'

const SEEDS = {
  I1a: 5, I1b: 1, I1c: 2, I1d: 1, I2: 1, I2b: 2, 'I2c.front': 3681, I3a: 4, I3b: 12, I4a: 1, I4b: 1, 'I4b.lapsed': 4, I5: 10, 'I5.ask': 6, 'I5.content': 76, I6: 271,
  I7a: 1, 'I7a.onset': 1, I7i: 1, I7b: 3, I7c: 2, I7d: 2, I7f: 40, 'I7f.window': 3611, I7g: 9, I8: 1, I8b: 1, I9: 10, I10: 4, 'I10.close': 6,
  I11: 7, 'I11.handover': 65, I12: 119, I13: 6, 'I13.none': 30, 'I13.round': 18, 'I13.declared': 66, 'I1a.round2': 18, 'I1a.restore': 18, 'I2.round': 59, 'I2.slotless': 59, 'I13.wait': 63, 'I1d.counted': 18,
  ackFreesSlot: 1, anyNewReportIsContent: 271, contentMayMoveBack: 70, reReadOnResume: 4, raiseBesideOwnerBlock: 7, twoOwnerItems: 6,
  onlyOwnPromptAnswer: 82, noRecheckAfterOwnerWait: 129,
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
    if (name === 'I7e' || name === 'I2c') continue
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

  // Random sequences reach this preemption only rarely, so I2c is proven on a
  // schedule built for it: an item is active, a prompt whose deadline comes
  // before the active item's next reminder preempts it, and the process dies
  // between the preemption and the preemptor's show. The replay comes after
  // the preemptor's deadline has passed, so only the preemptor-first rule
  // keeps the preempted item from being shown straight back.
  it('I2c (scenario): the preempted item shown straight back after a crash is caught', () => {
    const build = (policy) => {
      const h = createHarness({ config: { per_source: { chroxy: 15 } }, ...(policy ? { policy } : {}) })
      const a = W.addSession(h.world, { source: 'chroxy', native_id: 'a', scope: 'r' })
      const b = W.addSession(h.world, { source: 'chroxy', native_id: 'b', scope: 'r' })
      W.author(h.world, a, T0, { state: 'blocked', blocked_on: 'approve', owner: OWNER })
      W.author(h.world, b, T0, { state: 'running', next: 'b' })
      const mon = createMonitor({ config: h.ctx.state.config, firstCycleBound: 20, surfaceBound: 100 })
      h.tick('chroxy', T0 + 15 * MIN)
      checkStep(mon, h)
      // A deadline at +46, before a's first reminder at +75.
      W.raisePrompt(h.world, b, T0 + 16 * MIN, 30 * 60)
      return { h, mon }
    }
    const run = (policy) => {
      const slotStart = T0 + 30 * MIN
      for (let n = 0; n < 80; n++) {
        const { h, mon } = build(policy)
        try {
          h.tick('chroxy', T0 + 30 * MIN, { crashAfter: n, slotStart })
          continue
        } catch (e) {
          if (!(e instanceof Crash)) throw e
        }
        const surf = h.records('surface')
        const preempted = surf.some((r) => r.body.step === 'preempted')
        const shown = surf.some((r) => r.body.step === 'shown' && r.body.phase === 'attempt' && r.session.native_id === 'b')
        if (!preempted || shown) continue
        // Killed between the preemption and the preemptor's show; replayed
        // in the same slot after the preemptor's deadline has passed.
        try {
          checkStep(mon, h, { complete: false })
          h.restart()
          h.tick('chroxy', T0 + 50 * MIN, { slotStart })
          checkStep(mon, h)
        } catch (e) {
          if (e instanceof InvariantError) return e.id
          throw e
        }
        return null
      }
      throw new Error('the crash point between the preemption and the show was not found')
    }
    assert.equal(run(), null)
    assert.equal(run(MUTANTS.I2c), 'I2c')
  })

  // The same crash and late replay, with a third item owed a prompt round's
  // show: exhausted with its limit used, its prompt's deadline far ahead, so
  // it sorts at the head. A round's show takes no slot, so it must not hide
  // the still-queued preemptor from the preemptor-first rule.
  it('I2c (scenario): a round owed to an item at the head of the order does not let the preempted item be shown straight back', () => {
    const surface = (max) => ({ max_presentations: max, item_time_limit_hours: 8, reminder_after_minutes: [60, 180] })
    const build = (policy) => {
      const h = createHarness({ config: { per_source: { chroxy: 15 }, surface: surface(1) }, ...(policy ? { policy } : {}) })
      const mon = createMonitor({ config: h.ctx.state.config, firstCycleBound: 20, surfaceBound: 100 })
      const add = (id) => W.addSession(h.world, { source: 'chroxy', native_id: id, scope: 'r' })
      const c = add('c')
      const a = add('a')
      const b = add('b')
      const cid = itemIds.owner(h.world.sessions[c].session)
      const at = (m) => T0 + m * MIN
      const tick = (m) => {
        h.tick('chroxy', at(m))
        checkStep(mon, h)
      }
      W.author(h.world, c, T0, { state: 'blocked', blocked_on: 'c', owner: OWNER })
      W.author(h.world, b, T0, { state: 'running', next: 'b' })
      tick(15)
      h.owner(cid, 'done', 'm1', { at: at(16) })
      tick(30)
      h.owner(cid, 'done', 'm2', { at: at(31) })
      tick(45)
      W.author(h.world, a, at(46), { state: 'blocked', blocked_on: 'a', owner: OWNER })
      tick(60)
      // c's round: owed while a holds the slot.
      W.raisePrompt(h.world, c, at(61), 600 * 60)
      tick(75)
      // The limit raised, so a can be shown again; then b's prompt, whose
      // deadline (+107) comes before a's first reminder (+120).
      run(h.ctx, planConfig(h.ctx, { config: makeConfig({ owner_name: OWNER, per_source: { chroxy: 15 }, surface: surface(3) }), now: at(76) }))
      checkStep(mon, h)
      W.raisePrompt(h.world, b, at(77), 30 * 60)
      return { h, mon, cid }
    }
    const run1 = (policy) => {
      const slotStart = T0 + 90 * MIN
      for (let n = 0; n < 120; n++) {
        const { h, mon, cid } = build(policy)
        assert.deepEqual([h.item(cid).state, h.item(cid).roundOwed], ['exhausted', 1])
        try {
          h.tick('chroxy', slotStart, { crashAfter: n, slotStart })
          continue
        } catch (e) {
          if (!(e instanceof Crash)) throw e
        }
        const surf = h.records('surface')
        const preempted = surf.some((r) => r.body.step === 'preempted')
        const shown = surf.some((r) => r.body.step === 'shown' && r.body.phase === 'attempt' && r.session.native_id === 'b')
        if (!preempted || shown) continue
        try {
          checkStep(mon, h, { complete: false })
          h.restart()
          h.tick('chroxy', T0 + 110 * MIN, { slotStart })
          checkStep(mon, h)
        } catch (e) {
          if (e instanceof InvariantError) return e.id
          throw e
        }
        return null
      }
      throw new Error('the crash point between the preemption and the show was not found')
    }
    assert.equal(run1(), null)
    assert.equal(run1(MUTANTS.I2c), 'I2c')
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

  it('I4b (fault): an attention item withdrawn as merged with no owner item carrying it is caught', () => {
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

  it('I11 (fault): an owner item whose recorded list does not match its own changes is caught', () => {
    const rewriteAppend = (d) => (d.kind === 'surface' && d.body.carry?.op === 'carry' ? { ...d, body: { ...d.body, carried: [] } } : d)
    const f = firstFailure('I11', 1, { fault: { rewriteAppend } })
    assert.ok(f)
    assert.match(f.r.error.message, /content names 0 conditions where its changes add up to 1/)
    assert.ok(runSequence(f.seed).ok)
  })

  it('I10 (fault): an owner item whose recorded asks do not match its own ask changes is caught', () => {
    const rewriteAppend = (d) => (d.kind === 'surface' && d.body.ask?.op === 'join' ? { ...d, body: { ...d.body, asks: d.body.asks.filter((a) => a.kind !== d.body.ask.kind) } } : d)
    const f = firstFailure('I10', 1, { fault: { rewriteAppend } })
    assert.ok(f)
    assert.match(f.r.error.message, /content lists asks/)
    assert.ok(runSequence(f.seed).ok)
  })

  it('I10 (fault): a declared ask whose ending is never written stays on the item after the newer report, and is caught', () => {
    const dropAppend = (d) => d.kind === 'surface' && d.body.ask?.op === 'end' && d.body.ask.kind === 'declared'
    const f = firstFailure('I10', 1, { fault: { dropAppend } })
    assert.ok(f)
    assert.match(f.r.error.message, /still carries a declared ask/)
    assert.ok(runSequence(f.seed).ok)
  })

  it('I4b (fault): an ask recorded as ended without its evidence is caught', () => {
    const rewriteAppend = (d) => (d.kind === 'surface' && d.body.ask?.op === 'content' && d.body.ask.kind === 'declared' ? { ...d, body: { ...d.body, ask: { ...d.body.ask, op: 'end', how: 'resolved' }, asks: d.body.asks.filter((a) => a.kind !== 'declared') } } : d)
    const f = firstFailure('I4b', 1, { fault: { rewriteAppend } })
    assert.ok(f)
    assert.match(f.r.error.message, /ask was ended/)
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
