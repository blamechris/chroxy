/**
 * One owner item per session: a declared block that names the owner and a
 * pending prompt are two asks on one item (README, "The owner item").
 *
 * Every scenario runs with the invariant monitor checked after each tick.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { itemIds } from './model/keys.js'
import { compareKeys } from './model/policy.js'
import { makeConfig } from './model/config.js'
import { planConfig, run } from './model/reconciler.js'
import { Crash, MIN, OWNER, T0, createHarness } from './helpers/harness.js'
import { InvariantError, checkStep, createMonitor } from './helpers/invariants.js'
import { LITERAL, MUTANTS } from './helpers/variants.js'
import * as W from './helpers/world.js'

const FAST = { per_source: { chroxy: 15, codex: 15, 'claude-desktop': 15 } }
const ownerBlock = (blocked_on = 'approve the merge') => ({ state: 'blocked', blocked_on, owner: OWNER })
const at = (m) => T0 + m * MIN

function setup(over = {}, policy) {
  const h = createHarness({ config: { ...FAST, ...over }, ...(policy ? { policy } : {}) })
  const mon = createMonitor({ config: h.ctx.state.config, firstCycleBound: 20, surfaceBound: 100 })
  const c = W.addSession(h.world, { source: 'chroxy', native_id: 'c', scope: 'repo' })
  const s = h.world.sessions[c].session
  const id = itemIds.owner(s)
  const tick = (m, opts) => {
    h.tick('chroxy', at(m), opts)
    checkStep(mon, h)
  }
  const owner = (intent, ref, m, until) => {
    h.owner(id, intent, ref, { at: at(m), until: until == null ? null : at(until) })
    checkStep(mon, h)
  }
  return { h, mon, sk: c, s, id, tick, owner }
}

const steps = (h, id) => h.surface(id).filter((r) => r.body.phase !== 'outcome')
const asks = (h, id) => [...h.item(id).asks.keys()].sort()
const sent = (h, id) => h.sendsFor(id).map((x) => `${x.step}${x.n}`)
const joins = (h, id) => steps(h, id).filter((r) => r.body.ask?.op === 'join')

describe('one owner item per session', () => {
  it('a prompt joins a declared block: one item with both asks, shown again with a counted show', () => {
    const { h, sk, id, tick } = setup()
    W.author(h.world, sk, T0, ownerBlock())
    tick(15)
    assert.deepEqual(sent(h, id), ['shown1'])
    W.raisePrompt(h.world, sk, at(16), 7200)
    tick(30)
    assert.deepEqual(h.openItems().map((i) => i.itemId), [id])
    assert.deepEqual(asks(h, id), ['declared', 'prompt'])
    assert.deepEqual(sent(h, id), ['shown1', 'shown2'])
    assert.equal(h.item(id).counters.shows_counted, 2)
    assert.equal(joins(h, id)[0].body.ask.kind, 'prompt')
    assert.equal(h.item(id).episode, 1)
  })

  it('a declared block joins a prompt: the same, the other way round', () => {
    const { h, sk, id, tick } = setup()
    W.author(h.world, sk, T0, { state: 'running', next: 'a' })
    W.raisePrompt(h.world, sk, at(1), 7200)
    tick(15)
    assert.deepEqual(asks(h, id), ['prompt'])
    W.author(h.world, sk, at(16), ownerBlock())
    tick(30)
    assert.deepEqual(asks(h, id), ['declared', 'prompt'])
    assert.equal(joins(h, id)[0].body.ask.kind, 'declared')
    assert.deepEqual(sent(h, id), ['shown1', 'shown2'])
  })

  it('read the earlier way, the same session holds two owner items and I9 fails', () => {
    const { h, mon, sk } = setup({}, LITERAL.twoOwnerItems.policy)
    W.author(h.world, sk, T0, ownerBlock())
    h.tick('chroxy', at(15))
    checkStep(mon, h)
    W.raisePrompt(h.world, sk, at(16), 7200)
    h.tick('chroxy', at(30))
    assert.throws(() => checkStep(mon, h), (e) => e instanceof InvariantError && e.id === 'I9')
  })

  it('mutation: a new ask that only changes the content turns I13 red', () => {
    const { h, mon, sk } = setup({}, MUTANTS.I13)
    W.author(h.world, sk, T0, ownerBlock())
    h.tick('chroxy', at(15))
    checkStep(mon, h)
    W.raisePrompt(h.world, sk, at(16), 7200)
    h.tick('chroxy', at(30))
    assert.throws(() => checkStep(mon, h), (e) => e instanceof InvariantError && e.id === 'I13')
  })
})

describe('asks end one at a time', () => {
  function bothAsks() {
    const sc = setup()
    W.author(sc.h.world, sc.sk, T0, ownerBlock())
    sc.tick(15)
    sc.ref = W.raisePrompt(sc.h.world, sc.sk, at(16), 7200)
    sc.tick(30)
    return sc
  }

  it('the prompt answered while the declared block stays: an update that drops it, nothing sent, the item open', () => {
    const { h, sk, id, tick, ref } = bothAsks()
    const before = h.sends.length
    W.answerPrompt(h.world, sk, ref, at(31))
    tick(45)
    const last = steps(h, id).at(-1)
    assert.equal(last.body.step, 'updated')
    assert.deepEqual([last.body.ask.op, last.body.ask.kind, last.body.ask.how], ['end', 'prompt', 'answered'])
    assert.deepEqual(asks(h, id), ['declared'])
    assert.ok(h.item(id).open)
    assert.equal(h.sends.length, before)
  })

  it('the declared block ending while the prompt stays: the same; then the prompt, the last ask, closes the item with `resolved`', () => {
    const { h, sk, id, tick, ref } = bothAsks()
    const before = h.sends.length
    W.author(h.world, sk, at(31), { state: 'running', next: 'go' })
    tick(45)
    assert.deepEqual(asks(h, id), ['prompt'])
    assert.equal(h.sends.length, before)
    W.answerPrompt(h.world, sk, ref, at(46))
    tick(60)
    const last = steps(h, id).at(-1)
    assert.deepEqual([last.body.step, last.body.closing_ask, last.body.resolution_evidence], ['resolved', 'prompt', ref])
    assert.equal(h.item(id).state, 'closed')
  })

  it('the declared block as the last ask closes the item with `resolved` on the newer report', () => {
    const { h, sk, id, tick, ref } = bothAsks()
    W.answerPrompt(h.world, sk, ref, at(31))
    tick(45)
    W.author(h.world, sk, at(46), { state: 'running', next: 'go' })
    tick(60)
    const last = steps(h, id).at(-1)
    assert.deepEqual([last.body.step, last.body.closing_ask], ['resolved', 'declared'])
    assert.equal(last.body.resolution_evidence, h.ctx.state.sessions.get(sk).latestAuthored)
  })

  it('a lapsed prompt as the last ask closes the item with `withdrawn`, reason lapsed', () => {
    const { h, sk, id, tick } = setup()
    W.author(h.world, sk, T0, { state: 'running', next: 'a' })
    const ref = W.raisePrompt(h.world, sk, at(1), 7200)
    tick(15)
    W.lapsePrompt(h.world, sk, ref, at(16))
    W.author(h.world, sk, at(17), { state: 'idle' })
    tick(30)
    const last = steps(h, id).at(-1)
    assert.deepEqual([last.body.step, last.body.reason, last.body.closing_ask], ['withdrawn', 'lapsed', 'prompt'])
  })

  it('mutation: an item closed when its first ask ends, while the other is live, turns I10 red', () => {
    const { h, mon, sk } = setup({}, MUTANTS['I10.close'])
    W.author(h.world, sk, T0, ownerBlock())
    h.tick('chroxy', at(15))
    checkStep(mon, h)
    const ref = W.raisePrompt(h.world, sk, at(16), 7200)
    h.tick('chroxy', at(30))
    checkStep(mon, h)
    W.answerPrompt(h.world, sk, ref, at(31))
    h.tick('chroxy', at(45))
    assert.throws(() => checkStep(mon, h), (e) => e instanceof InvariantError && e.id === 'I10')
  })
})

describe('references an ask stood on', () => {
  // A declared block on R1 with a prompt live; the line reworded to R2 (new
  // content); a newer line R3 that is no owner block ends the declared ask;
  // the session rewound to R2.
  function rewound(policy) {
    const { h, mon, sk, id } = setup({}, policy)
    const step = (m) => {
      h.tick('chroxy', at(m))
      checkStep(mon, h)
    }
    W.author(h.world, sk, T0, ownerBlock('approve the merge'))
    W.raisePrompt(h.world, sk, at(1), 7200)
    step(15)
    W.author(h.world, sk, at(16), ownerBlock('approve the other merge'))
    step(30)
    W.author(h.world, sk, at(31), { state: 'running', next: 'go' })
    step(45)
    const shows = () => h.sendsFor(id).filter((x) => x.step === 'shown').length
    const before = shows()
    W.rewind(h.world, sk, 1)
    step(60)
    step(75)
    return { h, id, before, shows }
  }

  it('a declared block rewound to a line its content had moved to does not come back: no join, no extra show', () => {
    const { h, id, before, shows } = rewound()
    const declared = steps(h, id).filter((r) => r.body.ask?.kind === 'declared').map((r) => r.body.ask.op)
    assert.deepEqual(declared, ['open', 'content', 'end'], 'R2 was its content; it is never an opening again')
    assert.deepEqual(asks(h, id), ['prompt'])
    assert.equal(shows(), before, 'no extra show')
  })

  it('mutation: with only opening references used, the rewound line joins again and I5 goes red', () => {
    assert.throws(() => rewound(MUTANTS['I5.content']), (e) => e instanceof InvariantError && e.id === 'I5')
  })
})

describe('a prompt the ask opened on, still pending when the ask ends', () => {
  // P1 pending opens the prompt ask; P2 raised moves its content to P2; P2
  // answered while P1 is still pending ends the ask. P1 must be an ask again.
  function movedPast(policy, { declared = false } = {}) {
    const sc = setup({}, policy)
    const { h, sk } = sc
    W.author(h.world, sk, T0, declared ? ownerBlock() : { state: 'running', next: 'a' })
    sc.p1 = W.raisePrompt(h.world, sk, at(1), 7200)
    sc.tick(15)
    sc.p2 = W.raisePrompt(h.world, sk, at(16), 7200)
    sc.tick(30)
    W.answerPrompt(h.world, sk, sc.p2, at(31))
    sc.tick(45)
    return sc
  }
  const promptAsk = (h, id) => h.item(id)?.asks.get('prompt')

  it('with no other ask: the item closes on the answer and the same tick opens a new episode with a prompt ask for P1, shown', () => {
    const { h, id, p1, p2, tick } = movedPast()
    const closing = steps(h, id).find((r) => r.body.step === 'resolved')
    assert.deepEqual([closing.body.closing_ask, closing.body.resolution_evidence, closing.body.episode], ['prompt', p2, 1])
    const it = h.item(id)
    assert.ok(it.open, 'the session waits on the owner for P1: it has an owner item')
    assert.equal(it.episode, 2)
    assert.equal(promptAsk(h, id).content_ref, p1)
    assert.notEqual(promptAsk(h, id).opened_by, p1, 'P1 was the first ask\'s opening reference; the new ask opens on a new one')
    assert.deepEqual(sent(h, id), ['shown1', 'shown1'], 'one show per episode')
    // A tick that brings no owner answer adds nothing: no loop.
    const before = h.surface(id).length
    tick(60)
    assert.equal(h.surface(id).length, before)
  })

  it('a second time (P3 raised and answered while P1 is still pending): yet another reference; then P1 answered closes it for good', () => {
    const { h, sk, id, p1, tick } = movedPast()
    const first = promptAsk(h, id).opened_by
    const p3 = W.raisePrompt(h.world, sk, at(61), 7200)
    tick(75)
    assert.equal(promptAsk(h, id).content_ref, p3)
    W.answerPrompt(h.world, sk, p3, at(76))
    tick(90)
    assert.equal(h.item(id).episode, 3)
    assert.equal(promptAsk(h, id).content_ref, p1)
    assert.notEqual(promptAsk(h, id).opened_by, first)
    assert.notEqual(promptAsk(h, id).opened_by, p1)
    W.answerPrompt(h.world, sk, p1, at(91))
    tick(105)
    tick(120)
    assert.equal(h.item(id).open, false)
    assert.equal(h.item(id).episode, 3, 'an answered prompt is never added again')
    assert.equal(h.conflicts().length, 0)
  })

  it('with the declared block keeping the item open: the prompt ask ends and P1 joins again in the same tick, shown as a new ask', () => {
    const { h, id, p1 } = movedPast(undefined, { declared: true })
    const changes = steps(h, id).filter((r) => r.body.ask?.kind === 'prompt').map((r) => r.body.ask.op)
    assert.deepEqual(changes, ['join', 'content', 'end', 'join'])
    assert.ok(h.item(id).open)
    assert.equal(h.item(id).episode, 1)
    assert.deepEqual(asks(h, id), ['declared', 'prompt'])
    assert.equal(promptAsk(h, id).content_ref, p1)
    assert.deepEqual(sent(h, id), ['shown1', 'shown2'], 'the block and the first prompt (one show: they arrived in one tick), then P1 again: a counted show')
    assert.equal(steps(h, id).at(-1).body.new_ask, true)
  })

  it('killed at every operation of the tick that adds P1 again and replayed: one new ask on one reference, no conflict, no second send', () => {
    let points = 0
    for (let op = 0; ; op++) {
      const { h, mon, sk, id, tick } = setup()
      W.author(h.world, sk, T0, { state: 'running', next: 'a' })
      const p1 = W.raisePrompt(h.world, sk, at(1), 7200)
      tick(15)
      const p2 = W.raisePrompt(h.world, sk, at(16), 7200)
      tick(30)
      W.answerPrompt(h.world, sk, p2, at(31))
      let crashed = false
      try {
        h.tick('chroxy', at(45), { crashAfter: op })
      } catch (e) {
        if (!(e instanceof Crash)) throw e
        crashed = true
        checkStep(mon, h, { complete: false })
        h.restart()
        h.tick('chroxy', at(48), { slotStart: h.slotFor('chroxy', at(45)) })
      }
      checkStep(mon, h)
      assert.equal(h.conflicts().length, 0, `crash at op ${op}`)
      const ids = h.sends.map((x) => x.attempt_id)
      assert.equal(new Set(ids).size, ids.length, `no second send: op ${op}`)
      const opens = steps(h, id).filter((r) => r.body.step === 'queued')
      assert.equal(opens.length, 2, `two episodes: op ${op}`)
      assert.equal(opens[1].body.ask.content_ref, p1)
      if (!crashed) break
      points += 1
    }
    assert.ok(points > 5, `${points} crash points exercised`)
  })

  it('fault: a prompt ask added again for a prompt that is no longer pending is caught by I5', () => {
    const { h, mon, sk, p1, tick } = movedPast()
    W.answerPrompt(h.world, sk, p1, at(46))
    tick(60)
    const p4 = W.raisePrompt(h.world, sk, at(61), 7200)
    // The new ask on P4 recorded as if it were for P1, which an earlier ask
    // stood on and which is answered.
    const forge = (a) => (a.kind === 'prompt' && a.content_ref === p4 ? { ...a, content_ref: p1 } : a)
    h.rewriteAppend = (d) => (d.kind === 'surface' && d.body.step === 'queued' && d.body.ask ? { ...d, body: { ...d.body, ask: forge(d.body.ask), asks: d.body.asks.map(forge) } } : d)
    h.tick('chroxy', at(75))
    assert.throws(() => checkStep(mon, h), (e) => e instanceof InvariantError && e.id === 'I5' && /not pending/.test(e.message))
  })

  it('mutation: the earlier rule (P1 refused as a used reference) leaves the pending prompt with no item, and I10 goes red', () => {
    assert.throws(() => movedPast(MUTANTS['I10.prompt']), (e) => e instanceof InvariantError && e.id === 'I10')
  })
})

describe('reports a declared ask covered without a content change', () => {
  // The fingerprint leaves out the next step, so on a source that stamps a
  // declaration only when it changes, the same block with another next step
  // is a new report with no content change. A prompt keeps the item open, so
  // a rewind to that report would be a join.
  function sameBlockNewReport(policy) {
    const { h, mon, sk, id } = setup({}, policy)
    const step = (m) => {
      h.tick('chroxy', at(m))
      checkStep(mon, h)
    }
    W.author(h.world, sk, T0, { ...ownerBlock(), next: 'a' })
    W.raisePrompt(h.world, sk, at(1), 7200)
    step(15)
    W.author(h.world, sk, at(16), { ...ownerBlock(), next: 'b' })
    step(30)
    W.author(h.world, sk, at(31), { state: 'running', next: 'go' })
    step(45)
    const shows = () => h.sendsFor(id).filter((x) => x.step === 'shown').length
    const before = shows()
    W.rewind(h.world, sk, 1)
    step(60)
    return { h, id, before, shows }
  }

  // On a source that stamps every message, an identical re-authored line is
  // a new report too. With no prompt, the declared ask's ending closes the
  // item, so a rewind to that report would open a new episode.
  function identicalLine(policy) {
    const { h, mon } = setup({}, policy)
    const x = W.addSession(h.world, { source: 'codex', native_id: 'x', scope: 'repo' })
    const id = itemIds.owner(h.world.sessions[x].session)
    const step = (m) => {
      h.tick('codex', at(m))
      checkStep(mon, h)
    }
    W.author(h.world, x, T0, ownerBlock())
    step(15)
    W.author(h.world, x, at(16), ownerBlock())
    step(30)
    W.author(h.world, x, at(31), { state: 'running', next: 'go' })
    step(45)
    const shows = () => h.sendsFor(id).filter((y) => y.step === 'shown').length
    const before = shows()
    W.rewind(h.world, x, 1)
    step(60)
    return { h, id, before, shows }
  }

  it('the same block with another next step, rewound to while a prompt keeps the item open: no join, no show', () => {
    const { h, id, before, shows } = sameBlockNewReport()
    assert.deepEqual(steps(h, id).filter((r) => r.body.ask?.kind === 'declared').map((r) => r.body.ask.op), ['open', 'end'], 'no content change, and no join')
    assert.deepEqual(asks(h, id), ['prompt'])
    assert.equal(shows(), before)
  })

  it('an identical re-authored line on a source that stamps every message, rewound to after the item closed: no new episode, no show', () => {
    const { h, id, before, shows } = identicalLine()
    assert.equal(h.item(id).state, 'closed')
    assert.equal(h.item(id).episode, 1)
    assert.equal(shows(), before)
  })

  it('mutation: with only opening references used, both rewinds bring the declared ask back and I5 goes red', () => {
    for (const run of [sameBlockNewReport, identicalLine]) {
      assert.throws(() => run(MUTANTS['I5.content']), (e) => e instanceof InvariantError && e.id === 'I5')
    }
  })
})

describe('the class of a two-ask item', () => {
  it('a two-ask item sorts by its earliest live ask: when the earlier ask ends, it sorts by the one left', () => {
    const { h, sk, id, tick } = setup()
    const o = W.addSession(h.world, { source: 'chroxy', native_id: 'o', scope: 'repo' })
    W.author(h.world, sk, T0, { state: 'running', next: 'a' })
    const ref = W.raisePrompt(h.world, sk, at(1), 7200)
    W.author(h.world, o, at(10), ownerBlock('another'))
    tick(15)
    W.author(h.world, sk, at(16), ownerBlock())
    tick(30)
    assert.deepEqual(asks(h, id), ['declared', 'prompt'])
    assert.equal(h.item(id).orderTime, at(1), 'the earlier of its two asks')
    W.answerPrompt(h.world, sk, ref, at(31))
    tick(45)
    assert.deepEqual(asks(h, id), ['declared'])
    assert.equal(h.item(id).orderTime, at(16), 'the ask that is left')
    // Both are declared-only owner items now: the other one, authored at +10,
    // goes first.
    const other = h.item(itemIds.owner(h.world.sessions[o].session))
    assert.equal(compareKeys(h.ctx.policy.orderKey(other, at(45)), h.ctx.policy.orderKey(h.item(id), at(45))), -1)
  })


  it('a prompt with a deadline puts the item in the deadline class with that deadline; when the prompt ends it returns to the owner class', () => {
    const { h, sk, id, tick } = setup()
    W.author(h.world, sk, T0, ownerBlock())
    tick(15)
    const ref = W.raisePrompt(h.world, sk, at(16), 7200)
    tick(30)
    const it = h.item(id)
    assert.equal(it.deadline, at(16) + 7200 * 1000)
    const key = h.ctx.policy.orderKey(it, at(30))
    assert.equal(key[0], 0, 'the deadline class')
    assert.equal(key[4], it.deadline, 'ordered by its deadline')
    W.answerPrompt(h.world, sk, ref, at(31))
    tick(45)
    const after = h.ctx.policy.orderKey(h.item(id), at(45))
    assert.equal(h.item(id).deadline, null)
    assert.deepEqual([after[0], after[3]], [1, 1], 'the owner class, behind owner items with a live prompt')
    // With a live prompt but no deadline left, it sorts ahead of a declared-only owner item.
    const promptOnly = { ...h.item(id), promptLive: true, deadline: null, orderTime: Infinity }
    assert.equal(compareKeys(h.ctx.policy.orderKey(promptOnly, at(45)), after), -1)
  })
})

describe('a new ask in each state of the item', () => {
  it('exhausted with a counted show left: queued again and shown; with none left: a prompt round is shown once and the item stays exhausted', () => {
    for (const max of [3, 1]) {
      const { h, sk, id, tick, owner } = setup({ surface: { max_presentations: max, item_time_limit_hours: 8, reminder_after_minutes: [60, 180] } })
      W.author(h.world, sk, T0, ownerBlock())
      tick(15)
      owner('done', 'm1', 16)
      tick(30)
      owner('done', 'm2', 31)
      tick(45)
      assert.equal(h.item(id).state, 'exhausted')
      const before = sent(h, id)
      W.raisePrompt(h.world, sk, at(46), 7200)
      tick(60)
      assert.deepEqual(asks(h, id), ['declared', 'prompt'])
      if (max === 3) {
        assert.deepEqual(sent(h, id), [...before, 'shown2'])
        assert.equal(joins(h, id)[0].body.requeue, true)
      } else {
        assert.deepEqual(sent(h, id), [...before, 'shown2'], 'the round\'s one show')
        assert.equal(h.item(id).counters.shows_counted, 1, 'not taken from the limit')
        assert.equal(h.item(id).counters.round_shows, 1)
        assert.equal(h.item(id).state, 'exhausted', 'exhausted and listed, not holding the slot')
      }
    }
  })

  it('deferred by the owner: the new ask cancels the deferral and is shown, counted', () => {
    const { h, sk, id, tick, owner } = setup()
    W.author(h.world, sk, T0, ownerBlock())
    tick(15)
    owner('defer', 'd1', 16, 16 + 8 * 60)
    assert.equal(h.item(id).state, 'deferred')
    W.raisePrompt(h.world, sk, at(17), 7200)
    tick(30)
    assert.deepEqual(sent(h, id), ['shown1', 'shown2'])
    assert.equal(h.item(id).counters.shows_counted, 2, 'counted, not a show after the deferral')
    assert.equal(h.item(id).state, 'active')
  })

  it('acknowledged and holding the slot for its verification: shown again at once, and the acknowledgment is not verified', () => {
    const { h, sk, id, tick, owner } = setup()
    W.author(h.world, sk, T0, ownerBlock())
    tick(15)
    owner('done', 'm1', 16)
    W.raisePrompt(h.world, sk, at(17), 7200)
    tick(30)
    assert.deepEqual(sent(h, id), ['shown1', 'shown2'], 'a show, not a return')
    assert.equal(h.item(id).state, 'active')
    assert.equal(h.records('owner_ack').filter((r) => r.body.phase === 'verify').length, 0)
  })

  it('queued behind another item: keeps its place, and its next show is a counted one', () => {
    const { h, sk, id, tick } = setup()
    const o = W.addSession(h.world, { source: 'chroxy', native_id: 'o', scope: 'repo' })
    W.author(h.world, o, T0, ownerBlock('another'))
    W.author(h.world, sk, T0 + 1000, ownerBlock())
    tick(15)
    const other = itemIds.owner(h.world.sessions[o].session)
    assert.deepEqual(sent(h, other), ['shown1'])
    assert.equal(h.item(id).state, 'queued')
    W.raisePrompt(h.world, sk, at(16), 7200)
    tick(30)
    assert.deepEqual(sent(h, id), [], 'the slot is held')
    assert.equal(h.item(id).state, 'queued')
    W.author(h.world, o, at(31), { state: 'running', next: 'go' })
    tick(45)
    assert.deepEqual(sent(h, id), ['shown1'])
    assert.equal(h.item(id).counters.shows_counted, 1)
  })

  it('a new-ask show restarts the reminder and time-limit clock; the reminders used stay used', () => {
    const { h, sk, id, tick } = setup()
    W.author(h.world, sk, T0, ownerBlock())
    for (const m of [15, 30, 45, 60, 75]) tick(m)
    assert.deepEqual(sent(h, id), ['shown1', 'reminded1'])
    W.raisePrompt(h.world, sk, at(76), 7200)
    tick(90)
    assert.deepEqual(sent(h, id), ['shown1', 'reminded1', 'shown2'])
    // Reminder 2 comes 180 minutes after the new-ask show (+270), not after
    // the first show (+195).
    for (let m = 105; m <= 255; m += 15) tick(m)
    assert.deepEqual(sent(h, id), ['shown1', 'reminded1', 'shown2'])
    tick(270)
    assert.deepEqual(sent(h, id), ['shown1', 'reminded1', 'shown2', 'reminded2'])
  })
})

describe('one send history: a standing declared block through five prompt rounds', () => {
  it('after the show limit, each later prompt round is shown once: shows 1 to 6 and reminder 1, nothing more', () => {
    const { h, sk, id, tick } = setup()
    W.author(h.world, sk, T0, ownerBlock())
    tick(15)
    let m = 15
    for (let k = 0; k < 5; k++) {
      const ref = W.raisePrompt(h.world, sk, at(m + 1))
      tick((m += 15))
      W.answerPrompt(h.world, sk, ref, at(m + 1))
      tick((m += 15))
    }
    // The block at +15; rounds 1 and 2 (+30, +60) use the counted shows;
    // rounds 3 to 5 (+90, +120, +150) each earn one. Reminder 1 falls 60
    // minutes after the latest counted show (+60): round shows move no clock.
    assert.deepEqual(sent(h, id), ['shown1', 'shown2', 'shown3', 'shown4', 'shown5', 'reminded1', 'shown6'])
    const at1 = (n) => (Date.parse(h.surface(id).find((r) => r.body.step === 'reminded' && r.body.n === n && r.body.phase === 'attempt').ts) - T0) / MIN
    assert.equal(at1(1), 120)
    assert.equal(joins(h, id).length, 5, 'five prompts joined')
    assert.deepEqual(joins(h, id).map((r) => r.body.round_owed ?? 0), [0, 0, 1, 1, 1])
    assert.deepEqual([h.item(id).counters.shows_counted, h.item(id).counters.round_shows], [3, 3])
    assert.equal(h.item(id).episode, 1)
    assert.deepEqual(asks(h, id), ['declared'])
    assert.equal(h.conflicts().length, 0)
  })
})

describe('prompt rounds after the show limit', () => {
  const ONE = { surface: { max_presentations: 1, item_time_limit_hours: 8, reminder_after_minutes: [60, 180] } }
  const shows = (h, id) => h.sendsFor(id).filter((x) => x.step === 'shown').length

  it('a declared block joining with the limit used only changes the content: no show', () => {
    const { h, sk, id, tick } = setup(ONE)
    W.author(h.world, sk, T0, { state: 'running', next: 'a' })
    W.raisePrompt(h.world, sk, at(1), 7200)
    tick(15)
    assert.deepEqual(sent(h, id), ['shown1'])
    W.author(h.world, sk, at(16), ownerBlock())
    tick(30)
    assert.deepEqual(asks(h, id), ['declared', 'prompt'])
    assert.deepEqual(sent(h, id), ['shown1'])
    assert.equal(joins(h, id)[0].body.round_owed, undefined)
  })

  it('active: shown at once, and it keeps holding the slot; the clock does not move', () => {
    const { h, sk, id, tick } = setup(ONE)
    W.author(h.world, sk, T0, ownerBlock())
    tick(15)
    W.raisePrompt(h.world, sk, at(16), 7200)
    tick(30)
    assert.deepEqual(sent(h, id), ['shown1', 'shown2'])
    assert.equal(h.item(id).state, 'active')
    assert.equal(h.item(id).lastShowAt, at(15), 'the reminder and time-limit clock still counts from the counted show')
    tick(45)
    tick(60)
    tick(75)
    assert.deepEqual(sent(h, id), ['shown1', 'shown2', 'reminded1'], 'reminder 1 at +75, as it would have been anyway')
  })

  it('acknowledged and holding the slot: shown at once; the verification goes ahead at the next tick as usual', () => {
    const { h, sk, id, tick, owner } = setup(ONE)
    W.author(h.world, sk, T0, ownerBlock())
    tick(15)
    owner('done', 'm1', 16)
    W.raisePrompt(h.world, sk, at(17), 7200)
    tick(30)
    // The round's show at once, then the verification this tick owed the
    // "done" anyway: no confirming report, so the one return.
    assert.deepEqual(sent(h, id), ['shown1', 'shown2', 'returned1'])
    const order = steps(h, id).filter((r) => r.body.phase === 'attempt').map((r) => r.body.step)
    assert.deepEqual(order, ['shown', 'shown', 'returned'])
    assert.equal(h.item(id).state, 'active', 'the return, not the round, put it back in the slot')
  })

  it('queued behind another item: waits while the slot is held, is shown once the slot is free, then exhausted at the slot', () => {
    const { h, sk, id, tick } = setup({ surface: { max_presentations: 1, item_time_limit_hours: 1, reminder_after_minutes: [20, 40] } })
    const o = W.addSession(h.world, { source: 'chroxy', native_id: 'o', scope: 'repo' })
    const other = itemIds.owner(h.world.sessions[o].session)
    W.author(h.world, sk, T0, ownerBlock())
    tick(15)
    W.author(h.world, o, at(20), ownerBlock('another'))
    for (const m of [30, 45, 60, 75]) tick(m)
    // Ours expired at +75 with no counted show left; the other went ahead.
    assert.equal(h.item(id).state, 'queued')
    assert.equal(h.item(other).state, 'active')
    const before = shows(h, id)
    W.raisePrompt(h.world, sk, at(76), 7200)
    tick(90)
    assert.equal(shows(h, id), before, 'the slot is held: the round waits in its place')
    assert.equal(h.item(id).roundOwed, 1)
    W.author(h.world, o, at(91), { state: 'running', next: 'go' })
    tick(105)
    assert.equal(shows(h, id), before + 1, 'one show for the round')
    assert.equal(h.item(id).state, 'exhausted', 'exhausted and listed, not holding the slot')
  })

  it('deferred by the owner: shown once while the slot is free; the deferral stands', () => {
    const { h, sk, id, tick, owner } = setup(ONE)
    W.author(h.world, sk, T0, ownerBlock())
    tick(15)
    owner('defer', 'd1', 16, 16 + 8 * 60)
    W.raisePrompt(h.world, sk, at(17), 7200)
    tick(30)
    assert.deepEqual(sent(h, id), ['shown1', 'shown2'])
    assert.equal(h.item(id).state, 'deferred')
    assert.equal(h.item(id).deferUntil, at(16 + 8 * 60))
  })

  it('two rounds in consecutive ticks: one show each', () => {
    const { h, sk, id, tick } = setup(ONE)
    W.author(h.world, sk, T0, ownerBlock())
    tick(15)
    const p1 = W.raisePrompt(h.world, sk, at(16), 7200)
    tick(30)
    W.answerPrompt(h.world, sk, p1, at(31))
    W.raisePrompt(h.world, sk, at(32), 7200)
    tick(45)
    assert.deepEqual(sent(h, id), ['shown1', 'shown2', 'shown3'])
    assert.equal(h.item(id).counters.round_shows, 2)
  })

  it('a round whose prompt ends before the item reaches the slot: its owed show is dropped', () => {
    const { h, sk, id, tick } = setup(ONE)
    const o = W.addSession(h.world, { source: 'chroxy', native_id: 'o', scope: 'repo' })
    W.author(h.world, sk, T0, { state: 'running', next: 'a' })
    W.raisePrompt(h.world, sk, at(1), 7200)
    W.author(h.world, o, T0 + 1000, ownerBlock('another'))
    tick(15)
    // Ours (a live prompt) is shown first; the owner defers it, the other takes the slot.
    const other = itemIds.owner(h.world.sessions[o].session)
    assert.deepEqual(sent(h, id), ['shown1'])
    h.owner(id, 'defer', 'd1', { at: at(16), until: at(16 + 8 * 60) })
    tick(30)
    assert.equal(h.item(other).state, 'active')
    W.author(h.world, sk, at(31), ownerBlock())
    tick(45)
    assert.deepEqual(asks(h, id), ['declared', 'prompt'], 'a declared join: no round')
    const p2ref = h.item(id).asks.get('prompt').opened_by
    W.answerPrompt(h.world, sk, p2ref, at(46))
    const p3 = W.raisePrompt(h.world, sk, at(47), 7200)
    tick(60)
    assert.equal(h.item(id).roundOwed, 1, 'a new round, owed its show while the other holds the slot')
    W.answerPrompt(h.world, sk, p3, at(61))
    tick(75)
    assert.equal(h.item(id).roundOwed, 0, 'its prompt ended: the owed show is dropped')
    W.author(h.world, o, at(76), { state: 'running', next: 'go' })
    tick(90)
    assert.deepEqual(sent(h, id), ['shown1'], 'never shown for the ended round')
  })

  it('a lowered show limit mid-episode: rounds after it are shown once each, from the lowered limit', () => {
    const { h, sk, id, tick } = setup()
    W.author(h.world, sk, T0, ownerBlock())
    tick(15)
    const p1 = W.raisePrompt(h.world, sk, at(16), 7200)
    tick(30)
    assert.equal(h.item(id).counters.shows_counted, 2)
    run(h.ctx, planConfig(h.ctx, { config: makeConfig({ owner_name: OWNER, ...FAST, surface: { max_presentations: 1 } }), now: at(31) }))
    W.answerPrompt(h.world, sk, p1, at(32))
    W.raisePrompt(h.world, sk, at(33), 7200)
    tick(45)
    assert.deepEqual(sent(h, id), ['shown1', 'shown2', 'shown3'])
    assert.deepEqual([h.item(id).counters.shows_counted, h.item(id).counters.round_shows], [2, 1])
  })

  it('a round owed to an exhausted item while the slot is held, and the limit raised meanwhile: still the round\'s one show; the item stays exhausted', () => {
    const { h, sk, id, tick, owner } = setup(ONE)
    const o = W.addSession(h.world, { source: 'chroxy', native_id: 'o', scope: 'repo' })
    W.author(h.world, sk, T0, ownerBlock())
    tick(15)
    owner('done', 'm1', 16)
    tick(30)
    owner('done', 'm2', 31)
    W.author(h.world, o, at(32), ownerBlock('another'))
    tick(45)
    assert.equal(h.item(id).state, 'exhausted')
    W.raisePrompt(h.world, sk, at(46), 7200)
    tick(60)
    assert.equal(h.item(id).roundOwed, 1, 'owed, the other holds the slot')
    run(h.ctx, planConfig(h.ctx, { config: makeConfig({ owner_name: OWNER, ...FAST, surface: { max_presentations: 3 } }), now: at(61) }))
    W.author(h.world, o, at(62), { state: 'running', next: 'go' })
    tick(75)
    assert.deepEqual(sent(h, id), ['shown1', 'returned1', 'shown2'])
    assert.deepEqual([h.item(id).counters.shows_counted, h.item(id).counters.round_shows], [1, 1])
    assert.equal(h.item(id).state, 'exhausted')
  })

  it('a carried attention condition on an item that gets round shows: carried throughout, nothing handed back early', () => {
    const { h, sk, id, tick } = setup(ONE)
    const y = W.addSession(h.world, { source: 'chroxy', native_id: 'y', scope: 'repo' })
    W.author(h.world, y, T0, { state: 'idle' })
    W.author(h.world, sk, T0, ownerBlock())
    tick(15)
    const err = { outcome: 'error', error_code: 'timeout' }
    const only = (a) => ({ ...a, read: (s, n) => (s.native_id === 'c' ? err : a.read(s, n)), reread: (s, n) => (s.native_id === 'c' ? err : a.reread(s, n)) })
    for (const m of [30, 45, 60]) tick(m, { reads: only })
    assert.deepEqual(h.item(id).carried.map((c) => c.trigger), ['repeated_error'])
    let m = 60
    for (let k = 0; k < 3; k++) {
      const ref = W.raisePrompt(h.world, sk, at(m + 1), 7200)
      tick((m += 15))
      W.answerPrompt(h.world, sk, ref, at(m + 1))
      tick((m += 15))
    }
    assert.equal(h.item(id).counters.round_shows, 3)
    assert.deepEqual(h.item(id).carried.map((c) => c.trigger), ['repeated_error'])
    assert.equal(h.openItems().filter((i) => i.origin === 'attention').length, 0)
  })

  // An exhausted item owed a round while another item holds the slot for
  // several ticks.
  function waitingRound(policy) {
    const { h, mon, sk, id } = setup(ONE, policy)
    const o = W.addSession(h.world, { source: 'chroxy', native_id: 'o', scope: 'repo' })
    const step = (mm) => {
      h.tick('chroxy', at(mm))
      checkStep(mon, h)
    }
    const owner = (intent, ref, mm) => {
      h.owner(id, intent, ref, { at: at(mm) })
      checkStep(mon, h)
    }
    const owed = []
    const run = () => {
      W.author(h.world, sk, T0, ownerBlock())
      step(15)
      owner('done', 'm1', 16)
      step(30)
      owner('done', 'm2', 31)
      step(45)
      W.author(h.world, o, at(46), ownerBlock('another'))
      step(60)
      W.raisePrompt(h.world, sk, at(61), 7200)
      for (const mm of [75, 90, 105]) {
        step(mm)
        owed.push(h.item(id).roundOwed)
      }
      W.author(h.world, o, at(106), { state: 'running', next: 'go' })
      step(120)
    }
    return { h, id, run, owed }
  }

  it('a round that waits several ticks behind another item keeps its show owed, and is shown once the slot frees', () => {
    const { h, id, run, owed } = waitingRound()
    run()
    assert.deepEqual(owed, [1, 1, 1], 'owed through three ticks of the other item\'s hold')
    assert.deepEqual(sent(h, id), ['shown1', 'returned1', 'shown2'])
    assert.equal(h.item(id).roundOwed, 0)
    assert.equal(h.item(id).state, 'exhausted')
  })

  it('mutations: a waiting round forgotten turns I13 red; a round shown while another holds the slot turns I2 red; a round show stored as counted turns I1d red', () => {
    for (const [name, expect] of [['I13.wait', 'I13'], ['I2.slotless', 'I2'], ['I1d.counted', 'I1d']]) {
      const { run } = waitingRound(MUTANTS[name])
      assert.throws(run, (e) => e instanceof InvariantError && e.id === expect, name)
    }
  })

  it('mutation: a round given no show (the earlier rule) turns I13 red; a round given two shows turns I1a red; a round taking the slot turns I2 red', () => {
    for (const [name, expect] of [['I13.round', 'I13'], ['I2.round', 'I2']]) {
      const { h, mon, sk, id } = setup(ONE, MUTANTS[name])
      const step = (mm) => {
        h.tick('chroxy', at(mm))
        checkStep(mon, h)
      }
      const owner = (intent, ref, mm) => {
        h.owner(id, intent, ref, { at: at(mm) })
        checkStep(mon, h)
      }
      const go = () => {
        // Exhausted with its one counted show used, then a prompt round.
        W.author(h.world, sk, T0, ownerBlock())
        step(15)
        owner('done', 'm1', 16)
        step(30)
        owner('done', 'm2', 31)
        step(45)
        W.raisePrompt(h.world, sk, at(46), 7200)
        for (const mm of [60, 75, 90]) step(mm)
      }
      assert.throws(go, (e) => e instanceof InvariantError && e.id === expect, name)
    }
    // Two shows for one round: the first at once while the item holds the
    // slot, the second when the item, expired, next reaches the slot.
    const { h, mon, sk } = setup({ surface: { max_presentations: 1, item_time_limit_hours: 1, reminder_after_minutes: [20, 40] } }, MUTANTS['I1a.round2'])
    const go = () => {
      W.author(h.world, sk, T0, ownerBlock())
      for (const mm of [15, 30, 45, 60, 75, 90]) {
        if (mm === 30) W.raisePrompt(h.world, sk, at(16), 7200)
        h.tick('chroxy', at(mm))
        checkStep(mon, h)
      }
    }
    assert.throws(go, (e) => e instanceof InvariantError && e.id === 'I1a', 'I1a.round2')
  })
})

describe('crash and replay in a tick in which an ask joins', () => {
  for (const [name, build] of [
    [
      'a prompt joining a declared block',
      (h, sk) => {
        W.author(h.world, sk, T0, ownerBlock())
        return () => W.raisePrompt(h.world, sk, at(16), 7200)
      },
    ],
    [
      'a declared block joining a prompt',
      (h, sk) => {
        W.author(h.world, sk, T0, { state: 'running', next: 'a' })
        W.raisePrompt(h.world, sk, at(1), 7200)
        return () => W.author(h.world, sk, at(16), ownerBlock())
      },
    ],
  ]) {
    it(`${name}: killed at every operation and replayed, one join and one new-ask show; no conflict, no second send`, () => {
      let points = 0
      for (let op = 0; ; op++) {
        const { h, mon, sk, id } = setup()
        const second = build(h, sk)
        h.tick('chroxy', at(15))
        checkStep(mon, h)
        second()
        let crashed = false
        try {
          h.tick('chroxy', at(30), { crashAfter: op })
        } catch (e) {
          if (!(e instanceof Crash)) throw e
          crashed = true
          checkStep(mon, h, { complete: false })
          h.restart()
          h.tick('chroxy', at(33), { slotStart: h.slotFor('chroxy', at(30)) })
        }
        checkStep(mon, h)
        assert.equal(h.conflicts().length, 0, `crash at op ${op}`)
        const ids = h.sends.map((x) => x.attempt_id)
        assert.equal(new Set(ids).size, ids.length)
        assert.equal(joins(h, id).length, 1)
        const showAttempts = steps(h, id).filter((r) => r.body.step === 'shown' && r.body.phase === 'attempt')
        assert.equal(showAttempts.length, 2, `two shows recorded: op ${op}`)
        assert.deepEqual(asks(h, id), ['declared', 'prompt'])
        if (!crashed) break
        points += 1
      }
      assert.ok(points > 5, `${points} crash points exercised`)
    })
  }
})

describe('crash and replay in a tick with a round show after the limit', () => {
  const ONE = { surface: { max_presentations: 1, item_time_limit_hours: 8, reminder_after_minutes: [60, 180] } }
  for (const [name, before] of [
    ['holding the slot (shown at once)', () => {}],
    [
      'exhausted (shown as the tick fills the slot)',
      (h, id) => {
        h.owner(id, 'done', 'm1', { at: at(16) })
        h.tick('chroxy', at(20))
        h.owner(id, 'done', 'm2', { at: at(21) })
      },
    ],
  ]) {
    it(`${name}: killed at every operation and replayed, exactly one round show; no conflict, no second send`, () => {
      let points = 0
      for (let op = 0; ; op++) {
        const { h, mon, sk, id } = setup(ONE)
        W.author(h.world, sk, T0, ownerBlock())
        h.tick('chroxy', at(15))
        before(h, id)
        checkStep(mon, h)
        W.raisePrompt(h.world, sk, at(22), 7200)
        const rounds = () => h.surface(id).filter((r) => r.body.step === 'shown' && r.body.phase === 'attempt' && r.body.round).length
        let crashed = false
        try {
          h.tick('chroxy', at(30), { crashAfter: op })
        } catch (e) {
          if (!(e instanceof Crash)) throw e
          crashed = true
          checkStep(mon, h, { complete: false })
          h.restart()
          h.tick('chroxy', at(33), { slotStart: h.slotFor('chroxy', at(30)) })
        }
        checkStep(mon, h)
        assert.equal(h.conflicts().length, 0, `crash at op ${op}`)
        const ids = h.sends.map((x) => x.attempt_id)
        assert.equal(new Set(ids).size, ids.length, `no second send: op ${op}`)
        assert.equal(rounds(), 1, `exactly one round show: op ${op}`)
        assert.equal(h.item(id).roundOwed, 0)
        if (!crashed) break
        points += 1
      }
      assert.ok(points > 5, `${points} crash points exercised`)
    })
  }
})

describe('crash and replay in a tick in which one ask ends and another arrives', () => {
  for (const [name, build, closes] of [
    [
      'the prompt answered while a newer prompt is pending (the item stays open)',
      (h, sk) => {
        W.author(h.world, sk, T0, ownerBlock())
        const p1 = W.raisePrompt(h.world, sk, at(1), 7200)
        return () => {
          W.answerPrompt(h.world, sk, p1, at(16))
          W.raisePrompt(h.world, sk, at(17), 7200)
        }
      },
      false,
    ],
    [
      'the last ask ending as a declared block arrives (a new episode)',
      (h, sk) => {
        W.author(h.world, sk, T0, { state: 'running', next: 'a' })
        const p1 = W.raisePrompt(h.world, sk, at(1), 7200)
        return () => {
          W.answerPrompt(h.world, sk, p1, at(16))
          W.author(h.world, sk, at(17), ownerBlock())
        }
      },
      true,
    ],
  ]) {
    it(`${name}: killed at every operation and replayed, exactly one show; no conflict, no second send`, () => {
      let points = 0
      for (let op = 0; ; op++) {
        const { h, mon, sk, id } = setup()
        const next = build(h, sk)
        h.tick('chroxy', at(15))
        checkStep(mon, h)
        const shows = () => h.surface(id).filter((r) => r.body.step === 'shown' && r.body.phase === 'attempt').length
        const before = shows()
        next()
        let crashed = false
        try {
          h.tick('chroxy', at(30), { crashAfter: op })
        } catch (e) {
          if (!(e instanceof Crash)) throw e
          crashed = true
          checkStep(mon, h, { complete: false })
          h.restart()
          h.tick('chroxy', at(33), { slotStart: h.slotFor('chroxy', at(30)) })
        }
        checkStep(mon, h)
        assert.equal(h.conflicts().length, 0, `crash at op ${op}`)
        const ids = h.sends.map((x) => x.attempt_id)
        assert.equal(new Set(ids).size, ids.length, `no second send: op ${op}`)
        assert.equal(shows() - before, 1, `exactly one show: op ${op}`)
        assert.equal(h.item(id).episode, closes ? 2 : 1)
        assert.deepEqual(asks(h, id), closes ? ['declared'] : ['declared', 'prompt'])
        if (!crashed) break
        points += 1
      }
      assert.ok(points > 5, `${points} crash points exercised`)
    })
  }
})

describe('a carried attention condition on the owner item', () => {
  const failing = (a) => ({ ...a, read: () => ({ outcome: 'error', error_code: 'timeout' }), reread: () => ({ outcome: 'error', error_code: 'timeout' }) })

  it('carried while both asks are live; it stays when the prompt ends, and the declared block\'s ending report ends it too: no attention item', () => {
    const { h, sk, id, tick } = setup()
    const y = W.addSession(h.world, { source: 'chroxy', native_id: 'y', scope: 'repo' })
    W.author(h.world, y, T0, { state: 'idle' })
    W.author(h.world, sk, T0, ownerBlock())
    tick(15)
    const ref = W.raisePrompt(h.world, sk, at(16), 7200)
    tick(30)
    const only = (a) => ({ ...failing(a), read: (s, n) => (s.native_id === 'c' ? failing(a).read() : a.read(s, n)), reread: (s, n) => (s.native_id === 'c' ? failing(a).reread() : a.reread(s, n)) })
    for (const m of [45, 60, 75]) tick(m, { reads: only })
    assert.deepEqual(asks(h, id), ['declared', 'prompt'])
    assert.deepEqual(h.item(id).carried.map((c) => c.trigger), ['repeated_error'])
    W.answerPrompt(h.world, sk, ref, at(76))
    tick(90)
    assert.deepEqual(asks(h, id), ['declared'])
    assert.equal(h.item(id).carried.length, 1, 'the condition outlives the prompt ask')
    W.author(h.world, sk, at(91), { state: 'running', next: 'go' })
    tick(105)
    assert.equal(h.item(id).state, 'closed')
    assert.deepEqual(h.openItems(), [], 'the newer report ends the condition as well: nothing is handed back')
  })

  it('carried after the declared block ended, on the remaining prompt ask: when the prompt closes the item, it is handed back as an attention item', () => {
    const { h, sk, id, tick } = setup()
    const y = W.addSession(h.world, { source: 'chroxy', native_id: 'y', scope: 'repo' })
    W.author(h.world, y, T0, { state: 'idle' })
    W.author(h.world, sk, T0, ownerBlock())
    tick(15)
    const ref = W.raisePrompt(h.world, sk, at(16), 7200)
    tick(30)
    W.author(h.world, sk, at(31), { state: 'running', next: 'go' })
    tick(45)
    assert.deepEqual(asks(h, id), ['prompt'])
    const only = (a) => ({ ...a, read: (s, n) => (s.native_id === 'c' ? failing(a).read() : a.read(s, n)), reread: (s, n) => (s.native_id === 'c' ? failing(a).reread() : a.reread(s, n)) })
    for (const m of [60, 75, 90]) tick(m, { reads: only })
    assert.deepEqual(h.item(id).carried.map((c) => c.trigger), ['repeated_error'])
    W.answerPrompt(h.world, sk, ref, at(91))
    tick(105)
    assert.equal(h.item(id).state, 'closed')
    const att = h.openItems().find((i) => i.origin === 'attention')
    assert.ok(att, 'handed back')
    assert.equal(steps(h, att.itemId).find((r) => r.body.step === 'queued').body.handover_of, `${id}|1`)
  })
})

