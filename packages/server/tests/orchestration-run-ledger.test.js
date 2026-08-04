import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RunLedger } from '../src/orchestration/run-ledger.js'
import { makeRunRecord, applyEvent, makeUsageCell } from '../src/orchestration/run-record.js'

// #6691 M-2 — the durable run store. Every test uses a temp baseDir (the same
// sandbox discipline as stateFilePath); nothing touches the real ~/.chroxy.

let baseDir
let clock
const now = () => clock

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'chroxy-runledger-'))
  clock = 1_000
})
afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true })
})

// A ledger with synchronous saves (debounce 0) unless a test overrides.
function mkLedger(opts = {}) {
  return new RunLedger({ baseDir, saveDebounceMs: 0, now, ...opts })
}

describe('run-record reducer (pure)', () => {
  it('folds a turn into overall/byRole/byModel/bySession cells with the same numbers', () => {
    const r = makeRunRecord({ runId: 'r1' })
    applyEvent(r, { seq: 1, ts: 1, type: 'run_created', title: 't' })
    applyEvent(r, {
      seq: 2, ts: 2, type: 'turn_usage', role: 'architect', model: 'opus', sessionId: 's1',
      cost: 0.5, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 10 },
    })
    assert.equal(r.usageTotals.overall.inputTokens, 100)
    assert.equal(r.usageTotals.overall.costUsd, 0.5)
    assert.equal(r.usageTotals.overall.effectiveUsd, 0.5)
    assert.equal(r.usageTotals.byRole.architect.inputTokens, 100)
    assert.equal(r.usageTotals.byModel.opus.cacheReadTokens, 10)
    assert.equal(r.usageTotals.bySession.s1.outputTokens, 20)
    assert.equal(r.lastSeq, 2)
  })

  it('keeps provider costUsd separate from derived pricedCostUsd; effectiveUsd sums them', () => {
    const c = makeUsageCell()
    // one known-cost turn + one priced (cost:null) turn folded via events
    const r = makeRunRecord({ runId: 'r1' })
    applyEvent(r, { seq: 1, ts: 1, type: 'turn_usage', role: 'a', cost: 1.0, usage: { input_tokens: 1 } })
    applyEvent(r, { seq: 2, ts: 2, type: 'turn_usage', role: 'a', cost: null, pricedCostUsd: 0.25, usage: { input_tokens: 1 } })
    applyEvent(r, { seq: 3, ts: 3, type: 'turn_usage', role: 'a', cost: null, usage: { input_tokens: 1 } }) // unpriced
    const cell = r.usageTotals.byRole.a
    assert.equal(cell.costUsd, 1.0) // NOT contaminated by the 0.25
    assert.equal(cell.pricedCostUsd, 0.25)
    assert.equal(cell.effectiveUsd, 1.25)
    assert.equal(cell.costKnownTurns, 1)
    assert.equal(cell.unknownCostTurns, 1)
    assert.equal(c.turns, 0) // sanity: the standalone cell is untouched
  })

  it('signed cost (refund) subtracts from costUsd', () => {
    const r = makeRunRecord({ runId: 'r1' })
    applyEvent(r, { seq: 1, ts: 1, type: 'turn_usage', role: 'a', cost: 2.0, usage: { input_tokens: 1 } })
    applyEvent(r, { seq: 2, ts: 2, type: 'turn_usage', role: 'a', cost: -0.5, usage: { input_tokens: 1 } })
    assert.equal(r.usageTotals.byRole.a.costUsd, 1.5)
  })

  it('records a metering gap for an unmeterable session', () => {
    const r = makeRunRecord({ runId: 'r1' })
    applyEvent(r, { seq: 1, ts: 1, type: 'turn_usage', sessionId: 's1', meterable: false, usage: { input_tokens: 1 } })
    assert.deepEqual(r.meteringGaps, ['s1'])
  })

  it('flags model drift when a turn model differs from the attached subtask model', () => {
    const r = makeRunRecord({ runId: 'r1' })
    applyEvent(r, { seq: 1, ts: 1, type: 'subtask_created', subtaskId: 'st1', role: 'w' })
    applyEvent(r, { seq: 2, ts: 2, type: 'session_attached', subtaskId: 'st1', sessionId: 's1', provider: 'p', model: 'sonnet' })
    applyEvent(r, { seq: 3, ts: 3, type: 'turn_usage', subtaskId: 'st1', model: 'haiku', usage: { input_tokens: 1 } })
    assert.equal(r.subtasks[0].modelDrift, true)
  })
})

describe('RunLedger persistence + folding', () => {
  it('createRun writes a snapshot + index + journal', () => {
    const led = mkLedger()
    const run = led.createRun({ title: 'audit', preset: 'repo-audit' })
    assert.match(run.runId, /^run_\d+_[0-9a-f]{8}$/)
    assert.equal(run.status, 'created')
    assert.ok(existsSync(join(baseDir, 'runs', run.runId, 'run.json')))
    assert.ok(existsSync(join(baseDir, 'runs', run.runId, 'events.jsonl')))
    assert.ok(existsSync(join(baseDir, 'runs-index.json')))
    const idx = JSON.parse(readFileSync(join(baseDir, 'runs-index.json'), 'utf8'))
    assert.equal(idx.runs[0].runId, run.runId)
    led.dispose()
  })

  it('recordTurnUsage prices a cost:null turn via the injected priceTurn', () => {
    const led = mkLedger({ priceTurn: ({ usage }) => (usage.input_tokens || 0) * 0.001 })
    const run = led.createRun({})
    led.createSubtask(run.runId, { subtaskId: 'st1', role: 'worker.audit' })
    led.attachSession(run.runId, 'st1', { sessionId: 's1', provider: 'codex', model: 'gpt-5.1', meterable: true })
    const { cell } = led.recordTurnUsage(run.runId, {
      subtaskId: 'st1', sessionId: 's1', role: 'worker.audit', terminalEvent: 'result',
      data: { cost: null, usage: { input_tokens: 1000, output_tokens: 10 } },
    })
    assert.equal(cell.costUsd, 0) // no provider cost
    assert.equal(cell.pricedCostUsd, 1) // 1000 * 0.001
    assert.equal(cell.effectiveUsd, 1)
    led.dispose()
  })

  it('an unpriced cost:null turn counts as unknown-cost, never a wrong number', () => {
    const led = mkLedger() // default priceTurn returns null
    const run = led.createRun({})
    led.createSubtask(run.runId, { subtaskId: 'st1', role: 'w' })
    led.attachSession(run.runId, 'st1', { sessionId: 's1', provider: 'gemini', model: 'g', meterable: true })
    led.recordTurnUsage(run.runId, { subtaskId: 'st1', sessionId: 's1', role: 'w', data: { cost: null, usage: { input_tokens: 5 } } })
    const r = led.getRun(run.runId)
    assert.equal(r.usageTotals.overall.effectiveUsd, 0)
    assert.equal(r.usageTotals.overall.unknownCostTurns, 1)
    led.dispose()
  })
})

describe('RunLedger crash recovery', () => {
  it('replays journal lines ahead of a stale snapshot (lastSeq gate) to reconstruct state', () => {
    // Simulate a crash: build a run, then hand-truncate run.json's lastSeq back
    // so the journal is "ahead", then recover with a fresh ledger.
    const led = mkLedger()
    const run = led.createRun({ title: 'x' })
    led.createSubtask(run.runId, { subtaskId: 'st1', role: 'a' })
    led.recordTurnUsage(run.runId, { subtaskId: 'st1', sessionId: 's1', role: 'a', data: { cost: 0.4, usage: { input_tokens: 10 } } })
    led.flush()
    led.dispose()

    // Roll the snapshot back to BEFORE the turn_usage fold (as a crash between
    // journal append and the debounced save would leave it).
    const snapPath = join(baseDir, 'runs', run.runId, 'run.json')
    const snap = JSON.parse(readFileSync(snapPath, 'utf8'))
    const staleSeq = 2 // run_created(1) + subtask_created(2); turn_usage(3) not yet in snapshot
    snap.lastSeq = staleSeq
    snap.usageTotals = makeRunRecord({ runId: run.runId }).usageTotals // zeroed
    // Also zero the per-subtask fold so replay must reconstruct it too, not just
    // the run totals — proves the reducer folds subtask cells on replay.
    if (snap.subtasks[0]) {
      snap.subtasks[0].usage = makeUsageCell()
      snap.subtasks[0].numTurns = 0
      snap.subtasks[0].apiDurationMs = 0
    }
    writeFileSync(snapPath, JSON.stringify(snap))

    const led2 = mkLedger()
    const recovered = led2.recoverRuns()
    assert.equal(recovered.length, 1)
    const r = led2.getRun(run.runId)
    assert.equal(r.usageTotals.overall.costUsd, 0.4, 'turn_usage(3) replayed into run totals')
    assert.equal(r.subtasks[0].usage.costUsd, 0.4, 'turn_usage(3) replayed into the subtask cell')
    assert.equal(r.subtasks[0].usage.inputTokens, 10)
    assert.equal(r.lastSeq, 3)
    led2.dispose()
  })

  it('recovers zero runs from an empty base dir', () => {
    const led = mkLedger()
    assert.deepEqual(led.recoverRuns(), [])
    led.dispose()
  })

  // #6720 (2) — recoverRuns() loads every run dir into _records; without an
  // _updateIndex()/_gc() pass at the end, a maxRuns lowered between boots is
  // only re-enforced on the NEXT lifecycle event, so memory (and the on-disk
  // index) transiently exceed the cap.
  it('re-applies the LRU bound (and rebuilds the index) at the end of recovery', () => {
    const led = mkLedger() // default maxRuns — nothing evicted while writing
    const ids = []
    for (let i = 0; i < 3; i++) {
      clock = 5000 + i
      const run = led.createRun({ title: `r${i}` })
      ids.push(run.runId)
      led.setStatus(run.runId, 'completed') // terminal → eligible for eviction
    }
    assert.equal(led.listRuns().length, 3, 'fixture: all three runs written under the old cap')
    led.dispose()

    // Reboot with a LOWER cap, as an operator edit between boots would.
    const led2 = mkLedger({ maxRuns: 2 })
    const recovered = led2.recoverRuns()

    // Positive control: recovery genuinely read the runs back off disk (this
    // passes on unmodified source — it proves the fixture is wired, so the
    // cap assertions below are not passing for free).
    assert.equal(led2.getRun(ids[2])?.status, 'completed', 'newest run recovered from disk')
    assert.ok(existsSync(join(baseDir, 'runs', ids[2])), 'newest run dir kept')

    const remaining = led2.listRuns().map((r) => r.runId)
    assert.equal(remaining.length, 2, 'lowered maxRuns enforced during recovery')
    assert.ok(!remaining.includes(ids[0]), 'oldest terminal run evicted')
    assert.ok(!existsSync(join(baseDir, 'runs', ids[0])), 'evicted run dir removed')
    assert.deepEqual(
      recovered.map((r) => r.runId).sort(),
      [ids[1], ids[2]].sort(),
      'the returned records exclude runs the GC just deleted',
    )

    const idx = JSON.parse(readFileSync(join(baseDir, 'runs-index.json'), 'utf8'))
    assert.equal(idx.runs.length, 2, 'the on-disk index was rebuilt from the recovered set')
    assert.ok(!idx.runs.some((r) => r.runId === ids[0]), 'evicted run dropped from the index')
    led2.dispose()
  })
})

describe('RunLedger journal-append failure durability (#6720)', () => {
  it('fsyncs the snapshot when a debounced journal append fails, so the fold is not lost', () => {
    // A long debounce means nothing reaches run.json on its own during the test.
    const led = mkLedger({ saveDebounceMs: 60_000 })
    const run = led.createRun({ title: 'x' })
    led.createSubtask(run.runId, { subtaskId: 'st1', role: 'a' }) // lifecycle → flushed
    const snapPath = join(baseDir, 'runs', run.runId, 'run.json')
    const journalPath = join(baseDir, 'runs', run.runId, 'events.jsonl')
    const readSnap = () => JSON.parse(readFileSync(snapPath, 'utf8'))

    // Positive control: with the journal HEALTHY, a debounced turn_usage stays
    // out of the snapshot (that is the documented durability boundary — the
    // journal is the crash record). Passes on unmodified source, and proves the
    // debounce fixture is live so the assertion below cannot pass for free.
    led.recordTurnUsage(run.runId, {
      subtaskId: 'st1', sessionId: 's1', role: 'a', data: { cost: 0.1, usage: { input_tokens: 1 } },
    })
    assert.equal(readSnap().usageTotals.overall.costUsd, 0, 'debounced fold is not durable yet')
    assert.equal(readSnap().lastSeq, 2, 'snapshot still at the last lifecycle event')

    // Break the journal: a directory at the journal path makes appendFileSync
    // throw EISDIR while leaving the run dir writable for the snapshot.
    rmSync(journalPath)
    mkdirSync(journalPath)

    led.recordTurnUsage(run.runId, {
      subtaskId: 'st1', sessionId: 's1', role: 'a', data: { cost: 0.4, usage: { input_tokens: 10 } },
    })

    // Positive control: the append really did fail — nothing landed at the
    // journal path, and the in-memory fold advanced anyway (the daemon must not
    // crash on a journal write failure). Both pass on unmodified source.
    assert.ok(statSync(journalPath).isDirectory(), 'journal path is still the broken directory')
    assert.deepEqual(readdirSync(journalPath), [], 'no journal line was written')
    assert.equal(led.getRun(run.runId).lastSeq, 4, 'the event still folded in memory')

    // The fix: a failed append forces the fsync'd snapshot, so BOTH folds are
    // durable instead of living only in memory until the next debounced save.
    const snap = readSnap()
    assert.equal(snap.lastSeq, 4, 'snapshot caught up to the un-journaled event')
    assert.equal(snap.usageTotals.overall.costUsd, 0.5, 'both folds reached the durable snapshot')
    led.dispose()
  })
})

describe('RunLedger GC', () => {
  it('LRU-evicts terminal runs beyond maxRuns and removes their directory', () => {
    const led = mkLedger({ maxRuns: 2 })
    const ids = []
    for (let i = 0; i < 3; i++) {
      clock = 1000 + i
      const run = led.createRun({ title: `r${i}` })
      ids.push(run.runId)
      led.setStatus(run.runId, 'completed') // terminal → eligible for eviction
    }
    // 3 terminal runs, cap 2 → oldest evicted
    const remaining = led.listRuns().map((r) => r.runId)
    assert.equal(remaining.length, 2)
    assert.ok(!remaining.includes(ids[0]), 'oldest run evicted')
    assert.ok(!existsSync(join(baseDir, 'runs', ids[0])), 'evicted run dir removed')
    assert.ok(existsSync(join(baseDir, 'runs', ids[2])), 'newest run dir kept')
    led.dispose()
  })

  it('never evicts a non-terminal run even over the cap', () => {
    const led = mkLedger({ maxRuns: 1 })
    clock = 2000; led.createRun({}) // non-terminal
    clock = 2001; led.createRun({}) // non-terminal
    assert.equal(led.listRuns().length, 2, 'both kept — neither is terminal')
    led.dispose()
  })
})

describe('RunLedger committee body cap', () => {
  it('truncates a committee-review body over 32KB', () => {
    const led = mkLedger()
    const run = led.createRun({})
    led.createSubtask(run.runId, { subtaskId: 'st1', role: 'a' })
    led.recordCommitteeReview(run.runId, 'st1', { phase: 'plan', verdict: 'approve', notes: 'x'.repeat(40 * 1024) })
    const journal = readFileSync(join(baseDir, 'runs', run.runId, 'events.jsonl'), 'utf8')
    const line = journal.trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.type === 'committee_review')
    assert.equal(line.truncated, true)
    assert.ok(Buffer.byteLength(line.notes, 'utf8') <= 32 * 1024, 'body capped by bytes')
    led.dispose()
  })

  it('caps a multibyte committee body by BYTES, not UTF-16 code units', () => {
    const led = mkLedger()
    const run = led.createRun({})
    led.createSubtask(run.runId, { subtaskId: 'st1', role: 'a' })
    // '你' is 3 bytes / 1 code unit — 20k code units ≈ 60KB, well over the 32KB
    // byte cap despite being under it in .length terms.
    led.recordCommitteeReview(run.runId, 'st1', { phase: 'plan', verdict: 'approve', notes: '你'.repeat(20 * 1024) })
    const journal = readFileSync(join(baseDir, 'runs', run.runId, 'events.jsonl'), 'utf8')
    const line = journal.trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.type === 'committee_review')
    assert.equal(line.truncated, true)
    assert.ok(Buffer.byteLength(line.notes, 'utf8') <= 32 * 1024, 'multibyte body capped by bytes')
    led.dispose()
  })
})
