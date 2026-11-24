/**
 * The read-only adapter contract: no send method, shape-checked reads, and a
 * failing adapter reads as an error, never as an absence of status.
 */

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { FIXTURE_CAPS, MIN, REAL, SRC, T0, cleanupTmp, cleanupVariants, entry, fixtureAdapter, fixtureSession, must, rig, mustKill } from './helpers/harness.js'

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
const ok = { source: 'fixture', list: () => [], read: () => ({ outcome: 'no_report' }) }

proves(
  'contract: an adapter is source, list and read and nothing else; a send, post or notify member is refused, not trimmed',
  (M) => {
    const view = M.sealAdapter(ok)
    assert.deepEqual(Object.keys(view).sort(), ['list', 'read', 'source'])
    assert.ok(Object.isFrozen(view))
    for (const name of ['send', 'post', 'notify', 'deliver', 'sendMessage']) {
      assert.throws(() => M.sealAdapter({ ...ok, [name]: () => {} }), (e) => e instanceof M.AdapterContractError, name)
    }
    class WithSend {
      source = 'fixture'
      list() { return [] }
      read() { return { outcome: 'no_report' } }
      send() {}
    }
    assert.throws(() => M.sealAdapter(new WithSend()), (e) => e instanceof M.AdapterContractError, 'a method on the prototype')
    class OwnReadAndList {
      source = 'fixture'
      list = () => []
      read = () => ({ outcome: 'no_report' })
      send() {}
    }
    assert.throws(() => M.sealAdapter(new OwnReadAndList()), (e) => e instanceof M.AdapterContractError, 'a send on the prototype of an adapter whose own members are right')
    assert.throws(() => M.sealAdapter({ get source() { return 'fixture' }, list: ok.list, read: ok.read }), (e) => e instanceof M.AdapterContractError, 'an accessor')
    assert.throws(() => M.sealAdapter({ ...ok, source: 'Not A Name' }), (e) => e instanceof M.AdapterContractError)
    assert.throws(() => M.sealAdapter({ ...ok, source: 'a'.repeat(65) }), (e) => e instanceof M.AdapterContractError, 'longer than 64')
    M.sealAdapter({ ...ok, source: 'a'.repeat(64) })
    assert.throws(() => M.sealAdapter({ source: 'fixture', list: ok.list }), (e) => e instanceof M.AdapterContractError)
    assert.throws(() => M.sealAdapter({ ...ok, [Symbol('x')]: 1 }), (e) => e instanceof M.AdapterContractError, 'a symbol member')
    const real = M.createStateFileAdapter({ path: '/nonexistent/state.json' })
    assert.deepEqual(Object.keys(real).sort(), ['list', 'read', 'source'], 'the state-file adapter has no other member')
    M.sealAdapter(real)
  },
  {
    'extra members are accepted': [edit('adapter.js', 'if (extra.length) {', 'if (false) {')],
    'a prototype is accepted': [edit('adapter.js', 'return proto === Object.prototype || proto === null', 'return true')],
    'the source name length is not limited': [edit('adapter.js', 'name.length <= 64', 'true')],
    'an accessor is accepted': [edit('adapter.js', "if (!d || 'get' in d || 'set' in d)", 'if (!d)')],
    'the source name is not checked': [edit('adapter.js', 'if (!validSourceName(adapter.source)) {', 'if (false) {')],
  },
)

proves(
  'contract: nothing the reconciler exports can send',
  (M) => {
    const names = Object.keys(M)
    assert.deepEqual(names.filter((n) => /send|deliver|notify|post|publish|emit|webhook/i.test(n)), [])
  },
  { 'a send function is exported': [edit('core.js', 'export function coreConfig(', 'export function sendOwnerMessage() {}\nexport function coreConfig(')] },
)

const BAD_READS = {
  'not an object': 'ok',
  'an array': [],
  'an unknown key': { outcome: 'no_report', note: 'x' },
  'an unknown outcome': { outcome: 'fine' },
  'listed is not a boolean': { listed: 'yes', outcome: 'no_report' },
  'a report with no ok outcome': { outcome: 'no_report', report: { state: 'running', last_report_at: T0, declared_via: 'marker' } },
  'ok with no report': { outcome: 'ok' },
  'a state outside the set': { outcome: 'ok', report: { state: 'napping', last_report_at: T0, declared_via: 'marker' } },
  'a report time that is not an integer': { outcome: 'ok', report: { state: 'running', last_report_at: 'noon', declared_via: 'marker' } },
  'a report that vouches for its own freshness': { outcome: 'ok', report: { state: 'running', last_report_at: T0, declared_via: 'marker', freshness: 'fresh' } },
  'free text in the error code': { outcome: 'error', error_code: 'it broke: CANARY-ERR-d1' },
  'a decision basis outside the set': { outcome: 'ok', report: { state: 'running', last_report_at: T0, declared_via: 'marker', decision_basis: 'certain' } },
  'native with an unknown key': { outcome: 'no_report', native: { turn_in_flight: true, secrets: 1 } },
  'a pending prompt with no ref': { outcome: 'no_report', native: { pending: [{ raised_at: 1 }] } },
}

proves(
  'contract: a read with the wrong shape is an error read with a fixed code, whatever it carried',
  (M) => {
    for (const [name, read] of Object.entries(BAD_READS)) {
      const r = rig(M)
      const f = M.coreConfig({ sources: { fixture: FIXTURE_CAPS } })
      const rec = r.open({ now: T0, adapters: [fixtureAdapter('fixture', { list: [fixtureSession('a')], read })], config: f })
      rec.tick({ source: 'fixture', slotStart: T0, now: T0 })
      rec.close()
      const c = r.kinds('check')[0].body
      assert.equal(c.freshness, 'error', name)
      assert.equal(c.error_code, 'adapter_shape', name)
      assert.ok(!fs.readFileSync(r.ledgerFile, 'utf8').includes('CANARY'), name)
    }
  },
  {
    'unknown keys in a report are accepted': [edit('adapter.js', 'if (!isPlain(r) || !onlyKeys(r, REPORT_FIELDS)) return false', 'if (!isPlain(r)) return false')],
    'any error code is accepted': [edit('adapter.js', "!(typeof read[k] === 'string' && CODE_RE.test(read[k]))", 'false')],
    'any state is accepted': [edit('adapter.js', 'if (!REPORT_STATES.has(r.state)) return false', '')],
    'a report with another outcome is accepted': [edit('adapter.js', "if (read.report && read.outcome !== 'ok') return SHAPE_ERROR", '')],
    'unknown keys in a read are accepted': [edit('adapter.js', "if (!onlyKeys(read, ['listed', 'outcome', 'error_code', 'not_read_reason', 'source_now', 'remote_without_clock', 'report', 'native'])) return SHAPE_ERROR", '')],
    'a malformed read is read as no report': [edit('adapter.js', "const SHAPE_ERROR = Object.freeze({ outcome: 'error', error_code: 'adapter_shape' })", "const SHAPE_ERROR = Object.freeze({ outcome: 'no_report' })")],
  },
)

proves(
  'contract: an adapter that throws reads as error adapter_fault and its message never reaches the ledger; one that cannot list is recorded',
  (M) => {
    const r = rig(M)
    const f = M.coreConfig({ sources: { fixture: FIXTURE_CAPS } })
    const throwing = { source: 'fixture', list: () => [fixtureSession('a')], read: () => { throw new Error('CANARY-THROW-77') } }
    let rec = r.open({ now: T0, adapters: [throwing], config: f })
    rec.tick({ source: 'fixture', slotStart: T0, now: T0 })
    rec.close()
    const c = r.kinds('check')[0].body
    assert.equal(c.freshness, 'error')
    assert.equal(c.error_code, 'adapter_fault')
    const noList = { source: 'fixture', list: () => { throw new Error('CANARY-LIST-88') }, read: () => ({ outcome: 'error', error_code: 'unreachable' }) }
    rec = r.open({ now: T0 + 30 * MIN, adapters: [noList], config: f })
    must(() => rec.tick({ source: 'fixture', slotStart: T0 + 30 * MIN, now: T0 + 30 * MIN }), 'the tick')
    rec.close()
    assert.equal(r.kinds('system', (x) => x.body.event === 'source_unreadable').length, 1)
    const second = r.kinds('check').at(-1).body
    assert.equal(second.freshness, 'error', 'the session already tracked is read, and the read says why it failed')
    assert.equal(second.error_code, 'unreachable')
    assert.ok(!/CANARY/.test(fs.readFileSync(r.ledgerFile, 'utf8')))
  },
  {
    'a throwing read is read as no report': [edit('adapter.js', 'return FAULT_ERROR\n  }\n}\n\n/** Call an adapter\'s `list`', "return { outcome: 'no_report' }\n  }\n}\n\n/** Call an adapter's `list`")],
    'a throwing list is not caught': [edit('adapter.js', 'return validateList(sealed.list(), sealed.source)\n  } catch {\n    return null', 'return validateList(sealed.list(), sealed.source)\n  } catch (e) {\n    throw e')],
  },
)

proves(
  'contract: a listing of another source\'s sessions, or a malformed one, is an unlistable source',
  (M) => {
    for (const list of [[fixtureSession('a', 'other')], [{ session: { source: 'fixture', native_id: '' }, scope: null }], 'x', [{ session: { source: 'fixture', native_id: 'a' }, extra: 1 }]]) {
      const r = rig(M)
      const f = M.coreConfig({ sources: { fixture: FIXTURE_CAPS } })
      const rec = r.open({ now: T0, adapters: [fixtureAdapter('fixture', { list, read: { outcome: 'no_report' } })], config: f })
      rec.tick({ source: 'fixture', slotStart: T0, now: T0 })
      rec.close()
      assert.equal(r.kinds('system', (x) => x.body.event === 'source_unreadable').length, 1)
      assert.equal(r.kinds('check').length, 0)
    }
  },
  { 'a session of another source is accepted': [edit('adapter.js', 's.source !== source || ', '')] },
)

proves(
  'contract: a tick reports source, checked-at, last-report-at, state and freshness for each session, graded by the reconciler',
  (M) => {
    const r = rig(M)
    r.writeState([entry('s1', { state: 'running', updatedAt: T0 - 30 * MIN })])
    const res = r.ticks([T0])
    assert.deepEqual(res.reads, [{ source: 'chroxy-state-file', session: 's1', checked_at: T0, last_report_at: T0 - 30 * MIN, state: 'running', freshness: 'aging', freshness_reason: null, error_code: null }])
  },
)

void path
void SRC
void REAL
