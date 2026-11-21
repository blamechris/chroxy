/**
 * One session, one item: a condition that would raise an attention item for
 * a session that already has an open owner-block item is merged into that
 * item instead (README, "One session, one item").
 *
 * Every scenario is a list of ticks run with the invariant monitor checked
 * after each, so the same list also drives the crash-at-every-operation
 * proofs at the end.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG } from './model/config.js'
import { itemIds } from './model/keys.js'
import { Crash, MIN, OWNER, T0, createHarness } from './helpers/harness.js'
import { InvariantError, checkStep, createMonitor } from './helpers/invariants.js'
import { LITERAL, MUTANTS } from './helpers/variants.js'
import * as W from './helpers/world.js'

const FAST = { per_source: { chroxy: 15, codex: 15, 'claude-desktop': 15 } }
const ownerBlock = (blocked_on = 'approve the merge') => ({ state: 'blocked', blocked_on, owner: OWNER })
const at = (m) => T0 + m * MIN

/** Reads of one session fail (its own reads, not the source's). */
function failing(nativeId) {
  const err = { outcome: 'error', error_code: 'timeout' }
  return (a) => ({ ...a, read: (s, n) => (s.native_id === nativeId ? err : a.read(s, n)), reread: (s, n) => (s.native_id === nativeId ? err : a.reread(s, n)) })
}

function setup(over = {}, policy) {
  const h = createHarness({ config: { ...FAST, ...over }, ...(policy ? { policy } : {}) })
  const mon = createMonitor({ config: h.ctx.state.config, firstCycleBound: 20, surfaceBound: 100 })
  return { h, mon }
}
function session(h, source, id, scope = 'repo') {
  const sk = W.addSession(h.world, { source, native_id: id, scope })
  return { sk, s: h.world.sessions[sk].session }
}

/**
 * Run a scenario's ticks in order; `crash` = { tick, op } stops that tick
 * after `op` operations, restarts from the ledger and replays the slot a few
 * minutes later. Returns whether the crash point was reached.
 */
function play(sc, { crash = null, upTo = sc.ticks.length, from = 0 } = {}) {
  const { h, mon } = sc
  let crashed = false
  for (let k = from; k < upTo; k++) {
    const t = sc.ticks[k]
    t.before?.(h)
    const slotStart = h.slotFor(t.source, t.at)
    if (crash && crash.tick === k) {
      try {
        h.tick(t.source, t.at, { reads: t.reads, crashAfter: crash.op, slotStart })
      } catch (e) {
        if (!(e instanceof Crash)) throw e
        crashed = true
        checkStep(mon, h, { complete: false })
        h.restart()
        h.tick(t.source, t.at + 3 * MIN, { reads: t.reads, slotStart })
        checkStep(mon, h)
        continue
      }
    } else {
      h.tick(t.source, t.at, { reads: t.reads, slotStart })
    }
    checkStep(mon, h)
  }
  return crashed
}

const steps = (h, id) => h.surface(id).filter((r) => r.body.phase !== 'outcome')
const carries = (h, id) => steps(h, id).filter((r) => r.body.step === 'updated' && r.body.carry)

// ── scenarios ───────────────────────────────────────────────────────────────

/** A declared block shown at +15; the session's own reads fail from +30; merged at +60. */
function repeatedError(over, policy) {
  const sc = setup(over, policy)
  const x = session(sc.h, 'codex', 'x')
  const y = session(sc.h, 'codex', 'y')
  W.author(sc.h.world, x.sk, T0, ownerBlock())
  W.author(sc.h.world, y.sk, T0, { state: 'idle' })
  const bad = failing('x')
  sc.ticks = [
    { source: 'codex', at: at(15) },
    { source: 'codex', at: at(30), reads: bad },
    { source: 'codex', at: at(45), reads: bad },
    { source: 'codex', at: at(60), reads: bad },
  ]
  return Object.assign(sc, { x, merge: 3, ob: itemIds.declared(x.s) })
}

/** A declared block on a source that cannot confirm gone; the session leaves the list at +30. */
function droppedCannotConfirm() {
  const sources = { ...DEFAULT_CONFIG.sources, 'claude-desktop': { ...DEFAULT_CONFIG.sources['claude-desktop'], can_confirm_gone: false } }
  const sc = setup({ sources })
  const d = session(sc.h, 'claude-desktop', 'd', null)
  W.author(sc.h.world, d.sk, T0, ownerBlock())
  sc.ticks = [
    { source: 'claude-desktop', at: at(15) },
    { source: 'claude-desktop', at: at(30), before: (h) => (h.world.sessions[d.sk].listed = false) },
    { source: 'claude-desktop', at: at(45) },
  ]
  return Object.assign(sc, { x: d, merge: 2, ob: itemIds.declared(d.s) })
}

/** A declared block whose list omits the session at every tick read while every confirming read finds it. */
function intermittentList() {
  const sc = setup()
  const x = session(sc.h, 'codex', 'x')
  W.author(sc.h.world, x.sk, T0, ownerBlock())
  const flicker = (h) => (h.world.sessions[x.sk].flickerDrop = true)
  sc.ticks = [
    { source: 'codex', at: at(15) },
    { source: 'codex', at: at(30), before: flicker },
    { source: 'codex', at: at(45), before: flicker },
  ]
  return Object.assign(sc, { x, merge: 2, ob: itemIds.declared(x.s) })
}

/**
 * A pending prompt shown at +15; the session's reads fail from +30 and the
 * condition is merged into the prompt item at +60; the owner answers at +61
 * and the reads recover at +75, so the prompt item closes while the
 * condition still holds.
 */
function promptThenAnswered(policy) {
  const sc = setup({}, policy)
  const c = session(sc.h, 'chroxy', 'c')
  const y = session(sc.h, 'chroxy', 'y')
  W.author(sc.h.world, c.sk, T0, { state: 'running', next: 'a' })
  W.author(sc.h.world, y.sk, T0, { state: 'idle' })
  const ref = W.raisePrompt(sc.h.world, c.sk, at(5), 7200)
  const bad = failing('c')
  sc.ticks = [
    { source: 'chroxy', at: at(15) },
    { source: 'chroxy', at: at(30), reads: bad },
    { source: 'chroxy', at: at(45), reads: bad },
    { source: 'chroxy', at: at(60), reads: bad },
    { source: 'chroxy', at: at(75), before: (h) => W.answerPrompt(h.world, c.sk, ref, at(61)) },
  ]
  return Object.assign(sc, { x: c, merge: 3, close: 4, ob: itemIds.prompt(c.s) })
}

/**
 * The reverse order: a stale line is surfaced as attention at +75; a prompt
 * is raised at +76 and its item opens at +90; the owner answers at +91.
 */
function attentionThenPrompt(policy) {
  const sc = setup({}, policy)
  const c = session(sc.h, 'chroxy', 'c')
  const y = session(sc.h, 'chroxy', 'y')
  W.author(sc.h.world, c.sk, T0, { state: 'running', next: 'a' })
  W.author(sc.h.world, y.sk, T0, { state: 'idle' })
  let ref = null
  sc.ticks = [15, 30, 45, 60, 75].map((m) => ({ source: 'chroxy', at: at(m) }))
  sc.ticks.push({ source: 'chroxy', at: at(90), before: (h) => (ref = W.raisePrompt(h.world, c.sk, at(76), 7200)) })
  sc.ticks.push({ source: 'chroxy', at: at(105), before: (h) => W.answerPrompt(h.world, c.sk, ref, at(91)) })
  return Object.assign(sc, { x: c, merge: 5, close: 6, ob: itemIds.prompt(c.s) })
}

function attentionIdOf(sc) {
  return itemIds.attention(sc.x.s, sc.h.ctx.state.sessions.get(sc.x.sk).latestAuthored)
}

// ── the merge while the owner-block item is open ───────────────────────────

describe('a second item about a session with an open owner-block item is merged into it', () => {
  for (const [name, build, trigger] of [
    ['its own reads keep failing (repeated_error)', repeatedError, 'repeated_error'],
    ['it left the list of a source that cannot confirm gone', droppedCannotConfirm, 'dropped_from_list'],
    ['every confirming read found it listed again', intermittentList, 'dropped_from_list'],
  ]) {
    it(`${name}: no attention item, the owner-block item names the condition, nothing is sent`, () => {
      const sc = build()
      play(sc, { upTo: sc.merge })
      const sendsBefore = sc.h.sends.length
      const before = sc.h.records().length
      play(sc, { from: sc.merge })
      const h = sc.h
      assert.deepEqual(h.openItems().map((i) => i.origin), ['declared'])
      const att = attentionIdOf(sc)
      assert.equal(h.item(att), undefined, 'no attention item is ever raised')
      // The condition is in the item's content: what it would have been,
      // the trigger and the time it began.
      const carried = h.item(sc.ob).carried
      assert.equal(carried.length, 1)
      assert.equal(carried[0].attention_item, att)
      assert.equal(carried[0].trigger, trigger)
      const onset = h.ctx.state.checks.get(carried[0].opened_by)
      assert.equal(carried[0].since, onset.body.checked_at)
      assert.ok(carried[0].since < sc.ticks[sc.merge].at, 'the time it began, not the time it was merged')
      // The update sends nothing by itself.
      const [rec] = carries(h, sc.ob)
      assert.equal(rec.body.phase, 'none')
      assert.equal(rec.body.carry.path, 'signal')
      assert.ok(rec.seq > h.records()[before - 1].seq)
      assert.equal(h.sends.length, sendsBefore)
      assert.equal(h.conflicts().length, 0)
    })
  }

  it('gap witness: read the earlier way (both items raised), the session holds two items and I9 fails', () => {
    const old = repeatedError({}, LITERAL.raiseBesideOwnerBlock.policy)
    assert.throws(() => play(old), (e) => e instanceof InvariantError && e.id === 'I9')
    assert.deepEqual(old.h.openItems().map((i) => i.origin).sort(), ['attention', 'declared'])
  })

  it('mutation: a condition beside an open owner-block item that is dropped instead of merged turns I11 red', () => {
    const sc = repeatedError({}, MUTANTS.I11)
    assert.throws(() => play(sc), (e) => e instanceof InvariantError && e.id === 'I11')
    assert.equal(sc.h.openItems().length, 1)
  })
})

// ── the updated row ─────────────────────────────────────────────────────────

describe('a merge is the updated row of the transition table', () => {
  it('from exhausted it queues the item again only while a counted show is left; a flapping condition cannot add shows', () => {
    const surface = { max_presentations: 2, item_time_limit_hours: 20, reminder_after_minutes: [600, 900] }
    const sc = setup({ surface })
    const { h } = sc
    const x = session(h, 'codex', 'x')
    const y = session(h, 'codex', 'y')
    W.author(h.world, x.sk, T0, ownerBlock())
    W.author(h.world, y.sk, T0, { state: 'idle' })
    const id = itemIds.declared(x.s)
    const bad = failing('x')
    const ticks = (list) => play({ ...sc, ticks: list.map(([m, reads]) => ({ source: 'codex', at: at(m), reads })) })
    ticks([[15]])
    h.owner(id, 'done', 'm1', { at: at(16) })
    ticks([[30]])
    h.owner(id, 'done', 'm2', { at: at(31) })
    ticks([[45]])
    assert.equal(h.item(id).state, 'exhausted')
    assert.equal(h.item(id).counters.shows_counted, 1)
    // A condition merged while one counted show is left: queued, then shown
    // at the slot. The send is the show's, not the update's.
    ticks([[60, bad], [75, bad], [90, bad]])
    const last = steps(h, id).slice(-2).map((r) => `${r.body.step}:${r.body.phase}`)
    assert.deepEqual(last, ['updated:none', 'shown:attempt'])
    assert.equal(carries(h, id)[0].body.requeue, true)
    assert.equal(h.item(id).counters.shows_counted, 2)
    // Exhausted again, now with no counted show left.
    h.owner(id, 'done', 'm3', { at: at(91) })
    ticks([[105, bad]])
    assert.equal(h.item(id).state, 'exhausted')
    const sends = h.sendsFor(id).length
    // The condition clears (a newer authored line, the same block) and a new
    // one is merged, three times over: each is a content change, none queues
    // the item, nothing is sent.
    let m = 105
    for (let k = 0; k < 3; k++) {
      W.author(h.world, x.sk, at(m + 1), ownerBlock())
      ticks([[(m += 15)], [(m += 15), bad], [(m += 15), bad], [(m += 15), bad]])
    }
    const changes = carries(h, id).map((r) => r.body.carry.op)
    assert.deepEqual(changes, ['carry', 'clear', 'carry', 'clear', 'carry', 'clear', 'carry'])
    assert.ok(carries(h, id).slice(1).every((r) => r.body.requeue === false))
    assert.equal(h.item(id).state, 'exhausted')
    assert.equal(h.sendsFor(id).length, sends)
    assert.equal(h.sendsFor(id).filter((s) => s.step === 'shown').length, 2, 'never more counted shows than the limit')
    assert.equal(h.conflicts().length, 0)
  })

  it('mutation (fault): a carried-condition change that changes nothing cannot lift exhaustion; the show it leads to turns I6 red', () => {
    const run = (fault) => {
      const surface = { max_presentations: 2, item_time_limit_hours: 20, reminder_after_minutes: [600, 900] }
      const sc = setup({ surface })
      const { h } = sc
      const x = session(h, 'codex', 'x')
      const y = session(h, 'codex', 'y')
      W.author(h.world, x.sk, T0, ownerBlock())
      W.author(h.world, y.sk, T0, { state: 'idle' })
      const id = itemIds.declared(x.s)
      const bad = failing('x')
      const ticks = (list) => play({ ...sc, ticks: list.map(([m, reads]) => ({ source: 'codex', at: at(m), reads })) })
      // Merged while the item is active (one counted show of two used).
      ticks([[15], [30, bad], [45, bad], [60, bad]])
      h.owner(id, 'done', 'm1', { at: at(61) })
      ticks([[75, bad]])
      h.owner(id, 'done', 'm2', { at: at(76) })
      ticks([[90, bad]])
      assert.equal(h.item(id).state, 'exhausted')
      // The condition clears while a counted show is left: queued, shown.
      // The fault records the clearing as a second carry of what is already
      // carried, which changes nothing.
      if (fault) h.rewriteAppend = (d) => (d.kind === 'surface' && d.body.carry?.op === 'clear' ? { ...d, body: { ...d.body, carry: { ...d.body.carry, op: 'carry' } } } : d)
      W.author(h.world, x.sk, at(91), ownerBlock())
      ticks([[105]])
      return h
    }
    const h = run(false)
    assert.equal(h.sendsFor(itemIds.declared(h.world.sessions[h.world.order[0]].session)).filter((s) => s.step === 'shown').length, 2)
    assert.throws(() => run(true), (e) => e instanceof InvariantError && e.id === 'I6')
  })

  it('a condition that clears and returns: carried, dropped when superseded, carried again under its new onset, no key repeated', () => {
    const sc = repeatedError()
    const { h, x } = sc
    const bad = failing('x')
    sc.ticks.push(
      { source: 'codex', at: at(75), before: (hh) => (hh.world.sessions[x.sk].listed = false) },
      { source: 'codex', at: at(90), before: (hh) => (hh.world.sessions[x.sk].listed = true) },
      { source: 'codex', at: at(105), reads: bad },
      { source: 'codex', at: at(120), reads: bad },
      { source: 'codex', at: at(135), reads: bad },
    )
    play(sc)
    const recs = carries(h, sc.ob)
    assert.deepEqual(recs.map((r) => `${r.body.carry.op}:${r.body.carry.path}`), ['carry:signal', 'clear:superseded', 'carry:signal'])
    assert.equal(recs[0].body.carry.attention_item, recs[2].body.carry.attention_item, 'the same attention item')
    assert.notEqual(recs[0].body.carry.opened_by, recs[2].body.carry.opened_by, 'a new onset')
    assert.equal(new Set(recs.map((r) => r.id)).size, 3)
    assert.equal(h.conflicts().length, 0)
    assert.deepEqual(h.item(sc.ob).carried.map((c) => c.opened_by), [recs[2].body.carry.opened_by])
    assert.deepEqual(h.openItems().map((i) => i.origin), ['declared'])
  })

  it('a condition whose own closing evidence arrives is dropped from the content; the item stays open', () => {
    const sc = repeatedError()
    play(sc)
    const { h, x } = sc
    W.author(h.world, x.sk, at(61), ownerBlock('approve the other merge'))
    sc.ticks = [{ source: 'codex', at: at(75) }]
    play(sc)
    assert.deepEqual(carries(h, sc.ob).map((r) => `${r.body.carry.op}:${r.body.carry.path}`), ['carry:signal', 'clear:resolved'])
    assert.deepEqual(h.item(sc.ob).carried, [])
    assert.ok(h.item(sc.ob).open)
    assert.equal(h.item(attentionIdOf(sc)), undefined)
  })
})

// ── when the owner-block item closes, and the reverse order ────────────────

describe('the condition outlives the owner-block item; the reverse order leaves one item', () => {
  it('the owner-block item closes while the condition holds: the condition raises its own attention item in that tick', () => {
    const sc = promptThenAnswered()
    play(sc)
    const { h } = sc
    assert.equal(h.item(sc.ob).state, 'closed')
    const att = h.item(attentionIdOf(sc))
    assert.ok(att?.open, 'raised as for a session with no open item')
    const queued = steps(h, att.itemId).find((r) => r.body.step === 'queued')
    assert.equal(queued.body.handover_of, `${sc.ob}|1`)
    assert.equal(att.openedBy, carries(h, sc.ob)[0].body.carry.opened_by, 'opened by the onset that would have opened it')
    assert.equal(queued.body.condition.trigger, 'repeated_error')
    assert.deepEqual(h.openItems().map((i) => i.origin), ['attention'])
  })

  it('mutation: a condition not handed on when its owner-block item closes turns I11 red', () => {
    const sc = promptThenAnswered(MUTANTS['I11.handover'])
    assert.throws(() => play(sc), (e) => e instanceof InvariantError && e.id === 'I11')
  })

  it('an attention item open when the session gets an owner-block item is withdrawn as merged and carried; handed back when that item closes', () => {
    const sc = attentionThenPrompt()
    play(sc, { upTo: sc.merge })
    const { h } = sc
    const attId = attentionIdOf(sc)
    assert.ok(h.item(attId).open)
    const opened = h.item(attId).openedBy
    play(sc, { from: sc.merge, upTo: sc.close })
    assert.deepEqual(h.openItems().map((i) => i.origin), ['prompt'])
    assert.equal(steps(h, attId).at(-1).body.reason, 'merged')
    const [rec] = carries(h, sc.ob)
    assert.equal(rec.body.carry.path, 'open_attention')
    assert.equal(rec.body.carry.opened_by, opened)
    assert.equal(rec.body.carry.trigger, 'stale_report')
    assert.ok(rec.seq < steps(h, attId).at(-1).seq, 'carried before it is withdrawn')
    play(sc, { from: sc.close })
    const att = h.item(attId)
    assert.ok(att.open)
    assert.equal(att.episode, 2)
    assert.notEqual(att.openedBy, opened, 'a used opening reference is never reopened')
    assert.deepEqual(h.openItems().map((i) => i.origin), ['attention'])
  })

  it('mutation: the reverse order left alone keeps both items and turns I9 red', () => {
    const sc = attentionThenPrompt(MUTANTS.I9)
    assert.throws(() => play(sc), (e) => e instanceof InvariantError && e.id === 'I9')
  })
})

// ── crash and replay in the middle of a merge ──────────────────────────────

describe('crash and replay in the middle of a merge', () => {
  for (const [name, build, tickOf] of [
    ['a merge on a signal', () => repeatedError(), (sc) => sc.merge],
    ['the reverse order', attentionThenPrompt, (sc) => sc.merge],
    ['a handover when the owner-block item closes', () => promptThenAnswered(), (sc) => sc.close],
  ]) {
    it(`${name}: killed at every operation of its tick and replayed, one item and one change; no conflict, no second send`, () => {
      let points = 0
      for (let op = 0; ; op++) {
        const sc = build()
        const crashed = play(sc, { crash: { tick: tickOf(sc), op } })
        const h = sc.h
        assert.equal(h.conflicts().length, 0, `crash at op ${op}`)
        const sent = h.sends.map((s) => s.attempt_id)
        assert.equal(new Set(sent).size, sent.length, `no second send: op ${op}`)
        const recs = carries(h, sc.ob)
        assert.equal(new Set(recs.map((r) => `${r.body.carry.op}|${r.body.carry.attention_item}|${r.body.carry.opened_by}`)).size, recs.length)
        assert.equal(h.openItems().length, 1, `one item: op ${op}`)
        if (!crashed) break
        points += 1
      }
      assert.ok(points > 5, `${points} crash points exercised`)
    })
  }
})
