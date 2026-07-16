// Tests for the OrchestrationManager IMPLEMENT (write) path (E-3 part 2).
// Drives full implement runs against a fake SessionManager (worktree-aware) and
// a fake gitOps that records calls and returns canned results — the manager's
// ORCHESTRATION logic is under test here; real git behavior is covered by
// orchestration-git-ops.test.js.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

import { OrchestrationManager } from '../src/orchestration/orchestration-manager.js'
import { RunLedger } from '../src/orchestration/run-ledger.js'
import { TurnDriver } from '../src/orchestration/turn-driver.js'

const KIND_RE = /kind "([a-z_]+)"/
const fenced = (obj) => 'ok\n\n```chroxy-decision\n' + JSON.stringify(obj) + '\n```'

class FakeSession extends EventEmitter {
  constructor(sessionId, sm, opts, decide, model) {
    super()
    this.sessionId = sessionId
    this._sm = sm
    this.opts = opts
    this._decide = decide
    this._model = model
    this.role = opts.metadata?.orchestrationRole ?? null
    this.worktreePath = opts.worktree ? join(sm._wtRoot, sessionId) : null
    this.permissionRules = null
    this.destroyed = false
    this.lastKind = null
    this.kindCalls = Object.create(null)
    this.sends = []
    this.permissionResponses = []
  }
  setPermissionRules(rules) { this.permissionRules = rules }
  interrupt() {}
  respondToPermission(requestId, decision) { this.permissionResponses.push({ requestId, decision }) }
  sendMessage(prompt) {
    this.sends.push(String(prompt))
    const m = String(prompt).match(KIND_RE)
    const kind = m ? m[1] : this.lastKind
    this.lastKind = kind
    this.kindCalls[kind] = (this.kindCalls[kind] || 0) + 1
    queueMicrotask(() => {
      if (this.destroyed) return
      const out = this._decide({ role: this.role, kind, n: this.kindCalls[kind] })
      if (out == null) return
      const text = typeof out === 'string' ? out : fenced(out)
      this._sm.emit('session_event', { sessionId: this.sessionId, event: 'stream_delta', data: { messageId: 'm1', delta: text } })
      this._sm.emit('session_event', {
        sessionId: this.sessionId, event: 'result',
        data: { model: this._model, cost: 0.01, duration: 100, usage: { input_tokens: 10, output_tokens: 5 } },
      })
    })
    return Promise.resolve()
  }
}

class FakeSM extends EventEmitter {
  constructor(decide, { architectModel = 'fable', workerModel = 'codex-m' } = {}) {
    super()
    this.setMaxListeners(0)
    this._decide = decide
    this._models = { architect: architectModel, worker: workerModel }
    this._sessions = new Map()
    this._n = 0
    this._wtRoot = mkdtempSync(join(tmpdir(), 'impl-wt-'))
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
  getSession(id) { const s = this._sessions.get(id); return s ? { session: s, worktreePath: s.worktreePath } : null }
  destroySession(id) { const s = this._sessions.get(id); if (s) { s.destroyed = true; this._sessions.delete(id); this.destroyedIds.push(id) } }
  listSessions() { return [...this._sessions.keys()] }
}

function makeFakeGitOps({ conflict = false, failCreateBranch = false } = {}) {
  const calls = []
  const branches = new Set() // stateful so redelegate exercises delete-then-recreate
  const rec = (name, arg) => calls.push({ name, arg })
  return {
    calls,
    integrationWorktreePath: (runId) => `/wt/${runId}/integration`,
    async branchExists(_r, b) { return { exists: branches.has(b) } },
    async deleteBranch(_r, b) { rec('deleteBranch', b); branches.delete(b); return { deleted: true } },
    async createBranch(worktreePath, branchName) {
      rec('createBranch', { worktreePath, branchName })
      if (failCreateBranch) throw new Error('createBranch failed')
      branches.add(branchName)
      return { branch: branchName, baseSha: `base_${branchName}` }
    },
    async autoCommit(a) { rec('autoCommit', a); return { committed: true, sha: 'sha1' } },
    async isDirty() { return { dirty: false } },
    async computeCappedDiff(a) { rec('computeCappedDiff', a); return { stat: '1 file', patch: '+added line', truncated: false, omittedFiles: [], includedFiles: ['f.js'] } },
    async createIntegrationWorktree({ runId, branchName }) { rec('createIntegrationWorktree', { runId, branchName }); return { worktreePath: `/wt/${runId}/integration`, branch: branchName } },
    async mergeNoFf({ branch, subtaskId }) { rec('mergeNoFf', { branch, subtaskId }); return conflict ? { ok: false, conflict: true, conflictFiles: ['README.md'] } : { ok: true } },
    async abortMerge() { rec('abortMerge'); return { aborted: true } },
    async removeWorktree(a) { rec('removeWorktree', a); return { removed: true, method: 'git' } },
    async pruneWorktrees() { rec('pruneWorktrees'); return { pruned: true } },
  }
}

const ROLES_CODEX = {
  architect: { provider: 'claude-sdk', model: 'fable' },
  auditWorker: { provider: 'codex', model: 'codex-m' }, // codex = implement-eligible
}
const ROLES_SDK = {
  architect: { provider: 'claude-sdk', model: 'fable' },
  auditWorker: { provider: 'claude-sdk', model: 'haiku' }, // NOT implement-eligible
}

function harness(decide, { roles = ROLES_CODEX, gitOpts = {}, config = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'impl-mgr-'))
  const sm = new FakeSM(decide)
  const ledger = new RunLedger({ baseDir: dir })
  const driver = new TurnDriver({ sessionManager: sm })
  const gitOps = makeFakeGitOps(gitOpts)
  const mgr = new OrchestrationManager({ sessionManager: sm, ledger, turnDriver: driver, gitOps, roles, config })
  const cleanup = () => { mgr.dispose(); driver.dispose(); ledger.dispose?.(); rmSync(dir, { recursive: true, force: true }); rmSync(sm._wtRoot, { recursive: true, force: true }) }
  return { sm, ledger, driver, gitOps, mgr, cleanup }
}

function waitFor(mgr, events, { timeoutMs = 5000 } = {}) {
  const wanted = new Set([...events, 'run_failed'])
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`timeout for ${events.join('/')}`)) }, timeoutMs)
    const handlers = new Map()
    const cleanup = () => { clearTimeout(timer); for (const [e, h] of handlers) mgr.off(e, h) }
    for (const ev of wanted) { const h = (p) => { cleanup(); resolve({ event: ev, payload: p }) }; handlers.set(ev, h); mgr.on(ev, h) }
  })
}

function implementDecider(planRole = 'implement') {
  return ({ role, kind }) => {
    if (role === 'architect') {
      if (kind === 'epic_plan') return { kind: 'epic_plan', subtasks: [{ title: 'Add a helper', goal: 'implement it', role: planRole }] }
      if (kind === 'poa_review') return { kind: 'poa_review', verdict: 'approve' }
      if (kind === 'result_review') return { kind: 'result_review', verdict: 'approve' }
      if (kind === 'synthesis') return { kind: 'synthesis', reportMarkdown: '# Done' }
    }
    if (kind === 'plan_of_attack') return { kind: 'plan_of_attack', plan: 'edit f.js', summary: 'poa' }
    if (kind === 'work_result') return { kind: 'work_result', summary: 'edited f.js', filesChanged: ['f.js'] }
    throw new Error(`unexpected ${role}/${kind}`)
  }
}

// --- tests -----------------------------------------------------------------

test('full implement run: branch → commit → diff review → merge → done → completed', async () => {
  const { sm, ledger, gitOps, mgr, cleanup } = harness(implementDecider())
  try {
    const rec = mgr.createRun({ goal: 'Implement', cwd: '/repo', autoApprovePlan: true })
    const done = waitFor(mgr, ['run_completed'])
    await mgr.startRun(rec.runId)
    const { payload } = await done
    const record = ledger.getRun(rec.runId)
    assert.equal(record.status, 'completed')
    assert.equal(record.subtasks[0].role, 'worker.implement')
    assert.equal(record.subtasks[0].status, 'done')

    const names = gitOps.calls.map((c) => c.name)
    assert.ok(names.includes('createBranch'), 'worker branch created')
    assert.ok(names.includes('autoCommit'), 'worktree auto-committed')
    assert.ok(names.includes('computeCappedDiff'), 'review diff computed')
    assert.ok(names.includes('createIntegrationWorktree'), 'integration worktree created')
    assert.ok(names.includes('mergeNoFf'), 'branch merged')
    assert.ok(names.includes('removeWorktree'), 'integration worktree cleaned up on complete')
    assert.equal(payload.integrationBranch, 'chroxy/orch/' + rec.runId + '/integration')
    // load-bearing ORDER: commit before the review diff, and the merge before cleanup
    assert.ok(names.indexOf('autoCommit') < names.indexOf('computeCappedDiff'), 'commit before diff')
    assert.ok(names.indexOf('autoCommit') < names.indexOf('mergeNoFf'), 'commit before merge')
    assert.ok(names.indexOf('createBranch') < names.indexOf('mergeNoFf'), 'branch before merge')
    assert.ok(names.indexOf('mergeNoFf') < names.lastIndexOf('removeWorktree'), 'merge before cleanup')

    // the implement worker was spawned write-capable
    const worker = sm.created.find((c) => c.opts.metadata?.orchestrationRole === 'worker.implement')
    assert.equal(worker.opts.worktree, true)
    assert.equal(worker.opts.permissionMode, 'acceptEdits')
    assert.equal(worker.opts.codexSandbox, 'workspace-write')
    assert.equal(worker.session.permissionRules, null, 'no read-only rules on the write worker')

    // the architect's result_review prompt carried the diff
    const arch = sm.created.find((c) => c.opts.metadata?.orchestrationRole === 'architect').session
    assert.ok(arch.sends.some((s) => s.includes('DIFF') && s.includes('+added line')), 'diff shown to reviewer')
  } finally {
    cleanup()
  }
})

test('two implement subtasks merge sequentially into ONE integration worktree (no race)', async () => {
  // architect plans TWO implement subtasks; both approved. maxParallelWorkers=2
  // runs them concurrently, so the accept/merge path must serialize.
  const decide = ({ role, kind }) => {
    if (role === 'architect' && kind === 'epic_plan') {
      return { kind: 'epic_plan', subtasks: [
        { title: 'A', goal: 'g', role: 'implement' },
        { title: 'B', goal: 'g', role: 'implement' },
      ] }
    }
    if (role === 'architect' && kind === 'poa_review') return { kind: 'poa_review', verdict: 'approve' }
    if (role === 'architect' && kind === 'result_review') return { kind: 'result_review', verdict: 'approve' }
    if (role === 'architect' && kind === 'synthesis') return { kind: 'synthesis', reportMarkdown: '# Done' }
    if (kind === 'plan_of_attack') return { kind: 'plan_of_attack', plan: 'p', summary: 'poa' }
    if (kind === 'work_result') return { kind: 'work_result', summary: 's' }
    throw new Error(`unexpected ${role}/${kind}`)
  }
  const { ledger, gitOps, mgr, cleanup } = harness(decide)
  try {
    const rec = mgr.createRun({ goal: 'Implement', cwd: '/repo', autoApprovePlan: true })
    const done = waitFor(mgr, ['run_completed'])
    await mgr.startRun(rec.runId)
    await done
    const record = ledger.getRun(rec.runId)
    assert.equal(record.status, 'completed')
    assert.ok(record.subtasks.every((s) => s.status === 'done'), 'both subtasks merged')
    const names = gitOps.calls.map((c) => c.name)
    assert.equal(names.filter((n) => n === 'createIntegrationWorktree').length, 1, 'integration worktree created EXACTLY once (no double-create race)')
    assert.equal(names.filter((n) => n === 'mergeNoFf').length, 2, 'both branches merged')
    assert.equal(names.filter((n) => n === 'abortMerge').length, 0, 'no spurious conflict/abort from a race')
    assert.equal(names.filter((n) => n === 'removeWorktree').length, 1, 'integration worktree cleaned up once')
    assert.equal(record.subtasks.length, 2)
  } finally {
    cleanup()
  }
})

test('redelegate of an implement worker recreates the worktree + branch', async () => {
  const decide = ({ role, kind, n }) => {
    if (role === 'architect' && kind === 'epic_plan') return { kind: 'epic_plan', subtasks: [{ title: 'A', goal: 'g', role: 'implement' }] }
    if (role === 'architect' && kind === 'poa_review') return { kind: 'poa_review', verdict: n === 1 ? 'redelegate' : 'approve' }
    if (role === 'architect' && kind === 'result_review') return { kind: 'result_review', verdict: 'approve' }
    if (role === 'architect' && kind === 'synthesis') return { kind: 'synthesis', reportMarkdown: '# Done' }
    if (kind === 'plan_of_attack') return { kind: 'plan_of_attack', plan: 'p', summary: 'poa' }
    if (kind === 'work_result') return { kind: 'work_result', summary: 's' }
    throw new Error(`unexpected ${role}/${kind}`)
  }
  const { sm, ledger, gitOps, mgr, cleanup } = harness(decide)
  try {
    const rec = mgr.createRun({ goal: 'Implement', cwd: '/repo', autoApprovePlan: true })
    const done = waitFor(mgr, ['run_completed'])
    await mgr.startRun(rec.runId)
    await done
    assert.equal(ledger.getRun(rec.runId).status, 'completed')
    // TWO implement workers created for the one subtask (original + redelegated)
    const workers = sm.created.filter((c) => c.opts.metadata?.orchestrationRole === 'worker.implement')
    assert.equal(workers.length, 2, 'redelegate spawned a fresh write worker')
    const names = gitOps.calls.map((c) => c.name)
    assert.equal(names.filter((n) => n === 'createBranch').length, 2, 'branch created for each worker')
    assert.ok(names.includes('deleteBranch'), 'stale branch deleted before recreate on respawn')
  } finally {
    cleanup()
  }
})

test('a failed createBranch at spawn escalates (does not crash the run)', async () => {
  const { ledger, gitOps, mgr, cleanup } = harness(implementDecider(), { gitOpts: { failCreateBranch: true } })
  try {
    const rec = mgr.createRun({ goal: 'Implement', cwd: '/repo', autoApprovePlan: true })
    const gated = waitFor(mgr, ['gate_opened'])
    await mgr.startRun(rec.runId)
    const { payload } = await gated
    assert.equal(payload.gate.kind, 'escalation')
    assert.ok(!gitOps.calls.some((c) => c.name === 'mergeNoFf'), 'never attempted a merge without a branch')
    const done = waitFor(mgr, ['run_completed'])
    await mgr.resolveGate(rec.runId, payload.gate.gateId, { decision: 'skip' })
    await done
    assert.equal(ledger.getRun(rec.runId).status, 'completed')
  } finally {
    cleanup()
  }
})

test('merge conflict aborts and escalates; skip completes the run', async () => {
  const { ledger, gitOps, mgr, cleanup } = harness(implementDecider(), { gitOpts: { conflict: true } })
  try {
    const rec = mgr.createRun({ goal: 'Implement', cwd: '/repo', autoApprovePlan: true })
    const gated = waitFor(mgr, ['gate_opened'])
    await mgr.startRun(rec.runId)
    const { payload } = await gated
    assert.equal(payload.gate.kind, 'escalation')
    assert.ok(gitOps.calls.some((c) => c.name === 'abortMerge'), 'merge aborted on conflict')

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

test('an implement subtask is coerced to audit when the worker provider is not implement-eligible', async () => {
  const { sm, ledger, gitOps, mgr, cleanup } = harness(implementDecider(), { roles: ROLES_SDK })
  try {
    const rec = mgr.createRun({ goal: 'Implement', cwd: '/repo', autoApprovePlan: true })
    const done = waitFor(mgr, ['run_completed'])
    await mgr.startRun(rec.runId)
    await done
    const record = ledger.getRun(rec.runId)
    assert.equal(record.subtasks[0].role, 'worker.audit', 'coerced to audit (sdk not implement-eligible)')
    assert.ok(!gitOps.calls.some((c) => c.name === 'createBranch'), 'no worktree/branch for a coerced audit subtask')
    const worker = sm.created.find((c) => c.opts.metadata?.orchestrationRole === 'worker.audit')
    assert.ok(!worker.opts.worktree, 'audit worker has no worktree')
    assert.ok(Array.isArray(worker.session.permissionRules), 'audit worker got read-only rules')
  } finally {
    cleanup()
  }
})

test('repo-audit preset forces audit even with a codex (implement-eligible) worker', async () => {
  const { ledger, gitOps, mgr, cleanup } = harness(implementDecider(), {})
  try {
    const rec = mgr.createRun({ cwd: '/repo', preset: 'repo-audit', autoApprovePlan: true })
    const done = waitFor(mgr, ['run_completed'])
    await mgr.startRun(rec.runId)
    await done
    assert.equal(ledger.getRun(rec.runId).subtasks[0].role, 'worker.audit')
    assert.ok(!gitOps.calls.some((c) => c.name === 'createBranch'))
  } finally {
    cleanup()
  }
})

test('auto-commit runs before the worker is destroyed on accept', async () => {
  const { gitOps, mgr, cleanup } = harness(implementDecider())
  try {
    const rec = mgr.createRun({ goal: 'Implement', cwd: '/repo', autoApprovePlan: true })
    const done = waitFor(mgr, ['run_completed'])
    await mgr.startRun(rec.runId)
    await done
    // autoCommit was called against the worker's worktree at least once
    const commits = gitOps.calls.filter((c) => c.name === 'autoCommit')
    assert.ok(commits.length >= 1)
    assert.ok(commits.some((c) => typeof c.arg.worktreePath === 'string'), 'auto-commit targeted a worktree')
  } finally {
    cleanup()
  }
})

test('cancel during an implement run auto-commits + cleans up the integration worktree', async () => {
  // architect plan hangs → cancel mid-run.
  const decide = ({ role, kind, n }) => {
    if (role === 'architect' && kind === 'epic_plan') return { kind: 'epic_plan', subtasks: [{ title: 'A', goal: 'g', role: 'implement' }] }
    if (role === 'architect' && kind === 'poa_review') return null // hang so the run is mid-flight
    return implementDecider()({ role, kind, n })
  }
  const { ledger, gitOps, mgr, cleanup } = harness(decide)
  try {
    const rec = mgr.createRun({ goal: 'Implement', cwd: '/repo', autoApprovePlan: true })
    let failed = false
    mgr.on('run_failed', () => { failed = true })
    const startP = mgr.startRun(rec.runId)
    await new Promise((r) => setTimeout(r, 20)) // let the worker spawn + branch, then hang at poa_review
    await mgr.cancelRun(rec.runId)
    await startP
    assert.equal(ledger.getRun(rec.runId).status, 'cancelled')
    assert.equal(failed, false, 'no run_failed after cancel')
    // the implement worker's worktree was auto-committed before teardown
    assert.ok(gitOps.calls.some((c) => c.name === 'autoCommit'), 'auto-commit before destroy on cancel')
  } finally {
    cleanup()
  }
})
