/**
 * The session-registry adapter: activity evidence only (a session it reads can
 * never be graded fresh), the registry's title and other fields never reaching
 * the ledger, and a changed shape yielding `error`, never `idle`. Each guard
 * has a mutant that must fail its check.
 */

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { MIN, REAL, T0, cleanupTmp, cleanupVariants, rig, mustKill } from './helpers/harness.js'

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
const ADAPTER = 'session-registry-adapter.js'

/** One registry row as the tool writes it, plus fields this adapter must never read. */
const row = (id, o = {}) => ({ pid: 4242, sessionId: id, cwd: '/work/project-a', status: 'idle', statusUpdatedAt: T0 - MIN, entrypoint: 'cli', name: 'a session title', startedAt: T0 - 60 * MIN, ...o })

/** A registry directory beside the rig's ledger, and the adapters over it. */
function registry(r, M, opts = {}) {
  const dir = path.join(r.root, 'registry')
  fs.mkdirSync(dir, { recursive: true })
  return {
    dir,
    put: (pid, obj) => fs.writeFileSync(path.join(dir, `${pid}.json`), typeof obj === 'string' ? obj : JSON.stringify(obj)),
    remove: (pid) => fs.rmSync(path.join(dir, `${pid}.json`)),
    adapters: () => [M.createSessionRegistryAdapter({ dir, ...opts })],
  }
}
const REG = 'claude-session-registry'
const ticks = (r, g, times) => r.ticks(times, { source: REG, adapters: g.adapters() })

proves(
  'activity only: a registry session carries activity evidence and is never graded fresh',
  (M) => {
    const r = rig(M)
    const g = registry(r, M)
    g.put(11, row('busy-1', { status: 'busy', statusUpdatedAt: T0 - MIN, entrypoint: 'desktop' }))
    g.put(12, row('idle-1', { status: 'idle', statusUpdatedAt: T0, cwd: '/work/project-b/' }))
    for (const at of [T0, T0 + 10 * 24 * 60 * MIN]) {
      ticks(r, g, [at])
      const checks = r.kinds('check', (c) => c.body.checked_at === at)
      assert.equal(checks.length, 2, 'both sessions are checked')
      for (const c of checks) {
        assert.equal(c.body.outcome, 'no_report')
        assert.equal(c.body.freshness, 'unknown')
        assert.equal(c.body.freshness_reason, 'no_status_line')
        assert.equal(c.body.state, 'none')
        assert.equal(c.body.native_available, true)
        assert.equal(c.body.report_id, null)
      }
      assert.deepEqual(checks.map((c) => c.body.scope).sort(), ['project-a', 'project-b'])
    }
    assert.equal(r.kinds('report').length, 0, 'a registry row is never a report')
    const acts = r.kinds('activity')
    const busy = acts.filter((a) => a.session.native_id === 'busy-1')
    assert.deepEqual(busy.map((a) => [a.body.basis, a.body.ref, a.body.activity_at, a.body.evidence_class]).sort(), [['busy_now_turn', null, null, 'E1'], ['busy_now_turn', null, null, 'E1'], ['registry_busy', 'desktop', T0 - MIN, 'E1']])
    const idle = acts.filter((a) => a.session.native_id === 'idle-1')
    assert.deepEqual(idle.map((a) => [a.body.basis, a.body.ref, a.body.activity_at]), [['registry_idle', 'cli', T0]])
  },
  {
    'a row is reported as a fresh running status': [edit(ADAPTER, "return { outcome: 'no_report', native:", "return { outcome: 'ok', report: { state: 'running', last_report_at: row.since, declared_via: 'marker' }, native:")],
    'no native activity is returned': [edit(ADAPTER, 'native: { turn_in_flight: row.busy, events: [{ basis, ref: row.app, activity_at: row.since }] } }', 'native: undefined }')],
    'the source has no capabilities in the configuration': [edit('core.js', '[REGISTRY_SOURCE]: REGISTRY_CAPS, ', '')],
  },
)

proves(
  'content: a title, an unknown field and a raw entrypoint never reach the ledger',
  (M) => {
    const r = rig(M)
    const g = registry(r, M)
    g.put(21, row('s-1', { status: 'busy', name: 'PLANTED-TITLE-7f3a', extra: { nested: 'PLANTED-NESTED-7f3a' }, entrypoint: 'Planted Entry 7f3a!' }))
    g.put(22, row('s-2', { name: 'PLANTED-TITLE-7f3a' }))
    ticks(r, g, [T0, T0 + 30 * MIN])
    const text = fs.readFileSync(r.ledgerFile, 'utf8').toLowerCase()
    assert.ok(text.includes('s-1'), 'the session is in the ledger')
    assert.ok(!text.includes('planted'), 'nothing planted in the registry reached the ledger')
    assert.ok(!text.includes('a session title'))
    const ev = r.kinds('activity', (a) => a.body.basis === 'registry_busy')
    assert.equal(ev[0].body.ref, 'other', 'an entrypoint that is not a short token is other')
  },
  {
    'the title becomes the scope': [edit(ADAPTER, 'project: projectOf(cwd)', 'project: String(doc.name)')],
    'the raw entrypoint becomes the application': [edit(ADAPTER, "return validSourceName(t) ? t : 'other'", 'return entrypoint')],
  },
)

proves(
  'cwd: the project is the last path segment, made safe to store',
  (M) => {
    const r = rig(M)
    const g = registry(r, M)
    g.put(1, row('a', { cwd: '/Users/someone/Projects/my-repo/' }))
    g.put(2, row('b', { cwd: 'C:\\work\\proj' }))
    g.put(3, row('c', { cwd: '/' }))
    g.put(4, row('d', { cwd: '/x/bad;name<y>' }))
    const list = g.adapters()[0].list()
    assert.deepEqual(Object.fromEntries(list.map((e) => [e.session.native_id, e.scope])), { a: 'my-repo', b: 'proj', c: 'root', d: 'bad_name_y_' })
  },
  {
    'characters are not made safe': [edit(ADAPTER, ".replace(/[^A-Za-z0-9._@+ -]/g, '_')", '')],
    'the root has no name': [edit(ADAPTER, "safe === '' ? 'root' : safe", 'safe')],
  },
)

const VALID = () => row('s1', { status: 'busy' })
// Each is a registry whose shape the tool did not write, and the code it reads as. [name, [code, mutate(dir, put)]].
const CHANGED_SHAPES = {
  'status is outside busy and idle': ['shape_changed', (g) => g.put(5, row('s1', { status: 'sleeping' }))],
  'status is missing': ['shape_changed', (g) => g.put(5, { ...VALID(), status: undefined })],
  'the time is in seconds': ['shape_changed', (g) => g.put(5, row('s1', { statusUpdatedAt: Math.floor(T0 / 1000) }))],
  'the time is a string': ['shape_changed', (g) => g.put(5, row('s1', { statusUpdatedAt: 'now' }))],
  'the time is fractional': ['shape_changed', (g) => g.put(5, row('s1', { statusUpdatedAt: T0 + 0.5 }))],
  'sessionId is missing': ['shape_changed', (g) => g.put(5, { ...VALID(), sessionId: undefined })],
  'sessionId is a number': ['shape_changed', (g) => g.put(5, row(7))],
  'sessionId is not a token': ['shape_changed', (g) => g.put(5, row('a b<script>'))],
  'cwd is missing': ['shape_changed', (g) => g.put(5, { ...VALID(), cwd: undefined })],
  'entrypoint is missing': ['shape_changed', (g) => g.put(5, { ...VALID(), entrypoint: undefined })],
  'a row is an array': ['shape_changed', (g) => g.put(5, '[]')],
  'a row is null': ['shape_changed', (g) => g.put(5, 'null')],
  'a row is not JSON': ['parse_failed', (g) => g.put(5, '{ not json')],
  'a duplicate sessionId': ['shape_changed', (g) => (g.put(5, VALID()), g.put(6, VALID()))],
  'a row file is a directory': ['shape_changed', (g) => fs.mkdirSync(path.join(g.dir, '5.json'))],
  'a row file is a symlink': ['shape_changed', (g) => (g.put(900, VALID()), fs.symlinkSync(path.join(g.dir, '900.json'), path.join(g.dir, '5.json')))],
  'a row file is too large': ['too_large', (g) => g.put(5, row('s1', { pad: 'x'.repeat(2000) }))],
  'the directory is gone': ['source_missing', (g) => fs.rmSync(g.dir, { recursive: true })],
  'the registry is a file': ['shape_changed', (g) => (fs.rmSync(g.dir, { recursive: true }), fs.writeFileSync(g.dir, 'x'))],
}

proves(
  'shape: a changed registry shape yields error, never idle, never no_report, never a state',
  (M) => {
    for (const [name, [code, mutate]] of Object.entries(CHANGED_SHAPES)) {
      const r = rig(M)
      const g = registry(r, M, { maxFileBytes: 1000 })
      g.put(1, VALID())
      ticks(r, g, [T0]) // the session is tracked, as after any earlier tick
      const before = r.records().length
      fs.rmSync(path.join(g.dir, '1.json'))
      mutate(g)
      ticks(r, g, [T0 + 30 * MIN])
      const second = r.kinds('check').filter((c) => c.body.checked_at === T0 + 30 * MIN)
      assert.equal(second.length, 1, `${name}: the tracked session is still checked`)
      const b = second[0].body
      assert.equal(b.freshness, 'error', `${name}: freshness`)
      assert.equal(b.outcome, 'error', `${name}: outcome`)
      assert.equal(b.state, 'none', `${name}: no state is invented`)
      assert.equal(b.error_code, code, `${name}: code`)
      assert.equal(r.kinds('activity').length, 1 + 1, `${name}: no activity is recorded from an unreadable registry`)
      assert.equal(r.kinds('system', (s) => s.body.event === 'source_unreadable').length, 1, `${name}: the unreadable source is recorded`)
      assert.ok(r.records().length > before)
    }
  },
  {
    'a status outside busy and idle reads as idle': [edit(ADAPTER, "status !== 'busy' && status !== 'idle'", 'false')],
    'a time in seconds is accepted': [edit(ADAPTER, ' || statusUpdatedAt < MIN_EPOCH_MS', '')],
    'a sessionId that is not a token is accepted': [edit(ADAPTER, ' || !SESSION_ID_RE.test(sessionId)', '')],
    'a duplicate sessionId is accepted': [edit(ADAPTER, ' || rows.has(row.id)', '')],
    'a parse failure is skipped': [edit(ADAPTER, "return { error: 'parse_failed' }", 'continue')],
    'a row that is not a regular file is read': [edit(ADAPTER, "if (!e.isFile()) return { error: 'shape_changed' }", '')],
    'a large row is read': [edit(ADAPTER, '.size > maxFileBytes', '.size > Infinity')],
    'a missing directory is an empty registry': [edit(ADAPTER, "return { error: err?.code === 'ENOENT' ? 'source_missing' : 'unreachable' }", 'return { rows: new Map() }')],
    'a registry that is a file is unreachable': [edit(ADAPTER, "if (err?.code === 'ENOTDIR') return { error: 'shape_changed' }", '')],
    'an unreadable registry reads as no report': [edit(ADAPTER, "if (snapshot.error) return { outcome: 'error', error_code: snapshot.error }", "if (snapshot.error) return { outcome: 'no_report' }")],
  },
)

proves(
  'shape: more rows than the limit is an error',
  (M) => {
    const r = rig(M)
    const g = registry(r, M, { maxFiles: 2 })
    g.put(1, row('a'))
    ticks(r, g, [T0])
    g.put(2, row('b'))
    g.put(3, row('c'))
    ticks(r, g, [T0 + 30 * MIN])
    const b = r.kinds('check').find((c) => c.body.checked_at === T0 + 30 * MIN).body
    assert.equal(b.freshness, 'error')
    assert.equal(b.error_code, 'too_large')
  },
  { 'the row count is unbounded': [edit(ADAPTER, 'candidates.length > maxFiles', 'false')] },
)

proves(
  'shape: files that are not row files are ignored, even when they are garbage',
  (M) => {
    const r = rig(M)
    const g = registry(r, M)
    g.put(1, row('a'))
    fs.writeFileSync(path.join(g.dir, 'notes.txt'), 'x')
    fs.writeFileSync(path.join(g.dir, 'abc.json'), '{ not json')
    fs.writeFileSync(path.join(g.dir, '12.json.bak'), '{ not json')
    fs.writeFileSync(path.join(g.dir, '.DS_Store'), '\0\0')
    fs.mkdirSync(path.join(g.dir, 'sub'))
    ticks(r, g, [T0])
    const checks = r.kinds('check')
    assert.deepEqual(checks.map((c) => [c.session.native_id, c.body.outcome]), [['a', 'no_report']])
  },
  { 'every file is read as a row': [edit(ADAPTER, 'const ROW_FILE_RE = /^[0-9]{1,10}\\.json$/', 'const ROW_FILE_RE = /./')] },
)

proves(
  'activity: a changed status is one new event, an unchanged one is not repeated, a vanished row is not listed',
  (M) => {
    const r = rig(M)
    const g = registry(r, M)
    g.put(1, row('a', { status: 'busy', statusUpdatedAt: T0 - 10 * MIN }))
    ticks(r, g, [T0])
    ticks(r, g, [T0 + 30 * MIN])
    g.put(1, row('a', { status: 'idle', statusUpdatedAt: T0 + 5 * MIN }))
    ticks(r, g, [T0 + 60 * MIN])
    ticks(r, g, [T0 + 90 * MIN])
    const ev = r.kinds('activity', (a) => a.body.basis.startsWith('registry_')).map((a) => [a.body.basis, a.body.activity_at])
    assert.deepEqual(ev, [['registry_busy', T0 - 10 * MIN], ['registry_idle', T0 + 5 * MIN]])
    g.remove(1)
    ticks(r, g, [T0 + 120 * MIN])
    const last = r.kinds('check').find((c) => c.body.checked_at === T0 + 120 * MIN).body
    assert.equal(last.listed, false)
    assert.equal(last.freshness, 'unknown')
    assert.equal(last.freshness_reason, 'not_listed')
  },
  {
    'busy and idle swap bases': [edit(ADAPTER, "busy: 'registry_busy', idle: 'registry_idle'", "busy: 'registry_idle', idle: 'registry_busy'")],
  },
)

proves(
  'time: a row dated well past the check time is error clock_skew',
  (M) => {
    const r = rig(M)
    const g = registry(r, M)
    g.put(1, row('near', { statusUpdatedAt: T0 + 4 * MIN }))
    g.put(2, row('far', { statusUpdatedAt: T0 + 10 * MIN }))
    ticks(r, g, [T0])
    const by = Object.fromEntries(r.kinds('check').map((c) => [c.session.native_id, c.body]))
    assert.equal(by.near.outcome, 'no_report')
    assert.equal(by.far.outcome, 'error')
    assert.equal(by.far.error_code, 'clock_skew')
  },
  { 'a future time is accepted': [edit(ADAPTER, 'row.since - now > MAX_FUTURE_MS', 'false')] },
)

proves(
  'read-only: ticking over a registry changes nothing in it',
  (M) => {
    const r = rig(M)
    const g = registry(r, M)
    g.put(1, row('a', { status: 'busy' }))
    fs.writeFileSync(path.join(g.dir, 'notes.txt'), 'keep')
    const snap = () => fs.readdirSync(g.dir).sort().map((f) => [f, fs.readFileSync(path.join(g.dir, f), 'utf8'), fs.statSync(path.join(g.dir, f)).mtimeMs])
    const before = snap()
    ticks(r, g, [T0, T0 + 30 * MIN])
    assert.deepEqual(snap(), before)
  },
  { 'the adapter writes a file into the registry': [edit(ADAPTER, '    let text\n', "    fs.writeFileSync(path.join(dir, 'x.tmp'), '')\n    let text\n")] },
)

proves(
  'contract: the source name is validated by the shared rule',
  (M) => {
    for (const source of ['Bad Name', '', '1abc', 'a'.repeat(65)]) {
      assert.throws(() => M.createSessionRegistryAdapter({ dir: '/x', source }), TypeError, `source ${JSON.stringify(source)}`)
    }
    assert.equal(M.createSessionRegistryAdapter({ dir: '/x', source: 'my-registry' }).source, 'my-registry')
    assert.throws(() => M.createSessionRegistryAdapter({ dir: '' }), TypeError)
    assert.deepEqual(Object.keys(M.createSessionRegistryAdapter({ dir: '/x' })).sort(), ['list', 'read', 'source'])
  },
  { 'any source name is accepted': [edit(ADAPTER, "if (!validSourceName(source)) throw new TypeError('createSessionRegistryAdapter: source must be a short lowercase name')", '')] },
)
