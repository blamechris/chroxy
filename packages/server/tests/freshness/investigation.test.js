import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { itemIds } from './model/keys.js'
import { DEFAULT_POLICY } from './model/policy.js'
import { MIN, OWNER, T0, createHarness } from './helpers/harness.js'
import { LITERAL, MUTANTS, staleOwnerBlockInconclusive } from './helpers/variants.js'
import * as W from './helpers/world.js'

const CAD = 15
function setup(over = {}, policy) {
  return createHarness({ config: { per_source: { chroxy: CAD, codex: CAD, 'claude-desktop': CAD }, ...over }, ...(policy ? { policy } : {}) })
}
function session(h, source, id, scope = 'repo') {
  const sk = W.addSession(h.world, { source, native_id: id, scope })
  return { sk, s: h.world.sessions[sk].session }
}
function ticks(h, source, from, n, opts) {
  let t = from
  for (let i = 0; i < n; i++) {
    t += CAD * MIN
    h.tick(source, t, opts)
  }
  return t
}
const invs = (h, sk) => [...h.ctx.state.investigations.values()].filter((i) => i.sk === sk)
const classes = (h, sk) => invs(h, sk).map((i) => `${i.trigger === 'recheck' ? 'R' : i.cycle}:${i.classification}`)
const attentionFor = (h, x) => h.item(itemIds.attention(x.s, h.ctx.state.sessions.get(x.sk).latestAuthored))

describe('classification', () => {
  it('a stale running line with a turn in flight at this read is working_unreported and is not surfaced', () => {
    const h = setup()
    const c = session(h, 'chroxy', 'c')
    W.author(h.world, c.sk, T0, { state: 'running', next: 'a' })
    W.turnStart(h.world, c.sk, T0 + 10 * MIN)
    ticks(h, 'chroxy', T0, 5)
    assert.deepEqual(classes(h, c.sk).slice(0, 2), ['1:working_unreported', 'R:working_unreported'])
    assert.equal(h.sends.length, 0)
  })

  it('mutation: a turn-ending event two minutes ago and a recent last activity are not working', () => {
    const h = setup()
    const c = session(h, 'chroxy', 'c')
    W.author(h.world, c.sk, T0, { state: 'running', next: 'a' })
    W.turnStart(h.world, c.sk, T0 + 50 * MIN)
    W.turnEnd(h.world, c.sk, T0 + 58 * MIN)
    ticks(h, 'chroxy', T0, 4)
    assert.equal(classes(h, c.sk)[0], '1:finished_unreported')
  })

  it('an open-turn event older than the activity window, with no end event and a host not busy, is not working', () => {
    for (const windowMin of [20, 10_000]) {
      const h = setup({ investigation: { activity_window_minutes: windowMin, background_wait_max_minutes: 90 } })
      const c = session(h, 'chroxy', 'c')
      W.author(h.world, c.sk, T0, { state: 'running', next: 'a' })
      W.turnStart(h.world, c.sk, T0 + 5 * MIN)
      // The session dies in the middle of its turn: no turn-ending event.
      W.dieMidTurn(h.world, c.sk)
      ticks(h, 'chroxy', T0, 4)
      const first = classes(h, c.sk)[0]
      if (windowMin === 20) assert.notEqual(first, '1:working_unreported', 'an event 55 minutes old is outside the window')
      else assert.equal(first, '1:working_unreported', 'inside a huge window the same event counts')
    }
    const m = setup({}, MUTANTS['I7f.window'])
    const c = session(m, 'chroxy', 'c')
    W.author(m.world, c.sk, T0, { state: 'running', next: 'a' })
    W.turnStart(m.world, c.sk, T0 + 5 * MIN)
    W.dieMidTurn(m.world, c.sk)
    ticks(m, 'chroxy', T0, 4)
    assert.equal(classes(m, c.sk)[0], '1:working_unreported', 'mutation: with the window ignored, old activity reads as working')
  })

  it('an open-turn event exactly the activity window old is still working; one millisecond older is not', () => {
    const config = { investigation: { activity_window_minutes: 20 } }
    const base = { rungBlocked: false, sourceLevel: false, trigger: 'stale_report', rereadFailed: false, native: null, ownerBlock: false, state: 'running', reportAt: T0, now: T0 + 60 * MIN }
    const at = (activity_at) => [{ basis: 'open_turn_event_after_report', activity_at }]
    const edge = base.now - 20 * MIN
    assert.equal(DEFAULT_POLICY.withinActivityWindow({ activity_at: edge }, base.now, config), true)
    assert.equal(DEFAULT_POLICY.withinActivityWindow({ activity_at: edge - 1 }, base.now, config), false)
    assert.equal(DEFAULT_POLICY.classify({ ...base, events: at(edge) }, config), 'working_unreported')
    assert.equal(DEFAULT_POLICY.classify({ ...base, events: at(edge - 1) }, config), 'running_claim_unverified')
  })

  it('a tool start after the report and then a turn ending in error: not working_unreported', () => {
    const h = setup()
    const x = session(h, 'codex', 'x')
    W.author(h.world, x.sk, T0, { state: 'running', next: 'a' })
    W.turnStart(h.world, x.sk, T0 + 30 * MIN)
    W.turnEnd(h.world, x.sk, T0 + 40 * MIN)
    ticks(h, 'codex', T0, 4)
    assert.equal(classes(h, x.sk)[0], '1:finished_unreported')
  })

  it('a stale running line with a pending permission is waiting_on_owner: one owner item with a prompt ask, none from the investigation', () => {
    const h = setup()
    const c = session(h, 'chroxy', 'c')
    W.author(h.world, c.sk, T0, { state: 'running', next: 'a' })
    W.raisePrompt(h.world, c.sk, T0 + 50 * MIN, 3600)
    ticks(h, 'chroxy', T0, 5)
    assert.equal(classes(h, c.sk)[0], '1:waiting_on_owner')
    assert.deepEqual(h.openItems().map((i) => i.origin), ['owner'])
  })

  it('a source with no live busy state: running_claim_unverified, not surfaced on the first cycle, surfaced after the second', () => {
    const h = setup()
    const d = session(h, 'claude-desktop', 'd', null)
    W.author(h.world, d.sk, T0, { state: 'running', next: 'a' })
    let t = ticks(h, 'claude-desktop', T0, 4)
    assert.deepEqual(classes(h, d.sk), ['1:running_claim_unverified'])
    assert.equal(h.openItems().length, 0)
    ticks(h, 'claude-desktop', t, 1)
    assert.deepEqual(classes(h, d.sk), ['1:running_claim_unverified', '2:running_claim_unverified'])
    assert.ok(attentionFor(h, d).open)
  })

  it('a first cycle inconclusive and a second running_claim_unverified is surfaced after the second', () => {
    const h = setup()
    const d = session(h, 'claude-desktop', 'd', null)
    W.author(h.world, d.sk, T0, { state: 'running', next: 'a' })
    let t = ticks(h, 'claude-desktop', T0, 3)
    // The re-read is not allowed at the next tick only: the rung is blocked.
    let n = 0
    const blockedOnce = (a) => ({ ...a, reread: (s) => (n++ === 0 ? { outcome: 'blocked', not_read_reason: 'credential_required' } : a.reread(s)) })
    t += CAD * MIN
    h.tick('claude-desktop', t, { reads: blockedOnce })
    t = ticks(h, 'claude-desktop', t, 1)
    assert.deepEqual(classes(h, d.sk), ['1:inconclusive', '2:running_claim_unverified'])
    assert.ok(attentionFor(h, d).open)
  })

  it('a rung that needs access it lacks is blocked and the classification inconclusive; no access is widened', () => {
    const h = setup()
    const c = session(h, 'chroxy', 'c')
    W.author(h.world, c.sk, T0, { state: 'running', next: 'a' })
    const blocked = (a) => ({ ...a, reread: () => ({ outcome: 'blocked', not_read_reason: 'credential_required' }) })
    ticks(h, 'chroxy', T0, 4, { reads: blocked })
    const inv = invs(h, c.sk)[0]
    assert.equal(inv.classification, 'inconclusive')
    const close = h.records('investigation').find((r) => r.body.phase === 'close')
    assert.ok(close.body.rungs.some((r) => r.rung === 're_read' && r.outcome === 'blocked'))
  })

  it('idle declared with a turn in flight in the same roster read opens native_disagreement; never on a source without native state', () => {
    const h = setup()
    const c = session(h, 'chroxy', 'c')
    const d = session(h, 'claude-desktop', 'd', null)
    W.author(h.world, c.sk, T0, { state: 'idle' })
    W.author(h.world, d.sk, T0, { state: 'idle' })
    W.turnStart(h.world, c.sk, T0 + MIN)
    W.turnStart(h.world, d.sk, T0 + MIN)
    ticks(h, 'chroxy', T0, 1)
    ticks(h, 'claude-desktop', T0, 1)
    assert.deepEqual(invs(h, c.sk).map((i) => i.trigger), ['native_disagreement'])
    assert.deepEqual(invs(h, d.sk), [])
  })

  it('blocked on CI, no owner, no decision, four hours old: blocked_unresolved and one attention item after the first cycle (and for stalled)', () => {
    for (const state of ['blocked', 'stalled']) {
      const h = setup({ per_source: { codex: 30 } })
      const x = session(h, 'codex', 'x')
      W.author(h.world, x.sk, T0, { state, blocked_on: 'waiting on CI' })
      let t = T0
      for (let i = 0; i < 9; i++) {
        t += 30 * MIN
        h.tick('codex', t)
      }
      assert.deepEqual(classes(h, x.sk), ['1:blocked_unresolved'])
      assert.ok(attentionFor(h, x).open)
      assert.equal(h.item(itemIds.owner(x.s)), undefined)
    }
  })

  it('background shells only: waiting_on_background, not surfaced before the limit, surfaced once after it', () => {
    const h = setup()
    const c = session(h, 'chroxy', 'c')
    W.author(h.world, c.sk, T0, { state: 'running', next: 'a' })
    h.world.sessions[c.sk].background = true
    let t = ticks(h, 'chroxy', T0, 6)
    assert.equal(h.openItems().length, 0, 'at 90 minutes, not yet')
    ticks(h, 'chroxy', t, 4)
    const att = attentionFor(h, c)
    assert.ok(att.open)
    assert.equal(h.sendsFor(att.itemId).filter((s) => s.step === 'shown').length, 1)
    assert.ok(classes(h, c.sk).every((x) => x.endsWith('waiting_on_background')))
  })

  it('a stale owner block is waiting_on_owner and is not surfaced a second time as an attention item', () => {
    const h = setup()
    const x = session(h, 'codex', 'x')
    W.author(h.world, x.sk, T0, { state: 'blocked', blocked_on: 'approve', owner: OWNER })
    ticks(h, 'codex', T0, 20)
    assert.deepEqual(classes(h, x.sk), ['1:waiting_on_owner'])
    assert.deepEqual(h.openItems().map((i) => i.origin), ['owner'])
    assert.deepEqual(h.item(itemIds.owner(x.s)).carried, [], 'and its own item carries no stale condition about it')
  })

  it('a session rewound to an owner-block line its item already used is not waiting on that item: the stale line is surfaced', () => {
    const h = setup()
    const x = session(h, 'codex', 'x')
    W.author(h.world, x.sk, T0, { state: 'blocked', blocked_on: 'approve', owner: OWNER })
    let t = ticks(h, 'codex', T0, 1)
    W.author(h.world, x.sk, t + MIN, { state: 'running', next: 'go' })
    t = ticks(h, 'codex', t, 1)
    assert.equal(h.item(itemIds.owner(x.s)).state, 'closed')
    W.rewind(h.world, x.sk, 0)
    ticks(h, 'codex', t, 20)
    assert.equal(h.item(itemIds.owner(x.s)).episode, 1, 'the used line never reopens its item')
    assert.deepEqual(classes(h, x.sk), ['1:blocked_unresolved'])
    assert.ok(attentionFor(h, x)?.open, 'surfaced as attention instead')
  })

  it('read literally, a stale owner block is inconclusive twice: its own item then carries a stale condition about the wait it already shows', () => {
    const h = setup({}, staleOwnerBlockInconclusive)
    const x = session(h, 'codex', 'x')
    W.author(h.world, x.sk, T0, { state: 'blocked', blocked_on: 'approve', owner: OWNER })
    ticks(h, 'codex', T0, 20)
    assert.deepEqual(h.openItems().map((i) => i.origin), ['owner'])
    assert.deepEqual(h.item(itemIds.owner(x.s)).carried.map((c) => c.trigger), ['stale_report'])
  })
})

describe('cycles, onsets and rechecks', () => {
  it('an inconclusive first cycle gets a second at the next tick under a different key; then surfaced; never a third', () => {
    const h = setup()
    const c = session(h, 'chroxy', 'c')
    W.author(h.world, c.sk, T0, { state: 'running', next: 'a' })
    ticks(h, 'chroxy', T0, 12)
    const cyc = invs(h, c.sk)
    assert.deepEqual(cyc.map((i) => [i.cycle, i.classification]), [[1, 'inconclusive'], [2, 'inconclusive']])
    assert.notEqual(cyc[0].id, cyc[1].id)
    assert.ok(attentionFor(h, c).open)
  })

  it('a session classified working that stops is rechecked: the row no longer says working; a new onset gets its two cycles', () => {
    const h = setup()
    const c = session(h, 'chroxy', 'c')
    W.author(h.world, c.sk, T0, { state: 'running', next: 'a' })
    W.turnStart(h.world, c.sk, T0 + 10 * MIN)
    let t = ticks(h, 'chroxy', T0, 5)
    W.turnEnd(h.world, c.sk, t + MIN)
    t = ticks(h, 'chroxy', t, 4)
    assert.deepEqual(classes(h, c.sk), ['1:working_unreported', 'R:working_unreported', 'R:no_longer_observed', '1:finished_unreported'])
    const onsets = invs(h, c.sk).filter((i) => i.trigger !== 'recheck').map((i) => i.onset)
    assert.equal(new Set(onsets).size, 2, 'no_longer_observed starts a new onset')
    // Every classification is recorded with the time it was made.
    assert.ok(h.records('investigation').filter((r) => r.body.phase === 'close').every((r) => typeof r.body.classified_at === 'number'))
  })

  it('the same turn seen in flight at two consecutive rechecks makes two activity records, neither refused', () => {
    const h = setup()
    const c = session(h, 'chroxy', 'c')
    W.author(h.world, c.sk, T0, { state: 'running', next: 'a' })
    W.turnStart(h.world, c.sk, T0 + 10 * MIN)
    ticks(h, 'chroxy', T0, 7)
    assert.ok(h.records('activity').filter((r) => r.body.basis === 'busy_now_turn').length >= 2)
    assert.equal(h.conflicts().length, 0)
  })

  it('a stale line explained by a pending prompt is rechecked, and surfaced once the prompt is answered and nothing explains it', () => {
    const run = (policy) => {
      const h = setup({}, policy)
      const c = session(h, 'chroxy', 'c')
      W.author(h.world, c.sk, T0, { state: 'blocked', blocked_on: 'waiting on CI' })
      const ref = W.raisePrompt(h.world, c.sk, T0 + 4 * 60 * MIN, 3600)
      let t = ticks(h, 'chroxy', T0, 18)
      W.answerPrompt(h.world, c.sk, ref, t + MIN)
      t = ticks(h, 'chroxy', t, 12)
      return { h, c }
    }
    const model = run()
    assert.ok(attentionFor(model.h, model.c)?.open, 'the model surfaces it')
    const literal = run(LITERAL.noRecheckAfterOwnerWait.policy)
    assert.equal(attentionFor(literal.h, literal.c), undefined, 'gap witness: read literally, never surfaced')
  })

  it('five stale sessions with a cycle budget of three: three this tick, two the next, never two open for one session', () => {
    const h = setup({ investigation_budget_per_tick: 3 })
    const ss = ['a', 'b', 'c', 'd', 'e'].map((id) => session(h, 'chroxy', id))
    ss.forEach((x, i) => W.author(h.world, x.sk, T0 + i * 1000, { state: 'running', next: 'a' }))
    let t = ticks(h, 'chroxy', T0, 3)
    t += CAD * MIN
    h.tick('chroxy', t)
    const first = h.records('investigation').filter((r) => r.body.phase === 'open' && r.body.cycle === 1).length
    t += CAD * MIN
    h.tick('chroxy', t)
    const firsts = h.records('investigation').filter((r) => r.body.phase === 'open' && r.body.cycle === 1).length
    assert.equal(first, 3)
    assert.equal(firsts, 5)
  })

  it('three sessions under recheck do not keep a fourth, newly stale, from its first cycle (and the mutation does)', () => {
    const run = (policy) => {
      const h = setup({ investigation_budget_per_tick: 3 }, policy)
      const busy = ['a', 'b', 'c'].map((id) => session(h, 'chroxy', id))
      busy.forEach((x) => {
        W.author(h.world, x.sk, T0, { state: 'running', next: 'a' })
        W.turnStart(h.world, x.sk, T0 + MIN)
      })
      const d = session(h, 'chroxy', 'd')
      W.author(h.world, d.sk, T0 + 30 * MIN, { state: 'running', next: 'a' })
      ticks(h, 'chroxy', T0, 10)
      return invs(h, d.sk).filter((i) => i.cycle === 1).length
    }
    assert.equal(run(), 1)
    assert.equal(run(MUTANTS.I7d), 0)
  })

  it('a recheck that finds nothing after both ordinary cycles were used on an earlier onset: new onset, two cycles, surfaced', () => {
    const h = setup()
    const c = session(h, 'chroxy', 'c')
    W.author(h.world, c.sk, T0, { state: 'running', next: 'a' })
    let t = ticks(h, 'chroxy', T0, 4)
    h.world.sessions[c.sk].background = true
    t = ticks(h, 'chroxy', t, 2)
    h.world.sessions[c.sk].background = false
    ticks(h, 'chroxy', t, 3)
    assert.deepEqual(classes(h, c.sk), ['1:inconclusive', '2:waiting_on_background', 'R:waiting_on_background', 'R:no_longer_observed', '1:inconclusive', '2:inconclusive'])
    const onsets = invs(h, c.sk).filter((i) => i.trigger !== 'recheck').map((i) => i.onset)
    assert.equal(new Set(onsets).size, 2)
    assert.ok(attentionFor(h, c).open)
  })
})

describe('disappearance and outages', () => {
  it('a session that disappears is gone only after a second confirming read', () => {
    const h = setup()
    const c = session(h, 'chroxy', 'c')
    W.author(h.world, c.sk, T0, { state: 'running', next: 'a' })
    let t = ticks(h, 'chroxy', T0, 1)
    h.world.sessions[c.sk].listed = false
    ticks(h, 'chroxy', t, 1)
    const inv = invs(h, c.sk)[0]
    assert.equal(inv.classification, 'gone')
    const reads = h.records('check').filter((r) => r.body.trigger === 'investigation')
    assert.equal(reads.length, 2, 'the re-read and the confirming read')
    assert.ok(h.item(itemIds.gone(c.s)).open)
  })

  it('a re-read that fails, its retry and the confirming read in one investigation: three distinct check keys, no conflict', () => {
    const h = setup()
    const c = session(h, 'chroxy', 'c')
    W.author(h.world, c.sk, T0, { state: 'running', next: 'a' })
    let t = ticks(h, 'chroxy', T0, 1)
    h.world.sessions[c.sk].listed = false
    let n = 0
    const failFirst = (a) => ({ ...a, reread: (s) => (n++ === 0 ? { outcome: 'error', error_code: 'timeout' } : a.reread(s)) })
    t += CAD * MIN
    h.tick('chroxy', t, { reads: failFirst })
    const reads = h.records('check').filter((r) => r.body.trigger === 'investigation')
    assert.equal(reads.length, 3)
    assert.equal(new Set(reads.map((r) => r.id)).size, 3)
    assert.equal(h.conflicts().length, 0)
  })

  it('a re-read that fails and a retry that sees a turn in flight: the retry\'s native state is the activity evidence, working_unreported', () => {
    const h = setup()
    const c = session(h, 'chroxy', 'c')
    W.author(h.world, c.sk, T0, { state: 'running', next: 'a' })
    let t = ticks(h, 'chroxy', T0, 3)
    // The tick's own read sees no turn; the re-read fails; its retry sees one.
    let n = 0
    const retrySeesTurn = (a) => ({
      ...a,
      reread: (s, now) => {
        if (n++ === 0) return { outcome: 'error', error_code: 'timeout' }
        const r = a.reread(s, now)
        return { ...r, native: { ...r.native, turn_in_flight: true, answering_now: true } }
      },
    })
    t += CAD * MIN
    h.tick('chroxy', t, { reads: retrySeesTurn })
    const inv = invs(h, c.sk)
    assert.equal(inv.length, 1)
    assert.equal(inv[0].classification, 'working_unreported')
    const rungs = h.records('investigation').find((r) => r.body.phase === 'close').body.rungs.map((x) => `${x.rung}:${x.outcome}`)
    assert.deepEqual(rungs, ['re_read:error', 're_read:ok', 'activity_read:read', 'classify:working_unreported'])
  })

  it('dropped, gone, listed again, dropped again: two episodes of the gone item; the stale item is withdrawn as superseded each time', () => {
    const h = setup()
    const d = session(h, 'claude-desktop', 'd', null)
    W.author(h.world, d.sk, T0, { state: 'running', next: 'a' })
    let t = ticks(h, 'claude-desktop', T0, 6)
    const att = attentionFor(h, d)
    assert.ok(att.open)
    h.world.sessions[d.sk].listed = false
    t = ticks(h, 'claude-desktop', t, 1)
    assert.equal(h.surface(att.itemId).find((r) => r.body.step === 'withdrawn')?.body.reason, 'superseded')
    h.world.sessions[d.sk].listed = true
    t = ticks(h, 'claude-desktop', t, 1)
    assert.equal(h.item(itemIds.gone(d.s)).state, 'closed')
    h.world.sessions[d.sk].listed = false
    ticks(h, 'claude-desktop', t, 1)
    assert.equal(h.item(itemIds.gone(d.s)).episode, 2)
  })

  it('every session of a source unreadable: one outage item, not one per session; three outages are three episodes', () => {
    const h = setup()
    const a = session(h, 'chroxy', 'a')
    const b = session(h, 'chroxy', 'b')
    W.author(h.world, a.sk, T0, { state: 'running', next: 'a' })
    W.author(h.world, b.sk, T0, { state: 'running', next: 'b' })
    let t = ticks(h, 'chroxy', T0, 1)
    const id = itemIds.outage('chroxy')
    for (let k = 1; k <= 3; k++) {
      h.world.sources.chroxy.up = false
      t = ticks(h, 'chroxy', t, 3)
      assert.ok(h.item(id).open)
      assert.equal(h.item(id).episode, k)
      h.world.sources.chroxy.up = true
      t = ticks(h, 'chroxy', t, 1)
      assert.equal(h.item(id).state, 'closed')
    }
    assert.equal(h.openItems().filter((i) => i.origin === 'attention').length, 0)
    assert.equal(h.sendsFor(id).filter((s) => s.step === 'shown').length, 3)
  })

  it('a session whose only declaration is an api write of running, and which is dead, is surfaced after two cycles', () => {
    const h = setup()
    const c = session(h, 'chroxy', 'c')
    W.relayedWrite(h.world, c.sk, T0, 'running')
    ticks(h, 'chroxy', T0, 6)
    assert.equal(h.lastCheck(c.sk).freshnessReason, 'relayed_declaration')
    const cyc = invs(h, c.sk).filter((i) => i.trigger === 'stale_report')
    assert.equal(cyc.length, 2)
    assert.ok(h.openItems().some((i) => i.origin === 'attention'))
  })

  it('a dismissed attention item raised by a recheck stays dismissed until a new onset', () => {
    const h = setup()
    const c = session(h, 'chroxy', 'c')
    W.author(h.world, c.sk, T0, { state: 'running', next: 'a' })
    h.world.sessions[c.sk].background = true
    let t = ticks(h, 'chroxy', T0, 8)
    const att = attentionFor(h, c)
    assert.ok(att.open)
    h.owner(att.itemId, 'dismiss', 'm1', { at: t + MIN })
    t = ticks(h, 'chroxy', t, 6)
    assert.equal(h.item(att.itemId).episode, 1)
    assert.ok(!h.item(att.itemId).open)
  })

})
