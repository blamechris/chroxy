// #6732 — the run-model FSM guards must be WIRED into the engine's status
// writes, not merely exported.
//
// Two independent properties are covered here, because either one alone is a
// false green:
//   1. CONFORMANCE — every status the engine actually journals is a legal
//      transition from the status the ledger currently holds. (A guard wired
//      into an engine that emits illegal transitions just breaks the engine.)
//   2. WIRING — an illegal transition offered to the engine's write choke point
//      is REJECTED and never journaled, and there is no second, unguarded write
//      path in the manager. (A legal engine with an unwired guard is #6732.)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'

import { OrchestrationManager } from '../src/orchestration/orchestration-manager.js'
import { RunLedger } from '../src/orchestration/run-ledger.js'
import { TurnDriver } from '../src/orchestration/turn-driver.js'
import { assertRunTransition, assertNodeTransition, TransitionError } from '../src/orchestration/run-model.js'

const MANAGER_SRC = fileURLToPath(new URL('../src/orchestration/orchestration-manager.js', import.meta.url))

// --- fakes (a trimmed copy of the orchestration-manager harness) ------------

const KIND_RE = /kind "([a-z_]+)"/

function fenced(obj) {
  return 'Here is my decision.\n\n```chroxy-decision\n' + JSON.stringify(obj) + '\n```'
}

class FakeSession extends EventEmitter {
  constructor(sessionId, sm, opts, decide, model) {
    super()
    this.sessionId = sessionId
    this._sm = sm
    this.opts = opts
    this._decide = decide
    this._model = model
    this.role = opts.metadata?.orchestrationRole ?? null
    this.destroyed = false
    this.lastKind = null
    this.kindCalls = Object.create(null)
  }
  setPermissionRules() {}
  interrupt() {}
  sendMessage(prompt) {
    const m = String(prompt).match(KIND_RE)
    const kind = m ? m[1] : this.lastKind
    this.lastKind = kind
    this.kindCalls[kind] = (this.kindCalls[kind] || 0) + 1
    queueMicrotask(() => {
      if (this.destroyed) return
      const out = this._decide({ role: this.role, kind, n: this.kindCalls[kind] })
      if (out == null) return // sentinel: hang this turn
      this._sm.emit('session_event', { sessionId: this.sessionId, event: 'stream_delta', data: { messageId: 'm1', delta: fenced(out) } })
      this._sm.emit('session_event', {
        sessionId: this.sessionId,
        event: 'result',
        data: { model: this._model, cost: 0.01, duration: 5, apiDurationMs: 4, numTurns: 1, usage: { input_tokens: 10, output_tokens: 4 } },
      })
    })
    return Promise.resolve()
  }
}

class FakeSM extends EventEmitter {
  constructor(decide) {
    super()
    this.setMaxListeners(0)
    this._decide = decide
    this._sessions = new Map()
    this._n = 0
  }
  createSession(opts) {
    const sessionId = `sess_${++this._n}`
    const model = opts.metadata?.orchestrationRole === 'architect' ? 'fable-hi' : 'haiku'
    this._sessions.set(sessionId, new FakeSession(sessionId, this, opts, this._decide, model))
    return sessionId
  }
  getSession(id) { const s = this._sessions.get(id); return s ? { session: s } : null }
  destroySession(id) {
    const s = this._sessions.get(id)
    if (!s) return
    s.destroyed = true
    this._sessions.delete(id)
    this.emit('session_destroyed', { sessionId: id })
  }
  listSessions() { return [...this._sessions.keys()] }
}

const ROLES = {
  architect: { provider: 'claude-sdk', model: 'fable-hi' },
  auditWorker: { provider: 'claude-sdk', model: 'haiku' },
}

// Record every (from -> to) pair the engine journals, WITHOUT validating it
// inline — a wrapper that threw here would abort the run and hide the rest of
// the sequence. The recorded trace is validated after the run instead.
function makeHarness(decide) {
  const dir = mkdtempSync(join(tmpdir(), 'orch-fsm-'))
  const sm = new FakeSM(decide)
  const ledger = new RunLedger({ baseDir: dir })
  const runTrace = []
  const nodeTrace = []
  const origSetStatus = ledger.setStatus.bind(ledger)
  const origUpdateSubtask = ledger.updateSubtask.bind(ledger)
  ledger.setStatus = (runId, status, reason = null) => {
    runTrace.push({ from: ledger.getRun(runId)?.status ?? null, to: status })
    return origSetStatus(runId, status, reason)
  }
  ledger.updateSubtask = (runId, subtaskId, patch) => {
    const st = ledger.getRun(runId)?.subtasks?.find((s) => s.subtaskId === subtaskId)
    nodeTrace.push({ subtaskId, from: st?.status ?? null, to: patch?.status })
    return origUpdateSubtask(runId, subtaskId, patch)
  }
  const driver = new TurnDriver({ sessionManager: sm })
  const mgr = new OrchestrationManager({ sessionManager: sm, ledger, turnDriver: driver, roles: ROLES })
  const cleanup = () => {
    mgr.dispose()
    driver.dispose()
    ledger.dispose?.()
    rmSync(dir, { recursive: true, force: true })
  }
  return { sm, ledger, mgr, cleanup, runTrace, nodeTrace }
}

function happyDecider({ role, kind }) {
  if (role === 'architect') {
    if (kind === 'epic_plan') {
      return { kind: 'epic_plan', summary: 'One-area audit', subtasks: [{ title: 'Audit auth', goal: 'Review auth', role: 'audit' }] }
    }
    if (kind === 'poa_review') return { kind: 'poa_review', verdict: 'approve' }
    if (kind === 'result_review') return { kind: 'result_review', verdict: 'approve' }
    if (kind === 'synthesis') return { kind: 'synthesis', reportMarkdown: '# Report' }
  }
  if (kind === 'plan_of_attack') return { kind: 'plan_of_attack', plan: 'Read + grep.', summary: 'PoA' }
  if (kind === 'work_result') return { kind: 'work_result', summary: 'Found 2 issues.' }
  throw new Error(`unexpected turn role=${role} kind=${kind}`)
}

function waitFor(mgr, events, { timeoutMs = 5000 } = {}) {
  const wanted = new Set(events)
  const all = new Set([...wanted, 'run_failed'])
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error(`timed out waiting for ${[...wanted].join('|')}`)) }, timeoutMs)
    const handlers = []
    const off = () => { clearTimeout(timer); for (const [e, h] of handlers) mgr.off(e, h) }
    for (const e of all) {
      const h = (payload) => {
        if (!wanted.has(e)) { off(); reject(new Error(`unexpected ${e}: ${payload?.code ?? ''} ${payload?.message ?? ''}`)); return }
        off(); resolve({ event: e, payload })
      }
      handlers.push([e, h])
      mgr.on(e, h)
    }
  })
}

// Replay a recorded trace through the FSM guards; return the first illegal pair.
function firstIllegal(trace, assertFn) {
  for (const step of trace) {
    try { assertFn(step.from, step.to) } catch (err) { return { step, err } }
  }
  return null
}

// --- 1. conformance --------------------------------------------------------

test('#6732 every run status the engine journals on a full audit run is a legal FSM transition', async () => {
  const { mgr, cleanup, runTrace } = makeHarness(happyDecider)
  try {
    const rec = mgr.createRun({ goal: 'Audit', cwd: '/repo', autoApprovePlan: false })
    const gated = waitFor(mgr, ['gate_opened'])
    await mgr.startRun(rec.runId)
    const { payload } = await gated
    const done = waitFor(mgr, ['run_completed'])
    await mgr.resolveGate(rec.runId, payload.gate.gateId, { decision: 'approve' })
    await done

    // POSITIVE CONTROL: the wrapper really observed the engine's writes.
    // (Passes on unmodified source — proves the fixture takes effect.)
    assert.ok(runTrace.length >= 4, `expected the run trace to be populated, got ${JSON.stringify(runTrace)}`)
    assert.deepEqual(runTrace[0], { from: 'created', to: 'planning' })
    assert.deepEqual(runTrace.at(-1), { from: 'synthesizing', to: 'completed' })

    const bad = firstIllegal(runTrace, assertRunTransition)
    assert.equal(bad, null, `engine journaled an illegal RUN transition: ${bad?.err?.message}`)
  } finally {
    cleanup()
  }
})

test('#6732 every subtask status the engine journals on a full audit run is a legal FSM transition', async () => {
  const { mgr, cleanup, nodeTrace } = makeHarness(happyDecider)
  try {
    const rec = mgr.createRun({ goal: 'Audit', cwd: '/repo', autoApprovePlan: true })
    const done = waitFor(mgr, ['run_completed'])
    await mgr.startRun(rec.runId)
    await done

    // POSITIVE CONTROL: the subtask wrapper really observed the engine's writes.
    assert.ok(nodeTrace.length >= 4, `expected the node trace to be populated, got ${JSON.stringify(nodeTrace)}`)
    assert.equal(nodeTrace[0].from, 'pending')
    assert.deepEqual(nodeTrace.at(-1).to, 'done')

    const bad = firstIllegal(nodeTrace, assertNodeTransition)
    assert.equal(bad, null, `engine journaled an illegal NODE transition: ${bad?.err?.message}`)
  } finally {
    cleanup()
  }
})

test('#6732 the redelegate + committee-cap path journals only legal subtask transitions', async () => {
  // Every poa_review comes back `redelegate`, so the subtask cycles
  // briefing -> poa_review -> respawning -> ... until the iteration cap forces
  // an escalation — the loop shape most likely to produce an illegal write.
  const decide = ({ role, kind }) => {
    if (role === 'architect' && kind === 'epic_plan') {
      return { kind: 'epic_plan', summary: 'x', subtasks: [{ title: 'A', goal: 'g', role: 'audit' }] }
    }
    if (role === 'architect' && kind === 'poa_review') return { kind: 'poa_review', verdict: 'redelegate', feedback: 'again' }
    return happyDecider({ role, kind })
  }
  const { mgr, cleanup, nodeTrace } = makeHarness(decide)
  try {
    const rec = mgr.createRun({ goal: 'Audit', cwd: '/repo', autoApprovePlan: true })
    const gated = waitFor(mgr, ['gate_opened'])
    await mgr.startRun(rec.runId)
    await gated

    // POSITIVE CONTROL: the redelegate loop really ran (respawning + escalated).
    const seen = nodeTrace.map((s) => s.to)
    assert.ok(seen.includes('respawning'), `expected a respawning write, got ${seen.join(',')}`)
    assert.ok(seen.includes('escalated'), `expected an escalated write, got ${seen.join(',')}`)

    const bad = firstIllegal(nodeTrace, assertNodeTransition)
    assert.equal(bad, null, `engine journaled an illegal NODE transition: ${bad?.err?.message}`)
  } finally {
    cleanup()
  }
})

test('#6732 cancelRun journals only legal run transitions', async () => {
  const decide = ({ role, kind }) => (kind === 'epic_plan' ? null : happyDecider({ role, kind })) // hang the plan turn
  const { mgr, cleanup, runTrace } = makeHarness(decide)
  try {
    const rec = mgr.createRun({ goal: 'Audit', cwd: '/repo', autoApprovePlan: true })
    const startP = mgr.startRun(rec.runId)
    await new Promise((r) => setTimeout(r, 10))
    await mgr.cancelRun(rec.runId)
    await startP

    // POSITIVE CONTROL: the cancel really landed terminal.
    assert.equal(runTrace.at(-1).to, 'cancelled')

    const bad = firstIllegal(runTrace, assertRunTransition)
    assert.equal(bad, null, `engine journaled an illegal RUN transition: ${bad?.err?.message}`)
  } finally {
    cleanup()
  }
})

test('#7132 a concurrent double cancel acks twice and journals one cancelling + one cancelled', async () => {
  // The FSM cannot catch this one: `cancelling -> cancelling` is LEGAL (the
  // cancel/suspend/fail terminals are reachable from any non-terminal state), so
  // an unguarded second cancel re-runs the whole teardown and only trips the
  // guard at the very END, on `cancelled -> cancelled`. That throw reaches the
  // wire as ORCHESTRATION_ACTION_FAILED for a cancel that in fact succeeded —
  // which is why this lands with the surface that first exposes `cancel` (#7138).
  const { mgr, ledger, cleanup, runTrace } = makeHarness(happyDecider)
  try {
    const rec = mgr.createRun({ goal: 'Audit', cwd: '/repo', autoApprovePlan: false })
    const gated = waitFor(mgr, ['gate_opened'])
    await mgr.startRun(rec.runId)
    await gated // deterministic mid-flight state: live at plan_review, architect session owned

    let cancelledEvents = 0
    mgr.on('run_cancelled', () => { cancelledEvents += 1 })

    // Deterministic overlap, no sleep: `cancelRun` runs synchronously up to its
    // first `await`, so issuing the second call before awaiting the first puts it
    // squarely inside the window the guard has to close. This is the double-click
    // shape exactly. Driven through `runAction` — the wire entry point — because
    // the user-visible half of the bug is its ack, not the engine state.
    const first = mgr.runAction(rec.runId, 'cancel')
    const second = mgr.runAction(rec.runId, 'cancel')
    const settled = await Promise.allSettled([first, second])

    const rejected = settled.filter((s) => s.status === 'rejected')
    assert.equal(rejected.length, 0, `both cancels must ack; got: ${rejected.map((r) => r.reason?.message).join(' | ')}`)
    for (const [i, s] of settled.entries()) {
      assert.ok(s.value, `cancel #${i + 1} must resolve truthy — runAction throws "not found" on a falsy result`)
      assert.equal(s.value.runId, rec.runId)
    }

    // POSITIVE CONTROL: the trace wrapper really observed the cancel writes.
    const pairs = runTrace.map((s) => `${s.from} -> ${s.to}`)
    assert.ok(pairs.includes('plan_review -> cancelling'), `expected the cancel to start from plan_review, got:\n${pairs.join('\n')}`)

    // The teardown ran ONCE: one `cancelling` write, one `cancelled` write, one event.
    assert.equal(runTrace.filter((s) => s.to === 'cancelling').length, 1, `exactly one cancelling write, got:\n${pairs.join('\n')}`)
    assert.equal(runTrace.filter((s) => s.to === 'cancelled').length, 1, `exactly one cancelled write, got:\n${pairs.join('\n')}`)
    assert.equal(cancelledEvents, 1, 'exactly one run_cancelled event')
    assert.equal(ledger.getRun(rec.runId).status, 'cancelled')

    const bad = firstIllegal(runTrace, assertRunTransition)
    assert.equal(bad, null, `engine journaled an illegal RUN transition: ${bad?.err?.message}`)
  } finally {
    cleanup()
  }
})

test('#7132 cancelling a run that already reached a terminal cancel is a no-op ack', async () => {
  // The sequential sibling of the race above: the run is gone from `_runs`, so
  // this exercises the "unknown run" answer rather than the guard. `runAction`
  // must surface it as a failure (a cancel for a run this engine has no record
  // of is not something to ack silently), while `cancelRun` itself answers null.
  const { mgr, cleanup } = makeHarness(happyDecider)
  try {
    const rec = mgr.createRun({ goal: 'Audit', cwd: '/repo', autoApprovePlan: false })
    const gated = waitFor(mgr, ['gate_opened'])
    await mgr.startRun(rec.runId)
    await gated
    assert.equal((await mgr.cancelRun(rec.runId)).phase, 'cancelled')
    assert.equal(await mgr.cancelRun(rec.runId), null, 'a retired run is unknown, not cancellable')
  } finally {
    cleanup()
  }
})

// The two remaining table reconciliations (`result_review -> briefing` on a
// result revise, `escalated -> spawning` on a user retry) are LOAD-BEARING under
// the fail-closed posture: drop either row and the corresponding live run dies
// with a TransitionError mid-flight. Neither is reachable from the happy path,
// the redelegate loop or the cancel path above, so each gets its own driven run
// — otherwise the whole suite stays green while the row rots.

test('#6732 a result-review revise re-drives briefing and journals only legal subtask transitions', async () => {
  // First result_review comes back `revise`, so the committee loop returns to
  // the TOP of the cycle (fresh plan-of-attack) rather than re-prompting in
  // place: result_review -> briefing. Second time it approves so the run ends.
  const decide = ({ role, kind, n }) => {
    if (role === 'architect' && kind === 'result_review' && n === 1) {
      return { kind: 'result_review', verdict: 'revise', feedback: 'tighten it' }
    }
    return happyDecider({ role, kind })
  }
  const { mgr, cleanup, nodeTrace } = makeHarness(decide)
  try {
    const rec = mgr.createRun({ goal: 'Audit', cwd: '/repo', autoApprovePlan: true })
    const done = waitFor(mgr, ['run_completed'])
    await mgr.startRun(rec.runId)
    await done

    // POSITIVE CONTROL: the revise really re-entered briefing from result_review.
    const pairs = nodeTrace.map((s) => `${s.from} -> ${s.to}`)
    assert.ok(pairs.includes('result_review -> briefing'), `expected a result_review -> briefing write, got:\n${pairs.join('\n')}`)

    const bad = firstIllegal(nodeTrace, assertNodeTransition)
    assert.equal(bad, null, `engine journaled an illegal NODE transition: ${bad?.err?.message}`)
  } finally {
    cleanup()
  }
})

test('#6732 an escalation retry re-spawns from escalated and journals only legal subtask transitions', async () => {
  // First poa_review escalates; the user approves the escalation gate, which
  // hands the subtask to a FRESH worker — so it re-enters through the spawn
  // step: escalated -> spawning. Second poa_review approves so the run ends.
  const decide = ({ role, kind, n }) => {
    if (role === 'architect' && kind === 'poa_review' && n === 1) {
      return { kind: 'poa_review', verdict: 'escalate', feedback: 'needs a human' }
    }
    return happyDecider({ role, kind })
  }
  const { mgr, cleanup, nodeTrace } = makeHarness(decide)
  try {
    const rec = mgr.createRun({ goal: 'Audit', cwd: '/repo', autoApprovePlan: true })
    const gated = waitFor(mgr, ['gate_opened'])
    await mgr.startRun(rec.runId)
    const { payload } = await gated
    const done = waitFor(mgr, ['run_completed'])
    await mgr.resolveGate(rec.runId, payload.gate.gateId, { decision: 'approve' })
    await done

    // POSITIVE CONTROL: the retry really re-spawned out of `escalated`.
    const pairs = nodeTrace.map((s) => `${s.from} -> ${s.to}`)
    assert.ok(pairs.includes('escalated -> spawning'), `expected an escalated -> spawning write, got:\n${pairs.join('\n')}`)

    const bad = firstIllegal(nodeTrace, assertNodeTransition)
    assert.equal(bad, null, `engine journaled an illegal NODE transition: ${bad?.err?.message}`)
  } finally {
    cleanup()
  }
})

// --- 2. wiring (fail-closed) ------------------------------------------------

test('#6732 an illegal RUN transition is rejected fail-closed and never journaled', async () => {
  const { mgr, ledger, cleanup } = makeHarness(happyDecider)
  try {
    const rec = mgr.createRun({ goal: 'Audit', cwd: '/repo' })
    const run = mgr._runs.get(rec.runId)
    assert.equal(ledger.getRun(rec.runId).status, 'created') // positive control

    assert.throws(() => mgr._setRunStatus(run, 'completed'), (err) => {
      assert.ok(err instanceof TransitionError, `expected TransitionError, got ${err?.name}: ${err?.message}`)
      assert.equal(err.code, 'ILLEGAL_TRANSITION')
      return true
    })
    assert.equal(ledger.getRun(rec.runId).status, 'created', 'the illegal status must NOT be journaled')
    assert.equal(run.phase, 'created', 'the engine mirror must not advance either')
  } finally {
    cleanup()
  }
})

test('#6732 an illegal SUBTASK transition is rejected fail-closed and never journaled', async () => {
  const { mgr, ledger, cleanup } = makeHarness(happyDecider)
  try {
    const rec = mgr.createRun({ goal: 'Audit', cwd: '/repo', autoApprovePlan: false })
    const gated = waitFor(mgr, ['gate_opened'])
    await mgr.startRun(rec.runId)
    await gated
    const run = mgr._runs.get(rec.runId)
    const subtaskId = [...run.subtasks.keys()][0]
    assert.equal(ledger.getRun(rec.runId).subtasks[0].status, 'pending') // positive control

    assert.throws(() => mgr._setSubtaskStatus(run, subtaskId, 'done'), (err) => {
      assert.ok(err instanceof TransitionError, `expected TransitionError, got ${err?.name}: ${err?.message}`)
      assert.equal(err.code, 'ILLEGAL_TRANSITION')
      return true
    })
    assert.equal(ledger.getRun(rec.runId).subtasks[0].status, 'pending', 'the illegal status must NOT be journaled')
  } finally {
    cleanup()
  }
})

// --- 3. no second, unguarded write path ------------------------------------

test('#6732 the manager has exactly one guarded run-status and one guarded subtask-status write path', () => {
  const src = readFileSync(MANAGER_SRC, 'utf8')
  // POSITIVE CONTROL: the file was read and the patterns are not phantoms.
  assert.ok(src.length > 1000, 'orchestration-manager.js should be non-trivial')
  assert.ok(src.includes('_ledger.setStatus('), 'sanity: the setStatus pattern must match somewhere')
  assert.ok(src.includes('_ledger.updateSubtask('), 'sanity: the updateSubtask pattern must match somewhere')

  const lines = src.split('\n')
  const setStatusLines = lines.filter((l) => l.includes('_ledger.setStatus('))
  const updateLines = lines.filter((l) => l.includes('_ledger.updateSubtask('))
  assert.equal(setStatusLines.length, 1, `every run-status write must go through _setRunStatus; found ${setStatusLines.length} raw _ledger.setStatus( call sites:\n${setStatusLines.join('\n')}`)
  assert.equal(updateLines.length, 1, `every subtask-status write must go through _setSubtaskStatus; found ${updateLines.length} raw _ledger.updateSubtask( call sites:\n${updateLines.join('\n')}`)

  // and those single sites must be the asserting helpers
  // #7401 — boolean collapse: `src` is orchestration-manager.js (~66 KB) and a
  // failing assert.match would serialise all of it as the error's `actual`.
  assert.ok(/_setRunStatus\s*\([^)]*\)\s*\{[\s\S]{0,600}?assertRunTransition\(/.test(src), '_setRunStatus must call assertRunTransition')
  assert.ok(/_setSubtaskStatus\s*\([^)]*\)\s*\{[\s\S]{0,600}?assertNodeTransition\(/.test(src), '_setSubtaskStatus must call assertNodeTransition')
})
