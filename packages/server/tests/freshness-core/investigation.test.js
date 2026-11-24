/**
 * The stale investigation, run by the reconciler core against the read-only
 * adapter contract. Every rule is shown on a fixture adapter and then on the
 * mutants that break it: a mutant is the real source with one edit, and the
 * check must fail on it with an assertion (see helpers/harness.js).
 *
 * The scenarios read one fixture source, `fx`. Reports are timed from T0 and
 * ticks run on a 30 minute cadence, so a `running` line is stale (older than
 * 45 minutes) from the second tick.
 */

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { FIXTURE_CAPS, HOUR, MIN, REAL, SRC, T0, cleanupTmp, cleanupVariants, mustKill, rig } from './helpers/harness.js'

afterEach(() => cleanupTmp())
process.on('exit', cleanupVariants)

const proves = (name, check, mutants = {}) =>
  describe(name, () => {
    it('holds on the real code', async () => {
      await check(REAL)
    })
    for (const [label, edits] of Object.entries(mutants)) it(`mutant "${label}" fails it`, () => mustKill(check, label, edits))
  })

const edit = (file, from, to) => ({ file, from, to })
const SOURCE = 'fx'
const PLAIN = Object.freeze({ native_in_read: false, activity_read: false, scope: false, can_confirm_gone: true, report_time_basis: 'authored_at' })
const NATIVE = FIXTURE_CAPS
const ACTIVITY = Object.freeze({ ...PLAIN, activity_read: true })
const NO_GONE = Object.freeze({ ...PLAIN, can_confirm_gone: false })
const at = (k) => T0 + k * 30 * MIN
const running = (extra = {}) => ({ state: 'running', last_report_at: T0, ...extra })

/**
 * A fixture world: sessions whose answers a test sets, and a log of every
 * call the reconciler made on the adapter. A session's `rereads` is a script
 * for the reads after the first one at the same time (the investigation's):
 * 'error', 'blocked' or 'ok'.
 */
function makeWorld(sessions = {}) {
  const w = { up: true, s: {}, log: [], seen: new Map(), members: new Set() }
  for (const [id, x] of Object.entries(sessions)) w.s[id] = { listed: true, ...x }
  return w
}

function makeAdapter(w) {
  return {
    source: SOURCE,
    list() {
      w.log.push({ call: 'list' })
      if (!w.up) return null
      return Object.keys(w.s)
        .filter((id) => w.s[id].listed && !w.s[id].hidden)
        .map((id) => ({ session: { source: SOURCE, native_id: id, incarnation: null }, scope: null }))
    },
    read(session, now) {
      const id = session.native_id
      w.log.push({ call: 'read', id, now })
      const x = w.s[id]
      const key = `${id}@${now}`
      const n = w.seen.get(key) ?? 0
      w.seen.set(key, n + 1)
      if (!x || !x.listed) return { listed: false, outcome: 'no_report' }
      let mode = x.fail ? 'error' : 'ok'
      if (n > 0 && x.rereads?.length) mode = x.rereads.shift()
      if (mode === 'error') return { outcome: 'error', error_code: 'timeout' }
      if (mode === 'blocked') return { outcome: 'blocked', not_read_reason: 'access_needed' }
      if (x.report) return { outcome: 'ok', report: { declared_via: 'marker', ...x.report }, ...(x.native ? { native: x.native } : {}) }
      return { outcome: 'no_report', ...(x.native ? { native: x.native } : {}) }
    },
  }
}

/** Run ticks of `fx` at `times` over the world; `hook(i, time, world)` runs before each tick. */
function drive(M, { caps = PLAIN, w, times, hook, config = {} }) {
  const r = rig(M)
  const adapter = makeAdapter(w)
  let rec
  const ticks = []
  try {
    rec = r.open({ now: times[0], adapters: [adapter], config: M.coreConfig({ sources: { [SOURCE]: caps }, ...config }) })
    for (const [i, time] of times.entries()) {
      hook?.(i, time, w)
      ticks.push(rec.tick({ source: SOURCE, slotStart: time, now: time }))
    }
  } catch (err) {
    if (err instanceof assert.AssertionError) throw err
    assert.fail(`a tick threw ${err.name}: ${err.message}`)
  } finally {
    rec?.close()
  }
  const closes = r.kinds('investigation', (x) => x.body.phase === 'close')
  return { r, w, ticks, closes, bodies: closes.map((x) => x.body) }
}

const klass = (b) => `${b.trigger === 'recheck' ? 'R' : b.cycle}:${b.classification}`
const rungNames = (b) => b.rungs.map((x) => (x.retry ? `${x.rung}+retry` : x.rung))
const forSession = (res, id) => res.closes.filter((c) => c.session?.native_id === id).map((c) => c.body)
const readsOf = (w, id, now) => w.log.filter((l) => l.call === 'read' && l.id === id && l.now === now).length

// ───────────────────────── the five triggers ─────────────────────────

proves(
  'trigger stale_report: an old running line is investigated, a fresh one is not, and nothing is asked of the session',
  (M) => {
    const w = makeWorld({ a: { report: running() }, b: { report: running() } })
    const res = drive(M, {
      w,
      times: [at(1), at(2), at(3)],
      hook: (i, time) => {
        w.s.b.report = running({ last_report_at: time })
      },
    })
    assert.ok(res.bodies.length >= 1, 'the stale line was investigated')
    assert.deepEqual([...new Set(res.closes.map((c) => c.session.native_id))], ['a'], 'only the stale session')
    const first = res.bodies[0]
    assert.equal(first.trigger, 'stale_report')
    assert.equal(first.cycle, 1)
    assert.equal(first.classification, 'running_claim_unverified')
    assert.equal(first.surface, null, 'the first cycle surfaces nothing')
    assert.deepEqual(rungNames(first), ['re_read', 'activity_read', 'classify'])
    assert.equal(first.rungs[1].outcome, 'unavailable', 'a source with no native state has no activity read')
    assert.equal(res.closes[0].refs.tick != null, true)
  },
  {
    'every session counts as stale': [edit('derive.js', 'f.stale_report = staleBySelf || relayedLong', 'f.stale_report = true')],
    'no session counts as stale': [edit('derive.js', 'f.stale_report = staleBySelf || relayedLong', 'f.stale_report = false')],
  },
)

proves(
  'trigger native_disagreement: an idle line while a turn is in flight is investigated; a running line with a turn is not',
  (M) => {
    const w = makeWorld({
      a: { report: { state: 'idle', last_report_at: T0 }, native: { turn_in_flight: true } },
      b: { report: running({ last_report_at: T0 }), native: { turn_in_flight: true } },
    })
    const res = drive(M, {
      caps: NATIVE,
      w,
      times: [at(1)],
      hook: (i, time) => {
        w.s.b.report.last_report_at = time
      },
    })
    assert.deepEqual(res.bodies.map((b) => [b.trigger, b.classification]), [['native_disagreement', 'working_unreported']])
    assert.equal(res.closes[0].session.native_id, 'a')
  },
  {
    'the trigger never holds': [edit('derive.js', 'f.native_disagreement = Boolean(c.nativeAvailable && c.turnInFlight && state.policy.disagreementStates.has(c.state))', 'f.native_disagreement = false')],
    'any state counts as a disagreement': [edit('derive.js', 'state.policy.disagreementStates.has(c.state)', 'true')],
  },
)

proves(
  'trigger native_disagreement needs a source whose read carries native state',
  (M) => {
    const w = makeWorld({ a: { report: { state: 'idle', last_report_at: T0 }, native: { turn_in_flight: true } } })
    const res = drive(M, { caps: PLAIN, w, times: [at(1), at(2)] })
    assert.equal(res.bodies.length, 0)
  },
  { 'the capability is not checked': [edit('investigation.js', "if (trigger === 'native_disagreement' && !caps.native_in_read) return", '')] },
)

proves(
  'trigger dropped_from_list: a second read confirms the session is gone; a listing that still answers is not gone; a source that cannot confirm never says gone',
  (M) => {
    const gone = drive(M, {
      w: makeWorld({ a: {}, c: {} }),
      times: [at(1), at(2), at(3)],
      hook: (i, time, w) => {
        if (i === 1) w.s.a.listed = false
      },
    })
    assert.deepEqual(gone.bodies.map((b) => [b.trigger, b.classification, b.surface]), [['dropped_from_list', 'gone', 'gone']], 'one investigation, none after a confirmed loss')
    assert.deepEqual(rungNames(gone.bodies[0]), ['re_read', 'confirm_gone', 'classify'])
    assert.equal(gone.bodies[0].rungs[1].outcome, 'not_listed')

    const hidden = drive(M, {
      w: makeWorld({ a: {} }),
      times: [at(1), at(2)],
      hook: (i, time, w) => {
        if (i === 1) w.s.a.hidden = true
      },
    })
    assert.deepEqual(hidden.bodies.map((b) => [b.classification, b.surface]), [['inconclusive', null]], 'a session the listing missed but a read still finds is not gone')
    assert.equal(hidden.bodies[0].rungs[1].outcome, 'listed')

    const cannot = drive(M, {
      caps: NO_GONE,
      w: makeWorld({ a: {} }),
      times: [at(1), at(2)],
      hook: (i, time, w) => {
        if (i === 1) w.s.a.listed = false
      },
    })
    assert.deepEqual(cannot.bodies.map((b) => b.classification), ['inconclusive'])
  },
  {
    'the confirming read is skipped': [edit('investigation.js', "if (cand.trigger === 'dropped_from_list' && !cand.sourceLevel) {", 'if (false) {')],
    'a listed answer reads as not listed': [edit('investigation.js', 'confirmListed = c.body.listed !== false', 'confirmListed = false')],
    'gone is never concluded': [edit('policy.js', "if (ev.confirmListed === false && ev.canConfirmGone) return 'gone'", "if (false) return 'gone'")],
    'a source that cannot confirm may say gone': [edit('investigation.js', 'canConfirmGone: caps.can_confirm_gone,', 'canConfirmGone: true,')],
    'a dropped session is not surfaced': [edit('policy.js', "case 'gone':\n        return 'gone'", "case 'gone':\n        return null")],
  },
)

proves(
  'trigger repeated_error: two errored checks in a row, one re-read and one retry, a second cycle, then no more',
  (M) => {
    const w = makeWorld({ a: { fail: true }, b: { report: running({ last_report_at: T0 }) } })
    const res = drive(M, {
      w,
      times: [at(1), at(2), at(3), at(4), at(5)],
      hook: (i, time) => {
        w.s.b.report.last_report_at = time
      },
    })
    const a = res.closes.filter((c) => c.session.native_id === 'a')
    assert.equal(a.length, 2, 'two cycles, none after')
    assert.deepEqual(a.map((c) => c.refs.tick === res.ticks[1].tickId), [true, false], 'the first at the second tick, not the first')
    assert.deepEqual(a.map((c) => [c.body.trigger, c.body.cycle, c.body.classification, c.body.surface]), [
      ['repeated_error', 1, 'inconclusive', null],
      ['repeated_error', 2, 'inconclusive', 'attention'],
    ])
    assert.deepEqual(rungNames(a[0].body), ['re_read', 're_read+retry', 'activity_read', 'classify'])
    assert.equal(readsOf(w, 'a', at(2)), 3, 'the tick read, the re-read and its retry')
  },
  {
    'one error is enough': [edit('derive.js', "f.repeated_error = c.outcome === 'error' && s.prev?.outcome === 'error'", "f.repeated_error = c.outcome === 'error'")],
    'a failed read is not retried': [edit('investigation.js', 'if (failed) {', 'if (false) {')],
  },
)

proves(
  'trigger repeated_error, source level: every session failing is one investigation of the source, never one per session',
  (M) => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f']
    const w = makeWorld(Object.fromEntries(ids.map((id) => [id, { fail: true }])))
    const res = drive(M, { w, times: [at(1), at(2)] })
    assert.equal(res.closes.length, 1)
    const b = res.bodies[0]
    assert.equal(b.source_level, true)
    assert.deepEqual([b.classification, b.surface], ['source_unreachable', 'outage'])
    assert.equal(w.log.filter((l) => l.call === 'read' && l.now === at(2)).length, ids.length + 2, 'the tick reads, then a re-read and its retry of one session')
  },
  {
    'each session is investigated too': [edit('investigation.js', "if (trigger === 'repeated_error' && srcHeld) return", '')],
    'an unreachable source is inconclusive': [edit('policy.js', "if (ev.sourceLevel) return ev.rereadFailed ? 'source_unreachable' : 'inconclusive'", "if (ev.sourceLevel) return 'inconclusive'")],
    'an outage is not surfaced': [edit('policy.js', "case 'source_unreachable':\n        return 'outage'", "case 'source_unreachable':\n        return null")],
  },
)

proves(
  'trigger recheck: working is rechecked on the activity read alone; a recheck that finds nothing starts a new onset',
  (M) => {
    const w = makeWorld({ a: { report: running(), native: { turn_in_flight: true } } })
    const res = drive(M, {
      caps: NATIVE,
      w,
      times: [at(2), at(3), at(4), at(5)],
      hook: (i, time, world) => {
        if (i >= 2) world.s.a.native = { turn_in_flight: false }
      },
    })
    assert.deepEqual(res.bodies.map(klass), ['1:working_unreported', 'R:working_unreported', 'R:no_longer_observed', '1:inconclusive'])
    assert.deepEqual(rungNames(res.bodies[1]), ['activity_read', 'classify'], 'a recheck runs no re-read')
    assert.equal(readsOf(w, 'a', at(3)), 1, 'the tick read is the only read of the recheck tick')
    assert.equal(res.bodies[1].cycle, null, 'a recheck is no cycle')
  },
  {
    'nothing is rechecked': [edit('policy.js', "recheckAfter: Object.freeze(new Set(['working_unreported', 'waiting_on_background'])),", 'recheckAfter: Object.freeze(new Set([])),')],
    'a recheck always finds work': [edit('policy.js', "if (n && n.available && n.answering_now && n.turn_in_flight) return 'working_unreported'", "if (true) return 'working_unreported'")],
    'a recheck never finds work': [edit('policy.js', "if (n && n.available && n.answering_now && n.turn_in_flight) return 'working_unreported'", "if (false) return 'working_unreported'")],
  },
)

// ───────────────────────── cycles and classifications ─────────────────────────

proves(
  'cycles: at most two per onset, the second only after an unresolved first, and only the second surfaces',
  (M) => {
    const w = makeWorld({ a: { report: running() } })
    const res = drive(M, { w, times: [at(2), at(3), at(4), at(5), at(6)] })
    assert.deepEqual(res.bodies.map((b) => [b.cycle, b.classification, b.surface]), [
      [1, 'running_claim_unverified', null],
      [2, 'running_claim_unverified', 'attention'],
    ])
  },
  {
    'a third cycle': [edit('policy.js', 'maxCycles: 2,', 'maxCycles: 3,')],
    'the first cycle surfaces': [edit('policy.js', "return cycle === 2 ? 'attention' : null", "return 'attention'")],
    'no second cycle': [edit('policy.js', "secondCycleAfter: Object.freeze(new Set(['inconclusive', 'running_claim_unverified'])),", 'secondCycleAfter: Object.freeze(new Set([])),')],
  },
)

proves(
  'classification blocked_unresolved: a stale blocked line nobody explains is surfaced after the first cycle',
  (M) => {
    const w = makeWorld({ a: { report: { state: 'blocked', last_report_at: T0, declared_blocked_on: 'a review' } } })
    const res = drive(M, { w, times: [T0 + 5 * HOUR] })
    assert.deepEqual(res.bodies.map((b) => [b.cycle, b.classification, b.surface]), [[1, 'blocked_unresolved', 'attention']])
  },
  {
    'a blocked line is not classified': [edit('policy.js', 'BLOCKING_STATES.has(ev.state) &&', 'false &&')],
    'it is not surfaced': [edit('policy.js', "case 'blocked_unresolved':\n        return 'attention'", "case 'blocked_unresolved':\n        return null")],
  },
)

proves(
  'classification waiting_on_owner: a pending prompt explains a stale line, and is rechecked until it ends',
  (M) => {
    const w = makeWorld({ a: { report: running(), native: { pending: [{ ref: 'p1', raised_at: T0 + 10 * MIN }] } } })
    const res = drive(M, {
      caps: NATIVE,
      w,
      times: [at(2), at(3), at(4)],
      hook: (i, time, world) => {
        if (i === 2) world.s.a.native = { pending: [] }
      },
    })
    assert.deepEqual(res.bodies.map((b) => [klass(b), b.surface, b.owner_wait_basis]), [
      ['1:waiting_on_owner', null, 'prompt'],
      ['R:waiting_on_owner', null, 'prompt'],
      ['R:no_longer_observed', null, null],
    ])
  },
  {
    'a pending prompt explains nothing': [edit('policy.js', "if (live && n.pending) return 'waiting_on_owner'", 'if (false) return null')],
    'a pending prompt is not rechecked': [edit('policy.js', "return last.classification === 'waiting_on_owner' && last.ownerWaitBasis === 'prompt'", 'return false')],
  },
)

proves(
  'classification waiting_on_background: surfaced only once the report is older than the limit, and by the recheck',
  (M) => {
    const w = makeWorld({ a: { report: running(), native: { busy_background: true } } })
    const res = drive(M, { caps: NATIVE, w, times: [at(2), at(4)] })
    assert.deepEqual(res.bodies.map((b) => [klass(b), b.surface, b.report_age_ms]), [
      ['1:waiting_on_background', null, 60 * MIN],
      ['R:waiting_on_background', 'attention', 120 * MIN],
    ])
    assert.deepEqual(res.bodies[1].basis_onset, res.bodies[0].onset, 'the recheck opens on the onset of the cycle that led to it')
  },
  {
    'always surfaced': [edit('policy.js', 'ev.reportAgeMs > config.investigation.background_wait_max_minutes * MIN_MS', 'true')],
    'never surfaced': [edit('policy.js', 'ev.reportAgeMs > config.investigation.background_wait_max_minutes * MIN_MS', 'false')],
  },
)

proves(
  'classification finished_unreported: a turn that ended after the line raises nothing and is not investigated again',
  (M) => {
    const w = makeWorld({ a: { report: running(), native: { events: [{ id: 'e1', basis: 'turn_ended_after_report', activity_at: T0 + 10 * MIN }] } } })
    const res = drive(M, { caps: NATIVE, w, times: [at(2), at(3), at(4)] })
    assert.deepEqual(res.bodies.map((b) => [klass(b), b.surface]), [['1:finished_unreported', null]])
  },
  { 'the ended turn is not seen': [edit('policy.js', "if (Number.isFinite(lastEnd)) return 'finished_unreported'", '')] },
)

proves(
  'a re-read that fails, is blocked or recovers on its retry',
  (M) => {
    const run = (rereads) => drive(M, { w: makeWorld({ a: { report: running(), rereads } }), times: [at(2)] }).bodies[0]
    const failed = run(['error', 'error'])
    assert.equal(failed.classification, 'inconclusive')
    assert.deepEqual(rungNames(failed), ['re_read', 're_read+retry', 'activity_read', 'classify'])
    const recovered = run(['error', 'ok'])
    assert.equal(recovered.classification, 'running_claim_unverified', 'a retry that answers is the read of the cycle')
    const blocked = run(['blocked'])
    assert.equal(blocked.classification, 'inconclusive')
    assert.equal(blocked.rungs[0].outcome, 'blocked')
  },
  {
    'a failed retry is not a failure': [edit('investigation.js', 'failed = retry.body.outcome === \'error\'', 'failed = false')],
    'a retry that answers still fails': [edit('investigation.js', 'failed = retry.body.outcome === \'error\'', 'failed = true')],
    'a failed re-read is not a failure': [edit('policy.js', "if (ev.rereadFailed) return 'inconclusive'", '')],
    'a blocked read is not inconclusive': [edit('policy.js', "if (ev.rungBlocked) return 'inconclusive'", '')],
  },
)

// ───────────────────── the read-activity path and evidence classes ─────────────────────

proves(
  'activity read: a source that has a separate native read gets one, its report is ignored, and it supplies E1 alone',
  (M) => {
    const w = makeWorld({ a: { report: running(), native: { turn_in_flight: true } } })
    const res = drive(M, { caps: ACTIVITY, w, times: [at(2)] })
    const b = res.bodies[0]
    assert.equal(b.classification, 'working_unreported')
    assert.deepEqual(rungNames(b), ['re_read', 'activity_read', 'classify'])
    assert.equal(readsOf(w, 'a', at(2)), 3, 'the tick read, the re-read and the activity read')
    assert.deepEqual(b.rungs[1].evidence, ['E1'], 'the report an activity read carries is not recorded')
    const check = res.r.kinds('check', (x) => x.id === b.rungs[1].read)[0]
    assert.equal(check.body.read_kind, 'activity')
    assert.equal(check.body.report_id, null)
  },
  {
    'no activity read': [edit('investigation.js', '} else if (caps.activity_read) {\n        const a =', '} else if (false) {\n        const a =')],
    'the activity read records a report': [edit('checks.js', "} else if (body.outcome === 'ok' && read.report && opts.readKind !== 'activity') {", "} else if (body.outcome === 'ok' && read.report) {")],
  },
)

proves(
  'evidence: each rung names its read and the class of what the read supplied (E2 authored, E5 relayed, E1 native)',
  (M) => {
    const authored = drive(M, { caps: NATIVE, w: makeWorld({ a: { report: running(), native: { busy_background: true } } }), times: [at(2)] }).bodies[0]
    assert.deepEqual(authored.rungs.map((r) => [r.rung, r.evidence]), [
      ['re_read', ['E1', 'E2']],
      ['activity_read', ['E1']],
      ['classify', ['E1', 'E2']],
    ])
    assert.ok(authored.rungs.slice(0, 2).every((r) => typeof r.read === 'string'), 'a read is named by its check')
    assert.equal(authored.rungs[2].read, null)

    const relayed = drive(M, { w: makeWorld({ a: { report: running({ declared_via: 'api' }) } }), times: [at(1), at(2), at(3)] }).bodies[0]
    assert.equal(relayed.trigger, 'stale_report')
    assert.deepEqual(relayed.rungs.map((r) => [r.rung, r.evidence]), [
      ['re_read', ['E5']],
      ['activity_read', []],
      ['classify', ['E5']],
    ])

    const none = drive(M, { w: makeWorld({ a: { report: running(), rereads: ['blocked'] } }), times: [at(2)] }).bodies[0]
    assert.deepEqual(none.rungs[0].evidence, [], 'a read that supplied nothing names no class')
  },
  {
    'every report is E2': [edit('investigation.js', 'if (rep) out.push(rep.evidence_class)', "if (rep) out.push('E2')")],
    'native state is not counted': [edit('investigation.js', "if (body.native_available) out.push('E1')", '')],
    'the classify rung forgets the reads': [edit('investigation.js', "return [...new Set(rungs.flatMap((r) => r.evidence ?? []))].sort()", 'return []')],
  },
)

proves(
  'evidence: the ledger holds what the rung names: the check, its report and its activity, with the classes the rung gives',
  (M) => {
    const w = makeWorld({ a: { report: running(), native: { busy_background: true } } })
    const res = drive(M, { caps: NATIVE, w, times: [at(2)] })
    const rung = res.bodies[0].rungs[0]
    const check = res.r.kinds('check', (x) => x.id === rung.read)[0]
    assert.ok(check, 'the named read is a check in the ledger')
    assert.equal(check.body.trigger, 'investigation')
    const classes = [res.r.kinds('report', (x) => x.id === check.body.report_id)[0].body.evidence_class, ...res.r.kinds('activity', (x) => x.body.check_id === check.id).map((x) => x.body.evidence_class)]
    assert.deepEqual([...new Set(classes)].sort(), rung.evidence)
  },
  { 'the rung names a read that is not recorded': [edit('investigation.js', "rungs.push({ rung: 're_read', outcome: reRead.body.outcome, read: reRead.checkId,", "rungs.push({ rung: 're_read', outcome: reRead.body.outcome, read: 'chk_missing',")] },
)

// ───────────────────── read-only: nothing is written to a session ─────────────────────

const SEND_NAMES = /\b(send|deliver|notify|post|publish|emit|reply|spawn|exec|fetch|socket|write|append|unlink|rename|rm|mkdir)/i

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

/** What a source text of the scheduler imports, and every name in it that sends or writes. */
function scanScheduler(text) {
  const code = stripComments(text)
  const specs = [...code.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1]).sort()
  return { specs, names: code.match(new RegExp(SEND_NAMES.source, 'gi')) ?? [] }
}
const SCHEDULER_FILE = path.join(SRC, 'freshness/investigation.js')

describe('read-only: the investigation scheduler imports only the pure rule modules and names nothing that sends or writes', () => {
  it('holds on the shipped file', () => {
    const { specs, names } = scanScheduler(fs.readFileSync(SCHEDULER_FILE, 'utf8'))
    assert.deepEqual(specs, ['./checks.js', './config.js', './derive.js', './hash.js', './keys.js'], 'no adapter, ledger file or I/O module')
    assert.deepEqual(names, [], 'no name that sends or writes')
  })
  // The scan itself, shown to fail on each thing added to the real file.
  const real = fs.readFileSync(SCHEDULER_FILE, 'utf8')
  for (const [label, line] of Object.entries({
    'an adapter module': "import { sealAdapter } from './adapter.js'",
    'a file ledger module': "import { openFileLedger } from './file-ledger.js'",
    'a node module': "import fs from 'node:fs'",
    'a send helper': 'const sendInput = () => {}',
    'a reply helper': 'const reply = () => {}',
    'a file write': 'const f = (p) => writeFileSync(p, "")',
  })) {
    it(`the scan flags ${label}`, () => {
      const { specs, names } = scanScheduler(`${line}\n${real}`)
      assert.ok(specs.length !== 5 || names.length > 0)
    })
  }
})

proves(
  'read-only: a heavy run calls only list and read on the adapter, reads with the tick time, and the core cannot deliver',
  (M) => {
    const ids = ['a', 'b', 'c', 'd']
    const w = makeWorld({
      a: { report: running(), native: { turn_in_flight: true } },
      b: { report: { state: 'blocked', last_report_at: T0 } },
      c: { fail: true },
      d: {},
    })
    const res = drive(M, {
      caps: NATIVE,
      w,
      times: [at(2), at(3), at(4), at(5)],
      hook: (i, time, world) => {
        if (i === 2) world.s.d.listed = false
      },
    })
    assert.ok(res.closes.length >= 4, 'investigations ran')
    assert.deepEqual([...new Set(w.log.map((l) => l.call))].sort(), ['list', 'read'])
    assert.deepEqual(w.log.filter((l) => l.call === 'list').length, 4, 'one listing per tick')
    for (const l of w.log.filter((x) => x.call === 'read')) {
      assert.ok(ids.includes(l.id) && [at(2), at(3), at(4), at(5)].includes(l.now), 'a read of a known session at a tick time')
    }
    assert.deepEqual(Object.keys(M.sealAdapter(makeAdapter(w))).sort(), ['list', 'read', 'source'])
    for (const name of ['send', 'sendInput', 'write', 'reply', 'post', 'respond', 'input']) {
      assert.throws(() => M.sealAdapter({ ...makeAdapter(w), [name]: () => {} }), (e) => e instanceof M.AdapterContractError, name)
    }
    const kinds = new Set(res.r.records().map((x) => x.kind))
    for (const k of kinds) assert.ok(['tick', 'check', 'report', 'activity', 'investigation', 'config', 'system'].includes(k), `ledger record kind ${k}`)
  },
  {
    'a send is yielded': [edit('investigation.js', "yield put({ kind: 'investigation', id: investigationKey(invId, 'open'), session: env, refs: { tick: tickId }, body: openBody }, now)", "yield { op: 'send', effect: { text: 'status?' } }\n  yield put({ kind: 'investigation', id: investigationKey(invId, 'open'), session: env, refs: { tick: tickId }, body: openBody }, now)")],
    'an adapter with a write member is accepted': [edit('adapter.js', 'if (extra.length) {', 'if (false) {')],
  },
)

// ───────────────────────────── the bounds ─────────────────────────────

const perTick = (res) => {
  const m = new Map()
  for (const c of res.closes) m.set(c.refs.tick, [...(m.get(c.refs.tick) ?? []), c.body])
  return m
}

proves(
  'bounds: many stale sessions are investigated at most the budget per tick, one per session, two cycles per onset, first cycles first',
  (M) => {
    const N = 24
    const BUDGET = 2
    const ids = Array.from({ length: N }, (_, i) => `s${String(i).padStart(2, '0')}`)
    const w = makeWorld(Object.fromEntries(ids.map((id) => [id, { report: running() }])))
    const times = Array.from({ length: 30 }, (_, i) => at(i + 2))
    const res = drive(M, { w, times, config: { investigation_budget_per_tick: BUDGET } })

    for (const [tick, bodies] of perTick(res)) {
      assert.ok(bodies.length <= BUDGET, `tick ${tick} ran ${bodies.length} investigations, over the budget of ${BUDGET}`)
    }
    const perSession = new Map()
    for (const c of res.closes) {
      const key = `${c.session.native_id}|${c.refs.tick}`
      perSession.set(key, (perSession.get(key) ?? 0) + 1)
    }
    assert.ok([...perSession.values()].every((n) => n === 1), 'one investigation per session per tick')
    for (const id of ids) assert.deepEqual(forSession(res, id).map((b) => b.cycle), [1, 2], `${id}: two cycles, no third`)

    const cycles = res.bodies.map((b) => b.cycle)
    const firstSecond = cycles.indexOf(2)
    assert.equal(cycles.slice(0, firstSecond).filter((c) => c === 1).length, N, 'every first cycle ran before any second')
    assert.equal(res.bodies.length, 2 * N)
    const lastTick = res.ticks[res.ticks.length - 1].tickId
    assert.equal(perTick(res).get(lastTick)?.length ?? 0, 0, 'quiet once every session has had its cycles')

    // The reads: every session once per tick, plus each investigation's own.
    for (const time of times) {
      const reads = w.log.filter((l) => l.call === 'read' && l.now === time).length
      assert.ok(reads <= N + BUDGET, `reads at ${time}: ${reads}`)
    }
  },
  {
    'no budget': [edit('investigation.js', 'cycleBudget: Math.max(0, cfg.investigation_budget_per_tick - usedCycles),', 'cycleBudget: Infinity,')],
    'one over the budget': [edit('policy.js', '.slice(0, cycleBudget)', '.slice(0, cycleBudget + 1)')],
    'second cycles are not behind first': [edit('policy.js', '.sort((a, b) => a.cycle - b.cycle || a.onsetSeq - b.onsetSeq || cmpStr(a.key, b.key))', '.sort((a, b) => a.onsetSeq - b.onsetSeq || cmpStr(a.key, b.key))')],
    'a third cycle': [edit('policy.js', 'maxCycles: 2,', 'maxCycles: 3,')],
  },
)

proves(
  'bounds: rechecks that need their own read draw on their own budget, never on the cycles, and all get a turn',
  (M) => {
    const N = 10
    const ids = Array.from({ length: N }, (_, i) => `w${String(i).padStart(2, '0')}`)
    const w = makeWorld(Object.fromEntries(ids.map((id) => [id, { report: running(), native: { turn_in_flight: true } }])))
    const times = Array.from({ length: 16 }, (_, i) => at(i + 2))
    const res = drive(M, { caps: ACTIVITY, w, times, config: { investigation_budget_per_tick: 3, recheck_budget_per_tick: 2 } })

    for (const [tick, bodies] of perTick(res)) {
      const cycles = bodies.filter((b) => b.trigger !== 'recheck').length
      const rechecks = bodies.filter((b) => b.trigger === 'recheck').length
      assert.ok(cycles <= 3, `tick ${tick}: ${cycles} cycles`)
      assert.ok(rechecks <= 2, `tick ${tick}: ${rechecks} rechecks that read`)
    }
    // Reads: each session once, a cycle's re-read and activity read, a recheck's activity read.
    for (const time of times) {
      const reads = w.log.filter((l) => l.call === 'read' && l.now === time).length
      assert.ok(reads <= N + 3 * 2 + 2, `reads at ${time}: ${reads}`)
    }
    const rechecked = new Set(res.closes.filter((c) => c.body.trigger === 'recheck').map((c) => c.session.native_id))
    assert.equal(rechecked.size, N, 'every working session is rechecked')
    assert.equal(res.bodies.filter((b) => b.trigger !== 'recheck').length, N, 'one cycle each; a working session needs no second')
  },
  {
    'no recheck budget': [edit('policy.js', '.slice(0, recheckBudget)', '.slice(0, recheckBudget + 100)')],
    'the same sessions win every tick': [edit('policy.js', '.sort((a, b) => (a.lastInvestigatedAt ?? 0) - (b.lastInvestigatedAt ?? 0) || cmpStr(a.key, b.key))', '.sort((a, b) => cmpStr(a.key, b.key))')],
    'rechecks are not counted against the tick': [edit('investigation.js', 'recheckBudget: Math.max(0, cfg.recheck_budget_per_tick - usedPaid),', 'recheckBudget: Infinity,')],
  },
)

proves(
  'bounds: a source whose every session fails is one investigation and its reads do not grow with the sessions',
  (M) => {
    const N = 24
    const w = makeWorld(Object.fromEntries(Array.from({ length: N }, (_, i) => [`e${i}`, { fail: true }])))
    const times = [at(1), at(2), at(3), at(4)]
    const res = drive(M, { w, times })
    assert.deepEqual(res.bodies.map((b) => [b.source_level, b.cycle, b.classification]), [[true, 1, 'source_unreachable']], 'one, and none after an unreachable verdict')
    for (const time of times) {
      const reads = w.log.filter((l) => l.call === 'read' && l.now === time).length
      assert.ok(reads <= N + 2, `reads at ${time}: ${reads}`)
    }
  },
  { 'each session is investigated too': [edit('investigation.js', "if (trigger === 'repeated_error' && srcHeld) return", '')] },
)
