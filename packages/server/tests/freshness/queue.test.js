import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { makeConfig } from './model/config.js'
import { itemIds, surfaceOrdinal as surfaceOrdinalLiteral } from './model/keys.js'
import { planConfig, run } from './model/reconciler.js'
import { deriveState } from './model/derive.js'
import { append, createLedger } from './model/ledger.js'
import { DEFAULT_POLICY, withPolicy } from './model/policy.js'
import { Crash, HOUR, MIN, OWNER, T0, createHarness } from './helpers/harness.js'
import { literalPreempts } from './helpers/variants.js'
import * as W from './helpers/world.js'

const FAST = { per_source: { chroxy: 15, codex: 15, 'claude-desktop': 15 } }

function setup(over = {}, policy) {
  return createHarness({ config: { ...FAST, ...over }, ...(policy ? { policy } : {}) })
}
function session(h, source, id, scope = 'repo') {
  const sk = W.addSession(h.world, { source, native_id: id, scope })
  return { sk, s: h.world.sessions[sk].session }
}
const ownerBlock = (blocked_on = 'approve the merge') => ({ state: 'blocked', blocked_on, owner: OWNER })
/** Tick `source` every 15 minutes from `from` (exclusive) for `n` ticks; returns the last time. */
function ticks(h, source, from, n, stepMin = 15) {
  let t = from
  for (let i = 0; i < n; i++) {
    t += stepMin * MIN
    h.tick(source, t)
  }
  return t
}
const steps = (h, id) => h.surface(id).filter((r) => r.body.phase !== 'outcome').map((r) => r.body.step)
const sent = (h, id) => h.sendsFor(id).map((s) => `${s.step}${s.n}`)

describe('the single slot', () => {
  it('three blocked sessions: exactly one item shown; the next only once the first leaves the slot', () => {
    const h = setup()
    const a = session(h, 'chroxy', 'a')
    const b = session(h, 'chroxy', 'b')
    const c = session(h, 'chroxy', 'c')
    W.author(h.world, a.sk, T0, ownerBlock())
    W.author(h.world, b.sk, T0 + 1000, ownerBlock())
    W.author(h.world, c.sk, T0 + 2000, ownerBlock())
    let t = ticks(h, 'chroxy', T0, 1)
    assert.deepEqual(h.sends.map((s) => s.item_id), [itemIds.declared(a.s)])
    // Acknowledged and awaiting verification: the slot is still held.
    h.owner(itemIds.declared(a.s), 'done', 'm1', { at: t + MIN })
    t = ticks(h, 'chroxy', t, 1)
    assert.equal(h.sendsFor(itemIds.declared(b.s)).length, 0)
    assert.deepEqual(sent(h, itemIds.declared(a.s)), ['shown1', 'returned1'])
    // Resolved by evidence: the next item is shown at the next tick.
    W.author(h.world, a.sk, t + MIN, { state: 'running', next: 'go' })
    t = ticks(h, 'chroxy', t, 1)
    assert.equal(h.item(itemIds.declared(a.s)).state, 'closed')
    assert.deepEqual(sent(h, itemIds.declared(b.s)), ['shown1'])
    // Deferred: the slot frees, the third is shown.
    h.owner(itemIds.declared(b.s), 'defer', 'm2', { at: t + MIN, until: t + 4 * HOUR })
    ticks(h, 'chroxy', t, 1)
    assert.deepEqual(sent(h, itemIds.declared(c.s)), ['shown1'])
    assert.equal(h.openItems().filter((i) => i.state === 'active').length, 1)
  })

  it('gap witness: if acknowledgment frees the slot, the return makes two items active', () => {
    for (const literal of [true, false]) {
      const h = setup({}, literal ? withPolicy({ slotHolderStates: new Set(['active']) }) : undefined)
      const a = session(h, 'codex', 'a')
      const b = session(h, 'chroxy', 'b')
      W.author(h.world, a.sk, T0, ownerBlock())
      W.author(h.world, b.sk, T0 + 1000, ownerBlock())
      h.tick('codex', T0 + 15 * MIN)
      h.owner(itemIds.declared(a.s), 'done', 'm1', { at: T0 + 16 * MIN })
      // Another source's tick fills the freed slot; a's own source then returns it.
      h.tick('chroxy', T0 + 20 * MIN)
      h.tick('codex', T0 + 30 * MIN)
      const active = h.openItems().filter((i) => i.state === 'active')
      assert.equal(active.length, literal ? 2 : 1)
    }
  })

  it('"done" with no confirming report returns once, then the second unconfirmed "done" exhausts it', () => {
    const h = setup()
    const a = session(h, 'chroxy', 'a')
    const b = session(h, 'chroxy', 'b')
    W.author(h.world, a.sk, T0, ownerBlock())
    W.author(h.world, b.sk, T0 + 1000, ownerBlock())
    const id = itemIds.declared(a.s)
    let t = ticks(h, 'chroxy', T0, 1)
    h.owner(id, 'done', 'm1', { at: t + MIN })
    t = ticks(h, 'chroxy', t, 1)
    assert.deepEqual(sent(h, id), ['shown1', 'returned1'])
    assert.notEqual(h.item(id).state, 'closed')
    h.owner(id, 'done', 'm2', { at: t + MIN })
    t = ticks(h, 'chroxy', t, 1)
    assert.equal(h.item(id).state, 'exhausted')
    assert.ok(h.item(id).open, 'an exhausted item stays listed')
    assert.deepEqual(sent(h, itemIds.declared(b.s)), ['shown1'], 'the slot is free for the next item')
    const acks = h.records('owner_ack').filter((r) => r.body.item_id === id).map((r) => `${r.body.phase}:${r.body.verified}`)
    assert.deepEqual(acks, ['ack:null', 'verify:false', 'ack:null', 'verify:false'])
    assert.equal(h.conflicts().length, 0)
  })

  it('an item with no counted show left gives up the slot as exhausted when it next reaches it', () => {
    const h = setup({ surface: { max_presentations: 1, item_time_limit_hours: 1, reminder_after_minutes: [20, 40] } })
    const a = session(h, 'chroxy', 'a')
    const b = session(h, 'chroxy', 'b')
    const c = session(h, 'chroxy', 'c')
    W.author(h.world, a.sk, T0, ownerBlock())
    W.author(h.world, b.sk, T0 + 1000, ownerBlock())
    W.author(h.world, c.sk, T0 + 2000, ownerBlock())
    const ia = itemIds.declared(a.s)
    const ib = itemIds.declared(b.s)
    ticks(h, 'chroxy', T0, 5)
    // The transition table sends an expired item to the back of its class
    // (it is exhausted only when it next reaches the slot, not at the time
    // limit itself; README, DESIGN-GAP choices, queue.js).
    assert.deepEqual(steps(h, ia), ['queued', 'shown', 'reminded', 'reminded', 'expired'])
    assert.deepEqual(sent(h, ib), ['shown1'], 'the next item is shown when the first expires')
    ticks(h, 'chroxy', T0 + 5 * 15 * MIN, 12)
    assert.equal(steps(h, ia).at(-1), 'exhausted')
    assert.ok(h.item(ia).open, 'exhausted, never dropped')
    assert.equal(h.sendsFor(ia).filter((x) => x.step === 'shown').length, 1)
  })
})

describe('sends per episode', () => {
  it('the same blocked line across ticks and a restart, then re-authored identically five times: one show, at most two reminders, no new item', () => {
    const h = setup()
    const x = session(h, 'codex', 'x')
    W.author(h.world, x.sk, T0, ownerBlock())
    const id = itemIds.declared(x.s)
    let t = ticks(h, 'codex', T0, 5)
    h.restart()
    for (let k = 0; k < 5; k++) {
      W.author(h.world, x.sk, t + MIN, ownerBlock())
      t = ticks(h, 'codex', t, 1)
    }
    t = ticks(h, 'codex', t, 12)
    assert.deepEqual(sent(h, id), ['shown1', 'reminded1', 'reminded2'])
    assert.equal(h.records('report').length, 6)
    assert.equal(h.surface(id).filter((r) => r.body.step === 'queued').length, 1)
    assert.equal(h.surface(id).filter((r) => r.body.step === 'updated').length, 0, 'an identical line is not a content change')
  })

  it('a block that changes its wording is updated in place: one item, one notification', () => {
    const h = setup()
    const x = session(h, 'codex', 'x')
    W.author(h.world, x.sk, T0, ownerBlock('waiting 0h'))
    let t = ticks(h, 'codex', T0, 1)
    for (let k = 1; k <= 5; k++) {
      W.author(h.world, x.sk, t + MIN, ownerBlock(`waiting ${k}h`))
      t = ticks(h, 'codex', t, 1)
    }
    const id = itemIds.declared(x.s)
    assert.equal(h.surface(id).filter((r) => r.body.step === 'updated').length, 5)
    assert.equal(new Set(h.surface(id).map((r) => r.body.episode)).size, 1)
    assert.deepEqual(sent(h, id).filter((s) => s.startsWith('shown')), ['shown1'])
  })

  it('wording A, B, A, B across four reports: three updates, no conflict, the item shows B', () => {
    const h = setup()
    const x = session(h, 'codex', 'x')
    let t = T0
    for (const w of ['A', 'B', 'A', 'B']) {
      W.author(h.world, x.sk, t + MIN, ownerBlock(w))
      t = ticks(h, 'codex', t, 1)
    }
    const id = itemIds.declared(x.s)
    assert.equal(h.surface(id).filter((r) => r.body.step === 'updated').length, 3)
    assert.equal(h.conflicts().length, 0)
    const rep = h.ctx.state.reports.get(h.item(id).reportId).body
    assert.equal(rep.declared_blocked_on, 'B')
  })

  it('an exhausted item whose content changes while a counted show remains is queued once more', () => {
    const h = setup({ surface: { max_presentations: 2, item_time_limit_hours: 8, reminder_after_minutes: [60, 180] } })
    const x = session(h, 'codex', 'x')
    W.author(h.world, x.sk, T0, ownerBlock('A'))
    const id = itemIds.declared(x.s)
    let t = ticks(h, 'codex', T0, 1)
    h.owner(id, 'done', 'm1', { at: t + MIN })
    t = ticks(h, 'codex', t, 1)
    h.owner(id, 'done', 'm2', { at: t + MIN })
    t = ticks(h, 'codex', t, 1)
    assert.equal(h.item(id).state, 'exhausted')
    // The identical line again: no change, still exhausted, nothing sent.
    W.author(h.world, x.sk, t + MIN, ownerBlock('A'))
    t = ticks(h, 'codex', t, 2)
    assert.equal(h.item(id).state, 'exhausted')
    const before = h.sendsFor(id).length
    W.author(h.world, x.sk, t + MIN, ownerBlock('B'))
    t = ticks(h, 'codex', t, 1)
    assert.equal(h.item(id).state, 'active')
    assert.equal(h.sendsFor(id).length, before + 1)
    assert.ok(h.item(id).counters.shows_counted <= 2)
  })

  it('shows after the owner\'s own deferral are not counted; reminders total two across all presentations', () => {
    const h = setup({ surface: { max_presentations: 1, item_time_limit_hours: 8, reminder_after_minutes: [60, 180] } })
    const x = session(h, 'codex', 'x')
    W.author(h.world, x.sk, T0, ownerBlock())
    const id = itemIds.declared(x.s)
    let t = ticks(h, 'codex', T0, 1)
    for (let k = 0; k < 3; k++) {
      h.owner(id, 'defer', `d${k}`, { at: t + MIN, until: t + 30 * MIN })
      t = ticks(h, 'codex', t, 2)
      assert.equal(h.item(id).state, 'active', 'shown again once the deferral time comes')
    }
    t = ticks(h, 'codex', t, 30)
    const s = sent(h, id)
    assert.equal(s.filter((x) => x.startsWith('shown')).length, 4)
    assert.ok(s.filter((x) => x.startsWith('reminded')).length <= 2)
    assert.equal(h.item(id).counters.shows_counted, 1)
  })

  it('expiry sends an item to the back of its class; it is shown again under a new presentation and key', () => {
    const h = setup({ surface: { max_presentations: 3, item_time_limit_hours: 1, reminder_after_minutes: [20, 40] } })
    const x = session(h, 'codex', 'x')
    W.author(h.world, x.sk, T0, ownerBlock())
    const id = itemIds.declared(x.s)
    ticks(h, 'codex', T0, 14)
    const s = sent(h, id)
    assert.deepEqual(s.filter((v) => v.startsWith('shown')), ['shown1', 'shown2', 'shown3'])
    assert.equal(s.filter((v) => v.startsWith('reminded')).length, 2)
    assert.equal(h.item(id).state, 'exhausted')
  })
})

describe('configuration changes mid-episode', () => {
  it('lowering the show limit while an exhausted item is re-queued: exhausted again, no conflict (the literal ordinal conflicts)', () => {
    for (const literal of [false, true]) {
      const policy = literal ? withPolicy({ surfaceOrdinal: surfaceOrdinalLiteral }) : undefined
      const h = setup({}, policy)
      const x = session(h, 'codex', 'x')
      const y = session(h, 'chroxy', 'y')
      W.author(h.world, x.sk, T0, ownerBlock('A'))
      const id = itemIds.declared(x.s)
      h.tick('codex', T0 + 15 * MIN)
      h.owner(id, 'done', 'm1', { at: T0 + 16 * MIN })
      h.tick('codex', T0 + 30 * MIN)
      h.owner(id, 'done', 'm2', { at: T0 + 31 * MIN })
      h.tick('codex', T0 + 45 * MIN)
      W.author(h.world, y.sk, T0 + 46 * MIN, ownerBlock('Z'))
      h.tick('chroxy', T0 + 47 * MIN)
      W.author(h.world, x.sk, T0 + 50 * MIN, ownerBlock('B'))
      h.tick('codex', T0 + 61 * MIN)
      assert.equal(h.item(id).state, 'queued')
      run(h.ctx, planConfig(h.ctx, { config: makeConfig({ owner_name: OWNER, ...FAST, surface: { max_presentations: 1 } }), now: T0 + 62 * MIN }))
      W.author(h.world, y.sk, T0 + 63 * MIN, { state: 'idle' })
      h.tick('chroxy', T0 + 76 * MIN)
      if (literal) {
        assert.equal(h.conflicts().length, 1)
        assert.equal(h.item(id).state, 'queued', 'wedged: never exhausted, never shown')
      } else {
        assert.equal(h.conflicts().length, 0)
        assert.equal(h.item(id).state, 'exhausted')
      }
    }
  })
})

describe('crashes around sends', () => {
  it('killed after a shown attempt and before the send: no send after restart; delivery unknown and still listed', () => {
    const h = setup()
    const x = session(h, 'codex', 'x')
    W.author(h.world, x.sk, T0, ownerBlock())
    const id = itemIds.declared(x.s)
    // Find the op index of the attempt by running once on a copy.
    let n = 0
    for (; n < 50; n++) {
      const probe = setup()
      session(probe, 'codex', 'x')
      W.author(probe.world, Object.keys(probe.world.sessions)[0], T0, ownerBlock())
      try {
        probe.tick('codex', T0 + 15 * MIN, { crashAfter: n })
      } catch (e) {
        if (!(e instanceof Crash)) throw e
        if (probe.records('surface').some((r) => r.body.phase === 'attempt') && probe.sends.length === 0) break
        continue
      }
    }
    assert.throws(() => h.tick('codex', T0 + 15 * MIN, { crashAfter: n }), Crash)
    assert.equal(h.sends.length, 0)
    h.restart()
    h.tick('codex', T0 + 17 * MIN, { slotStart: h.slotFor('codex', T0 + 15 * MIN) })
    h.tick('codex', T0 + 30 * MIN)
    assert.equal(h.sends.length, 0, 'the attempt is never re-sent')
    assert.equal(h.records('system').filter((r) => r.body.event === 'delivery_unknown').length, 1)
    assert.ok(h.item(id).open)
    assert.equal(h.conflicts().length, 0)
  })

  it('killed after the reminder-1 attempt: no send after restart, and no reminder with n above 2 ever', () => {
    const h = setup()
    const x = session(h, 'codex', 'x')
    W.author(h.world, x.sk, T0, ownerBlock())
    const id = itemIds.declared(x.s)
    let t = ticks(h, 'codex', T0, 4)
    // The next tick is due reminder 1 (60 min after the show at +15).
    const at = T0 + 75 * MIN
    void t
    let crashed = false
    for (let n = 0; n < 40 && !crashed; n++) {
      const snapshot = h.records().length
      try {
        h.tick('codex', at, { crashAfter: n })
        break
      } catch (e) {
        if (!(e instanceof Crash)) throw e
        if (h.surface(id).some((r) => r.body.step === 'reminded' && r.body.phase === 'attempt')) crashed = true
        h.restart()
        void snapshot
      }
    }
    assert.ok(crashed)
    const sendsBefore = h.sendsFor(id).filter((s) => s.step === 'reminded').length
    h.restart()
    h.tick('codex', at + 2 * MIN, { slotStart: h.slotFor('codex', at) })
    t = ticks(h, 'codex', at, 20)
    const reminders = h.surface(id).filter((r) => r.body.step === 'reminded' && r.body.phase === 'attempt')
    assert.ok(reminders.every((r) => r.body.n <= 2))
    assert.ok(h.sendsFor(id).filter((s) => s.step === 'reminded' && s.n === 1).length <= 1)
    assert.ok(sendsBefore <= 1)
    assert.equal(h.conflicts().length, 0)
  })
})

describe('origins and their closing evidence', () => {
  it('a newer report that is blocked on something else resolves an owner block; reminders stop', () => {
    const h = setup()
    const x = session(h, 'codex', 'x')
    W.author(h.world, x.sk, T0, ownerBlock())
    const id = itemIds.declared(x.s)
    let t = ticks(h, 'codex', T0, 1)
    W.author(h.world, x.sk, t + MIN, { state: 'blocked', blocked_on: 'waiting on CI' })
    t = ticks(h, 'codex', t, 20)
    assert.equal(h.item(id).state, 'closed')
    assert.deepEqual(sent(h, id), ['shown1'])
  })

  it('a resolved block authored again in a new report is a new episode with one new notification; with no new report, none', () => {
    const h = setup()
    const x = session(h, 'codex', 'x')
    W.author(h.world, x.sk, T0, ownerBlock())
    const id = itemIds.declared(x.s)
    let t = ticks(h, 'codex', T0, 1)
    W.author(h.world, x.sk, t + MIN, { state: 'running', next: 'go' })
    t = ticks(h, 'codex', t, 10)
    assert.equal(h.item(id).episode, 1)
    W.author(h.world, x.sk, t + MIN, ownerBlock())
    t = ticks(h, 'codex', t, 1)
    assert.equal(h.item(id).episode, 2)
    assert.deepEqual(h.sendsFor(id).filter((s) => s.step === 'shown').map((s) => s.episode), [1, 2])
  })

  it('a session rewound to its earlier owner-block line does not reopen the item from the used reference', () => {
    const h = setup()
    const x = session(h, 'codex', 'x')
    W.author(h.world, x.sk, T0, ownerBlock())
    const id = itemIds.declared(x.s)
    let t = ticks(h, 'codex', T0, 1)
    W.author(h.world, x.sk, t + MIN, { state: 'running', next: 'go' })
    t = ticks(h, 'codex', t, 1)
    W.rewind(h.world, x.sk, 0)
    t = ticks(h, 'codex', t, 5)
    assert.equal(h.item(id).episode, 1)
    assert.ok(!h.item(id).open)
    assert.equal(h.records('system').filter((r) => r.body.event === 'report_regressed').length, 1)
  })

  it('a blocked footer naming CI and no owner raises no owner item; a seed footer with OWNER raises only the seed', () => {
    const h = setup()
    const x = session(h, 'codex', 'x', 'repo-a')
    const y = session(h, 'codex', 'y', 'repo-b')
    W.author(h.world, x.sk, T0, { state: 'blocked', blocked_on: 'waiting on CI' })
    W.author(h.world, y.sk, T0, { state: 'blocked', owner: OWNER, seed: { scope: 'repo-b', session: 'y', written_at: T0 } })
    ticks(h, 'codex', T0, 1)
    assert.equal(h.item(itemIds.declared(x.s)), undefined)
    assert.equal(h.item(itemIds.declared(y.s)), undefined)
    assert.ok(h.item(itemIds.seed('repo-b', 'y')).open)
  })

  it('on a changed-at source an inherited decision is no decision on a running line, and an owner block on a blocked one', () => {
    const h = setup()
    const c = session(h, 'chroxy', 'c')
    W.author(h.world, c.sk, T0, { state: 'running', next: 'a', decision: 'pick A or B' })
    let t = ticks(h, 'chroxy', T0, 1)
    W.author(h.world, c.sk, t + MIN, { state: 'running', next: 'b' })
    t = ticks(h, 'chroxy', t, 1)
    assert.equal(h.item(itemIds.declared(c.s)), undefined, 'running + inherited decision raises nothing')
    W.author(h.world, c.sk, t + MIN, { state: 'blocked', blocked_on: 'waiting on CI' })
    t = ticks(h, 'chroxy', t, 1)
    assert.ok(h.item(itemIds.declared(c.s))?.open, 'blocked + inherited decision is an owner block')
    // ...and the first running line, still inheriting it, resolves the item.
    W.author(h.world, c.sk, t + MIN, { state: 'running', next: 'c' })
    ticks(h, 'chroxy', t, 1)
    assert.equal(h.item(itemIds.declared(c.s)).state, 'closed')
  })

  it('gap witness: on a changed-at source a running line that DOES state a new decision is never an owner block', () => {
    const h = setup()
    const c = session(h, 'chroxy', 'c')
    W.author(h.world, c.sk, T0, { state: 'running', next: 'a', decision: 'a brand new question' })
    ticks(h, 'chroxy', T0, 2)
    assert.equal(h.item(itemIds.declared(c.s)), undefined)
  })

  it('a pending prompt that times out does not resolve its item; an owner answer recorded by the host does', () => {
    const h = setup()
    const c = session(h, 'chroxy', 'c')
    W.author(h.world, c.sk, T0, { state: 'running', next: 'a' })
    const p1 = W.raisePrompt(h.world, c.sk, T0 + 10 * MIN, 3600)
    let t = ticks(h, 'chroxy', T0, 1)
    const id = itemIds.prompt(c.s)
    W.lapsePrompt(h.world, c.sk, p1, t + MIN)
    t = ticks(h, 'chroxy', t, 2)
    assert.ok(h.item(id).open)
    assert.equal(h.item(id).episode, 1)
    const p2 = W.raisePrompt(h.world, c.sk, t + MIN, 3600)
    t = ticks(h, 'chroxy', t, 1)
    W.answerPrompt(h.world, c.sk, p2, t + MIN)
    ticks(h, 'chroxy', t, 1)
    assert.equal(h.item(id).state, 'closed')
    assert.equal(h.surface(id).find((r) => r.body.step === 'resolved').body.resolution_evidence, p2)
  })

  it('a prompt every five minutes for two hours, all timing out: one item, updated in place, one notification; then lapsed', () => {
    const h = setup({ per_source: { chroxy: 30 } })
    const c = session(h, 'chroxy', 'c')
    W.author(h.world, c.sk, T0, { state: 'running', next: 'a' })
    const id = itemIds.prompt(c.s)
    let t = T0
    for (let k = 0; k < 24; k++) {
      const at = T0 + k * 5 * MIN + 1000
      const ref = W.raisePrompt(h.world, c.sk, at)
      if (k % 6 === 5) h.tick('chroxy', at + 2 * MIN)
      W.lapsePrompt(h.world, c.sk, ref, at + 5 * MIN - 1000)
      t = at + 5 * MIN
    }
    assert.deepEqual(sent(h, id).filter((s) => s.startsWith('shown')), ['shown1'])
    assert.ok(h.surface(id).filter((r) => r.body.step === 'updated').length >= 2)
    W.author(h.world, c.sk, t + MIN, { state: 'idle' })
    h.tick('chroxy', t + 30 * MIN)
    const w = h.surface(id).find((r) => r.body.step === 'withdrawn')
    assert.equal(w?.body.reason, 'lapsed')
  })

  it('gap witness: a later prompt raised and answered between two ticks resolves the item (the literal rule never does)', () => {
    for (const literal of [false, true]) {
      const policy = literal ? withPolicy({ promptAnswered: (item, cur) => (cur?.status === 'answered' ? item.contentRef : null) }) : undefined
      const h = setup({}, policy)
      const c = session(h, 'chroxy', 'c')
      W.author(h.world, c.sk, T0, { state: 'running', next: 'a' })
      const p1 = W.raisePrompt(h.world, c.sk, T0 + 10 * MIN)
      let t = ticks(h, 'chroxy', T0, 1)
      W.lapsePrompt(h.world, c.sk, p1, t + MIN)
      const p2 = W.raisePrompt(h.world, c.sk, t + 2 * MIN)
      W.answerPrompt(h.world, c.sk, p2, t + 3 * MIN)
      t = ticks(h, 'chroxy', t, 4)
      assert.equal(h.item(itemIds.prompt(c.s)).open, literal, literal ? 'literal: stays open' : 'model: resolved')
    }
  })

  it('a stale line surfaced as attention, then a prompt on the same session: a separate owner-block item that notifies', () => {
    const h = setup()
    const d = session(h, 'claude-desktop', 'd', null)
    const c = session(h, 'chroxy', 'c')
    W.author(h.world, d.sk, T0, { state: 'running', next: 'a' })
    W.author(h.world, c.sk, T0, { state: 'running', next: 'a' })
    W.turnStart(h.world, c.sk, T0 + MIN)
    let t = T0
    for (let k = 0; k < 6; k++) {
      t += 15 * MIN
      h.tick('claude-desktop', t)
      h.tick('chroxy', t)
    }
    const att = itemIds.attention(d.s, h.ctx.state.sessions.get(d.sk).latestAuthored)
    assert.ok(h.item(att)?.open)
    W.turnEnd(h.world, c.sk, t + MIN)
    W.raisePrompt(h.world, c.sk, t + 2 * MIN, 3600)
    h.tick('chroxy', t + 15 * MIN)
    h.tick('chroxy', t + 30 * MIN)
    const pid = itemIds.prompt(c.s)
    assert.ok(h.item(pid)?.open)
    assert.notEqual(pid, att)
  })

  it('a seed archived with nothing else changing is not resolved; a new session in scope with a later first report is', () => {
    const h = setup()
    const x = session(h, 'codex', 'x', 'repo-a')
    W.author(h.world, x.sk, T0, { state: 'idle', seed: { scope: 'repo-a', session: 'x', written_at: T0 } })
    const id = itemIds.seed('repo-a', 'x')
    let t = ticks(h, 'codex', T0, 4)
    assert.ok(h.item(id).open)
    const n = session(h, 'chroxy', 'n', 'repo-a')
    W.author(h.world, n.sk, t + MIN, { state: 'running', next: 'start' })
    h.tick('chroxy', t + 15 * MIN)
    t = ticks(h, 'codex', t, 1)
    assert.equal(h.item(id).state, 'closed')
  })

  it('a resolved seed whose session never authors again raises no new episode in ten ticks (and dropping the used-reference rule cannot show it)', () => {
    for (const mutated of [false, true]) {
      const h = setup({}, mutated ? withPolicy({ mayOpenEpisode: (item) => !item || !item.open }) : undefined)
      const x = session(h, 'codex', 'x', 'repo-a')
      W.author(h.world, x.sk, T0, { state: 'idle', seed: { scope: 'repo-a', session: 'x', written_at: T0 } })
      let t = ticks(h, 'codex', T0, 1)
      const n = session(h, 'codex', 'n', 'repo-a')
      W.author(h.world, n.sk, t + MIN, { state: 'running', next: 'start' })
      t = ticks(h, 'codex', t, 11)
      const id = itemIds.seed('repo-a', 'x')
      assert.equal(h.item(id).episode, 1)
      assert.equal(h.sendsFor(id).filter((s) => s.step === 'shown').length, 1)
    }
  })
})

describe('the preemption link', () => {
  function surfaceRecords(steps) {
    const l = createLedger({ ledgerId: 'L' })
    const z = { presentation: 0, shows_counted: 0, reminders_used: 0, returns_used: 0 }
    steps.forEach(([item, episode, step, extra = {}], i) => {
      append(l, { kind: 'surface', id: `r${i}`, body: { item_id: item, item_kind: 'owner_block', origin: 'declared', episode, step, phase: 'none', ...z, opened_by: `ref-${item}-${episode}`, ...extra } }, T0 + i * 1000)
    })
    return deriveState(l.records, DEFAULT_POLICY)
  }

  it('is cleared when the preemptor closes without being shown', () => {
    const st = surfaceRecords([['a', 1, 'queued'], ['b', 1, 'queued'], ['a', 1, 'preempted', { preempted_by: 'b' }], ['b', 1, 'withdrawn']])
    assert.equal(st.items.get('a').preemptedBy, null)
  })

  it('is cleared when the preempted item opens a new episode', () => {
    const st = surfaceRecords([['a', 1, 'queued'], ['b', 1, 'queued'], ['a', 1, 'preempted', { preempted_by: 'b' }], ['a', 1, 'resolved'], ['a', 2, 'queued']])
    assert.equal(st.items.get('a').preemptedBy, null)
  })
})

describe('preemption', () => {
  function twoDeadlines(policy) {
    const h = setup({ surface: { reminder_after_minutes: [60, 180], item_time_limit_hours: 8, max_presentations: 3 } }, policy)
    const a = session(h, 'chroxy', 'a')
    const b = session(h, 'chroxy', 'b')
    W.author(h.world, a.sk, T0, { state: 'running', next: 'a' })
    W.author(h.world, b.sk, T0, { state: 'running', next: 'b' })
    W.raisePrompt(h.world, a.sk, T0 + MIN, 70 * 60)
    h.tick('chroxy', T0 + 2 * MIN)
    W.raisePrompt(h.world, b.sk, T0 + 5 * MIN, 45 * 60)
    ticks(h, 'chroxy', T0, 4)
    return { h, ia: itemIds.prompt(a.s), ib: itemIds.prompt(b.s) }
  }

  it('an item whose deadline passes before the active item\'s next reminder preempts it once; the preempted keeps its history', () => {
    const { h, ia, ib } = twoDeadlines()
    const seq = h.records('surface').filter((r) => r.body.phase !== 'outcome').map((r) => `${r.body.item_id === ia ? 'a' : 'b'}:${r.body.step}`)
    // a is shown; b (deadline 00:50, before a's reminder at 01:02) preempts
    // and is shown. Once b's own deadline has passed, a (deadline 01:11,
    // before b's reminder at 01:15) preempts b in turn: also by the rule.
    assert.deepEqual(seq, ['a:queued', 'a:shown', 'b:queued', 'a:preempted', 'b:shown', 'b:preempted', 'a:shown'])
    assert.deepEqual(steps(h, ia).slice(0, 3), ['queued', 'shown', 'preempted'], 'the preempted item keeps its history')
    assert.deepEqual(sent(h, ib), ['shown1'])
  })

  it('gap witness: with "front of its class" applied to deadline items, the preempted item is re-shown ahead of its preemptor', () => {
    const frontFirst = (item, now) => {
      const k = DEFAULT_POLICY.orderKey({ ...item, deadline: null }, now)
      const hasDeadline = item.kind === 'owner_block' && item.deadline != null && item.deadline > now
      return hasDeadline ? [0, item.position?.rank ?? 1, item.position?.seq ?? 0, 0, item.deadline, item.itemId] : k
    }
    // The preemptor-first rule would also prevent it, so it is switched off.
    const { h, ia, ib } = twoDeadlines(withPolicy({ orderKey: frontFirst, preemptorFirst: () => {} }))
    const seq = h.records('surface').filter((r) => r.body.phase !== 'outcome').map((r) => `${r.body.item_id === ia ? 'a' : 'b'}:${r.body.step}`)
    assert.deepEqual(seq.slice(0, 5), ['a:queued', 'a:shown', 'b:queued', 'a:preempted', 'a:shown'])
    assert.ok(h.item(ia).counters.shows_counted >= 2, 'the preempted item spent its shows')
    assert.ok(seq.indexOf('b:shown') === -1 || seq.indexOf('b:shown') > 4, 'the earlier deadline waited behind the item it preempted')
    void ib
  })

  it('gap witness: read literally, two deadline items preempt each other on alternate ticks', () => {
    const { h } = twoDeadlines(withPolicy({ preempts: literalPreempts }))
    assert.ok(h.records('surface').filter((r) => r.body.step === 'preempted').length >= 2)
  })
})
