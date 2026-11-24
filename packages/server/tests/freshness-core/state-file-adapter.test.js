/**
 * The state-file adapter: declared-status fields only, a shape check on every
 * read, `error` and never `idle` on a changed shape, content outside the
 * status fields never reaching the ledger. Each guard has a mutant that must
 * fail its check.
 */

import { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { MIN, REAL, STATE_SOURCE, T0, cleanupTmp, cleanupVariants, entry, proves, rig } from './helpers.js'

afterEach(() => cleanupTmp())
process.on('exit', cleanupVariants)

const edit = (file, from, to) => ({ file, from, to })
const good = (updatedAt = T0 - MIN) => entry('s1', { state: 'running', next: 'build', updatedAt })

// Each is a state file whose shape the daemon did not write. [name, content].
const CHANGED_SHAPES = {
  'not JSON': () => '{ not json',
  'a bare array': () => '[]',
  'another version': () => JSON.stringify({ version: 2, timestamp: T0, sessions: [good()] }),
  'sessions is not an array': () => JSON.stringify({ version: 1, timestamp: T0, sessions: { s1: good() } }),
  'an entry with no id': () => JSON.stringify({ version: 1, timestamp: T0, sessions: [good(), { name: 'x' }] }),
  'an entry that is not an object': () => JSON.stringify({ version: 1, timestamp: T0, sessions: [good(), 'x'] }),
  'a duplicate id': () => JSON.stringify({ version: 1, timestamp: T0, sessions: [good(), good()] }),
  'declaredStatus is null': () => JSON.stringify({ version: 1, timestamp: T0, sessions: [{ ...good(), declaredStatus: null }] }),
  'declaredStatus has an unknown key': () => JSON.stringify({ version: 1, timestamp: T0, sessions: [entry('s1', { state: 'running', updatedAt: T0 - MIN, flavour: 'new' })] }),
  'a state outside the enum': () => JSON.stringify({ version: 1, timestamp: T0, sessions: [entry('s1', { state: 'sleeping', updatedAt: T0 - MIN })] }),
  'updatedAt is a string': () => JSON.stringify({ version: 1, timestamp: T0, sessions: [entry('s1', { state: 'running', updatedAt: 'yesterday' })] }),
  'source is not a known writer': () => JSON.stringify({ version: 1, timestamp: T0, sessions: [entry('s1', { state: 'running', updatedAt: T0 - MIN, source: 'telepathy' })] }),
}

proves(
  'shape: a changed state-file shape yields error, never idle, never no_report, never a state',
  (M) => {
    for (const [name, content] of Object.entries(CHANGED_SHAPES)) {
      const r = rig(M)
      r.writeState([good()])
      r.ticks([T0]) // the session is tracked, as it would be after any earlier tick
      r.writeRaw(content())
      r.ticks([T0 + 30 * MIN])
      const second = r.kinds('check').filter((c) => c.body.checked_at === T0 + 30 * MIN)
      assert.equal(second.length, 1, `${name}: the tracked session is still checked`)
      const b = second[0].body
      assert.equal(b.freshness, 'error', `${name}: freshness`)
      assert.equal(b.outcome, 'error', `${name}: outcome`)
      assert.equal(b.state, 'none', `${name}: no state is invented`)
      assert.match(b.error_code, /^(shape_changed|parse_failed)$/, `${name}: code`)
      assert.equal(r.kinds('report').length, 1, `${name}: nothing new is reported`)
    }
  },
  {
    'another version is accepted': [edit('state-file-adapter.js', 'doc.version !== 1 || ', '')],
    'a bad declaration reads as no report': [edit('state-file-adapter.js', "if (!parsed.success) return { outcome: 'error', error_code: 'shape_changed' }", "if (!parsed.success) return { outcome: 'no_report' }")],
    'an unreadable file reads as no report': [edit('state-file-adapter.js', "if (snapshot.error) return { outcome: 'error', error_code: snapshot.error }", "if (snapshot.error) return { outcome: 'no_report' }")],
    'a duplicate id is accepted': [edit('state-file-adapter.js', ' || byId.has(entry.id)', '')],
    'a parse failure reads as an empty file': [edit('state-file-adapter.js', "return { error: 'parse_failed' }", 'return { byId: new Map() }')],
    'the declaration is not shape-checked': [edit('state-file-adapter.js', 'DeclaredStatusSchema.safeParse(raw)', '{ success: true, data: raw }')],
  },
)

proves(
  'shape: an unreadable file with no session tracked yet is recorded, not read as an empty source',
  (M) => {
    const r = rig(M)
    r.writeRaw('{ not json')
    r.ticks([T0])
    const sys = r.kinds('system', (x) => x.body.event === 'source_unreadable')
    assert.equal(sys.length, 1)
    assert.equal(sys[0].id, REAL.keys.systemKey('source_unreadable', [r.kinds('tick')[0].body.tick_id]))
    const close = r.kinds('tick').find((t) => t.body.phase === 'close')
    assert.equal(close.body.source_listed, false)
    // a missing file is a missing source, also an error once a session is tracked
    const r2 = rig(M)
    r2.writeState([good()])
    r2.ticks([T0])
    fs.rmSync(r2.stateFile)
    r2.ticks([T0 + 30 * MIN])
    const c = r2.kinds('check').find((x) => x.body.checked_at === T0 + 30 * MIN).body
    assert.equal(c.freshness, 'error')
    assert.equal(c.error_code, 'source_missing')
  },
  { 'an unlistable source is not recorded': [edit('core.js', "yield put({ kind: 'system', id: systemKey('source_unreadable', [tid])", "void ({ kind: 'system', id: systemKey('source_unreadable', [tid])")] },
)

proves(
  'shape: a session with no declaration is unknown, a session that left the file is not listed, and neither is an error or a state',
  (M) => {
    const r = rig(M)
    r.writeState([entry('a', null), good()])
    r.ticks([T0])
    r.writeState([good()])
    r.ticks([T0 + 30 * MIN])
    const checks = r.kinds('check')
    const a1 = checks.find((c) => c.session.native_id === 'a' && c.body.checked_at === T0).body
    assert.equal(a1.freshness, 'unknown')
    assert.equal(a1.freshness_reason, 'no_status_line')
    const a2 = checks.find((c) => c.session.native_id === 'a' && c.body.checked_at === T0 + 30 * MIN).body
    assert.equal(a2.listed, false)
    assert.equal(a2.freshness_reason, 'not_listed')
    assert.equal(r.kinds('report').length, 1)
    const direct = M.createStateFileAdapter({ path: r.stateFile })
    direct.list()
    assert.deepEqual(direct.read({ source: STATE_SOURCE, native_id: 'gone', incarnation: null }), { listed: false })
  },
  {
    'a missing declaration reads as an error': [edit('state-file-adapter.js', "if (raw === undefined) return { outcome: 'no_report' }", "if (raw === undefined) return { outcome: 'error', error_code: 'shape_changed' }")],
    'a session that left the file is still read': [edit('state-file-adapter.js', 'if (!snapshot.byId.has(session.native_id)) return { listed: false }', '')],
  },
)

// ── content outside the status fields ──────────────────────────────────
const CANARIES = ['CANARY-TOP-7f3a', 'CANARY-NAME-2b9c', 'CANARY-CWD-81de', 'CANARY-HISTORY-c04f', 'CANARY-SUMMARY-5a17', 'CANARY-ACTIVITY-9e62', 'CANARY-EXTRA-31bd']

proves(
  'planted content: nothing outside the status fields leaves a trace in the ledger',
  (M) => {
    const [top, name, cwd, history, summary, activity, extra] = CANARIES
    const planted = (id, declared) => ({
      id,
      name,
      cwd,
      history: [{ type: 'response', text: history }],
      sdkSessionId: extra,
      decisionActivity: { startedAt: 5, endedAt: 4, note: activity },
      ...(declared ? { declaredStatus: { source: 'marker', summary, ...declared } } : {}),
    })
    const r = rig(M)
    r.writeState([planted('s1', { state: 'running', next: 'build', updatedAt: T0 - MIN }), planted('s2', null), planted('s3', { state: 'blocked', blockedOn: 'a wait', decision: 'pick one', updatedAt: T0 - MIN, etaMinutes: 5 })], { canary: top })
    r.ticks([T0, T0 + 30 * MIN])
    const ledgerText = fs.readFileSync(r.ledgerFile, 'utf8')
    for (const c of CANARIES) assert.ok(!ledgerText.includes(c), `${c} reached the ledger`)
    // the status fields themselves did arrive, so the scan above is not vacuous
    const byId = Object.fromEntries(r.kinds('report').map((x) => [x.session.native_id, x.body]))
    assert.ok(byId.s1 && byId.s3, 'the status fields arrived')
    assert.equal(byId.s1.next, 'build')
    assert.equal(byId.s3.declared_blocked_on, 'a wait')
    assert.equal(byId.s3.decision, 'pick one')
    assert.equal(r.kinds('check').filter((c) => c.body.freshness === 'error').length, 0, 'planted keys are not a shape change')
  },
  {
    'the summary text is copied into the report': [edit('state-file-adapter.js', 'next: declared.next ?? null,', 'next: declared.next ?? declared.summary ?? null,')],
    'the whole entry is carried forward': [edit('state-file-adapter.js', 'byId.set(entry.id, entry.declaredStatus)', 'byId.set(entry.id, { ...entry.declaredStatus, name: entry.name })')],
  },
)

proves(
  'planted content: content planted where the shape check fails reaches the ledger as neither a value nor an error code',
  (M) => {
    const r = rig(M)
    r.writeState([good()])
    r.ticks([T0])
    r.writeState([entry('s1', { state: 'CANARY-STATE-aa11', updatedAt: T0 - MIN, 'CANARY-KEY-bb22': 'CANARY-VALUE-cc33' })])
    r.ticks([T0 + 30 * MIN])
    const text = fs.readFileSync(r.ledgerFile, 'utf8')
    assert.ok(!/CANARY/.test(text))
    assert.equal(r.kinds('check').at(-1).body.error_code, 'shape_changed')
  },
  {
    'the parse error is copied into the code': [edit('state-file-adapter.js', "if (!parsed.success) return { outcome: 'error', error_code: 'shape_changed' }", "if (!parsed.success) return { outcome: 'error', error_code: String(parsed.error.issues[0].keys ?? parsed.error.issues[0].path).replace(/[^a-z_]/gi, '_').toLowerCase() }")],
  },
)

// ── read-only ──────────────────────────────────────────────────────────
proves(
  'read-only: ticks leave the state file, and everything beside it, exactly as it was',
  (M) => {
    const r = rig(M)
    r.writeState([good()])
    const before = { bytes: fs.readFileSync(r.stateFile), mtime: fs.statSync(r.stateFile).mtimeMs, dir: fs.readdirSync(r.root).sort() }
    r.ticks([T0, T0 + 30 * MIN])
    assert.deepEqual(fs.readFileSync(r.stateFile), before.bytes)
    assert.equal(fs.statSync(r.stateFile).mtimeMs, before.mtime)
    assert.deepEqual(fs.readdirSync(r.root).sort(), [...before.dir, 'ledger'].sort(), 'the only thing added beside the state file is the ledger directory')
    assert.deepEqual(fs.readdirSync(r.ledgerDir), ['ledger.jsonl'], 'the lock is released')
  },
  { 'the adapter rewrites the state file': [edit('state-file-adapter.js', "text = fs.readFileSync(path, 'utf8')", "text = fs.readFileSync(path, 'utf8'); fs.writeFileSync(path, text + ' ')")] },
)

// ── the daemon's parser and the field mapping ──────────────────────────
const FOOTER = ['Done with the change.', '', '**Status:**', '- ✅ Tests passed', '- 🔄 none', '- ⛔ Waiting on a target', '- 🔶 DECISION: Choose production or staging; recommend staging', '', '**Next:** 🔴 BLOCKED — Choose the target OWNER: the-owner'].join('\n')

proves(
  'parser: a four-slot status block is read with the daemon\'s own parser and mapped to a report; an example in a fence or a quote is not a declaration',
  (M) => {
    const rep = M.reportFromText(FOOTER, { updatedAt: T0 })
    assert.equal(rep.state, 'blocked')
    assert.equal(rep.declared_via, 'transcript')
    assert.equal(rep.last_report_at, T0)
    assert.equal(rep.declared_blocked_on, 'Waiting on a target')
    assert.equal(rep.decision, 'Choose production or staging; recommend staging')
    assert.equal(rep.decision_basis, 'stated')
    assert.equal(rep.owner_named, 'the-owner')
    assert.equal(M.reportFromText('```\n' + FOOTER + '\n```', { updatedAt: T0 }), null)
    assert.equal(M.reportFromText('no footer here', { updatedAt: T0 }), null)
  },
  {
    'the decision is not marked stated': [edit('state-file-adapter.js', "via === 'transcript' ? 'stated' : 'possibly_inherited'", "'possibly_inherited'")],
    'the owner is not read': [edit('state-file-adapter.js', 'owner_named: relayed ? null : ownerOf(declared.next),', 'owner_named: null,')],
    'the parser is replaced by one that accepts any text': [edit('state-file-adapter.js', 'const declared = extractDeclaredStatus(text)', "const declared = { state: 'running', next: text }")],
  },
)

void path
