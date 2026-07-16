// Tests for the OrchestrationManager committee engine (read/audit path, E-2).
// Drives full audit runs against a fake SessionManager whose sessions detect the
// expected decision kind from each prompt and emit scripted `chroxy-decision`
// blocks — exercising the same TurnDriver → RunLedger → decision-contract wire
// path production uses, with no real provider.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

import { OrchestrationManager } from '../src/orchestration/orchestration-manager.js'
import { OrchestrationPermissionGate } from '../src/orchestration/permission-gate.js'
import { RunLedger } from '../src/orchestration/run-ledger.js'
import { TurnDriver } from '../src/orchestration/turn-driver.js'

// --- fakes -----------------------------------------------------------------

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
    this.permissionRules = null
    this.destroyed = false
    this.interrupted = 0
    this.lastKind = null
    this.kindCalls = Object.create(null)
    this.permissionResponses = []
  }
  setPermissionRules(rules) { this.permissionRules = rules }
  interrupt() { this.interrupted += 1 }
  respondToPermission(requestId, decision) { this.permissionResponses.push({ requestId, decision }) }
  sendMessage(prompt) {
    const m = String(prompt).match(KIND_RE)
    const kind = m ? m[1] : this.lastKind
    this.lastKind = kind
    this.kindCalls[kind] = (this.kindCalls[kind] || 0) + 1
    queueMicrotask(() => {
      if (this.destroyed) return
      const out = this._decide({ role: this.role, kind, prompt: String(prompt), n: this.kindCalls[kind], model: this._model })
      if (out == null) return // sentinel: hang this turn (no result emitted)
      const text = typeof out === 'string' ? out : fenced(out)
      this._sm.emit('session_event', { sessionId: this.sessionId, event: 'stream_delta', data: { messageId: 'm1', delta: text } })
      this._sm.emit('session_event', {
        sessionId: this.sessionId,
        event: 'result',
        data: {
          model: this._model,
          cost: 0.01,
          duration: 500,
          apiDurationMs: 400,
          numTurns: 1,
          usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 10 },
          modelUsage: { [this._model]: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 10 } },
        },
      })
    })
    return Promise.resolve()
  }
}

class FakeSM extends EventEmitter {
  constructor(decide, { architectModel = 'fable-hi', workerModel = 'haiku' } = {}) {
    super()
    this.setMaxListeners(0)
    this._decide = decide
    this._models = { architect: architectModel, worker: workerModel }
    this._sessions = new Map()
    this._n = 0
    this.created = []
    this.destroyedIds = []
  }
  createSession(opts) {
    const sessionId = `sess_${++this._n}`
    const isArch = opts.metadata?.orchestrationRole === 'architect'
    const model = isArch ? this._models.architect : this._models.worker
    const session = new FakeSession(sessionId, this, opts, this._decide, model)
    this._sessions.set(sessionId, session)
    this.created.push({ sessionId, opts, session })
    return sessionId
  }
  getSession(id) { const s = this._sessions.get(id); return s ? { session: s } : null }
  destroySession(id) {
    const s = this._sessions.get(id)
    if (!s) return
    s.destroyed = true
    this._sessions.delete(id)
    this.destroyedIds.push(id)
    this.emit('session_destroyed', { sessionId: id })
  }
  listSessions() { return [...this._sessions.keys()] }
}

// Default happy-path decider: architect plans 2 subtasks, approves every review,
// synthesizes; workers propose a PoA and report a result.
function happyDecider({ role, kind }) {
  if (role === 'architect') {
    if (kind === 'epic_plan') {
      return {
        kind: 'epic_plan',
        summary: 'Two-area audit',
        subtasks: [
          { title: 'Audit server auth', goal: 'Review auth for bugs', role: 'audit' },
          { title: 'Audit tunnel', goal: 'Review tunnel for bugs', role: 'audit' },
        ],
      }
    }
    if (kind === 'poa_review') return { kind: 'poa_review', verdict: 'approve' }
    if (kind === 'result_review') return { kind: 'result_review', verdict: 'approve' }
    if (kind === 'synthesis') return { kind: 'synthesis', reportMarkdown: '# Audit Report\n\nAll clear.' }
  }
  if (kind === 'plan_of_attack') return { kind: 'plan_of_attack', plan: 'Read the files and grep.', summary: 'PoA' }
  if (kind === 'work_result') return { kind: 'work_result', summary: 'Found 2 issues in the area.' }
  throw new Error(`unexpected turn role=${role} kind=${kind}`)
}

const ROLES = {
  architect: { provider: 'claude-sdk', model: 'fable-hi' },
  auditWorker: { provider: 'claude-sdk', model: 'haiku' },
}

function makeHarness(decide, { roles = ROLES, config = {}, permissionGate = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'orch-mgr-'))
  const sm = new FakeSM(decide)
  const ledger = new RunLedger({ baseDir: dir })
  const driver = new TurnDriver({ sessionManager: sm })
  const mgr = new OrchestrationManager({
    sessionManager: sm,
    ledger,
    turnDriver: driver,
    roles,
    config,
    permissionGateFactory: permissionGate ? (o) => new OrchestrationPermissionGate(o) : null,
  })
  const cleanup = () => {
    mgr.dispose()
    driver.dispose()
    ledger.dispose?.()
    rmSync(dir, { recursive: true, force: true })
  }
  return { dir, sm, ledger, driver, mgr, cleanup }
}

// Resolve on the first of the named manager events; reject on run_failed unless
// it is one of the awaited events.
function waitFor(mgr, events, { timeoutMs = 5000 } = {}) {
  const wanted = new Set(events)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`timeout waiting for ${events.join('/')}`)) }, timeoutMs)
    const handlers = new Map()
    const cleanup = () => { clearTimeout(timer); for (const [ev, h] of handlers) mgr.off(ev, h) }
    const allEvents = new Set([...wanted, 'run_failed'])
    for (const ev of allEvents) {
      const h = (payload) => { cleanup(); resolve({ event: ev, payload }) }
      handlers.set(ev, h)
      mgr.on(ev, h)
    }
  })
}

// --- tests -----------------------------------------------------------------

test('full audit run: plan → committee → synthesis → completed', async () => {
  const { sm, ledger, mgr, cleanup } = makeHarness(happyDecider)
  try {
    const rec = mgr.createRun({ goal: 'Audit the repo', cwd: '/repo', autoApprovePlan: true })
    const done = waitFor(mgr, ['run_completed'])
    await mgr.startRun(rec.runId)
    const { event, payload } = await done
    assert.equal(event, 'run_completed')
    assert.match(payload.reportMarkdown, /Audit Report/)

    const record = ledger.getRun(rec.runId)
    assert.equal(record.status, 'completed')
    assert.equal(record.subtasks.length, 2)
    assert.ok(record.subtasks.every((s) => s.status === 'done'), 'all subtasks done')

    // per-role + per-model attribution survived the turn-driver
    assert.ok(record.usageTotals.byRole.architect, 'architect role recorded')
    assert.ok(record.usageTotals.byRole['architect.review'], 'architect.review role recorded')
    assert.ok(record.usageTotals.byRole['worker.audit'], 'worker.audit role recorded')
    assert.ok(record.usageTotals.byModel['fable-hi'], 'architect model recorded')
    assert.ok(record.usageTotals.byModel.haiku, 'worker model recorded')

    // audit workers got read-allow / write-deny rules and were torn down
    const workerSessions = sm.created.filter((c) => c.opts.metadata?.orchestrationRole === 'worker.audit')
    assert.equal(workerSessions.length, 2)
    for (const w of workerSessions) {
      const rules = w.session.permissionRules
      assert.ok(rules.some((r) => r.tool === 'Write' && r.decision === 'deny'), 'Write denied')
      assert.ok(rules.some((r) => r.tool === 'Read' && r.decision === 'allow'), 'Read allowed')
    }
    // every spawned session destroyed by the end
    assert.equal(sm.listSessions().length, 0, 'no leaked sessions')
  } finally {
    cleanup()
  }
})

test('plan gate: startRun opens epic_plan gate; approve runs it to completion', async () => {
  const { ledger, mgr, cleanup } = makeHarness(happyDecider)
  try {
    const rec = mgr.createRun({ goal: 'Audit', cwd: '/repo', autoApprovePlan: false })
    const gated = waitFor(mgr, ['gate_opened'])
    const res = await mgr.startRun(rec.runId)
    assert.equal(res.phase, 'plan_review')
    const { payload } = await gated
    assert.equal(payload.gate.kind, 'epic_plan')
    assert.equal(ledger.getRun(rec.runId).status, 'plan_review')

    const done = waitFor(mgr, ['run_completed'])
    await mgr.resolveGate(rec.runId, payload.gate.gateId, { decision: 'approve' })
    await done
    assert.equal(ledger.getRun(rec.runId).status, 'completed')
  } finally {
    cleanup()
  }
})

test('plan gate: reject fails the run', async () => {
  const { ledger, mgr, cleanup } = makeHarness(happyDecider)
  try {
    const rec = mgr.createRun({ goal: 'Audit', cwd: '/repo', autoApprovePlan: false })
    const gated = waitFor(mgr, ['gate_opened'])
    await mgr.startRun(rec.runId)
    const { payload } = await gated
    const failed = waitFor(mgr, ['run_failed'])
    await mgr.resolveGate(rec.runId, payload.gate.gateId, { decision: 'reject', note: 'no' })
    const { payload: fp } = await failed
    assert.equal(fp.code, 'PLAN_REJECTED')
    assert.equal(ledger.getRun(rec.runId).status, 'failed')
  } finally {
    cleanup()
  }
})

test('revise verdict loops the subtask, then approves', async () => {
  // architect revises the first PoA of each subtask once, approves after.
  const decide = (ctx) => {
    if (ctx.role === 'architect' && ctx.kind === 'poa_review') {
      return { kind: 'poa_review', verdict: ctx.n === 1 ? 'revise' : 'approve', feedback: 'tighten scope' }
    }
    return happyDecider(ctx)
  }
  const { ledger, mgr, cleanup } = makeHarness(decide)
  try {
    const rec = mgr.createRun({ goal: 'Audit', cwd: '/repo', autoApprovePlan: true })
    const done = waitFor(mgr, ['run_completed'])
    await mgr.startRun(rec.runId)
    await done
    const record = ledger.getRun(rec.runId)
    assert.equal(record.status, 'completed')
    assert.ok(record.subtasks.every((s) => s.status === 'done'))
    // at least one poa committee review with a revise verdict was recorded
    const reviews = record.subtasks.flatMap((s) => s.committee)
    assert.ok(reviews.some((r) => r.phase === 'plan' && r.verdict === 'revise'), 'revise review recorded')
  } finally {
    cleanup()
  }
})

test('iteration cap escalates the subtask; skip lets the run finish', async () => {
  // architect always revises → subtask A can never pass poa_review → escalates.
  const decide = (ctx) => {
    if (ctx.role === 'architect' && ctx.kind === 'poa_review') return { kind: 'poa_review', verdict: 'revise', feedback: 'again' }
    if (ctx.role === 'architect' && ctx.kind === 'epic_plan') {
      return { kind: 'epic_plan', subtasks: [{ title: 'Only area', goal: 'g', role: 'audit' }] }
    }
    return happyDecider(ctx)
  }
  const { ledger, mgr, cleanup } = makeHarness(decide, { config: { maxCommitteeIterations: 2 } })
  try {
    const rec = mgr.createRun({ goal: 'Audit', cwd: '/repo', autoApprovePlan: true })
    const escalated = waitFor(mgr, ['gate_opened'])
    await mgr.startRun(rec.runId)
    const { payload } = await escalated
    assert.equal(payload.gate.kind, 'escalation')

    const done = waitFor(mgr, ['run_completed'])
    await mgr.resolveGate(rec.runId, payload.gate.gateId, { decision: 'skip' })
    await done
    const record = ledger.getRun(rec.runId)
    assert.equal(record.status, 'completed')
    assert.equal(record.subtasks[0].status, 'skipped')
  } finally {
    cleanup()
  }
})

test('worker parse failure is repaired on retry', async () => {
  // worker emits garbage on the first work_result turn, valid on the repair.
  const decide = (ctx) => {
    if (ctx.kind === 'work_result' && ctx.n === 1) return 'I could not comply. No block here.'
    return happyDecider(ctx)
  }
  const { ledger, mgr, cleanup } = makeHarness(decide)
  try {
    const rec = mgr.createRun({ goal: 'Audit', cwd: '/repo', autoApprovePlan: true })
    const done = waitFor(mgr, ['run_completed'])
    await mgr.startRun(rec.runId)
    await done
    assert.equal(ledger.getRun(rec.runId).status, 'completed')
  } finally {
    cleanup()
  }
})

test('unrecoverable parse failure fails the subtask', async () => {
  // one subtask's worker never emits a valid work_result → subtask fails, run
  // still synthesizes the rest.
  const decide = (ctx) => {
    if (ctx.kind === 'epic_plan') return { kind: 'epic_plan', subtasks: [{ title: 'A', goal: 'g', role: 'audit' }] }
    if (ctx.kind === 'work_result') return 'never a valid block'
    return happyDecider(ctx)
  }
  const { ledger, mgr, cleanup } = makeHarness(decide, { config: { maxParseRetries: 1 } })
  try {
    const rec = mgr.createRun({ goal: 'Audit', cwd: '/repo', autoApprovePlan: true })
    const done = waitFor(mgr, ['run_completed'])
    await mgr.startRun(rec.runId)
    await done
    const record = ledger.getRun(rec.runId)
    assert.equal(record.status, 'completed')
    assert.equal(record.subtasks[0].status, 'failed')
  } finally {
    cleanup()
  }
})

test('budget cap pauses the run before spawning workers', async () => {
  // maxUsd below the plan-turn cost → evaluateBudget caps before the first
  // worker delegation → budget_paused.
  const { ledger, mgr, cleanup } = makeHarness(happyDecider)
  try {
    const rec = mgr.createRun({ goal: 'Audit', cwd: '/repo', autoApprovePlan: true, budgetUsd: 0.005 })
    const paused = waitFor(mgr, ['run_budget_paused'])
    await mgr.startRun(rec.runId)
    await paused
    const record = ledger.getRun(rec.runId)
    assert.equal(record.status, 'budget_paused')
    // no worker subtask ran to done
    assert.ok(record.subtasks.every((s) => s.status !== 'done'))
  } finally {
    cleanup()
  }
})

test('rejects an ineligible worker provider at createRun', () => {
  const { mgr, cleanup } = makeHarness(happyDecider, {
    roles: { architect: ROLES.architect, auditWorker: { provider: 'gemini', model: 'g' } },
  })
  try {
    assert.throws(() => mgr.createRun({ goal: 'x', cwd: '/repo' }), /cannot be permission-gated read-only/)
  } finally {
    cleanup()
  }
})

test('rejects a cwd that fails validation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-cwd-'))
  const sm = new FakeSM(happyDecider)
  const ledger = new RunLedger({ baseDir: dir })
  const driver = new TurnDriver({ sessionManager: sm })
  const mgr = new OrchestrationManager({
    sessionManager: sm, ledger, turnDriver: driver, roles: ROLES,
    validateCwd: (cwd) => (cwd === '/ok' ? null : 'outside allowed roots'),
  })
  try {
    assert.throws(() => mgr.createRun({ goal: 'x', cwd: '/nope' }), /invalid cwd/)
    assert.doesNotThrow(() => mgr.createRun({ goal: 'x', cwd: '/ok' }))
  } finally {
    mgr.dispose(); driver.dispose(); rmSync(dir, { recursive: true, force: true })
  }
})

test('architect session is spawned read-only', async () => {
  const { sm, mgr, cleanup } = makeHarness(happyDecider)
  try {
    const rec = mgr.createRun({ goal: 'Audit', cwd: '/repo', autoApprovePlan: true })
    const done = waitFor(mgr, ['run_completed'])
    await mgr.startRun(rec.runId)
    await done
    const arch = sm.created.find((c) => c.opts.metadata?.orchestrationRole === 'architect')
    assert.ok(arch, 'architect session created')
    const rules = arch.session.permissionRules
    assert.ok(Array.isArray(rules), 'architect got permission rules')
    assert.ok(rules.some((r) => r.tool === 'Read' && r.decision === 'allow'), 'architect Read allowed')
    assert.ok(rules.some((r) => r.tool === 'Write' && r.decision === 'deny'), 'architect Write denied')
  } finally {
    cleanup()
  }
})

test('gate denies an architect Bash request (never ignores it)', async () => {
  // C2: with a permission gate, an owned architect session that emits Bash is
  // answered (deny), not left to wedge.
  const { sm, mgr, cleanup } = makeHarness(happyDecider, { permissionGate: true })
  try {
    const rec = mgr.createRun({ goal: 'Audit', cwd: '/repo', autoApprovePlan: false })
    const gated = waitFor(mgr, ['gate_opened'])
    await mgr.startRun(rec.runId)
    await gated // plan done; architect session still owned (destroyed at synthesis)
    const arch = sm.created.find((c) => c.opts.metadata?.orchestrationRole === 'architect').session
    sm.emit('session_event', { sessionId: arch.sessionId, event: 'permission_request', data: { requestId: 'rq', tool: 'Bash', input: { command: 'ls' } } })
    assert.deepEqual(arch.permissionResponses, [{ requestId: 'rq', decision: 'deny' }])
  } finally {
    cleanup()
  }
})

test('redelegate spawns a fresh worker session', async () => {
  const decide = (ctx) => {
    if (ctx.kind === 'epic_plan') return { kind: 'epic_plan', subtasks: [{ title: 'A', goal: 'g', role: 'audit' }] }
    if (ctx.role === 'architect' && ctx.kind === 'poa_review') {
      return { kind: 'poa_review', verdict: ctx.n === 1 ? 'redelegate' : 'approve' }
    }
    return happyDecider(ctx)
  }
  const { sm, ledger, mgr, cleanup } = makeHarness(decide)
  try {
    const rec = mgr.createRun({ goal: 'Audit', cwd: '/repo', autoApprovePlan: true })
    const done = waitFor(mgr, ['run_completed'])
    await mgr.startRun(rec.runId)
    await done
    assert.equal(ledger.getRun(rec.runId).status, 'completed')
    // one subtask, redelegated once → TWO worker sessions were created for it
    const workers = sm.created.filter((c) => c.opts.metadata?.orchestrationRole === 'worker.audit')
    assert.equal(workers.length, 2, 'redelegate created a fresh worker')
  } finally {
    cleanup()
  }
})

test('architect review usage lands in architect.review, not the subtask cell', async () => {
  const { ledger, mgr, cleanup } = makeHarness(happyDecider)
  try {
    const rec = mgr.createRun({ goal: 'Audit', cwd: '/repo', autoApprovePlan: true })
    const done = waitFor(mgr, ['run_completed'])
    await mgr.startRun(rec.runId)
    await done
    const record = ledger.getRun(rec.runId)
    // architect: plan + synthesis = 2 turns; architect.review: 2 subtasks × 2 reviews = 4
    assert.equal(record.usageTotals.byRole.architect.turns, 2)
    assert.equal(record.usageTotals.byRole['architect.review'].turns, 4)
    // each subtask cell holds only its worker's 2 turns (poa + execute), and the
    // architect's review turns did NOT flip modelDrift on it
    for (const st of record.subtasks) {
      assert.equal(st.usage.turns, 2, 'subtask cell = worker turns only')
      assert.notEqual(st.modelDrift, true, 'no spurious modelDrift from the review turn')
    }
  } finally {
    cleanup()
  }
})

test('startRun is rejected if the run already started', async () => {
  const { mgr, cleanup } = makeHarness(happyDecider)
  try {
    const rec = mgr.createRun({ goal: 'Audit', cwd: '/repo', autoApprovePlan: false })
    const gated = waitFor(mgr, ['gate_opened'])
    await mgr.startRun(rec.runId)
    await gated
    await assert.rejects(() => mgr.startRun(rec.runId), /already started/)
  } finally {
    cleanup()
  }
})

test('cancel during a turn keeps status cancelled (no failed overwrite)', async () => {
  // architect plan turn hangs; cancel mid-turn destroys it → the turn rejects
  // SESSION_GONE → _plan throws → _failRun must NOT overwrite cancelled.
  const decide = (ctx) => (ctx.kind === 'epic_plan' ? null : happyDecider(ctx))
  const { ledger, mgr, cleanup } = makeHarness(decide)
  try {
    const rec = mgr.createRun({ goal: 'Audit', cwd: '/repo', autoApprovePlan: true })
    let failed = false
    mgr.on('run_failed', () => { failed = true })
    const startP = mgr.startRun(rec.runId)
    await new Promise((r) => setTimeout(r, 10)) // let the plan turn start + hang
    mgr.cancelRun(rec.runId)
    await startP
    assert.equal(ledger.getRun(rec.runId).status, 'cancelled')
    assert.equal(failed, false, 'no run_failed emitted after cancel')
  } finally {
    cleanup()
  }
})

test('repo-audit preset supplies the goal and forces audit role', async () => {
  // architect proposes an implement subtask; preset coerces it to audit.
  const decide = (ctx) => {
    if (ctx.kind === 'epic_plan') return { kind: 'epic_plan', subtasks: [{ title: 'A', goal: 'g', role: 'implement' }] }
    return happyDecider(ctx)
  }
  const { ledger, mgr, cleanup } = makeHarness(decide)
  try {
    const rec = mgr.createRun({ cwd: '/repo', preset: 'repo-audit', autoApprovePlan: true })
    const done = waitFor(mgr, ['run_completed'])
    await mgr.startRun(rec.runId)
    await done
    const record = ledger.getRun(rec.runId)
    assert.equal(record.status, 'completed')
    assert.equal(record.subtasks[0].role, 'worker.audit', 'implement coerced to audit')
    // the run was created with no explicit goal — the preset supplied it
    assert.equal(record.preset, 'repo-audit')
  } finally {
    cleanup()
  }
})
