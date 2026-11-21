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

describe('the class of a two-ask item', () => {
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
  it('exhausted with a counted show left: queued again and shown; with none left: the content changes, nothing is sent, it stays exhausted', () => {
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
        assert.deepEqual(sent(h, id), before)
        assert.equal(h.item(id).state, 'exhausted')
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
  it('gets at most the show limit in counted shows: later prompts update the content and send nothing', () => {
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
    assert.deepEqual(sent(h, id), ['shown1', 'shown2', 'shown3', 'reminded1'])
    assert.equal(joins(h, id).length, 5, 'five prompts joined')
    assert.deepEqual(joins(h, id).map((r) => Boolean(r.body.show_now)), [true, true, false, false, false])
    assert.equal(h.item(id).counters.shows_counted, 3)
    assert.equal(h.item(id).episode, 1)
    assert.deepEqual(asks(h, id), ['declared'])
    assert.equal(h.conflicts().length, 0)
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

