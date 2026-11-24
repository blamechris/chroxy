/**
 * The Claude transcript reader: the last authored status block and its time,
 * read from the tail of a synthetic transcript, bounded; a damaged or changed
 * format is `error`; nothing but the block reaches the ledger; the file is only
 * opened read-only and only the provider's own files are opened. Each guard
 * has a mutant (an edit to a copy of `src`) that must fail its check.
 */

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { REAL_TREE, SRC, cleanupTmp, cleanupVariants, mustKillTree, rig } from '../freshness-core/helpers/harness.js'
import { MIN, SRC_NAME, T0, assistant, assistantBlocks, block, iso, jsonl, store, toolResult, user } from './helpers/transcripts.js'

afterEach(() => cleanupTmp())
process.on('exit', cleanupVariants)

const proves = (name, check, mutants = {}) =>
  describe(name, () => {
    it('holds on the real code', async () => {
      await check(REAL_TREE)
    })
    for (const [label, edits] of Object.entries(mutants)) it(`mutant "${label}" fails it`, () => mustKillTree(check, label, edits))
  })

const edit = (file, from, to) => ({ file, from, to })
const A = 'freshness-sources/claude-transcript-adapter.js'
const sid = (id) => ({ source: SRC_NAME, native_id: id, incarnation: null })
const adapterOf = (M, st, opts = {}) => M.createClaudeTranscriptAdapter({ projectsDir: st.projects, ...opts })
const readOf = (M, st, id, opts) => {
  const a = adapterOf(M, st, opts)
  a.list()
  return a.read(sid(id))
}
/** Run ticks over a store through the reconciler; the ledger is what the assertions read. */
const runTicks = (M, st, times = [T0], opts = {}) => {
  const r = rig(M)
  r.ticks(times, { adapters: [adapterOf(M, st, opts)], config: M.coreConfig({ sources: { [SRC_NAME]: M.CLAUDE_TRANSCRIPT_CAPS } }), source: SRC_NAME })
  return r
}
const lastCheck = (r) => r.kinds('check').at(-1).body

// ── the last authored block and its time ───────────────────────────────
proves(
  'fixtures: the last status block the assistant authored, and its time',
  (M) => {
    const st = store()
    const blocked = block({ done: 'built it', blocked: 'a review', decision: 'ship now or wait; recommend wait', next: '🔴 BLOCKED — Review the change OWNER: the-owner' })
    st.write('s1', jsonl([
      user('please start', T0 - 4 * 60 * MIN),
      assistant(block({ next: '🟢 RUNNING — keep going (agent)' }), T0 - 3 * 60 * MIN),
      assistant('Some prose with no block.', T0 - 40 * MIN),
      assistant(`Finished.\n\n${blocked}`, T0 - 20 * MIN),
      // none of these were authored by the session as its own status
      user(`quoting an old reply:\n\n${block({ next: '🟢 RUNNING — quoted' })}`, T0 - 5 * MIN),
      toolResult(block({ next: '🟢 RUNNING — tool output' }), T0 - 4 * MIN),
      assistant(block({ next: '🟢 RUNNING — a subagent' }), T0 - 2 * MIN, { isSidechain: true }),
    ]))
    const rep = readOf(M, st, 's1')
    assert.equal(rep.outcome, 'ok')
    assert.equal(rep.report.state, 'blocked')
    assert.equal(rep.report.last_report_at, T0 - 20 * MIN)
    assert.equal(rep.report.declared_via, 'transcript')
    assert.equal(rep.report.declared_blocked_on, 'a review')
    assert.equal(rep.report.decision, 'ship now or wait; recommend wait')
    assert.equal(rep.report.decision_basis, 'stated')
    assert.equal(rep.report.owner_named, 'the-owner')
    assert.equal(rep.report.later_unfootered_messages, false)

    // the same, through the reconciler: one report, timed by when it was authored
    const r = runTicks(M, st)
    const reports = r.kinds('report')
    assert.equal(reports.length, 1)
    assert.equal(reports[0].body.last_report_at, T0 - 20 * MIN)
    assert.equal(reports[0].body.report_time_basis, 'authored_at')
    assert.equal(lastCheck(r).state, 'blocked')
  },
  {
    'the first block is kept, not the last': [edit(A, 'last = report.last_report_at < 0 ? { badTime: true } : { report }\n      later = false', 'last = last ?? (report.last_report_at < 0 ? { badTime: true } : { report })\n      later = false')],
    'a user entry counts as authored': [edit(A, "if (entry.type !== 'assistant' || entry.isSidechain === true) continue", "if (entry.type !== 'assistant' && entry.type !== 'user') continue\n    if (entry.isSidechain === true) continue")],
    'a subagent entry counts as authored': [edit(A, "if (entry.type !== 'assistant' || entry.isSidechain === true) continue", "if (entry.type !== 'assistant') continue")],
    'the block is timed with the read time instead of its own': [edit(A, 'const report = reportFromText(text, { updatedAt: Number.isSafeInteger(at) && at >= 0 ? at : -1 })', 'const report = reportFromText(text, { updatedAt: T0_NOW })'), edit(A, 'const AMBIGUOUS', 'const T0_NOW = Date.now()\nconst AMBIGUOUS')],
  },
)

proves(
  'fixtures: a later assistant message with no block is marked, and a later block clears the mark',
  (M) => {
    const st = store()
    st.write('s1', jsonl([assistant(block(), T0 - 30 * MIN), assistant('I am looking at something else now.', T0 - 10 * MIN)]))
    st.write('s2', jsonl([assistant('prose', T0 - 40 * MIN), assistant(block(), T0 - 30 * MIN), assistantBlocks([{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } }], T0 - 10 * MIN)]))
    st.write('s3', jsonl([assistant(block(), T0 - 30 * MIN), assistant('more prose', T0 - 20 * MIN), assistant(block(), T0 - 10 * MIN)]))
    assert.equal(readOf(M, st, 's1').report.later_unfootered_messages, true)
    assert.equal(readOf(M, st, 's2').report.later_unfootered_messages, false, 'a tool call is not a message')
    assert.equal(readOf(M, st, 's3').report.later_unfootered_messages, false)
  },
  {
    'the mark is never set': [edit(A, '      later = true', '      later = false')],
    'the mark is not cleared by a later block': [edit(A, 'last = report.last_report_at < 0 ? { badTime: true } : { report }\n      later = false', 'last = report.last_report_at < 0 ? { badTime: true } : { report }')],
  },
)

proves(
  'fixtures: a transcript with no status block is no report; an empty one too; a block quoted in a fence is not one',
  (M) => {
    const st = store()
    st.write('none', jsonl([user('hi', T0 - MIN), assistant('hello', T0 - MIN)]))
    st.write('empty', '')
    st.write('fenced', jsonl([assistant('An example:\n\n```\n' + block() + '\n```', T0 - MIN)]))
    for (const id of ['none', 'empty', 'fenced']) assert.deepEqual(readOf(M, st, id), { outcome: 'no_report' }, id)
  },
  {},
)

// ── bounded reads ──────────────────────────────────────────────────────
const filler = (i) => assistantBlocks([{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: 'x'.repeat(200) } }], T0 - 2 * 60 * MIN)

proves(
  'bounded: only the end of the file is read, the line the window starts inside is dropped, and a window inside one line is an error',
  (M) => {
    const cap = 2048
    const st = store()
    // a block only at the top is outside the window
    st.write('old', jsonl([assistant(block({ next: '🟢 RUNNING — OLD-BLOCK-AT-TOP (agent)' }), T0 - 3 * 60 * MIN), ...Array.from({ length: 80 }, (_, i) => filler(i))]))
    assert.deepEqual(readOf(M, st, 'old', { maxTailBytes: cap }), { outcome: 'no_report' })
    // a block inside the window is found, wherever the window starts. Pad until it starts inside a line.
    for (let pad = 0; ; pad++) {
      const text = jsonl([...Array.from({ length: 60 }, (_, i) => filler(i)), assistant(block({ next: '🟢 RUNNING — NEW-BLOCK-AT-END (agent)' }), T0 - 5 * MIN)]) + ' '.repeat(pad)
      const buf = Buffer.from(text)
      const start = buf.length - cap - 1
      if (buf[start] !== 10 && buf[start - 1] !== 10 && buf[start + 1] !== 10) {
        st.write('new', text.trimEnd() + '\n')
        break
      }
      assert.ok(pad < 50, 'a window that starts inside a line is built')
    }
    const got = readOf(M, st, 'new', { maxTailBytes: cap })
    assert.equal(got.outcome, 'ok')
    assert.match(got.report.next, /NEW-BLOCK-AT-END/)
    // one line longer than the window: nothing can be said about it
    st.write('huge', jsonl([assistant('y'.repeat(20000), T0 - MIN)]))
    assert.deepEqual(readOf(M, st, 'huge', { maxTailBytes: cap }), { outcome: 'error', error_code: 'tail_too_small' })
  },
  {
    'the whole file is read': [edit(A, 'const start = size > maxTailBytes ? size - maxTailBytes - 1 : 0', 'const start = 0')],
    'a line cut by the window is parsed': [edit(A, 'from = buf[0] === NEWLINE ? 1 : buf.indexOf(NEWLINE) + 1', 'from = 0')],
    'a window inside one line is read as empty': [edit(A, "if (from === 0 || from >= off) return fail('tail_too_small')", '')],
  },
)

proves(
  'bounded: a torn last line is ignored, a bad line before it is a damaged transcript, an unreadable size limit is refused',
  (M) => {
    const st = store()
    const good = jsonl([assistant(block({ next: '🟢 RUNNING — before the tear (agent)' }), T0 - 5 * MIN)])
    st.write('torn', good + '{"type":"assistant","message":{"role":"assistant","content":[{"type":"te')
    const torn = readOf(M, st, 'torn')
    assert.equal(torn.outcome, 'ok')
    assert.match(torn.report.next, /before the tear/)
    st.write('damaged', good + '{"type":"assistant","mess\n' + jsonl([assistant('later', T0 - MIN)]))
    assert.deepEqual(readOf(M, st, 'damaged'), { outcome: 'error', error_code: 'corrupt' })
    assert.throws(() => adapterOf(M, st, { maxTailBytes: 10 }), TypeError)
  },
  {
    'a torn last line is an error': [edit(A, 'if (i === lines.length - 1) continue', '')],
    'a damaged line is skipped': [edit(A, "return fail('corrupt')", 'continue')],
    'any window size is accepted': [edit(A, "if (!Number.isSafeInteger(maxTailBytes) || maxTailBytes < 1024) throw new TypeError('createClaudeTranscriptAdapter: maxTailBytes must be an integer of at least 1024')", '')],
  },
)

// ── a changed format is an error ───────────────────────────────────────
const CHANGED = {
  'assistant content is a string': () => jsonl([{ type: 'assistant', timestamp: iso(T0 - MIN), message: { role: 'assistant', content: block() } }]),
  'assistant entry has no message': () => jsonl([{ type: 'assistant', timestamp: iso(T0 - MIN) }]),
  'an entry has no type': () => jsonl([{ role: 'assistant', text: block() }]),
  'a line is not an object': () => jsonl(['[1,2]']),
  'a content block has no type': () => jsonl([assistantBlocks([{ text: block() }], T0 - MIN)]),
  'a text block has no text': () => jsonl([assistantBlocks([{ type: 'text' }], T0 - MIN)]),
  'the block has no timestamp': () => jsonl([{ ...assistant(block(), T0 - MIN), timestamp: undefined }]),
  'the block has an unreadable timestamp': () => jsonl([{ ...assistant(block(), T0 - MIN), timestamp: 'yesterday' }]),
}

proves(
  'format: a changed or unreadable format is error, never no report, never a state, never a report',
  (M) => {
    for (const [name, content] of Object.entries(CHANGED)) {
      const st = store()
      st.write('s1', content())
      const r = runTicks(M, st)
      const c = lastCheck(r)
      assert.equal(c.freshness, 'error', `${name}: freshness`)
      assert.equal(c.outcome, 'error', `${name}: outcome`)
      assert.equal(c.state, 'none', `${name}: no state is invented`)
      assert.match(c.error_code, /^(shape_changed|bad_timestamp)$/, `${name}: code`)
      assert.equal(r.kinds('report').length, 0, `${name}: nothing is reported`)
    }
    // the same file is read normally once it is in the format again
    const st = store()
    st.write('s1', jsonl([assistant(block(), T0 - MIN)]))
    assert.equal(lastCheck(runTicks(M, st)).outcome, 'ok')
  },
  {
    'a string content is skipped': [edit(A, "if (!isPlain(entry.message) || !Array.isArray(content)) return fail('shape_changed')", 'if (!Array.isArray(content)) continue')],
    'an entry with no type is skipped': [edit(A, "if (!isPlain(entry) || typeof entry.type !== 'string') return fail('shape_changed')", "if (!isPlain(entry) || typeof entry.type !== 'string') continue")],
    'a typeless block is skipped': [edit(A, "if (!isPlain(block) || typeof block.type !== 'string') return fail('shape_changed')", "if (!isPlain(block) || typeof block.type !== 'string') continue")],
    'a text block with no text is skipped': [edit(A, "if (typeof block.text !== 'string') return fail('shape_changed')", "if (typeof block.text !== 'string') continue")],
    'an unreadable time reads as no report': [edit(A, "if (last.badTime) return fail('bad_timestamp')", "if (last.badTime) return { outcome: 'no_report' }")],
  },
)

// ── content outside the status block ───────────────────────────────────
const CANARIES = ['CANARY-PROMPT-7f3a', 'CANARY-TOOLIN-2b9c', 'CANARY-TOOLOUT-81de', 'CANARY-THINK-c04f', 'CANARY-SUMMARY-5a17', 'CANARY-PROSE-9e62', 'CANARY-OLDBLOCK-31bd', 'CANARY-DIR-44aa', 'CANARY-KEY-b5c6', 'CANARY-OTHER-d7e8']

proves(
  'planted content: nothing outside the status block leaves a trace in the ledger',
  (M) => {
    const [prompt, toolIn, toolOut, think, summary, prose, oldBlock, dir, key, other] = CANARIES
    const st = store()
    st.write('s1', jsonl([
      { ...user(prompt, T0 - 90 * MIN), cwd: `/work/${key}`, gitBranch: key, customTitle: key },
      assistantBlocks([{ type: 'thinking', thinking: think, signature: key }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: `echo ${toolIn}` } }], T0 - 80 * MIN),
      toolResult(toolOut, T0 - 70 * MIN),
      assistant(block({ done: oldBlock, next: `🟢 RUNNING — ${oldBlock} (agent)` }), T0 - 60 * MIN),
      assistant(`${prose}\n\n${block({ done: summary, blocked: 'a wait', decision: 'pick one; recommend a', next: '🔴 BLOCKED — Pick one OWNER: the-owner' })}`, T0 - 20 * MIN),
    ]), `-work-${dir}`)
    st.write('s2', jsonl([user(other, T0 - MIN), assistant(`${other} and no block`, T0 - MIN)]), `-work-${dir}`)
    const r = runTicks(M, st, [T0, T0 + 30 * MIN])
    const ledgerText = fs.readFileSync(r.ledgerFile, 'utf8')
    for (const c of CANARIES) assert.ok(!ledgerText.includes(c), `${c} reached the ledger`)
    // the block's own fields did arrive, so the scan above is not vacuous
    const rep = r.kinds('report').find((x) => x.session.native_id === 's1').body
    assert.equal(rep.declared_blocked_on, 'a wait')
    assert.equal(rep.decision, 'pick one; recommend a')
    assert.equal(rep.owner_named, 'the-owner')
  },
  {
    'the whole message is copied into the report': [edit(A, 'last = report.last_report_at < 0 ? { badTime: true } : { report }', 'last = report.last_report_at < 0 ? { badTime: true } : { report: { ...report, next: text } }')],
    'the status summary is copied into the report': [edit('freshness/state-file-adapter.js', 'next: declared.next ?? null,', 'next: declared.next ?? declared.summary ?? null,'), edit('freshness/state-file-adapter.js', 'const declared = extractDeclaredStatus(text)\n  return declared ? reportFromDeclared(declared, { updatedAt, via: \'transcript\' }) : null', "const declared = extractDeclaredStatus(text)\n  return declared ? reportFromDeclared({ ...declared, next: undefined }, { updatedAt, via: 'transcript' }) : null")],
    'the project directory name is copied into the scope': [edit(A, 'byId.set(id, byId.has(id) ? AMBIGUOUS : `${d.name}/${f.name}`)', 'byId.set(id, byId.has(id) ? AMBIGUOUS : `${d.name}/${f.name}`)\n      SCOPES.set(id, d.name)'), edit(A, 'scope: null }))', 'scope: SCOPES.get(id) ?? null }))'), edit(A, 'const AMBIGUOUS', 'const SCOPES = new Map()\nconst AMBIGUOUS')],
  },
)

// ── location: the provider's own files, as the same file ───────────────
proves(
  'location: a symlink is not listed, and one swapped in after the listing is refused, not followed',
  (M) => {
    const st = store()
    const outside = path.join(st.root, 'outside')
    fs.mkdirSync(outside)
    const secret = path.join(outside, 'x.jsonl')
    fs.writeFileSync(secret, jsonl([assistant(block({ next: '🟢 RUNNING — OUTSIDE-THE-STORE (agent)' }), T0 - MIN)]))
    st.write('real', jsonl([assistant(block(), T0 - MIN)]))
    fs.symlinkSync(secret, path.join(path.dirname(st.file('real')), 'linked.jsonl'))
    fs.symlinkSync(outside, path.join(st.projects, '-linked-dir'))
    const a = adapterOf(M, st)
    assert.deepEqual(a.list().map((e) => e.session.native_id), ['real'])
    // the file is replaced by a link after it was listed
    fs.rmSync(st.file('real'))
    fs.symlinkSync(secret, st.file('real'))
    assert.deepEqual(a.read(sid('real')), { outcome: 'error', error_code: 'invalid_source' })
    // the directory is replaced by a link after it was listed
    st.write('other', jsonl([assistant(block(), T0 - MIN)]), '-d2')
    const b = adapterOf(M, st)
    b.list()
    fs.rmSync(path.dirname(st.file('other', '-d2')), { recursive: true })
    fs.mkdirSync(path.join(outside, 'sub'))
    fs.copyFileSync(secret, path.join(outside, 'sub', 'other.jsonl'))
    fs.symlinkSync(path.join(outside, 'sub'), path.dirname(st.file('other', '-d2')))
    assert.deepEqual(b.read(sid('other')), { outcome: 'error', error_code: 'invalid_source' })
  },
  {
    'the locator is not consulted': [edit(A, "const found = resolve({ provider: 'claude', conversationId: session.native_id, sourceLocator: locator, sources })", "const found = { ok: true, path: join(projectsDir, locator), identity: null }")],
    'a linked file is listed': [edit(A, 'if (!f.isFile() || !f.name.endsWith', 'if (!(f.isFile() || f.isSymbolicLink()) || !f.name.endsWith')],
    'a linked directory is listed': [edit(A, 'if (!d.isDirectory()) continue', 'if (!(d.isDirectory() || d.isSymbolicLink())) continue')],
  },
)

proves(
  'location: a file that is not the one that was located, or is not a regular file, is refused',
  async (M) => {
    const { resolveTranscriptSource } = await import(pathToFileURL(path.join(SRC, 'transcript-sources.js')).href)
    const st = store()
    st.write('s1', jsonl([assistant(block(), T0 - MIN)]))
    const swapped = (swap) => (args) => {
      const found = resolveTranscriptSource(args)
      swap(found)
      return found
    }
    // another file takes the name between locating and opening it
    const replaced = readOf(M, st, 's1', {
      resolve: swapped((found) => {
        const other = `${found.path}.new`
        fs.writeFileSync(other, jsonl([assistant(block({ next: '🟢 RUNNING — A-DIFFERENT-FILE (agent)' }), T0 - MIN)]))
        fs.renameSync(other, found.path)
      }),
    })
    if (process.platform !== 'win32') assert.deepEqual(replaced, { outcome: 'error', error_code: 'file_changed' })
    // the located path is not a regular file
    if (process.platform !== 'win32') {
      const dirAsFile = path.join(st.root, 'adir')
      fs.mkdirSync(dirAsFile)
      const ds = fs.statSync(dirAsFile, { bigint: true })
      const got = readOf(M, st, 's1', { resolve: () => ({ ok: true, path: dirAsFile, identity: { dev: ds.dev, ino: ds.ino } }) })
      assert.deepEqual(got, { outcome: 'error', error_code: 'not_regular' })
    }
  },
  process.platform === 'win32'
    ? {}
    : {
        'the opened file is not compared with the located one': [edit(A, "if (expectedIdentity && (st.dev !== expectedIdentity.dev || st.ino !== expectedIdentity.ino)) return fail('file_changed')", '')],
        'a directory is read as a file': [edit(A, "if (!st.isFile()) return fail('not_regular')", '')],
      },
)

proves(
  'location: a store that cannot be listed is not an empty store, an id in two projects is ambiguous, and a vanished session is not listed',
  (M) => {
    // no store
    const missing = M.createClaudeTranscriptAdapter({ projectsDir: path.join(store().root, 'nope') })
    assert.equal(missing.list(), null)
    const none = store()
    const r0 = rig(M)
    r0.ticks([T0], { adapters: [M.createClaudeTranscriptAdapter({ projectsDir: path.join(none.root, 'nope') })], config: M.coreConfig({ sources: { [SRC_NAME]: M.CLAUDE_TRANSCRIPT_CAPS } }), source: SRC_NAME })
    assert.equal(r0.kinds('system', (x) => x.body.event === 'source_unreadable').length, 1)
    // too many sessions to list
    const many = store()
    for (const id of ['a', 'b', 'c']) many.write(id, '')
    assert.equal(adapterOf(M, many, { maxSessions: 2 }).list(), null)
    // one id, two projects
    const dup = store()
    dup.write('s1', jsonl([assistant(block(), T0 - MIN)]), '-one')
    dup.write('s1', jsonl([assistant(block(), T0 - MIN)]), '-two')
    assert.deepEqual(readOf(M, dup, 's1'), { outcome: 'error', error_code: 'ambiguous_id' })
    // a session that is not in the listing
    assert.deepEqual(readOf(M, dup, 'gone'), { listed: false })
  },
  {
    'an unreadable store lists as empty': [edit(A, '  } catch {\n    return null\n  }\n  const byId', '  } catch {\n    return new Map()\n  }\n  const byId')],
    'the session limit is not applied': [edit(A, 'if (byId.size > maxSessions) return null', '')],
    'the last of two same-named files wins': [edit(A, 'byId.has(id) ? AMBIGUOUS : `${d.name}/${f.name}`', '`${d.name}/${f.name}`')],
    'an unlisted session is read': [edit(A, 'if (locator === undefined) return { listed: false }', "if (locator === undefined) return fail('source_missing')")],
  },
)

// ── read-only, and the contract ────────────────────────────────────────
proves(
  'read-only: ticks leave every file and directory as it was, and the adapter has no member but list and read',
  (M) => {
    const st = store()
    st.write('s1', jsonl([assistant(block(), T0 - MIN)]))
    const file = st.file('s1')
    const before = { bytes: fs.readFileSync(file), mtime: fs.statSync(file).mtimeMs, tree: fs.readdirSync(st.projects, { recursive: true }).sort() }
    const r = runTicks(M, st, [T0, T0 + 30 * MIN])
    assert.deepEqual(fs.readFileSync(file), before.bytes)
    assert.equal(fs.statSync(file).mtimeMs, before.mtime)
    assert.deepEqual(fs.readdirSync(st.projects, { recursive: true }).sort(), before.tree)
    assert.equal(r.kinds('report').length, 1)
    assert.deepEqual(Object.keys(adapterOf(M, st)).sort(), ['list', 'read', 'source'])
    M.sealAdapter(adapterOf(M, st))
  },
  {
    'the reader writes to the transcript': [edit(A, 'constants as fsConstants, fstatSync, openSync, readSync, readdirSync', 'constants as fsConstants, fstatSync, openSync, readSync, readdirSync, writeSync'), edit(A, 'fsConstants.O_RDONLY |', 'fsConstants.O_RDWR |'), edit(A, 'return readTail(fd, found.identity, maxTailBytes)', "writeSync(fd, ' ', 0)\n        return readTail(fd, found.identity, maxTailBytes)")],
    'the adapter has a send member': [edit(A, '    source,\n    list() {', '    source,\n    send() {},\n    list() {')],
  },
)

proves(
  'contract: the source name is validated by the contract\'s own check',
  (M) => {
    const st = store()
    for (const bad of ['', 'Bad Name', 'x'.repeat(65), '1abc', 'a/b']) {
      assert.throws(() => adapterOf(M, st, { source: bad }), M.AdapterContractError, `"${bad}"`)
    }
    assert.equal(adapterOf(M, st, { source: 'claude-laptop' }).source, 'claude-laptop')
  },
  { 'any source name is accepted': [edit(A, "if (!validSourceName(source)) throw new AdapterContractError('adapter.source must be a short lowercase name')", '')] },
)
