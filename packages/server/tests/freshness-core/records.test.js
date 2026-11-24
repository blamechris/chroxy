/**
 * The key table and the rules under "Reports, checks and freshness"
 * (tests/freshness/README.md), against the real implementation, for the
 * record kinds the core writes: report, tick, check, activity, config and
 * system. Each guard has a mutant that must fail its check.
 */

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { FIXTURE_CAPS, HOUR, MIN, REAL, STATE_SOURCE, T0, cleanupTmp, cleanupVariants, entry, fixtureAdapter, fixtureSession, must, rig, mustKill } from './helpers/harness.js'

afterEach(() => cleanupTmp())
process.on('exit', cleanupVariants)

const proves = (name, check, mutants = {}) =>
  describe(name, () => {
    it('holds on the real code', async () => {
      await check(REAL)
    })
    for (const [label, edits] of Object.entries(mutants)) it(`mutant "${label}" fails it`, () => mustKill(check, label, edits))
  })

const { H, keys } = REAL
const S1 = { source: STATE_SOURCE, native_id: 's1', incarnation: null }
const RUNNING_FIELDS = { state: 'running', next: 'build', declared_blocked_on: null, decision: null, decision_basis: 'none', declared_via: 'marker', owner_named: null, seed_ref: null }

const edit = (file, from, to) => ({ file, from, to })

// ── report ─────────────────────────────────────────────────────────────
proves(
  'report: one record for one report however many times it is read (key H(session, report time, fields hash))',
  (M) => {
    const r = rig(M)
    r.writeState([entry('s1', { state: 'running', next: 'build', updatedAt: T0 - 5 * MIN })])
    r.ticks([T0, T0 + 30 * MIN, T0 + 60 * MIN, T0 + 90 * MIN, T0 + 120 * MIN])
    const reports = r.kinds('report')
    assert.equal(reports.length, 1, 'five reads of one report must write one report record')
    assert.equal(reports[0].id, keys.reportKey(S1, T0 - 5 * MIN, H(RUNNING_FIELDS)))
    assert.equal(r.kinds('check', (x) => x.body.trigger === 'tick').length, 5, 'each read is still a check')
    assert.equal(r.kinds('system', (x) => x.body.event === 'idempotency_conflict').length, 0)
  },
  {
    'the key includes something that changes per read': [edit('keys.js', 'return H(sessionIdentity(session), reportTime, fieldsHash)', 'return H(sessionIdentity(session), reportTime, fieldsHash, Math.random())')],
  },
)

proves(
  'report: two sessions with the same time and fields are two reports; same time, other fields is another report, not a conflict',
  (M) => {
    const r = rig(M)
    const at = T0 - 5 * MIN
    r.writeState([entry('s1', { state: 'running', updatedAt: at }), entry('s2', { state: 'running', updatedAt: at })])
    r.ticks([T0])
    assert.equal(r.kinds('report').length, 2, 'the session is part of the key')
    r.writeState([entry('s1', { state: 'running', next: 'other', updatedAt: at }), entry('s2', { state: 'running', updatedAt: at })])
    r.ticks([T0 + 30 * MIN])
    assert.equal(r.kinds('report').length, 3, 'the fields hash is part of the key')
    assert.equal(r.kinds('system', (x) => x.body.event === 'idempotency_conflict').length, 0)
  },
  {
    'the session is left out of the key': [edit('keys.js', 'return H(sessionIdentity(session), reportTime, fieldsHash)', 'return H(reportTime, fieldsHash)')],
    'the fields hash is left out of the key': [edit('keys.js', 'return H(sessionIdentity(session), reportTime, fieldsHash)', 'return H(sessionIdentity(session), reportTime)')],
  },
)

// ── tick ───────────────────────────────────────────────────────────────
proves(
  'tick: id H(ledger, source, slot start); open and close keyed by phase; a closed slot is not run again',
  (M) => {
    const r = rig(M)
    r.writeState([entry('s1', { state: 'running', updatedAt: T0 - MIN })])
    const rec = r.open()
    const first = rec.tick({ source: STATE_SOURCE, slotStart: T0, now: T0 })
    assert.equal(first.tickId, keys.tickId('ledger-test', STATE_SOURCE, T0))
    const again = rec.tick({ source: STATE_SOURCE, slotStart: T0, now: T0 + MIN })
    assert.equal(again.skipped, 'closed')
    const next = rec.tick({ source: STATE_SOURCE, slotStart: T0 + 30 * MIN, now: T0 + 30 * MIN })
    rec.close()
    assert.notEqual(next.tickId, first.tickId, 'another slot is another tick')
    const ticks = r.kinds('tick')
    assert.deepEqual(ticks.map((t) => t.id), [keys.tickKey(first.tickId, 'open'), keys.tickKey(first.tickId, 'close'), keys.tickKey(next.tickId, 'open'), keys.tickKey(next.tickId, 'close')])
    assert.equal(r.kinds('check').length, 2, 'the skipped slot read nothing')
  },
  {
    'the slot start is left out of the tick id': [edit('keys.js', 'return H(ledgerId, source, slotStart)', 'return H(ledgerId, source)')],
    'the phase is left out of the tick key': [edit('keys.js', 'export function tickKey(id, phase) {\n  return H(id, phase)', 'export function tickKey(id, phase) {\n  return H(id)')],
    'a closed slot runs again': [edit('core.js', "if (st.ticks.get(tid)?.closed) return { skipped: 'closed', tickId: tid }", '')],
  },
)

// ── check ──────────────────────────────────────────────────────────────
proves(
  'check: one per session per tick, keyed H(tick id, session)',
  (M) => {
    const r = rig(M)
    r.writeState([entry('s1', { state: 'running', updatedAt: T0 - MIN }), entry('s2', { state: 'done', updatedAt: T0 - MIN })])
    const res = r.ticks([T0])
    const checks = r.kinds('check')
    assert.equal(checks.length, 2)
    for (const id of ['s1', 's2']) {
      assert.ok(checks.some((c) => c.id === keys.checkTickKey(res.tickId, { source: STATE_SOURCE, native_id: id, incarnation: null })), `check for ${id}`)
    }
    assert.equal(r.kinds('system', (x) => x.body.event === 'idempotency_conflict').length, 0)
  },
  { 'the session is left out of the check key': [edit('keys.js', 'return H(id, sessionIdentity(session))', 'return H(id)')] },
)

// ── freshness grading ──────────────────────────────────────────────────
function gradeAt(M, ageMs, { state = 'running', checkAt = T0 } = {}) {
  const r = rig(M)
  r.writeState([entry('s1', { state, updatedAt: checkAt - ageMs })])
  r.ticks([checkAt])
  return r.kinds('check')[0].body
}

proves(
  'freshness: age is check time minus report time, fresh at most fresh_max, stale above stale_after, exactly stale_after is aging',
  (M) => {
    const f = (ms, o) => gradeAt(M, ms, o).freshness
    assert.equal(f(20 * MIN), 'fresh', 'exactly fresh_max is fresh')
    assert.equal(f(20 * MIN + 1), 'aging')
    assert.equal(f(45 * MIN), 'aging', 'exactly stale_after is aging')
    assert.equal(f(45 * MIN + 1), 'stale')
    assert.equal(f(4 * HOUR, { state: 'idle' }), 'fresh')
    assert.equal(f(4 * HOUR + 1, { state: 'idle' }), 'aging')
    assert.equal(f(24 * HOUR + 1, { state: 'done' }), 'stale')
    assert.equal(f(60 * MIN, { state: 'blocked' }), 'fresh')
    assert.equal(f(4 * HOUR + 1, { state: 'stalled' }), 'stale')
    const b = gradeAt(M, 10 * MIN)
    assert.equal(b.report_age_s, 600)
    assert.equal(b.checked_at, T0)
    assert.equal(b.last_report_at, T0 - 10 * MIN)
  },
  {
    'fresh_max is exclusive': [edit('grade.js', "if (ageMs <= row.fresh_max_s * 1000) return 'fresh'", "if (ageMs < row.fresh_max_s * 1000) return 'fresh'")],
    'stale_after is inclusive of stale': [edit('grade.js', "if (ageMs > row.stale_after_s * 1000) return 'stale'", "if (ageMs >= row.stale_after_s * 1000) return 'stale'")],
    'the age drifts by a millisecond': [edit('policy.js', 'reportAge: reportAgeMs,', 'reportAge: ({ lastReportAt, checkedAt }) => checkedAt - lastReportAt - 1,')],
  },
)

proves(
  'freshness: a check never moves the report time, so an unchanged report only gets older',
  (M) => {
    const r = rig(M)
    r.writeState([entry('s1', { state: 'running', updatedAt: T0 - 10 * MIN })])
    r.ticks([T0, T0 + 30 * MIN, T0 + 60 * MIN, T0 + 90 * MIN])
    const all = r.kinds('check').map((c) => c.body)
    const checks = all.filter((c) => c.trigger === 'tick')
    assert.deepEqual(checks.map((c) => c.freshness), ['fresh', 'aging', 'stale', 'stale'])
    assert.ok(all.every((c) => c.last_report_at === T0 - 10 * MIN), 'the report time is the report\'s, not the check\'s')
  },
  { 'a check refreshes the report': [edit('policy.js', 'reportAge: reportAgeMs,', 'reportAge: ({ lastReportAt, checkedAt, previousCheckedAt }) => checkedAt - (previousCheckedAt ?? lastReportAt),')] },
)

proves(
  'freshness: a report stamped later than the check is age zero inside the skew limit, error clock_skew beyond it, with no report record',
  (M) => {
    const inside = gradeAt(M, -120_000)
    assert.equal(inside.freshness, 'fresh', 'exactly the limit is not skew')
    assert.equal(inside.report_age_s, 0, 'no negative age is recorded')
    const r = rig(M)
    r.writeState([entry('s1', { state: 'running', updatedAt: T0 + 121_000 })])
    r.ticks([T0])
    const c = r.kinds('check')[0].body
    assert.equal(c.freshness, 'error')
    assert.equal(c.error_code, 'clock_skew')
    assert.equal(c.outcome, 'error', 'the outcome is error whatever the read found')
    assert.equal(c.report_id, null)
    assert.equal(r.kinds('report').length, 0, 'a line whose time cannot be trusted writes no report record')
  },
  {
    'the limit itself is skew': [edit('grade.js', 'if (input.lastReportAt - input.checkedAt > skewMs) {', 'if (input.lastReportAt - input.checkedAt >= skewMs) {')],
    'a skewed report is still recorded': [edit('checks.js', 'body.report_id = null\n      reportDraft = null', 'body.report_id = null')],
    'a skewed read keeps its outcome': [edit('checks.js', "body.outcome = 'error'\n      body.report_id = null", 'body.report_id = null')],
    'the age may be negative': [edit('grade.js', 'const ageMs = Math.max(0, ageFn(', 'const ageMs = (0, ageFn(')],
  },
)

function fixtureRig(M, answer, { config } = {}) {
  const r = rig(M)
  const a = fixtureAdapter('fixture', answer)
  const cfg = config ?? M.coreConfig({ sources: { fixture: FIXTURE_CAPS } })
  const tick = (at) => {
    const rec = r.open({ now: at, adapters: [a], config: cfg })
    try {
      return rec.tick({ source: 'fixture', slotStart: at, now: at })
    } finally {
      rec.close()
    }
  }
  return { r, tick }
}

proves(
  'freshness: a source clock off by more than the limit is error clock_skew, a read with no status line included, with no native state taken',
  (M) => {
    const okRead = (offset) => ({ outcome: 'ok', source_now: T0 + offset, report: { state: 'running', last_report_at: T0 - MIN, declared_via: 'transcript' }, native: { turn_in_flight: true } })
    const a = fixtureRig(M, { list: [fixtureSession('f1')], read: okRead(120_000) })
    a.tick(T0)
    assert.equal(a.r.kinds('check')[0].body.freshness, 'fresh', 'exactly the limit is not skew')
    const b = fixtureRig(M, { list: [fixtureSession('f1')], read: okRead(121_000) })
    b.tick(T0)
    const c = b.r.kinds('check')[0].body
    assert.equal(c.freshness, 'error')
    assert.equal(c.error_code, 'clock_skew')
    assert.equal(c.outcome, 'error')
    assert.equal(c.native_available, false, 'no native state is taken from a skewed read')
    assert.equal(b.r.kinds('activity').length, 0)
    const d = fixtureRig(M, { list: [fixtureSession('f1')], read: { outcome: 'no_report', source_now: T0 + 500_000 } })
    d.tick(T0)
    assert.equal(d.r.kinds('check')[0].body.error_code, 'clock_skew', 'a read with no status line is skew too')
  },
  {
    'the source limit itself is skew': [edit('grade.js', 'Math.abs(input.sourceNow - input.checkedAt) > skewMs', 'Math.abs(input.sourceNow - input.checkedAt) >= skewMs')],
    'native state is taken from a skewed read': [edit('checks.js', "const native = read.native && (body.outcome === 'ok' || body.outcome === 'no_report') ? read.native : null", 'const native = read.native ? read.native : null')],
  },
)

proves(
  'freshness: unknown for no status, error with its code, blocked with its reason, never shown as another value',
  (M) => {
    const f = fixtureRig(M, { list: [fixtureSession('a'), fixtureSession('b'), fixtureSession('c')], read: (s) => (s.native_id === 'a' ? { outcome: 'no_report' } : s.native_id === 'b' ? { outcome: 'error', error_code: 'timeout' } : { outcome: 'blocked', not_read_reason: 'credential_required' }) })
    f.tick(T0)
    const by = Object.fromEntries(f.r.kinds('check').map((c) => [c.session.native_id, c.body]))
    assert.equal(by.a.freshness, 'unknown')
    assert.equal(by.a.freshness_reason, 'no_status_line')
    assert.equal(by.b.freshness, 'error')
    assert.equal(by.b.error_code, 'timeout')
    assert.equal(by.c.freshness, 'blocked')
    assert.equal(by.c.not_read_reason, 'credential_required')
    for (const c of Object.values(by)) assert.equal(c.state, 'none', 'no state is invented')
    assert.equal(f.r.kinds('report').length, 0)
  },
  { 'an error is shown as unknown': [edit('grade.js', "return { ...out, freshness: 'error', errorCode: input.errorCode ?? 'adapter_fault' }", "return { ...out, freshness: 'unknown', errorCode: input.errorCode ?? 'adapter_fault' }")] },
)

proves(
  'freshness: a relayed declaration is recorded but never graded by age (unknown, relayed_declaration)',
  (M) => {
    const r = rig(M)
    r.writeState([entry('s1', { state: 'running', updatedAt: T0 - 10 * HOUR, source: 'api' }), entry('s2', { state: 'running', updatedAt: T0 - 10 * HOUR, source: 'hook' })])
    r.ticks([T0])
    for (const c of r.kinds('check')) {
      assert.equal(c.body.freshness, 'unknown')
      assert.equal(c.body.freshness_reason, 'relayed_declaration')
    }
    assert.deepEqual(r.kinds('report').map((x) => x.body.evidence_class), ['E5', 'E5'])
  },
  { 'a relayed declaration is graded by age': [edit('grade.js', "if (input.declaredVia === 'api' || input.declaredVia === 'hook') {", 'if (false) {')] },
)

proves(
  'freshness: a time that cannot be trusted writes no report record; a source with no clock is at most aging',
  (M) => {
    const f = fixtureRig(M, { list: [fixtureSession('a')], read: { outcome: 'ok', report: { state: 'running', last_report_at: T0 - MIN, declared_via: 'transcript', time_trusted: false } } })
    f.tick(T0)
    const c = f.r.kinds('check')[0].body
    assert.equal(c.freshness, 'unknown')
    assert.equal(c.freshness_reason, 'time_untrusted')
    assert.equal(f.r.kinds('report').length, 0)
    const g = fixtureRig(M, { list: [fixtureSession('a')], read: { outcome: 'ok', remote_without_clock: true, report: { state: 'running', last_report_at: T0 - MIN, declared_via: 'transcript' } } })
    g.tick(T0)
    assert.equal(g.r.kinds('check')[0].body.freshness, 'aging')
  },
  {
    'an untrusted time still writes a report': [edit('checks.js', 'if (rep.time_trusted === false) {', 'if (false) {')],
    'a source with no clock is fresh': [edit('grade.js', "if (input.remoteWithoutClock && freshness === 'fresh') freshness = 'aging'", '')],
  },
)

proves(
  'report: a changed-at source records a decision as possibly inherited, never stated; a report timed earlier than the latest authored one is noted',
  (M) => {
    const r = rig(M)
    r.writeState([entry('s1', { state: 'blocked', next: 'Pick one OWNER: the-owner', blockedOn: 'waiting', decision: 'ship or hold', updatedAt: T0 - 10 * MIN })])
    r.ticks([T0])
    const rep = r.kinds('report')[0].body
    assert.equal(rep.decision, 'ship or hold')
    assert.equal(rep.decision_basis, 'possibly_inherited')
    assert.equal(rep.owner_named, 'the-owner')
    assert.equal(rep.declared_blocked_on, 'waiting')
    assert.equal(rep.key_basis, `${STATE_SOURCE}:changed_at+fields`)
    r.writeState([entry('s1', { state: 'running', updatedAt: T0 - 40 * MIN })])
    r.ticks([T0 + 30 * MIN])
    r.ticks([T0 + 60 * MIN])
    const sys = r.kinds('system', (x) => x.body.event === 'report_regressed')
    assert.equal(sys.length, 1, 'noted once, not once per read')
    assert.equal(sys[0].id, keys.systemKey('report_regressed', [keys.sessionKey(S1), r.kinds('report')[1].id]))
  },
  { 'a regression is not noted': [edit('checks.js', 'latest.body.last_report_at > rep.last_report_at', 'latest.body.last_report_at < rep.last_report_at')] },
)

// ── activity ───────────────────────────────────────────────────────────
proves(
  'activity: states seen at a read are keyed H(check, basis, ref), an event seen again is one record, activity precedes its check',
  (M) => {
    const native = { turn_in_flight: true, busy_background: true, pending: [{ ref: 'p1', raised_at: T0 - MIN, deadline: T0 + 5 * MIN }], events: [{ id: 'e1', basis: 'prompt_event', activity_at: T0 - 2 * MIN }] }
    const f = fixtureRig(M, { list: [fixtureSession('a'), fixtureSession('b')], read: { outcome: 'ok', report: { state: 'running', last_report_at: T0 - MIN, declared_via: 'marker' }, native } })
    const t1 = f.tick(T0)
    f.tick(T0 + 30 * MIN)
    const acts = f.r.kinds('activity')
    const checkIds = f.r.kinds('check').map((c) => c.id)
    for (const c of f.r.kinds('check').filter((x) => x.refs.tick === t1.tickId)) {
      for (const basis of ['busy_now_turn', 'busy_now_background']) assert.ok(acts.some((a) => a.id === keys.activityStateKey(c.id, basis, null)), `${basis} for ${c.id}`)
      assert.ok(acts.some((a) => a.id === keys.activityStateKey(c.id, 'pending_permission', 'p1')))
      const firstAct = acts.find((a) => a.body.check_id === c.id)
      assert.ok(firstAct.seq < c.seq, 'the activity is written before the check that commits the read')
    }
    // 2 sessions x 2 ticks x 3 state records, plus one event per session however often it is seen
    assert.equal(acts.filter((a) => a.body.basis === 'prompt_event').length, 2, 'the same event at a later read is not another record')
    assert.equal(acts.length, 2 * 2 * 3 + 2)
    assert.equal(f.r.kinds('system', (x) => x.body.event === 'idempotency_conflict').length, 0)
    assert.ok(checkIds.length === 4)
  },
  {
    'no activity is written': [edit('checks.js', 'if (native) {', 'if (false) {')],
    'a repeated event is written again': [edit('checks.js', 'if (sameEvent(st.index.get(id), sessionEnv, e)) continue', '')],
    'the session is left out of the event key': [edit('keys.js', "if (hostEventId != null) return H(sessionIdentity(session), 'event', String(hostEventId))", "if (hostEventId != null) return H('event', String(hostEventId))")],
    'the ref is left out of the state key': [edit('keys.js', 'return H(checkId, basis, ref ?? null)', 'return H(checkId, basis)')],
  },
)

// ── config ─────────────────────────────────────────────────────────────
proves(
  'config: keyed H(previous config record, config hash); the same config is not written again; a config returned to is a new record',
  (M) => {
    const r = rig(M)
    const A = M.coreConfig({ owner_name: 'a' })
    const B = M.coreConfig({ owner_name: 'b' })
    for (const cfg of [A, A, B, A]) r.open({ config: cfg }).close()
    const cfgs = r.kinds('config')
    assert.equal(cfgs.length, 3, 'A, B, then A again; the repeated A writes nothing')
    assert.equal(cfgs[0].id, keys.configKey(null, H(A)))
    assert.equal(cfgs[1].id, keys.configKey(cfgs[0].id, H(B)))
    assert.equal(cfgs[2].id, keys.configKey(cfgs[1].id, H(A)))
    assert.equal(cfgs[2].body.previous_config_ref, cfgs[1].body.config_ref)
    assert.deepEqual(cfgs[1].body.changed_fields, ['owner_name'])
    // a check names the configuration it was graded under
    r.writeState([entry('s1', { state: 'running', updatedAt: T0 - MIN })])
    r.ticks([T0], { config: B })
    assert.equal(r.kinds('check')[0].body.config_ref, cfgs[1].body.config_ref)
    const rec = r.open({ config: A })
    assert.equal(rec.ctx.state.config.owner_name, 'a', 'the configuration in force after returning to A is A')
    rec.close()
  },
  {
    'the previous config is left out of the key': [edit('keys.js', 'return H(previousConfigRecordId ?? null, configHash)', 'return H(configHash)')],
    'an unchanged config is written again': [edit('core.js', 'if (!(ctx.state.config && H(ctx.state.config) === H(config))) run(', 'if (true) run(')],
  },
)

// ── system ─────────────────────────────────────────────────────────────
proves(
  'system: keyed H(event, ids); a key reused with another payload writes one idempotency_conflict, however often it is reused',
  (M) => {
    const r = rig(M)
    const h = M.openFileLedger({ dir: r.ledgerDir, ledgerId: 'ledger-test', now: T0 })
    const draft = (v) => ({ kind: 'system', id: 'K', body: { event: 'probe', detail: { v } } })
    assert.equal(h.append(draft(1), T0).status, 'appended')
    assert.equal(h.append(draft(1), T0 + 1).status, 'duplicate', 'the same payload is ignored')
    assert.equal(h.append(draft(2), T0 + 2).status, 'conflict')
    assert.equal(h.append(draft(3), T0 + 3).status, 'conflict')
    h.close()
    const conflicts = r.kinds('system', (x) => x.body.event === 'idempotency_conflict')
    assert.equal(conflicts.length, 1)
    assert.equal(conflicts[0].id, keys.systemKey('idempotency_conflict', ['K']))
    assert.equal(r.kinds('system', (x) => x.id === 'K').length, 1, 'the conflicting record was not written')
  },
  {
    'a repeat is a conflict': [edit('ledger.js', "if (existing === canonical(probe)) return { status: 'duplicate', record: null }", '')],
    'the conflict is written every time': [edit('ledger.js', "if (ledger.byKey.has(conflictDraft.id)) return { status: 'conflict', record: null }", '')],
    'the ids are left out of the system key': [edit('keys.js', 'return H(event, ids)', 'return H(event)')],
  },
)

proves(
  'tick replay: a tick cut off at any step and run again leaves one of each record and no conflict',
  (M) => {
    const make = () => {
      const r = rig(M)
      r.writeState([entry('s1', { state: 'running', updatedAt: T0 - 5 * MIN }), entry('s2', { state: 'blocked', blockedOn: 'x', updatedAt: T0 - 2 * HOUR })])
      return r
    }
    const clean = make()
    clean.open().close()
    const base = clean.records().length
    clean.ticks([T0])
    const tickAppends = clean.records().length - base
    assert.ok(tickAppends >= 6)
    for (let cut = 1; cut < tickAppends; cut++) {
      const r = make()
      let n = 0
      const rec = r.open()
      const real = rec.handle.append
      rec.handle.append = (d, a) => {
        if (++n > cut) throw new Error('crash')
        return real(d, a)
      }
      assert.throws(() => rec.tick({ source: STATE_SOURCE, slotStart: T0, now: T0 }), /crash/)
      rec.close()
      // the restart is later than the crash; nothing but the ledger file survives
      must(() => {
        const again = r.open({ now: T0 + 7 * MIN })
        again.tick({ source: STATE_SOURCE, slotStart: T0, now: T0 + 7 * MIN })
        again.close()
      }, 'the replay')
      const recs = r.records()
      assert.equal(recs.filter((x) => x.kind === 'system' && x.body.event === 'idempotency_conflict').length, 0, `cut at ${cut}`)
      assert.equal(recs.filter((x) => x.kind === 'check').length, 2, `cut at ${cut}`)
      assert.equal(recs.filter((x) => x.kind === 'tick').length, 2, `cut at ${cut}`)
      assert.equal(recs.length, base + tickAppends, `cut at ${cut}`)
    }
  },
  {
    'a recorded read is made again': [edit('policy.js', 'return rec && rec.kind === kind ? rec : null', 'return null')],
    'a repeat is a conflict': [edit('ledger.js', "if (existing === canonical(probe)) return { status: 'duplicate', record: null }", '')],
  },
)
