/**
 * OrchestrationManager (engine, epic #6691, step E-2) — the committee engine.
 * Owns run lifecycle for the READ/audit path: an architect session plans the
 * epic, worker sessions execute audit subtasks, the architect reviews each
 * plan-of-attack and result, and a synthesis turn produces the report. Write-
 * capable workers + merge-back are E-3; the wire projection is E-4.
 *
 * Wires the merged foundations: RunLedger (M-2) for durable state + usage,
 * run-budget (M-3) for soft caps, TurnDriver (E-1) to drive sessions,
 * decision-contract (E-1) for the structured committee decisions, run-model
 * (E-1) for the gate registry, role-prompts (this step), and the permission
 * gate. Sessions are real SessionManager sessions (one model per session).
 *
 * The manager is event-driven and async; each subtask advances through the
 * committee loop as its turns resolve. All external collaborators are injected,
 * so the whole loop is testable against a scripted fake provider.
 */

import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import { extractDecision, DecisionParseError, buildRepairPrompt } from './decision-contract.js'
import { makeGate, resolveGate as resolveGateModel, nextGateId } from './run-model.js'
import {
  architectPreamble, auditWorkerPreamble, presetFor,
  buildPlanPrompt, buildPoaPrompt, buildPoaReviewPrompt,
  buildExecutePrompt, buildResultReviewPrompt, buildSynthesisPrompt,
} from './role-prompts.js'

const DEFAULTS = {
  maxParallelWorkers: 2,
  reserveSessions: 1,
  maxCommitteeIterations: 4,
  maxParseRetries: 2,
  turnTimeoutMs: 30 * 60 * 1000,
}

// Providers whose sessions can be metered AND permission-gated read-only (S-2
// design matrix). audit workers must be one of these.
const AUDIT_ELIGIBLE_PROVIDERS = new Set(['claude-sdk', 'claude-byok', 'codex'])

// Engine-side subtask states that end scheduling. 'escalated' is deliberately
// excluded — it awaits a user gate, so it must block synthesis.
const TERMINAL_SUBTASK_STATES = new Set(['done', 'failed', 'skipped'])
function isTerminalSubtaskState(state) { return TERMINAL_SUBTASK_STATES.has(state) }

export class OrchestrationManager extends EventEmitter {
  /**
   * @param {{
   *   sessionManager: any, ledger: any, turnDriver: any, permissionGateFactory?: Function,
   *   config?: object, roles?: object, validateCwd?: (cwd: string) => (string|null),
   *   now?: () => number, log?: object,
   * }} opts
   */
  constructor({ sessionManager, ledger, turnDriver, permissionGateFactory = null, config = {}, roles = null, validateCwd = null, now = () => Date.now(), log = null }) {
    super()
    if (!sessionManager) throw new Error('OrchestrationManager requires a sessionManager')
    if (!ledger) throw new Error('OrchestrationManager requires a ledger')
    if (!turnDriver) throw new Error('OrchestrationManager requires a turnDriver')
    this._sm = sessionManager
    this._ledger = ledger
    this._driver = turnDriver
    this._cfg = { ...DEFAULTS, ...(config.orchestration || config || {}) }
    this._roles = roles || (config.orchestration && config.orchestration.roles) || null
    this._validateCwd = validateCwd
    this._now = now
    this._log = log
    this._runs = new Map() // runId -> engine state
    this._reports = new Map() // runId -> reportMarkdown (in-memory until M-4 persists report.md)
    this._maxReports = 32
    this._maxSessions = Number.isFinite(config.maxSessions) ? config.maxSessions : 5

    // Owned-session registry drives the permission gate (answers ONLY our sessions).
    if (permissionGateFactory) {
      this._gate = permissionGateFactory({
        sessionManager,
        isOwnedSession: (sid) => this._isOwnedSession(sid),
        policyForSession: (sid) => this._roleClassForSession(sid),
        emitEscalation: (info) => this._onPermissionEscalation(info),
        log,
      })
    }
  }

  dispose() {
    this._gate?.dispose?.()
  }

  // --- run creation --------------------------------------------------------

  createRun({ title = '', goal = null, cwd, preset = null, budgetUsd = null, autoApprovePlan = false, roleOverrides = null } = {}) {
    if (!cwd || typeof cwd !== 'string') throw new Error('createRun requires a cwd')
    if (this._validateCwd) {
      const cwdError = this._validateCwd(cwd)
      if (cwdError) throw new Error(`invalid cwd: ${cwdError}`)
    }
    if (this._runs.size > 0) throw new Error('a run is already active (one run at a time in v1)')

    const presetDef = preset ? presetFor(preset) : null
    const effectiveGoal = goal || presetDef?.goalTemplate || null
    if (!effectiveGoal) throw new Error('createRun requires a goal or a preset that provides one')

    const roleModels = this._resolveRoles(roleOverrides)
    const configSnapshot = {
      cwd,
      roleModels,
      budget: { maxUsd: Number.isFinite(budgetUsd) ? budgetUsd : null, warnPercent: 80 },
    }
    const record = this._ledger.createRun({ title: title || (presetDef?.name ?? 'orchestration run'), preset, configSnapshot })
    const runId = record.runId

    this._runs.set(runId, {
      runId,
      cwd,
      goal: effectiveGoal,
      preset: presetDef,
      autoApprovePlan: autoApprovePlan === true,
      roleModels,
      architectSessionId: null,
      ownedSessions: new Map(), // sessionId -> { role: 'architect'|'audit', subtaskId }
      gates: new Map(), // gateId -> gate
      subtasks: new Map(), // subtaskId -> { iterations, poa, result, state }
      results: [], // accepted { title, summary }
      phase: 'created',
      cancelled: false,
    })
    return record
  }

  _resolveRoles(overrides) {
    const base = this._roles || {}
    const merged = { ...base, ...(overrides || {}) }
    const architect = merged.architect
    const worker = merged.auditWorker || merged.worker
    if (!architect?.provider || !architect?.model) throw new Error('orchestration roles.architect must set { provider, model }')
    if (!worker?.provider || !worker?.model) throw new Error('orchestration roles.worker/auditWorker must set { provider, model }')
    if (!AUDIT_ELIGIBLE_PROVIDERS.has(worker.provider)) {
      throw new Error(`audit worker provider '${worker.provider}' cannot be permission-gated read-only (use ${[...AUDIT_ELIGIBLE_PROVIDERS].join('/')})`)
    }
    return { architect, worker }
  }

  // --- lifecycle -----------------------------------------------------------

  async startRun(runId) {
    const run = this._get(runId)
    run.phase = 'planning'
    this._ledger.setStatus(runId, 'planning')
    let plan
    try {
      plan = await this._plan(run)
    } catch (err) {
      return this._failRun(run, `PLAN_${err instanceof DecisionParseError ? 'PARSE' : 'FAILED'}`, err)
    }
    // materialize subtasks (audit preset coerces every subtask to role:'audit')
    for (const spec of plan.subtasks) {
      const subtaskId = `st_${randomBytes(4).toString('hex')}`
      const role = run.preset?.forceRole === 'audit' ? 'audit' : spec.role
      this._ledger.createSubtask(runId, { subtaskId, role: `worker.${role}`, title: spec.title })
      run.subtasks.set(subtaskId, { iterations: 0, spec: { ...spec, role }, state: 'pending', poa: null, result: null })
    }

    if (run.autoApprovePlan) {
      return this._beginExecuting(run)
    }
    // open the epic_plan user gate — the spend gate
    const gate = this._openGate(run, { kind: 'epic_plan', summary: `Approve the ${run.subtasks.size}-subtask audit plan`, detail: plan.summary ?? null })
    run.phase = 'plan_review'
    this._ledger.setStatus(runId, 'plan_review')
    this.emit('gate_opened', { runId, gate })
    return { runId, phase: 'plan_review', gateId: gate.gateId }
  }

  async _plan(run) {
    const sessionId = this._spawnSession(run, { role: 'architect' })
    run.architectSessionId = sessionId
    run.ownedSessions.set(sessionId, { role: 'architect', subtaskId: null })
    const repoMap = ''
    const prompt = buildPlanPrompt({ goal: run.goal, repoMap, maxSubtasks: 8 })
    const { decision } = await this._driveDecision(run, sessionId, prompt, 'epic_plan', 'plan', null)
    return decision
  }

  async resolveGate(runId, gateId, { decision, note = null, budgetUsd = null } = {}) {
    const run = this._get(runId)
    const gate = run.gates.get(gateId)
    if (!gate) {
      const err = new Error(`gate ${gateId} not found`)
      err.code = 'GATE_NOT_FOUND'
      throw err
    }
    const resolved = resolveGateModel(gate, { decision, note, budgetUsd, resolvedAt: this._now() })
    run.gates.set(gateId, resolved)
    this.emit('gate_resolved', { runId, gate: resolved })

    if (gate.kind === 'epic_plan') {
      if (decision === 'approve') return this._beginExecuting(run)
      return this._failRun(run, 'PLAN_REJECTED', new Error(note || 'epic plan rejected'))
    }
    if (gate.kind === 'escalation') {
      return this._resolveEscalation(run, gate, decision, note)
    }
    return { runId, gateId, decision }
  }

  _beginExecuting(run) {
    run.phase = 'executing'
    this._ledger.setStatus(run.runId, 'executing')
    this._schedule(run)
    return { runId: run.runId, phase: 'executing' }
  }

  // --- scheduler -----------------------------------------------------------

  _schedule(run) {
    if (run.cancelled || run.phase !== 'executing') return
    const all = [...run.subtasks.values()]
    // Ready to synthesize only when EVERY subtask is terminal. 'escalated' is
    // NOT terminal — it blocks synthesis until the user resolves its gate, so a
    // sibling escalation can't let the run synthesize with a hole in it.
    if (all.every((s) => isTerminalSubtaskState(s.state))) {
      this._synthesize(run).catch((err) => this._failRun(run, 'SYNTHESIS_FAILED', err))
      return
    }
    const pending = [...run.subtasks.entries()].filter(([, s]) => s.state === 'pending')
    for (const [subtaskId] of pending) {
      if (this._activeWorkerCount(run) >= this._cfg.maxParallelWorkers) break
      if (!this._sessionHeadroom()) break
      const budget = this._ledger.evaluateBudget(run.runId, { role: 'worker.audit' })
      if (budget && budget.ok === false) { this._pauseForBudget(run); break }
      const st = run.subtasks.get(subtaskId)
      st.state = 'active'
      this._runSubtask(run, subtaskId).catch((err) => {
        this._log?.warn?.(`subtask ${subtaskId} crashed: ${err?.message || err}`)
        this._finishSubtask(run, subtaskId, 'failed')
      })
    }
  }

  async _runSubtask(run, subtaskId) {
    const st = run.subtasks.get(subtaskId)
    const sessionId = this._spawnSession(run, { role: 'audit', subtaskId })
    run.ownedSessions.set(sessionId, { role: 'audit', subtaskId })
    this._ledger.updateSubtask(run.runId, subtaskId, { status: 'briefing' })
    this._ledger.attachSession(run.runId, subtaskId, { sessionId, provider: run.roleModels.worker.provider, model: run.roleModels.worker.model, meterable: true })

    // read-only rules for audit workers (write-deny; reads allowed)
    this._applyAuditRules(sessionId)

    let feedback = null
    // committee loop for this subtask
    while (true) {
      if (st.iterations > this._cfg.maxCommitteeIterations) {
        return this._escalateSubtask(run, subtaskId, 'committee iteration cap exceeded')
      }
      // 1) plan-of-attack
      this._ledger.updateSubtask(run.runId, subtaskId, { status: 'briefing' })
      const poa = await this._driveDecision(run, sessionId, buildPoaPrompt({ subtask: st.spec }), 'plan_of_attack', 'poa', subtaskId).then((r) => r.decision)
      st.poa = poa
      // 2) architect reviews the PoA
      this._ledger.updateSubtask(run.runId, subtaskId, { status: 'poa_review' })
      const poaReview = await this._architectReview(run, buildPoaReviewPrompt({ subtask: st.spec, poa }), 'poa_review', subtaskId)
      this._ledger.recordCommitteeReview(run.runId, subtaskId, { phase: 'plan', verdict: poaReview.verdict, reviewerSessionId: run.architectSessionId, notes: poaReview.feedback ?? '' })
      if (poaReview.verdict === 'escalate') return this._escalateSubtask(run, subtaskId, poaReview.feedback || 'architect escalated the plan')
      if (poaReview.verdict === 'revise' || poaReview.verdict === 'redelegate') { st.iterations += 1; feedback = poaReview.feedback ?? null; continue }
      // 3) execute
      this._ledger.updateSubtask(run.runId, subtaskId, { status: 'executing' })
      const result = await this._driveDecision(run, sessionId, buildExecutePrompt({ subtask: st.spec, feedback }), 'work_result', 'execute', subtaskId).then((r) => r.decision)
      st.result = result
      // 4) architect reviews the result
      this._ledger.updateSubtask(run.runId, subtaskId, { status: 'result_review' })
      const resultReview = await this._architectReview(run, buildResultReviewPrompt({ subtask: st.spec, result }), 'result_review', subtaskId)
      this._ledger.recordCommitteeReview(run.runId, subtaskId, { phase: 'result', verdict: resultReview.verdict, reviewerSessionId: run.architectSessionId, notes: resultReview.feedback ?? '' })
      if (resultReview.verdict === 'approve') {
        run.results.push({ title: st.spec.title, summary: result.summary })
        this._destroySession(run, sessionId)
        return this._finishSubtask(run, subtaskId, 'done')
      }
      if (resultReview.verdict === 'escalate') return this._escalateSubtask(run, subtaskId, resultReview.feedback || 'architect escalated the result')
      // revise / redelegate → loop with feedback
      st.iterations += 1
      feedback = resultReview.feedback ?? null
    }
  }

  _finishSubtask(run, subtaskId, status) {
    const st = run.subtasks.get(subtaskId)
    if (st) st.state = status
    this._ledger.updateSubtask(run.runId, subtaskId, { status })
    // release the worker if still owned
    for (const [sid, meta] of run.ownedSessions) {
      if (meta.subtaskId === subtaskId && meta.role === 'audit') this._destroySession(run, sid)
    }
    this._schedule(run)
  }

  _escalateSubtask(run, subtaskId, reason) {
    const st = run.subtasks.get(subtaskId)
    if (st) st.state = 'escalated'
    this._ledger.updateSubtask(run.runId, subtaskId, { status: 'escalated' })
    // Free this subtask's worker so a pending sibling can take the slot while
    // the user resolves the escalation gate.
    for (const [sid, meta] of [...run.ownedSessions]) {
      if (meta.subtaskId === subtaskId && meta.role === 'audit') this._destroySession(run, sid)
    }
    const gate = this._openGate(run, { kind: 'escalation', nodeId: subtaskId, summary: `Subtask "${st?.spec?.title ?? subtaskId}" escalated`, detail: reason })
    this.emit('gate_opened', { runId: run.runId, gate })
    this._schedule(run)
    return { runId: run.runId, subtaskId, escalated: true, gateId: gate.gateId }
  }

  _resolveEscalation(run, gate, decision, note) {
    const subtaskId = gate.nodeId
    const st = subtaskId ? run.subtasks.get(subtaskId) : null
    if (!st) return { runId: run.runId, resolved: true }
    if (decision === 'skip') { this._finishSubtask(run, subtaskId, 'skipped'); return { runId: run.runId, subtaskId, skipped: true } }
    if (decision === 'reject') return this._failRun(run, 'ESCALATION_REJECTED', new Error(note || 'user failed the run'))
    // approve / revise → re-drive the subtask (iteration reset via a fresh worker)
    st.state = 'pending'
    st.iterations = 0
    this._schedule(run)
    return { runId: run.runId, subtaskId, retrying: true }
  }

  async _synthesize(run) {
    run.phase = 'synthesizing'
    this._ledger.setStatus(run.runId, 'synthesizing')
    const { decision } = await this._driveDecision(run, run.architectSessionId, buildSynthesisPrompt({ goal: run.goal, results: run.results }), 'synthesis', 'synthesis', null)
    // The report lives in memory until M-4 (run-report.js) persists report.{json,md}.
    this._rememberReport(run.runId, decision.reportMarkdown)
    this._destroySession(run, run.architectSessionId)
    run.phase = 'completed'
    this._ledger.setStatus(run.runId, 'completed')
    this.emit('run_completed', { runId: run.runId, reportMarkdown: decision.reportMarkdown })
    this._runs.delete(run.runId)
    return { runId: run.runId, phase: 'completed', reportMarkdown: decision.reportMarkdown }
  }

  // --- turn driving + decisions -------------------------------------------

  async _architectReview(run, prompt, kind, subtaskId) {
    const { decision } = await this._driveDecision(run, run.architectSessionId, prompt, kind, kind, subtaskId)
    return decision
  }

  // Drive one turn and extract its decision, with a repair-reprompt ladder.
  async _driveDecision(run, sessionId, prompt, kind, turnLabel, subtaskId) {
    let attempt = 0
    let currentPrompt = prompt
    let lastError = null
    while (attempt <= this._cfg.maxParseRetries) {
      const { text, result } = await this._driver.driveTurn(sessionId, currentPrompt, { label: turnLabel, timeoutMs: this._cfg.turnTimeoutMs })
      const roleClass = run.ownedSessions.get(sessionId)?.role ?? null
      // dotted ledger role: architect plan/synthesis vs architect.review, worker.audit
      const ledgerRole = roleClass === 'architect'
        ? (turnLabel === 'poa_review' || turnLabel === 'result_review' ? 'architect.review' : 'architect')
        : `worker.${roleClass}`
      this._ledger.recordTurnUsage(run.runId, {
        subtaskId, sessionId, role: ledgerRole, turnLabel, terminalEvent: 'result', data: result,
      })
      try {
        return { decision: extractDecision(text, kind).decision }
      } catch (err) {
        lastError = err
        attempt += 1
        if (attempt > this._cfg.maxParseRetries) break
        currentPrompt = buildRepairPrompt(kind, err) // cheap: context is cached
      }
    }
    throw lastError || new DecisionParseError('no_block', 'exhausted parse retries')
  }

  // --- session spawn/teardown ---------------------------------------------

  _spawnSession(run, { role, subtaskId = null }) {
    const spec = role === 'architect' ? run.roleModels.architect : run.roleModels.worker
    const opts = {
      name: `orch:${run.runId}:${role}${subtaskId ? `:${subtaskId}` : ''}`,
      cwd: run.cwd,
      provider: spec.provider,
      model: spec.model,
      permissionMode: 'approve',
      sessionPreamble: role === 'architect' ? architectPreamble() : auditWorkerPreamble(),
      metadata: { orchestrationRunId: run.runId, orchestrationRole: role === 'architect' ? 'architect' : `worker.${role}` },
    }
    // codex audit workers get the read-only sandbox (#6690).
    if (spec.provider === 'codex') opts.codexSandbox = 'read-only'
    const sessionId = this._sm.createSession(opts)
    return sessionId
  }

  _applyAuditRules(sessionId) {
    const session = this._sm.getSession?.(sessionId)?.session
    if (session && typeof session.setPermissionRules === 'function') {
      session.setPermissionRules([
        { tool: 'Read', decision: 'allow' }, { tool: 'Glob', decision: 'allow' }, { tool: 'Grep', decision: 'allow' },
        { tool: 'Write', decision: 'deny' }, { tool: 'Edit', decision: 'deny' }, { tool: 'NotebookEdit', decision: 'deny' }, { tool: 'apply_patch', decision: 'deny' },
      ])
    }
  }

  _destroySession(run, sessionId) {
    if (!sessionId) return
    run.ownedSessions.delete(sessionId)
    try { this._sm.destroySession?.(sessionId) } catch { /* best-effort */ }
  }

  // --- helpers -------------------------------------------------------------

  _openGate(run, { kind, nodeId = null, summary, detail = null, budgetUsd = null }) {
    const gate = makeGate({ gateId: nextGateId(run.runId), runId: run.runId, kind, nodeId, summary, detail, budgetUsd, openedAt: this._now() })
    run.gates.set(gate.gateId, gate)
    return gate
  }

  _pauseForBudget(run) {
    run.phase = 'budget_paused'
    this._ledger.setStatus(run.runId, 'budget_paused')
    this.emit('run_budget_paused', { runId: run.runId })
  }

  _onPermissionEscalation(info) {
    const run = this._runForSession(info.sessionId)
    if (!run) return
    this.emit('permission_escalation', { runId: run.runId, ...info })
  }

  _failRun(run, code, err) {
    run.phase = 'failed'
    this._ledger.setStatus(run.runId, 'failed', code)
    // tear down any owned sessions
    for (const sid of [...run.ownedSessions.keys()]) this._destroySession(run, sid)
    this.emit('run_failed', { runId: run.runId, code, message: err?.message || String(err) })
    this._runs.delete(run.runId)
    return { runId: run.runId, phase: 'failed', code }
  }

  cancelRun(runId, { reason = 'user' } = {}) {
    const run = this._runs.get(runId)
    if (!run) return null
    run.cancelled = true
    for (const sid of [...run.ownedSessions.keys()]) {
      try { this._sm.getSession?.(sid)?.session?.interrupt?.() } catch { /* ignore */ }
      this._destroySession(run, sid)
    }
    this._ledger.setStatus(runId, 'cancelled', reason)
    this.emit('run_cancelled', { runId, reason })
    this._runs.delete(runId)
    return { runId, phase: 'cancelled' }
  }

  _get(runId) {
    const run = this._runs.get(runId)
    if (!run) throw new Error(`run ${runId} not found`)
    return run
  }
  _isOwnedSession(sessionId) {
    for (const run of this._runs.values()) if (run.ownedSessions.has(sessionId)) return true
    return false
  }
  _roleClassForSession(sessionId) {
    for (const run of this._runs.values()) {
      const meta = run.ownedSessions.get(sessionId)
      if (meta) return meta.role === 'audit' ? 'audit' : null // architect never gets gated tool prompts
    }
    return null
  }
  _runForSession(sessionId) {
    for (const run of this._runs.values()) if (run.ownedSessions.has(sessionId)) return run
    return null
  }
  _activeWorkerCount(run) {
    let n = 0
    for (const s of run.subtasks.values()) if (s.state === 'active') n += 1
    return n
  }
  _sessionHeadroom() {
    const size = typeof this._sm.listSessions === 'function' ? this._sm.listSessions().length : this._sm._sessions?.size ?? 0
    return size <= (this._maxSessions - this._cfg.reserveSessions)
  }

  // --- read API (consumed by the S-2 handlers; wire projection is E-4) -----

  listRuns() {
    return this._ledger.listRuns()
  }
  getRunSnapshot(runId) {
    const record = this._ledger.getRun(runId)
    if (!record) return null
    // E-4 projects this into the wire RunDetail; for now hand back the record
    // plus the in-memory report (M-4 will persist + project it).
    return { seq: 0, run: record, reportMarkdown: this._reports.get(runId) ?? null }
  }

  _rememberReport(runId, markdown) {
    this._reports.set(runId, markdown)
    while (this._reports.size > this._maxReports) {
      const oldest = this._reports.keys().next().value
      this._reports.delete(oldest)
    }
  }
}
