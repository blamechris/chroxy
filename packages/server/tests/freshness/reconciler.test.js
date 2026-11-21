import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { makeConfig } from './model/config.js'
import { checkTickKey, itemIds, sessionKey, tickId } from './model/keys.js'
import { foldRecord } from './model/derive.js'
import { append } from './model/ledger.js'
import { checkStep, createMonitor } from './helpers/invariants.js'
import { DEFAULT_POLICY } from './model/policy.js'
import { planConfig, restoreModel, run } from './model/reconciler.js'
import { Crash, HOUR, MIN, OWNER, T0, createHarness } from './helpers/harness.js'
import * as W from './helpers/world.js'

function setup(over = {}) {
  return createHarness({ config: { per_source: { chroxy: 15, codex: 15, 'claude-desktop': 15 }, ...over } })
}
function session(h, source, id, scope = 'repo', incarnation = 't0') {
  const sk = W.addSession(h.world, { source, native_id: id, scope, incarnation })
  return { sk, s: h.world.sessions[sk].session }
}
const tickChecks = (h, sk) => h.records('check').filter((r) => r.body.trigger === 'tick' && sessionKey(r.session) === sk)

describe('reports and checks', () => {
  it('a running report: last_report_at identical in every check; freshness fresh, aging, aging, stale; never bare running', () => {
    const h = setup()
    const c = session(h, 'chroxy', 'c')
    W.author(h.world, c.sk, T0, { state: 'running', next: 'a' })
    for (const m of [15, 30, 45, 60]) h.tick('chroxy', T0 + m * MIN)
    const cs = tickChecks(h, c.sk)
    assert.deepEqual(cs.map((r) => r.body.freshness), ['fresh', 'aging', 'aging', 'stale'])
    assert.equal(new Set(cs.map((r) => r.body.last_report_at)).size, 1)
    assert.ok(cs.every((r) => r.body.report_age_s != null && r.body.freshness), 'every check carries its age and freshness')
  })

  it('forty checks of one unchanged report: one report record, forty checks, the time never moves', () => {
    const h = setup()
    const x = session(h, 'codex', 'x')
    W.author(h.world, x.sk, T0, { state: 'idle' })
    for (let k = 1; k <= 40; k++) h.tick('codex', T0 + k * 15 * MIN)
    assert.equal(h.records('report').length, 1)
    assert.equal(tickChecks(h, x.sk).length, 40)
  })

  it('a new line is a new report with its own host time; a touch with no new message is none', () => {
    const h = setup()
    const x = session(h, 'codex', 'x')
    W.author(h.world, x.sk, T0, { state: 'running', next: 'a' })
    h.tick('codex', T0 + 15 * MIN)
    h.tick('codex', T0 + 30 * MIN)
    assert.equal(h.records('report').length, 1)
    W.author(h.world, x.sk, T0 + 40 * MIN, { state: 'running', next: 'b' })
    h.tick('codex', T0 + 45 * MIN)
    const reps = h.records('report')
    assert.equal(reps.length, 2)
    assert.equal(reps[1].body.last_report_at, T0 + 40 * MIN)
    assert.equal(tickChecks(h, x.sk).at(-1).body.freshness, 'fresh')
  })

  it('an identical line re-authored on a changed-at source: no new report, the age is not understated, no false fresh', () => {
    const h = setup()
    const c = session(h, 'chroxy', 'c')
    W.author(h.world, c.sk, T0, { state: 'running', next: 'a' })
    for (let k = 1; k <= 5; k++) {
      W.author(h.world, c.sk, T0 + k * 15 * MIN - MIN, { state: 'running', next: 'a' })
      h.tick('chroxy', T0 + k * 15 * MIN)
    }
    const rep = h.records('report')
    assert.equal(rep.length, 1)
    assert.equal(rep[0].body.report_time_basis, 'changed_at')
    assert.equal(tickChecks(h, c.sk).at(-1).body.freshness, 'stale')
  })

  it('no status line: state none, freshness unknown, never idle', () => {
    const h = setup()
    const x = session(h, 'codex', 'x')
    h.tick('codex', T0 + 15 * MIN)
    const b = tickChecks(h, x.sk)[0].body
    assert.deepEqual([b.state, b.freshness, b.freshness_reason], ['none', 'unknown', 'no_status_line'])
  })

  it('a time-out, then a parse failure: freshness error with the right code each time; the last good report keeps its own age', () => {
    const h = setup()
    const x = session(h, 'codex', 'x')
    W.author(h.world, x.sk, T0, { state: 'running', next: 'a' })
    h.tick('codex', T0 + 15 * MIN)
    const codes = ['timeout', 'parse_failed']
    codes.forEach((code, i) => h.tick('codex', T0 + (30 + i * 15) * MIN, { reads: (a) => ({ ...a, read: () => ({ outcome: 'error', error_code: code }) }) }))
    const cs = tickChecks(h, x.sk)
    assert.deepEqual(cs.slice(1).map((r) => [r.body.freshness, r.body.error_code]), [['error', 'timeout'], ['error', 'parse_failed']])
    const s = h.ctx.state.sessions.get(x.sk)
    assert.equal(h.ctx.state.reports.get(s.latestAuthored).body.last_report_at, T0)
  })

  it('a read that needs a credential: freshness blocked with credential_required', () => {
    const h = setup()
    const x = session(h, 'codex', 'x')
    h.world.sessions[x.sk].blockedRead = true
    h.tick('codex', T0 + 15 * MIN)
    const b = tickChecks(h, x.sk)[0].body
    assert.deepEqual([b.freshness, b.not_read_reason], ['blocked', 'credential_required'])
  })

  it('an api declaration of running written now for a session whose own line is three hours old is unknown, never fresh', () => {
    const h = setup()
    const c = session(h, 'chroxy', 'c')
    W.author(h.world, c.sk, T0, { state: 'running', next: 'a' })
    W.relayedWrite(h.world, c.sk, T0 + 3 * HOUR, 'running')
    h.tick('chroxy', T0 + 3 * HOUR + MIN)
    const b = tickChecks(h, c.sk)[0].body
    assert.deepEqual([b.freshness, b.freshness_reason], ['unknown', 'relayed_declaration'])
    const rep = h.ctx.state.reports.get(b.report_id).body
    assert.deepEqual([rep.declared_via, rep.evidence_class], ['api', 'E5'])
    const s = h.ctx.state.sessions.get(c.sk)
    assert.equal(s.latestAuthored, null, 'a relayed line is not the latest authored report')
  })

  it('a host time that cannot be trusted writes no report: one check, unknown, time_untrusted', () => {
    const h = setup()
    const x = session(h, 'codex', 'x')
    W.author(h.world, x.sk, T0, { state: 'running', next: 'a' })
    h.world.sessions[x.sk].untrusted = true
    h.tick('codex', T0 + 15 * MIN)
    assert.equal(h.records('report').length, 0)
    const b = tickChecks(h, x.sk)[0].body
    assert.deepEqual([b.freshness, b.freshness_reason], ['unknown', 'time_untrusted'])
  })

  it('host clock stepped back so the report is later than the check: clock_skew, no negative age, no fresh', () => {
    const h = setup()
    const x = session(h, 'codex', 'x')
    W.author(h.world, x.sk, T0 + 30 * MIN, { state: 'running', next: 'a' })
    h.tick('codex', T0 + 15 * MIN)
    const b = tickChecks(h, x.sk)[0].body
    assert.deepEqual([b.freshness, b.error_code], ['error', 'clock_skew'])
    assert.equal(b.report_age_s, null)
  })

  it('a session rewound to an older line: a report_regressed record; the older report is the report, with its own age', () => {
    const h = setup()
    const x = session(h, 'codex', 'x')
    W.author(h.world, x.sk, T0, { state: 'running', next: 'a' })
    W.author(h.world, x.sk, T0 + 10 * MIN, { state: 'running', next: 'b' })
    h.tick('codex', T0 + 15 * MIN)
    W.rewind(h.world, x.sk, 0)
    h.tick('codex', T0 + 30 * MIN)
    assert.equal(h.records('system').filter((r) => r.body.event === 'report_regressed').length, 1)
    assert.equal(tickChecks(h, x.sk).at(-1).body.last_report_at, T0)
  })

  it('a renamed session keeps its keys; a reused id with a new creation time is another identity and inherits nothing', () => {
    const h = setup()
    const a = session(h, 'codex', 'same-id', 'repo', 't0')
    W.author(h.world, a.sk, T0, { state: 'blocked', blocked_on: 'approve', owner: OWNER })
    h.tick('codex', T0 + 15 * MIN)
    h.world.sessions[a.sk].listed = false
    const b = session(h, 'codex', 'same-id', 'repo', 't1')
    W.author(h.world, b.sk, T0 + 20 * MIN, { state: 'running', next: 'go' })
    h.tick('codex', T0 + 30 * MIN)
    assert.notEqual(a.sk, b.sk)
    assert.ok(h.item(itemIds.owner(a.s)).open, 'the old session\'s item is not resolved by the new one')
    assert.equal(h.item(itemIds.owner(b.s)), undefined)
  })
})

describe('events from a host that numbers them per session', () => {
  it('two sessions whose first events both have id 1 each keep their event; nothing is dropped or in conflict', () => {
    const h = createHarness({ config: { per_source: { chroxy: 15 } }, world: W.createWorld({ perSessionIds: true }) })
    const a = session(h, 'chroxy', 'a')
    const b = session(h, 'chroxy', 'b')
    W.author(h.world, a.sk, T0, { state: 'running', next: 'a' })
    W.author(h.world, b.sk, T0, { state: 'running', next: 'b' })
    W.turnStart(h.world, a.sk, T0 + MIN)
    W.turnStart(h.world, b.sk, T0 + 2 * MIN)
    assert.equal(h.world.sessions[a.sk].events[0].id, h.world.sessions[b.sk].events[0].id)
    h.tick('chroxy', T0 + 15 * MIN)
    const ev = h.records('activity').filter((r) => r.body.basis === 'open_turn_event_after_report')
    assert.deepEqual(ev.map((r) => r.session.native_id).sort(), ['a', 'b'])
    assert.equal(h.conflicts().length, 0)
  })
})

describe('a key that already holds a different record', () => {
  it('a host that reuses an event id within one session for a different event: recorded as a conflict, not dropped', () => {
    const h = createHarness({ config: { per_source: { chroxy: 15 } } })
    const c = session(h, 'chroxy', 'c')
    W.author(h.world, c.sk, T0, { state: 'running', next: 'a' })
    const w = h.world.sessions[c.sk]
    w.events.push({ id: '7', basis: 'open_turn_event_after_report', activity_at: T0 + MIN, ref: null })
    h.tick('chroxy', T0 + 15 * MIN)
    assert.equal(h.conflicts().length, 0, 'the same event seen again is skipped')
    h.tick('chroxy', T0 + 30 * MIN)
    assert.equal(h.conflicts().length, 0)
    w.events.push({ id: '7', basis: 'turn_ended_after_report', activity_at: T0 + 35 * MIN, ref: null })
    h.tick('chroxy', T0 + 45 * MIN)
    assert.equal(h.conflicts().length, 1, 'a different event under the same key reaches append()')
  })

  it('a record of another kind planted under a tick check\'s key: the read is made and the collision recorded', () => {
    const h = createHarness({ config: { per_source: { codex: 15 } } })
    const x = session(h, 'codex', 'x')
    W.author(h.world, x.sk, T0, { state: 'running', next: 'a' })
    const at = T0 + 15 * MIN
    const key = checkTickKey(tickId(h.ctx.ledger.ledgerId, 'codex', h.slotFor('codex', at)), x.s)
    const planted = append(h.ctx.ledger, { kind: 'report', id: key, session: x.s, body: { planted: true } }, T0)
    foldRecord(h.ctx.state, planted.record)
    h.tick('codex', at)
    assert.equal(h.conflicts().length, 1, 'the planted record is not mistaken for the check')
  })
})

describe('relayed declarations stamped ahead of the clock', () => {
  it('a relayed write stamped beyond the skew limit is unknown (relayed), not error, and the monitor agrees', () => {
    const h = createHarness({ config: { per_source: { chroxy: 15 } } })
    const c = session(h, 'chroxy', 'c')
    W.relayedWrite(h.world, c.sk, T0 + 30 * MIN, 'running')
    const mon = createMonitor({ config: h.ctx.state.config, firstCycleBound: 100, surfaceBound: 100 })
    h.tick('chroxy', T0 + 15 * MIN)
    checkStep(mon, h)
    const b = tickChecks(h, c.sk)[0].body
    assert.deepEqual([b.outcome, b.freshness, b.freshness_reason], ['ok', 'unknown', 'relayed_declaration'])
  })
})

describe('ticks and configuration', () => {
  it('host asleep across six slots: one catch-up tick with missed_slots 6, nothing back-filled', () => {
    const h = setup()
    session(h, 'codex', 'x')
    h.tick('codex', T0 + 15 * MIN)
    h.tick('codex', T0 + 8 * 15 * MIN)
    const ticks = h.records('tick').filter((r) => r.body.phase === 'open')
    assert.equal(ticks.length, 2)
    assert.equal(ticks[1].body.missed_slots, 6)
  })

  it('two sources at 15 and 30 minutes keep their own slots and tick keys; a skipped pair of slots is counted', () => {
    const h = setup({ per_source: { chroxy: 15, codex: 30 } })
    session(h, 'chroxy', 'c')
    session(h, 'codex', 'x')
    h.tick('chroxy', T0)
    h.tick('codex', T0)
    h.tick('chroxy', T0 + 45 * MIN)
    h.tick('codex', T0 + 90 * MIN)
    const open = h.records('tick').filter((r) => r.body.phase === 'open')
    assert.deepEqual(open.map((r) => [r.body.source, r.body.missed_slots]), [['chroxy', 0], ['codex', 0], ['chroxy', 2], ['codex', 2]])
    assert.equal(new Set(open.map((r) => r.body.tick_id)).size, 4)
  })

  it('cadence 15, then 30, then 40: a config record each time, then back to A and to B again is four records; no stored time altered', () => {
    const h = setup()
    const x = session(h, 'codex', 'x')
    W.author(h.world, x.sk, T0, { state: 'running', next: 'a' })
    h.tick('codex', T0 + 15 * MIN)
    const before = JSON.stringify(h.records('report').map((r) => r.body.last_report_at))
    const A = makeConfig({ owner_name: OWNER, cadence_minutes: 30 })
    const B = makeConfig({ owner_name: OWNER, cadence_minutes: 40 })
    for (const c of [A, B, A, B]) run(h.ctx, planConfig(h.ctx, { config: c, now: T0 + HOUR }))
    assert.equal(h.records('config').length, 5, 'the initial one and four changes')
    assert.equal(JSON.stringify(h.records('report').map((r) => r.body.last_report_at)), before)
  })

  it('raising stale_after while a report is stale, under investigation and surfaced: re-graded under the new config_ref; nothing closed', () => {
    const h = createHarness({ config: { per_source: { 'claude-desktop': 15 } } })
    const d = session(h, 'claude-desktop', 'd', null)
    W.author(h.world, d.sk, T0, { state: 'running', next: 'a' })
    for (let k = 1; k <= 6; k++) h.tick('claude-desktop', T0 + k * 15 * MIN)
    const att = [...h.ctx.state.items.values()].find((i) => i.origin === 'attention')
    assert.ok(att?.open)
    const raised = makeConfig({ owner_name: OWNER, per_source: { 'claude-desktop': 15 }, freshness: { ...h.config.freshness, running: { fresh_max_s: 1200, stale_after_s: 6 * 3600 } } })
    run(h.ctx, planConfig(h.ctx, { config: raised, now: T0 + 95 * MIN }))
    h.tick('claude-desktop', T0 + 105 * MIN)
    const last = tickChecks(h, d.sk).at(-1).body
    assert.equal(last.freshness, 'aging')
    assert.equal(last.config_ref, h.ctx.state.configRef)
    assert.ok(h.item(att.itemId).open, 'a re-grade does not close the item')
  })
})

describe('crash and replay', () => {
  function busyWorld() {
    const h = setup()
    const c = session(h, 'chroxy', 'c')
    const x = session(h, 'codex', 'x')
    W.author(h.world, c.sk, T0, { state: 'blocked', blocked_on: 'approve', owner: OWNER })
    W.author(h.world, x.sk, T0, { state: 'running', next: 'a' })
    for (let k = 0; k < 3; k++) W.raisePrompt(h.world, c.sk, T0 + k * MIN, 7200)
    return { h, c, x }
  }

  it('killed at every operation of every tick and restarted: the slot\'s tick id is reused; nothing is written or sent twice', () => {
    let crashes = 0
    for (let k = 0; k < 8; k++) {
      for (let n = 0; ; n++) {
        const { h } = busyWorld()
        let crashed = false
        for (let m = 0; m < 8; m++) {
          const at = T0 + (m + 1) * 15 * MIN
          try {
            h.tick('chroxy', at, { crashAfter: m === k ? n : Infinity })
          } catch (e) {
            if (!(e instanceof Crash)) throw e
            crashed = true
            h.restart()
            // The replay happens a few minutes later, inside the same slot.
            h.tick('chroxy', at + 3 * MIN, { slotStart: h.slotFor('chroxy', at) })
          }
        }
        assert.equal(h.conflicts().length, 0, `tick ${k}, crash at op ${n}`)
        const sent = h.sends.map((s) => s.attempt_id)
        assert.equal(new Set(sent).size, sent.length, `no second send: tick ${k}, op ${n}`)
        const opens = h.records('tick').filter((r) => r.body.phase === 'open').map((r) => r.body.tick_id)
        assert.equal(new Set(opens).size, opens.length)
        if (!crashed) break
        crashes += 1
      }
    }
    assert.ok(crashes > 50, `${crashes} crash points exercised`)
  })

  it('a crash between a read\'s records never leaves a check without its activity (the check is the commit point)', () => {
    for (let n = 0; n < 12; n++) {
      const { h, c } = busyWorld()
      try {
        h.tick('chroxy', T0 + 15 * MIN, { crashAfter: n })
      } catch (e) {
        if (!(e instanceof Crash)) throw e
      }
      h.restart()
      h.tick('chroxy', T0 + 20 * MIN, { slotStart: h.slotFor('chroxy', T0 + 15 * MIN) })
      const check = tickChecks(h, c.sk)[0]
      const pend = h.records('activity').filter((r) => r.body.check_id === check.id && r.body.basis === 'pending_permission')
      assert.equal(pend.length, 3, `crash at op ${n}`)
      assert.equal(h.conflicts().length, 0)
    }
  })

  it('a process idle since start takes over after another wrote a shown attempt and died: it reads the ledger to its tail and sends nothing', () => {
    const { h } = busyWorld()
    let n = 0
    for (; n < 60; n++) {
      const { h: p } = busyWorld()
      try {
        p.tick('chroxy', T0 + 15 * MIN, { crashAfter: n })
      } catch (e) {
        if (!(e instanceof Crash)) throw e
        if (p.records('surface').some((r) => r.body.phase === 'attempt')) break
      }
    }
    assert.throws(() => h.tick('chroxy', T0 + 15 * MIN, { crashAfter: n }), Crash)
    const sendsBefore = h.sends.length
    // B catches up: its state is rebuilt from the whole ledger before any effect.
    h.ctx = restoreModel({ ledgerId: h.ctx.ledger.ledgerId, records: h.ctx.ledger.records, policy: DEFAULT_POLICY })
    h.tick('chroxy', T0 + 16 * MIN, { slotStart: h.slotFor('chroxy', T0 + 15 * MIN) })
    assert.equal(h.sends.length, sendsBefore)
    assert.equal(h.records('system').filter((r) => r.body.event === 'delivery_unknown').length, 1)
  })
})
