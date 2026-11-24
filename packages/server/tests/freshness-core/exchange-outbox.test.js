/**
 * The owner queue in the core, and the outbox file it writes: the same item is
 * rendered once per key across restarts, a changed item is an `updated` record
 * of the same key, a second item about one session merges into the first, the
 * outbox holds only the declared fields and the templates' text, and a write
 * that fails is a failed delivery that is not made again. Each rule has a mutant
 * that must fail its check.
 */

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { FIXTURE_CAPS, HOUR, MIN, REAL, STATE_SOURCE, T0, cleanupTmp, cleanupVariants, entry, fixtureAdapter, mustKill, rig, tmp, xrig } from './helpers/harness.js'

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
const items = (r) => r.lines('item')

proves(
  'the same item is rendered once per key across restarts, and a later delivery of it has the same key',
  (M) => {
    const r = xrig(M)
    r.blocked()
    r.tick(T0)
    r.tick(T0 + 30 * MIN)
    r.tick(T0 + 45 * MIN)
    assert.equal(items(r).length, 1, 'three ticks, each a restart, rendered the item once')
    assert.equal(items(r)[0].op, 'post')
    assert.equal(r.lines('digest').length, 1, 'and its digest once')
    r.tick(T0 + 61 * MIN)
    const [first, reminder] = items(r)
    assert.equal(items(r).length, 2)
    assert.equal(reminder.op, 'repost', 'the reminder is a further delivery')
    assert.equal(reminder.step, 'reminded')
    assert.equal(reminder.key, first.key, 'of the same key')
    assert.notEqual(reminder.rec, first.rec)
    assert.equal(new Set(r.outbox().map((l) => l.rec)).size, r.outbox().length, 'every line has its own id')
    assert.deepEqual(r.conflicts(), [])
  },
  {
    'a key that changes on every restart': [edit('render.js', "H('outbox_key', itemId, episode).slice(0, KEY_LEN)", "H('outbox_key', itemId, episode, Math.random()).slice(0, KEY_LEN)")],
    'every delivery is a first post': [edit('exchange.js', 'const first = !prior && !ex.pendingKeys.has(key)', 'const first = true')],
    'the queue does not run': [edit('core.js', 'if (ctx.exchange) yield* planExchange(', 'if (false) yield* planExchange(')],
  },
)

proves(
  'a changed active item is an `updated` record with the same key, written once',
  (M) => {
    const r = xrig(M)
    r.blocked()
    r.tick(T0)
    const [first] = items(r)
    r.blocked({ blockedOn: 'the migration', updatedAt: T0 + 5 * MIN })
    r.tick(T0 + 10 * MIN)
    const updates = () => items(r).filter((l) => l.op === 'updated')
    assert.equal(updates().length, 1)
    assert.equal(updates()[0].key, first.key, 'the same key, so a consumer edits the message')
    assert.match(updates()[0].text, /the migration/)
    assert.equal(updates()[0].status, 'open')
    r.tick(T0 + 20 * MIN)
    r.tick(T0 + 25 * MIN)
    assert.equal(updates().length, 1, 'an unchanged item is not updated again')
    assert.deepEqual(r.conflicts(), [])
  },
  {
    'an update under another key': [edit('exchange.js', "rec, key: e.key, op: 'updated'", "rec, key: recId('x', e.key), op: 'updated'")],
    'an update on every tick': [edit('exchange.js', 'if (hash === e.hash) continue', '')],
  },
)

proves(
  'an item that closes is edited to say so, once',
  (M) => {
    const r = xrig(M)
    r.blocked()
    r.tick(T0)
    r.running(T0 + 5 * MIN)
    r.tick(T0 + 10 * MIN)
    r.tick(T0 + 20 * MIN)
    const closed = items(r).filter((l) => l.status === 'closed')
    assert.equal(closed.length, 1)
    assert.equal(closed[0].op, 'updated')
    assert.equal(closed[0].key, items(r)[0].key)
    assert.match(closed[0].text, /^Closed/)
  },
  { 'a closed item renders as open': [edit('render.js', 'if (!item.open) {', 'if (false) {')] },
)

proves(
  'the digest is one message: posted, then updated as the open items change',
  (M) => {
    const r = xrig(M)
    r.blocked()
    r.tick(T0)
    assert.equal(r.lines('digest').length, 1)
    const [digest] = r.lines('digest')
    assert.equal(digest.op, 'post')
    assert.match(digest.text, /Open items: 1\./)
    assert.equal(digest.status, 'open')
    r.running(T0 + 5 * MIN)
    r.tick(T0 + 10 * MIN)
    const digests = r.lines('digest')
    assert.equal(digests.length, 2)
    assert.equal(digests[1].op, 'updated')
    assert.equal(digests[1].key, digest.key)
    assert.equal(digests[1].text, 'No open items.')
    r.tick(T0 + 20 * MIN)
    assert.equal(r.lines('digest').length, 2, 'unchanged, not written again')
    // and nothing at all while there never was an item
    const empty = xrig(M)
    empty.running(T0)
    empty.tick(T0)
    assert.deepEqual(empty.outbox(), [])
  },
  {
    'no digest': [edit('exchange.js', 'if (prior ? prior.hash !== hash : d.count > 0) {', 'if (false) {')],
    'a digest that is always written': [edit('exchange.js', 'if (prior ? prior.hash !== hash : d.count > 0) {', 'if (true) {')],
    'a changed digest posted as new': [edit('exchange.js', "op: prior ? 'updated' : 'post', cls: 'digest'", "op: 'post', cls: 'digest'")],
  },
)

proves(
  'a second item about one session merges into the owner item (#9256): no attention item is raised or sent',
  (M) => {
    const r = xrig(M, { sources: { fixture: FIXTURE_CAPS } })
    let mode = 'ok'
    const adapter = fixtureAdapter('fixture', {
      list: [{ session: { source: 'fixture', native_id: 'a', incarnation: null }, scope: null }],
      read: () => (mode === 'ok' ? { outcome: 'ok', report: { state: 'blocked', last_report_at: T0 - 6 * HOUR, declared_via: 'marker', declared_blocked_on: 'x', decision: 'pick', decision_basis: 'stated' }, native: { turn_in_flight: false, busy_background: false, pending: [], events: [] } } : { outcome: 'error', error_code: 'boom' }),
    })
    const tick = (at) => {
      let rec
      try {
        rec = r.open({ now: at, config: r.cfg, adapters: [adapter], exchangeDir: r.exchangeDir })
        rec.tick({ source: 'fixture', slotStart: at, now: at })
      } catch (err) {
        if (err instanceof assert.AssertionError) throw err
        assert.fail(`a tick threw ${err.name}: ${err.message}`)
      } finally {
        rec?.close()
      }
    }
    tick(T0)
    mode = 'err'
    tick(T0 + 30 * MIN)
    const surfaces = r.kinds('surface').map((x) => x.body)
    assert.deepEqual([...new Set(surfaces.filter((b) => b.origin === 'attention').map((b) => b.step))], [], 'no attention item')
    assert.ok(surfaces.some((b) => b.origin === 'owner' && b.step === 'updated' && b.carry?.op === 'carry'), 'its condition is carried by the owner item')
    const owner = items(r).filter((l) => l.origin === 'owner')
    assert.equal(owner.length, 1, 'one message for the session')
    assert.match(owner[0].text, /status report went stale/, 'and it names the second condition')
    assert.equal(items(r).filter((l) => l.origin === 'attention').length, 0)
  },
  { 'an attention item raised beside the owner item': [edit('queue.js', "const obs = P.attentionBesideOwnerBlock === 'raise' ? [] : openOwnerBlocks(st, sig.sk)", 'const obs = []')] },
)

proves(
  'the outbox holds only the schema fields and what the templates make from the declared fields',
  (M) => {
    const r = xrig(M, { exchange: { text_field_max: 30 } })
    r.writeState([
      entry('s1', { state: 'blocked', blockedOn: 'before \u001b[31mred\u001b[0m after', decision: 'pick one of the following very long options please', updatedAt: T0 - MIN }, { name: 'CANARY-NAME', cwd: '/CANARY/cwd' }),
    ])
    r.tick(T0)
    const lines = r.outbox()
    assert.ok(lines.length >= 2)
    for (const l of lines) {
      assert.deepEqual(Object.keys(l), [...M.OUTBOX_FIELDS], 'exactly the schema, in order')
      assert.equal(l.v, M.OUTBOX_VERSION)
      assert.ok(M.OUTBOX_OPS.includes(l.op) && M.OUTBOX_CLASSES.includes(l.class))
      assert.match(l.rec, /^[0-9a-f]{32}$/)
      assert.match(l.key, /^[0-9a-f]{32}$/)
      assert.ok(!/CANARY|summary/.test(JSON.stringify(l)), 'nothing outside the declared fields')
    }
    const text = items(r)[0].text
    assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(text), 'no control character reaches the text')
    assert.match(text, /before \[31mred \[0m after/, 'the declared words are there, the escape character a space')
    const decision = text.split('\n').find((x) => x.startsWith('Decision: '))
    assert.ok(decision.length - 'Decision: '.length <= 30, 'each field is cut to the configured length')
    assert.ok(decision.endsWith('…'))
  },
  {
    'control characters left in': [edit('render.js', '.replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]+/g, \' \')', '')],
    'fields not cut': [edit('render.js', "return flat.length > max ? flat.slice(0, Math.max(0, max - 1)) + '…' : flat", 'return flat')],
  },
)

proves(
  'the outbox writer: one line per record, no repeated id after a restart, a cut-off tail left behind, no field outside the schema, a regular file only',
  (M) => {
    const dir = tmp()
    const file = path.join(dir, 'outbox.jsonl')
    const rec = (n, extra = {}) => ({ ...M.outboxRecord({ at: T0, rec: String(n).padStart(32, '0'), key: 'k'.repeat(32), op: 'post', cls: 'item', status: 'open', text: 'x'.repeat(n === 9 ? 5000 : 3) }), ...extra })
    assert.equal(M.openOutbox(file).append(rec(1)), 'written')
    assert.equal(M.openOutbox(file).append(rec(1)), 'duplicate', 'a record written again after a restart is not written twice')
    assert.equal(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 1)
    // a write the crash cut off: the next record starts on a line of its own
    fs.appendFileSync(file, '{"v":1,"rec":"cut')
    M.openOutbox(file).append(rec(2))
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    assert.equal(lines.length, 3)
    assert.equal(JSON.parse(lines[2]).rec, rec(2).rec)
    assert.throws(() => M.openOutbox(file).append(rec(3, { path: '/somewhere' })), /not in the schema/)
    assert.ok(M.outboxRecord({ at: T0, rec: 'r', key: 'k', op: 'post', cls: 'item', status: 'open', text: 'y'.repeat(5000) }).text.length <= 2000, 'text is capped')
    assert.ok(M.openOutbox(path.join(dir, 'sub', 'dir', 'outbox.jsonl')).append(rec(4)) === 'written', 'the directory is made')
  },
  {
    'no dedup on the record id': [edit('outbox.js', "if (tail.recs.has(record.rec)) return 'duplicate'", '')],
    'a cut-off tail is run into': [edit('outbox.js', "(tail.open ? '\\n' : '')", "''")],
    'any field is written': [edit('outbox.js', 'if (!OUTBOX_FIELDS.includes(k)) throw', 'if (false) throw')],
    'text is not capped': [edit('outbox.js', 'text: String(text).length > MAX_TEXT ? String(text).slice(0, MAX_TEXT - 1) + \'…\' : String(text),', 'text: String(text),')],
  },
)

describe('the outbox writer refuses a link', { skip: process.platform === 'win32' }, () => {
  const check = (M) => {
    const dir = tmp()
    const target = path.join(dir, 'target.txt')
    fs.writeFileSync(target, 'keep\n')
    const file = path.join(dir, 'outbox.jsonl')
    fs.symlinkSync(target, file)
    assert.throws(() => M.openOutbox(file).append(M.outboxRecord({ at: T0, rec: 'r'.padEnd(32, '0'), key: 'k'.repeat(32), op: 'post', cls: 'item', status: 'open', text: 't' })), /regular file/)
    assert.equal(fs.readFileSync(target, 'utf8'), 'keep\n', 'nothing was written through it')
  }
  it('holds on the real code', () => check(REAL))
  it('mutant "a link is followed" fails it', () => mustKill(check, 'a link is followed', [edit('outbox.js', "if (!fs.lstatSync(file).isFile()) throw new Error('outbox: the file is not a regular file')", '')]))
})

proves(
  'a write to the outbox that fails is a failed delivery, recorded, and is not made again',
  (M) => {
    const r = xrig(M)
    r.blocked()
    // the outbox path is a directory: nothing can be written to it
    fs.mkdirSync(r.outboxFile, { recursive: true })
    r.tick(T0)
    r.tick(T0 + 5 * MIN)
    const outcomes = r.attempts('outcome').filter((x) => x.body.step === 'shown')
    assert.equal(outcomes.length, 1, 'one attempt, never repeated')
    assert.equal(outcomes[0].body.outcome, 'failed')
    assert.deepEqual(r.conflicts(), [])
    fs.rmSync(r.outboxFile, { recursive: true })
    r.tick(T0 + 10 * MIN)
    assert.equal(r.attempts().filter((x) => x.body.step === 'shown').length, 1, 'a working outbox later does not bring the attempt back')
    assert.deepEqual(items(r).filter((l) => l.step === 'shown'), [])
  },
  { 'a failed write reported as delivered': [edit('exchange.js', "} catch {\n    return 'failed'\n  }", "} catch {\n    return 'delivered'\n  }")] },
)

proves(
  'the exchange directory may not be the ledger directory',
  (M) => {
    const r = rig(M)
    r.writeState([])
    assert.throws(() => r.open({ exchangeDir: r.ledgerDir }), /exchangeDir/)
    assert.throws(() => M.createExchange({ dir: 'relative/dir' }), TypeError)
  },
  { 'the same directory accepted': [edit('core.js', "if (exchangeDir !== undefined && path.resolve(exchangeDir) === path.resolve(dir)) throw", 'if (false) throw')] },
)

proves(
  'the deferral caps and the exchange limits have documented defaults, read from the configuration and never absent',
  (M) => {
    const cfg = M.coreConfig()
    assert.equal(cfg.surface.defer_max_minutes, 24 * 60)
    assert.equal(cfg.surface.defer_max_count, 3)
    assert.deepEqual(cfg.exchange, { max_file_bytes: 1048576, max_line_bytes: 1024, max_new_lines_per_tick: 200, max_rejects_per_tick: 20, text_field_max: 240, digest_max_items: 12 })
    assert.equal(M.deferLimits(cfg).maxMs, 24 * HOUR)
    assert.equal(M.deferLimits(M.coreConfig({ surface: { defer_max_minutes: 5, defer_max_count: 1 } })).maxMs, 5 * MIN, 'a configured cap is the cap')
    assert.deepEqual(M.deferLimits({}), { maxMs: 24 * HOUR, maxCount: 3 }, 'a configuration stored before the caps existed gets the defaults')
    assert.equal(M.exchangeLimits({ exchange: { text_field_max: 7 } }).text_field_max, 7)
    assert.equal(M.exchangeLimits({}).max_line_bytes, 1024)
  },
  {
    'a different default length': [edit('config.js', 'defer_max_minutes: 24 * 60,', 'defer_max_minutes: 10 * 24 * 60,')],
    'a different default count': [edit('config.js', 'defer_max_count: 3,', 'defer_max_count: 30,')],
    'the configured cap ignored': [edit('config.js', "const s = { ...DEFAULT_CONFIG.surface, ...(config?.surface ?? {}) }", 'const s = { ...DEFAULT_CONFIG.surface }')],
  },
)

void STATE_SOURCE
