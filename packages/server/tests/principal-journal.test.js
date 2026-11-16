/**
 * The daemon-side principal event journal (principal-journal.js; #9118, S3 of #9112;
 * docs/security/agent-principals.md sections 7.1 and 8).
 *
 * The expectations are an ORACLE the test keeps itself: the seqs it knows it caused (a
 * counter in the test, one event per frame it sends) and the seqs the journal DELIVERED to a
 * listener, recorded as they happen. Nothing is asserted against the journal's own counters
 * alone (false-safety catalogue #7424). The crash cases are simulated by abandoning an
 * instance and opening a new one over the same directory.
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, statSync, readdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PrincipalJournal, JOURNAL_MAX_EVENTS, JOURNAL_EVENT_MAX_BYTES, FLOORED_RESULT_PLACEHOLDER, JOURNAL_GAP_REASONS,
} from '../src/principal-journal.js'
import { writeDurableFile } from '../src/durable-write.js'
import { classifyBroadcast, StreamAccumulator } from '../src/agent-control/events.js'

const SID = 'sess-1'
const posix = process.platform !== 'win32'
const NO_TIMERS = { setTimeout: () => null, clearTimeout: () => {} }

let dir
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'chroxy-journal-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** A writer over the real durable write that can be told to fail, and records what it confirmed. */
function writer() {
  const w = { mode: 'ok', metas: [], calls: 0 }
  w.write = (path, data) => {
    w.calls++
    if (w.mode === 'throw') throw new Error('ENOSPC: disk full')
    if (w.mode === 'unconfirmed') {
      writeDurableFile(path, data)
      return { durable: false, unconfirmed: 'EIO' }
    }
    const verdict = writeDurableFile(path, data)
    if (path.endsWith('.meta.json')) w.metas.push(JSON.parse(data))
    return verdict
  }
  return w
}

function makeJournal(over = {}) {
  const w = over.writer ?? writer()
  let t = over.start ?? 1_800_000_000_000
  const clock = { now: () => t, advance: (ms) => { t += ms } }
  const journal = new PrincipalJournal({
    dir, now: clock.now, writeDurable: w.write, timers: NO_TIMERS, enabled: () => true,
    newId: (() => { let n = 0; return () => `journal-${over.idPrefix ?? 'a'}${++n}` })(),
    ...over.opts,
  })
  return { journal, w, clock }
}

/** One forwarded broadcast per call: a `message` frame becomes exactly one journal event. */
const msg = (n, extra = {}) => ({ type: 'message', sessionId: SID, messageType: 'response', content: `m${n}`, ...extra })

/** Record what the journal DELIVERS to a listener, independently of its counters. */
function sink(journal, sessionId = SID) {
  const delivered = []
  const events = []
  const unlisten = journal.onAppend(sessionId, (e) => { events.push(e); if (e.kind === 'event') delivered.push(e.entry.seq) })
  return { delivered, events, unlisten }
}

const seqs = (read) => read.events.map((e) => e.seq)
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i)

describe('append and read against an independent oracle', () => {
  it('assigns 1..N in order and reads them back, with the type and a frozen payload', () => {
    const { journal } = makeJournal()
    const out = sink(journal)
    const N = 12
    for (let i = 1; i <= N; i++) journal.record(msg(i))
    assert.deepEqual(out.delivered, range(1, N), 'delivered seqs are the oracle 1..N')
    const read = journal.readFrom(SID, 0, 100)
    assert.deepEqual(seqs(read), range(1, N))
    assert.equal(read.gap, null)
    assert.equal(read.events.every((e, i) => e.type === 'message' && e.data.content === `m${i + 1}`), true)
    assert.equal(journal.head(SID).headSeq, N)
    assert.equal(Object.isFrozen(read.events[0]) && Object.isFrozen(read.events[0].data), true, 'stored events are deep-frozen')
  })

  it('pages: a limit never returns more, and the last seq of a page resumes the read exactly', () => {
    const { journal } = makeJournal()
    for (let i = 1; i <= 25; i++) journal.record(msg(i))
    const got = []
    let after = 0
    for (let guard = 0; guard < 10; guard++) {
      const page = journal.readFrom(SID, after, 7)
      assert.ok(page.events.length <= 7)
      got.push(...seqs(page))
      if (page.events.length === 0) break
      after = page.lastSeq
    }
    assert.deepEqual(got, range(1, 25), 'every event exactly once across pages')
  })

  it('ignores a frame with no session and every type the classifier does not forward', () => {
    const { journal } = makeJournal()
    journal.record({ type: 'message', content: 'no session' })
    journal.record({ type: 'cost_update', sessionId: SID, sessionCost: 1 })
    journal.record({ type: 'session_list', sessions: [] })
    journal.record(null)
    assert.equal(journal.head(SID).headSeq, 0)
  })

  it('records nothing while disabled, and writes no file', () => {
    let on = false
    const { journal } = makeJournal({ opts: { enabled: () => on } })
    journal.record(msg(1))
    assert.equal(journal.head(SID).headSeq, 0)
    assert.equal(existsSync(dir) ? readdirSync(dir).length : 0, 0)
    on = true
    journal.record(msg(2))
    assert.equal(journal.head(SID).headSeq, 1)
  })
})

describe('eviction advances the window start and is reported as a gap', () => {
  it('a cursor behind the window reports evicted, naming exactly the lost range', () => {
    const { journal } = makeJournal({ opts: { maxEvents: 10 } })
    const out = sink(journal)
    for (let i = 1; i <= 25; i++) journal.record(msg(i))
    assert.deepEqual(out.delivered, range(1, 25), 'every event was issued; only the window is bounded')
    const head = journal.head(SID)
    assert.equal(head.windowStart, 16)
    const cursor = { sessionId: SID, journalId: head.journalId, seq: 3 }
    const res = journal.resolveCursor(SID, cursor)
    assert.deepEqual(res.gap, { reason: 'evicted', fromSeq: 4, toSeq: 15 })
    const read = journal.readFrom(SID, res.afterSeq, 100)
    assert.deepEqual(seqs(read), range(16, 25))
    // a cursor inside the window has no gap
    assert.equal(journal.resolveCursor(SID, { ...cursor, seq: 16 }).gap, null)
  })

  it('the default window is 2000 events', () => {
    assert.equal(JOURNAL_MAX_EVENTS, 2000)
    const { journal } = makeJournal()
    for (let i = 1; i <= 2003; i++) journal.record(msg(i))
    assert.equal(journal.head(SID).windowStart, 4)
    assert.equal(journal.readFrom(SID, 3, 5000).events.length, 2000)
  })

  it('reading from inside an evicted range reports the gap and continues after it', () => {
    const { journal } = makeJournal({ opts: { maxEvents: 5 } })
    for (let i = 1; i <= 12; i++) journal.record(msg(i))
    const read = journal.readFrom(SID, 0, 100)
    assert.deepEqual(read.gap, { reason: 'evicted', fromSeq: 1, toSeq: 7 })
    assert.deepEqual(seqs(read), range(8, 12))
  })
})

describe('cursor reasons', () => {
  it('a journal id this daemon never issued is unknown_cursor; a cursor for another session too; a future seq too', () => {
    const { journal } = makeJournal()
    for (let i = 1; i <= 3; i++) journal.record(msg(i))
    const id = journal.head(SID).journalId
    assert.equal(journal.resolveCursor(SID, { sessionId: SID, journalId: 'someone-elses', seq: 2 }).gap.reason, 'unknown_cursor')
    assert.equal(journal.resolveCursor(SID, { sessionId: 'other', journalId: id, seq: 2 }).gap.reason, 'unknown_cursor')
    assert.equal(journal.resolveCursor(SID, { sessionId: SID, journalId: id, seq: 99 }).gap.reason, 'unknown_cursor')
    assert.equal(journal.resolveCursor(SID, { sessionId: SID, journalId: id, seq: -1 }).gap.reason, 'unknown_cursor')
    assert.equal(journal.resolveCursor(SID, 'garbage').gap.reason, 'unknown_cursor')
  })

  it('a holder that had seen nothing (seq 0) loses nothing to a different journal id', () => {
    const { journal } = makeJournal()
    journal.record(msg(1))
    assert.equal(journal.resolveCursor(SID, { sessionId: SID, journalId: 'old', seq: 0 }).gap, null)
  })

  it('a deliberate reset mints a new id; the old cursor reports journal_reset and replay starts at the new window', () => {
    const { journal } = makeJournal()
    for (let i = 1; i <= 4; i++) journal.record(msg(i))
    const old = journal.head(SID).journalId
    const out = sink(journal)
    journal.resetSession(SID)
    assert.equal(out.events.at(-1).kind, 'reset')
    assert.equal(out.events.at(-1).reason, 'journal_reset')
    journal.record(msg(5))
    const now = journal.head(SID)
    assert.notEqual(now.journalId, old)
    assert.equal(now.headSeq, 1, 'a new id restarts the numbering')
    const res = journal.resolveCursor(SID, { sessionId: SID, journalId: old, seq: 4 })
    assert.equal(res.gap.reason, 'journal_reset')
    assert.deepEqual(seqs(journal.readFrom(SID, res.afterSeq, 10)), [1])
  })

  it('every reason a gap can carry is one of the four documented', () => {
    assert.deepEqual([...JOURNAL_GAP_REASONS], ['evicted', 'journal_reset', 'restart_loss', 'unknown_cursor'])
  })
})

describe('restart: clean and unclean', () => {
  it('a clean restart keeps the journalId and continues the seq contiguously', () => {
    const first = makeJournal()
    const out = sink(first.journal)
    for (let i = 1; i <= 7; i++) first.journal.record(msg(i))
    const id = first.journal.head(SID).journalId
    first.journal.close()

    const second = makeJournal({ idPrefix: 'b' })
    const out2 = sink(second.journal)
    const head = second.journal.head(SID)
    assert.equal(head.journalId, id, 'a clean restart keeps the journal id')
    assert.equal(head.headSeq, 7)
    for (let i = 8; i <= 10; i++) second.journal.record(msg(i))
    assert.deepEqual([...out.delivered, ...out2.delivered], range(1, 10), 'monotonic and contiguous across the restart (oracle 1..10)')
    const read = second.journal.readFrom(SID, 0, 100)
    assert.deepEqual(seqs(read), range(1, 10))
    assert.equal(read.gap, null)
    assert.equal(second.journal.resolveCursor(SID, { sessionId: SID, journalId: id, seq: 7 }).gap, null)
  })

  it('an unclean restart keeps the id, never reuses a seq, and reports the unpersisted tail as restart_loss', () => {
    const first = makeJournal({ opts: { reservationStep: 20 } })
    const out = sink(first.journal)
    for (let i = 1; i <= 7; i++) first.journal.record(msg(i))
    first.journal.flush() // events 1..7 reach the disk
    for (let i = 8; i <= 10; i++) first.journal.record(msg(i)) // never flushed
    assert.deepEqual(out.delivered, range(1, 10))
    const id = first.journal.head(SID).journalId
    // crash: the instance is abandoned, nothing is closed

    const second = makeJournal({ idPrefix: 'b', opts: { reservationStep: 20 } })
    const out2 = sink(second.journal)
    assert.equal(second.journal.head(SID).journalId, id, 'a proved reservation keeps the id')
    second.journal.record(msg(11))
    second.journal.record(msg(12))
    const all = [...out.delivered, ...out2.delivered]
    assert.equal(new Set(all).size, all.length, 'no seq is issued twice')
    assert.ok(out2.delivered[0] > Math.max(...out.delivered), 'the first seq after the crash is above everything issued before it')
    assert.deepEqual(out2.delivered, [21, 22], 'resumes above the reservation (1 + 20)')
    // the tail 8..20 is a hole: a cursor that saw 9 learns it lost 10..20
    const res = second.journal.resolveCursor(SID, { sessionId: SID, journalId: id, seq: 9 })
    assert.deepEqual(res.gap, { reason: 'restart_loss', fromSeq: 10, toSeq: 20 })
    // a client that had seen the whole flushed window and nothing else has no loss before the hole
    assert.equal(second.journal.resolveCursor(SID, { sessionId: SID, journalId: id, seq: 20 }).gap, null)
    const read = second.journal.readFrom(SID, 0, 100)
    assert.deepEqual(seqs(read), range(1, 7), 'a read never spans a hole')
    const after = second.journal.readFrom(SID, read.lastSeq, 100)
    assert.deepEqual(after.gap, { reason: 'restart_loss', fromSeq: 8, toSeq: 20 })
    assert.deepEqual(seqs(after), [21, 22])
  })

  it('a sidecar that cannot be trusted cannot prove its reservation: a new id, and older cursors report restart_loss', () => {
    const first = makeJournal()
    for (let i = 1; i <= 3; i++) first.journal.record(msg(i))
    const old = first.journal.head(SID).journalId
    first.journal.close()
    const metaFile = readdirSync(dir).find((f) => f.endsWith('.meta.json'))
    writeFileSync(join(dir, metaFile), '{ not json', { mode: 0o600 })

    const second = makeJournal({ idPrefix: 'b' })
    const head = second.journal.head(SID)
    assert.notEqual(head.journalId, old)
    assert.equal(head.headSeq, 0)
    assert.equal(second.journal.resolveCursor(SID, { sessionId: SID, journalId: old, seq: 3 }).gap.reason, 'restart_loss')
  })

  it('a meta file that is not 0600 is untrusted the same way', { skip: !posix }, () => {
    const first = makeJournal()
    first.journal.record(msg(1))
    const old = first.journal.head(SID).journalId
    first.journal.close()
    for (const f of readdirSync(dir)) chmodSync(join(dir, f), 0o644)
    const second = makeJournal({ idPrefix: 'b' })
    assert.notEqual(second.journal.head(SID).journalId, old)
  })

  it('an events file that is missing after a clean close leaves a hole, and the seq still continues', () => {
    const first = makeJournal()
    for (let i = 1; i <= 4; i++) first.journal.record(msg(i))
    const id = first.journal.head(SID).journalId
    first.journal.close()
    rmSync(join(dir, readdirSync(dir).find((f) => f.endsWith('.events.json'))))
    const second = makeJournal({ idPrefix: 'b' })
    assert.equal(second.journal.head(SID).journalId, id)
    second.journal.record(msg(5))
    assert.deepEqual(second.journal.resolveCursor(SID, { sessionId: SID, journalId: id, seq: 2 }).gap, { reason: 'restart_loss', fromSeq: 3, toSeq: 4 })
    assert.deepEqual(seqs(second.journal.readFrom(SID, 4, 10)), [5])
  })

  it('files are 0600 in a 0700 directory', { skip: !posix }, () => {
    const { journal } = makeJournal()
    journal.record(msg(1))
    journal.close()
    assert.equal(statSync(dir).mode & 0o777, 0o700)
    const files = readdirSync(dir)
    assert.equal(files.length, 2)
    for (const f of files) assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600, f)
  })
})

describe('the confirmed reservation: no seq beyond what is durably reserved', () => {
  it('every delivered seq is covered by a reservation that had ALREADY been confirmed', () => {
    const w = writer()
    const { journal } = makeJournal({ writer: w, opts: { reservationStep: 4 } })
    const violations = []
    journal.onAppend(SID, (e) => {
      if (e.kind !== 'event') return
      const reserved = Math.max(0, ...w.metas.map((m) => m.reservedThrough))
      if (e.entry.seq > reserved) violations.push({ seq: e.entry.seq, reserved })
    })
    for (let i = 1; i <= 30; i++) journal.record(msg(i))
    assert.deepEqual(violations, [])
    assert.ok(w.metas.length >= Math.ceil(30 / 4), 'the reservation was extended in steps, each confirmed')
    assert.equal(w.metas.every((m) => m.clean === false), true, 'a running journal never claims a clean close')
  })

  it('persistence failure then crash: nothing is issued past the confirmed reservation, and no seq is ever reused', () => {
    const w = writer()
    const first = makeJournal({ writer: w, opts: { reservationStep: 5 } })
    const out = sink(first.journal)
    for (let i = 1; i <= 5; i++) first.journal.record(msg(i)) // reservation 1..5 confirmed
    w.mode = 'throw' // the next reservation cannot be written
    for (let i = 6; i <= 14; i++) first.journal.record(msg(i))
    assert.deepEqual(out.delivered, range(1, 5), 'events 6..14 were NOT issued: their reservation was never confirmed')
    assert.equal(first.journal.head(SID).headSeq, 5)
    const kill = out.events.find((e) => e.kind === 'reset')
    assert.ok(kill && kill.reason === 'restart_loss', 'a subscriber is told the journal id is dead')
    const id = first.journal.head(SID).journalId
    // crash while it was dead

    const second = makeJournal({ idPrefix: 'b', opts: { reservationStep: 5 } })
    const out2 = sink(second.journal)
    for (let i = 1; i <= 3; i++) second.journal.record(msg(i))
    const all = [...out.delivered, ...out2.delivered]
    assert.equal(new Set(all).size, all.length, 'no seq reuse across the failure and the crash')
    assert.deepEqual(all, [...range(1, 5), 6, 7, 8], 'monotonic across both lifetimes')
    assert.equal(second.journal.head(SID).journalId, id, 'the reservation it did confirm is provable, so the id is kept')
  })

  it('an unconfirmed (directory fsync failed) write is a failure: it raises nothing', () => {
    const w = writer()
    w.mode = 'unconfirmed'
    const { journal } = makeJournal({ writer: w })
    const out = sink(journal)
    journal.record(msg(1))
    assert.deepEqual(out.delivered, [], 'a write that was not confirmed durable reserves nothing')
  })

  it('after the back-off, the next successful start mints a NEW journal id and the old cursor reports restart_loss', () => {
    const w = writer()
    const { journal, clock } = makeJournal({ writer: w, opts: { reservationStep: 3, retryBackoffMs: 1000 } })
    const out = sink(journal)
    for (let i = 1; i <= 3; i++) journal.record(msg(i))
    const old = journal.head(SID).journalId
    w.mode = 'throw'
    journal.record(msg(4))
    const callsAfterFail = w.calls
    journal.record(msg(5))
    assert.equal(w.calls, callsAfterFail, 'during the back-off the disk is not hammered')
    w.mode = 'ok'
    journal.record(msg(6))
    assert.equal(journal.head(SID).journalId, old, 'still backing off: no new id yet')
    assert.equal(journal.head(SID).headSeq, 3, 'still backing off: nothing more issued')
    clock.advance(1001)
    journal.record(msg(7))
    const now = journal.head(SID)
    assert.notEqual(now.journalId, old)
    assert.equal(now.headSeq, 1)
    assert.equal(journal.resolveCursor(SID, { sessionId: SID, journalId: old, seq: 3 }).gap.reason, 'restart_loss')
    assert.deepEqual(out.delivered, [1, 2, 3, 1], 'the new id restarts at 1; the old id never issued 4')
  })
})

describe('what is never journaled', () => {
  it('raw PTY output and terminal size are not forwarded', () => {
    const { journal } = makeJournal()
    journal.record({ type: 'terminal_output', sessionId: SID, data: 'raw pty bytes \u001b[31m' })
    journal.record({ type: 'terminal_size', sessionId: SID, cols: 80, rows: 24 })
    assert.equal(journal.head(SID).headSeq, 0)
  })

  it('thinking is excluded: a thinking stream, and a thinking-typed message, leave no event', () => {
    const { journal } = makeJournal()
    journal.record({ type: 'stream_start', sessionId: SID, messageId: 'm1', thinking: true })
    journal.record({ type: 'stream_delta', sessionId: SID, messageId: 'm1', delta: 'secret reasoning' })
    journal.record({ type: 'stream_end', sessionId: SID, messageId: 'm1' })
    journal.record({ type: 'message', sessionId: SID, messageType: 'thinking', content: 'more reasoning' })
    journal.record({ type: 'message', sessionId: SID, messageType: 'reasoning', content: 'and more' })
    assert.equal(journal.head(SID).headSeq, 0)
    assert.equal(JSON.stringify(journal.readFrom(SID, 0, 10).events).includes('reasoning'), false)
  })

  it('an assistant stream is aggregated into ONE assistant_text event, not one per token', () => {
    const { journal } = makeJournal()
    journal.record({ type: 'stream_start', sessionId: SID, messageId: 'm2' })
    for (const d of ['he', 'llo ', 'world']) journal.record({ type: 'stream_delta', sessionId: SID, messageId: 'm2', delta: d })
    journal.record({ type: 'stream_end', sessionId: SID, messageId: 'm2' })
    const read = journal.readFrom(SID, 0, 10)
    assert.equal(read.events.length, 1)
    assert.equal(read.events[0].type, 'assistant_text')
    assert.equal(read.events[0].data.text, 'hello world')
  })

  it('the same classifier as the agent-control client: both forward the same events for the same frames', () => {
    const { journal } = makeJournal()
    const frames = [msg(1), { type: 'tool_start', sessionId: SID, toolUseId: 't1', tool: 'Read', input: { file_path: '/a' } }, { type: 'agent_busy', sessionId: SID }, { type: 'terminal_output', sessionId: SID, data: 'x' }]
    const acc = new StreamAccumulator()
    const expected = frames.flatMap((f) => classifyBroadcast(f, acc)).map((e) => e.type)
    for (const f of frames) journal.record(f)
    assert.deepEqual(journal.readFrom(SID, 0, 10).events.map((e) => e.type), expected)
  })
})

describe('floor provenance: the result of a floored tool call is replaced by a placeholder', () => {
  const start = (id, tool = 'Read') => ({ type: 'tool_start', sessionId: SID, toolUseId: id, tool, input: { file_path: '/x' } })
  const result = (id, text = 'SECRET FILE CONTENTS') => ({ type: 'tool_result', sessionId: SID, toolUseId: id, result: text })
  const perm = (over) => ({ type: 'permission_request', sessionId: SID, requestId: 'r1', tool: 'Read', input: {}, ...over })
  const resultOf = (journal, id) => journal.readFrom(SID, 0, 100).events.find((e) => e.type === 'tool_result' && e.data.toolUseId === id)

  it('floored with a toolUseId: placeholder, and the real text is nowhere in the journal', () => {
    const { journal } = makeJournal()
    journal.record(perm({ floored: true, toolUseId: 't1' }))
    journal.record(start('t1'))
    journal.record(result('t1'))
    const r = resultOf(journal, 't1')
    assert.equal(r.data.result, FLOORED_RESULT_PLACEHOLDER)
    assert.equal(r.data.withheld, 'floored')
    assert.equal(JSON.stringify(journal.readFrom(SID, 0, 100).events).includes('SECRET FILE CONTENTS'), false)
  })

  it('NOT floored (floored: false): the result is kept', () => {
    const { journal } = makeJournal()
    journal.record(perm({ floored: false, toolUseId: 't1' }))
    journal.record(start('t1'))
    journal.record(result('t1', 'ordinary output'))
    assert.equal(resultOf(journal, 't1').data.result, 'ordinary output')
  })

  it('fail closed: a request that states no verdict is treated as floored', () => {
    const { journal } = makeJournal()
    journal.record(perm({ toolUseId: 't1' }))
    journal.record(start('t1'))
    journal.record(result('t1'))
    assert.equal(resultOf(journal, 't1').data.result, FLOORED_RESULT_PLACEHOLDER)
  })

  it('a request with no toolUseId (the other pipeline) is matched to the NEXT call of that tool', () => {
    const { journal } = makeJournal()
    journal.record(perm({ floored: true }))
    journal.record(start('t7'))
    journal.record(result('t7'))
    assert.equal(resultOf(journal, 't7').data.result, FLOORED_RESULT_PLACEHOLDER)
    // a later call of the same tool is not floored: the pending request was consumed
    journal.record(start('t8'))
    journal.record(result('t8', 'fine'))
    assert.equal(resultOf(journal, 't8').data.result, 'fine')
  })

  it('a request with no toolUseId that arrives AFTER the call started matches the open call of that tool', () => {
    const { journal } = makeJournal()
    journal.record(start('t9'))
    journal.record(start('t10', 'Bash'))
    journal.record(perm({ floored: true }))
    journal.record(result('t9'))
    journal.record(result('t10', 'bash output'))
    assert.equal(resultOf(journal, 't9').data.result, FLOORED_RESULT_PLACEHOLDER)
    assert.equal(resultOf(journal, 't10').data.result, 'bash output', 'a different tool is untouched')
  })

  it('streamed input of a floored call is withheld too', () => {
    const { journal } = makeJournal()
    journal.record(perm({ floored: true, toolUseId: 't1' }))
    journal.record({ type: 'tool_input_delta', sessionId: SID, toolUseId: 't1', delta: '{"content":"api key sk-live-123"}' })
    const e = journal.readFrom(SID, 0, 10).events.find((x) => x.type === 'tool_input_delta')
    assert.equal(e.data.withheld, 'floored')
    assert.equal(JSON.stringify(e).includes('sk-live'), false)
  })

  it('another session\'s floored call does not affect this one', () => {
    const { journal } = makeJournal()
    journal.record({ ...perm({ floored: true, toolUseId: 't1' }), sessionId: 'other' })
    journal.record(start('t1'))
    journal.record(result('t1', 'mine'))
    assert.equal(resultOf(journal, 't1').data.result, 'mine')
  })
})

describe('bounds and redaction', () => {
  it('an oversize event is truncated to 4 KiB and marked truncated: true, never dropped', () => {
    const { journal } = makeJournal()
    const out = sink(journal)
    journal.record({ type: 'tool_result', sessionId: SID, toolUseId: 't1', result: 'x'.repeat(4100), truncated: false })
    journal.record({ type: 'message', sessionId: SID, messageType: 'response', content: 'é'.repeat(3000), toolUseId: 'm' })
    journal.record(msg(3))
    assert.deepEqual(out.delivered, [1, 2, 3], 'the oversize events kept their seq')
    const events = journal.readFrom(SID, 0, 10).events
    assert.equal(events[0].truncated, true)
    assert.equal(events[1].truncated, true)
    assert.equal(events[2].truncated, undefined)
    for (const e of events) assert.ok(Buffer.byteLength(JSON.stringify(e), 'utf8') <= JOURNAL_EVENT_MAX_BYTES, `event ${e.seq} within 4 KiB`)
    assert.equal(events[0].data.toolUseId, 't1', 'identity survives the cut')
  })

  it('an event just under the cap is kept whole', () => {
    const { journal } = makeJournal()
    journal.record({ type: 'message', sessionId: SID, messageType: 'response', content: 'y'.repeat(3000) })
    const e = journal.readFrom(SID, 0, 10).events[0]
    assert.equal(e.truncated, undefined)
    assert.equal(e.data.content.length, 3000)
  })

  it('the cap is the whole stored entry (seq, ts, type and data), for a payload that is wide and shallow', () => {
    const { journal } = makeJournal()
    const wide = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`k${i}`, 'v'.repeat(40)]))
    journal.record({ type: 'tool_start', sessionId: SID, toolUseId: 't', tool: 'X', input: wide })
    const e = journal.readFrom(SID, 0, 10).events[0]
    assert.equal(e.truncated, true)
    assert.ok(Buffer.byteLength(JSON.stringify(e), 'utf8') <= JOURNAL_EVENT_MAX_BYTES)
  })

  it('values are redacted with the shared redactor before they are stored', () => {
    const { journal } = makeJournal()
    journal.record({ type: 'message', sessionId: SID, messageType: 'response', content: 'use Bearer abcdefghijklmnopqrstuvwx and sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 now' })
    journal.record({ type: 'tool_start', sessionId: SID, toolUseId: 't', tool: 'Bash', input: { command: 'export TOKEN=hunter2hunter2hunter2', password: 'p4ss', env: { API_KEY: 'zzzzzzzzzzzz' } } })
    const text = JSON.stringify(journal.readFrom(SID, 0, 10).events)
    for (const secret of ['abcdefghijklmnopqrstuvwx', 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij', 'hunter2hunter2hunter2', 'p4ss', 'zzzzzzzzzzzz']) {
      assert.equal(text.includes(secret), false, `${secret} must not be stored`)
    }
    assert.ok(text.includes('[REDACTED]'))
  })

  it('redaction also covers what reaches the disk', () => {
    const { journal } = makeJournal()
    journal.record({ type: 'message', sessionId: SID, messageType: 'response', content: 'Bearer abcdefghijklmnopqrstuvwx' })
    journal.flush()
    const events = readdirSync(dir).find((f) => f.endsWith('.events.json'))
    const onDisk = readFileSync(join(dir, events), 'utf8')
    assert.equal(onDisk.includes('abcdefghijklmnopqrstuvwx'), false)
  })
})

describe('effort metadata (#9075): requested and effective effort are carried', () => {
  const effort = (extra) => ({ type: 'thinking_level_changed', sessionId: SID, ...extra })
  const thinkingEvents = (journal) => journal.readFrom(SID, 0, 100).events.filter((e) => e.type === 'thinking_level_changed')

  it('keeps the requested level and the effective string, null and absent distinct', () => {
    const { journal } = makeJournal()
    journal.record(effort({ level: 'high', effective: 'high' }))
    journal.record(effort({ level: 'high', effective: null }))
    journal.record(effort({ level: 'high' }))
    const [a, b, c] = thinkingEvents(journal)
    assert.deepEqual(a.data, { level: 'high', effective: 'high' })
    assert.equal(b.data.effective, null)
    assert.equal(Object.hasOwn(b.data, 'effective'), true, 'null is "not reported yet"')
    assert.equal(Object.hasOwn(c.data, 'effective'), false, 'absent is "this provider reports none"')
  })

  it('an applied level that differs from the requested one is preserved as sent', () => {
    const { journal } = makeJournal()
    journal.record(effort({ level: 'xhigh', effective: 'high' }))
    assert.deepEqual(thinkingEvents(journal)[0].data, { level: 'xhigh', effective: 'high' })
  })

  it('a model change that resets the effective effort is visible in order', () => {
    const { journal } = makeJournal()
    journal.record(effort({ level: 'high', effective: 'high' }))
    journal.record({ type: 'model_changed', sessionId: SID, model: 'haiku' })
    journal.record(effort({ level: 'high', effective: null }))
    const read = journal.readFrom(SID, 0, 100).events
    assert.deepEqual(read.map((e) => e.type), ['thinking_level_changed', 'model_changed', 'thinking_level_changed'])
    assert.equal(read[2].data.effective, null)
  })

  it('effort metadata is not thinking TEXT: the thinking exclusion is unchanged', () => {
    const { journal } = makeJournal()
    journal.record(effort({ level: 'high', effective: 'high' }))
    journal.record({ type: 'message', sessionId: SID, messageType: 'thinking', content: 'private reasoning' })
    const text = JSON.stringify(journal.readFrom(SID, 0, 10).events)
    assert.equal(text.includes('private reasoning'), false)
    assert.equal(thinkingEvents(journal).length, 1)
  })
})

describe('lifecycle', () => {
  it('removeSession deletes the sidecar and ends subscribers; prune drops the journal of a gone session', () => {
    const { journal } = makeJournal()
    journal.record(msg(1))
    journal.record({ ...msg(1), sessionId: 'keep' })
    journal.close()
    assert.equal(readdirSync(dir).length, 4)
    const second = makeJournal({ idPrefix: 'b' })
    assert.equal(second.journal.prune((id) => id === 'keep'), 1)
    assert.equal(readdirSync(dir).length, 2)
    const out = sink(second.journal, 'keep')
    second.journal.removeSession('keep')
    assert.equal(out.events.at(-1).kind, 'removed')
    assert.equal(readdirSync(dir).length, 0)
  })

  it('a listener that throws does not break the journal', () => {
    const { journal } = makeJournal()
    journal.onAppend(SID, () => { throw new Error('boom') })
    const out = sink(journal)
    journal.record(msg(1))
    journal.record(msg(2))
    assert.deepEqual(out.delivered, [1, 2])
  })

  it('record never throws, whatever the frame', () => {
    const { journal } = makeJournal()
    const cyclic = { type: 'message', sessionId: SID, messageType: 'response' }
    cyclic.self = cyclic
    assert.doesNotThrow(() => { journal.record(cyclic); journal.record({ type: 'message', sessionId: SID, content: 1n }) })
  })
})
